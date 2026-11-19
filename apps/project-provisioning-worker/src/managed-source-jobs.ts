import type { ClaimedOutboxEvent } from "@ohmyhost/database/provisioning-persistence";
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import type { ProductCommandQueuePort } from "@ohmyhost/orchestrator";

import type { ManagedSourceProcessorBinding } from "./bindings.js";

export const MANAGED_SOURCE_PUBLICATION_EVENT_TYPE = "ManagedSourcePublicationRequestedV1";
export const MANAGED_SOURCE_INITIALIZATION_EVENT_TYPE = "ManagedSourceInitializationRequestedV1";
const eventTypes = [
  MANAGED_SOURCE_PUBLICATION_EVENT_TYPE,
  MANAGED_SOURCE_INITIALIZATION_EVENT_TYPE,
] as const;

export interface ManagedSourcePublicationMessageV1 {
  readonly version: 1;
  readonly eventType: (typeof eventTypes)[number];
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
}

export type ManagedSourceConsumptionResult =
  | { readonly status: "pending"; readonly jobId: string }
  | {
      readonly status: "completed";
      readonly jobId: string;
      readonly durable: "managed_source_terminal" | "managed_source_handoff";
    };

export interface PublicationState {
  readonly state: string;
  readonly operationState: string;
  readonly initializationState: string | null;
}

/** Queue messages carry immutable locators only; source trees and credentials stay in custody. */
export function parseManagedSourcePublicationMessage(
  value: unknown,
): ManagedSourcePublicationMessageV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Managed source Queue message must be an object");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).sort().join(",") !==
      "billingEpochId,environmentId,eventId,eventType,operationId,organizationId,projectId,version" ||
    body["version"] !== 1 ||
    !eventTypes.includes(body["eventType"] as (typeof eventTypes)[number])
  )
    throw new TypeError("Managed source Queue message contract is invalid");
  return Object.freeze({
    version: 1,
    eventType: body["eventType"] as (typeof eventTypes)[number],
    eventId: messageId(body, "eventId"),
    organizationId: messageId(body, "organizationId"),
    projectId: messageId(body, "projectId"),
    operationId: messageId(body, "operationId"),
    billingEpochId: messageId(body, "billingEpochId"),
    environmentId: messageId(body, "environmentId"),
  });
}

/** Acknowledges a terminal journal/Operation and any linked initialization recipe under the exact event. */
export interface ManagedSourceStatePort {
  readPublication(message: ManagedSourcePublicationMessageV1): Promise<PublicationState>;
  readInitialization(message: ManagedSourcePublicationMessageV1): Promise<InitializationState>;
}

export function createManagedSourcePublicationConsumer(dependencies: {
  readonly processor: ManagedSourceProcessorBinding;
  readonly state: ManagedSourceStatePort;
}) {
  const { state } = dependencies;

  return Object.freeze({
    async consume(serializedMessage: string): Promise<ManagedSourceConsumptionResult> {
      const message = parseManagedSourcePublicationMessage(JSON.parse(serializedMessage));
      const jobId = `managed-source-v1-${message.eventId}-${message.operationId}`;
      if (message.eventType === MANAGED_SOURCE_INITIALIZATION_EVENT_TYPE)
        return consumeInitialization({ state, processor: dependencies.processor }, message, jobId);
      const current = await state.readPublication(message);
      if (isTerminal(current))
        return { status: "completed", jobId, durable: "managed_source_terminal" };
      const result: unknown = await dependencies.processor.process({
        organizationId: message.organizationId,
        projectId: message.projectId,
        operationId: message.operationId,
      });
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        Object.keys(result).join(",") !== "state" ||
        !("state" in result) ||
        !["staging", "committed", "failed"].includes(String(result.state))
      )
        throw new TypeError("Managed source processor response is invalid");
      if (result.state === "staging") return { status: "pending", jobId };
      const observed = await state.readPublication(message);
      if (!isTerminal(observed)) return { status: "pending", jobId };
      if (observed.state !== result.state)
        throw new Error("Managed source processor result does not match its durable journal");
      return { status: "completed", jobId, durable: "managed_source_terminal" };
    },
  });
}

export interface InitializationState {
  readonly state: string;
  readonly childOperationId: string | null;
  readonly handoff: boolean;
  readonly childState: string | null;
  readonly childOperationState: string | null;
}

async function consumeInitialization(
  dependencies: {
    readonly state: ManagedSourceStatePort;
    readonly processor: ManagedSourceProcessorBinding;
  },
  message: ManagedSourcePublicationMessageV1,
  jobId: string,
): Promise<ManagedSourceConsumptionResult> {
  const current = await dependencies.state.readInitialization(message);
  if (initializationTerminal(current))
    return { status: "completed", jobId, durable: "managed_source_terminal" };
  const result: unknown = await dependencies.processor.initialize({
    organizationId: message.organizationId,
    projectId: message.projectId,
    operationId: message.operationId,
  });
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new TypeError("Managed source initializer response is invalid");
  const body = result as Record<string, unknown>;
  if (
    !["state", "childOperationId,state"].includes(Object.keys(body).sort().join(",")) ||
    !["pending", "initialized", "failed"].includes(String(body["state"]))
  )
    throw new TypeError("Managed source initializer response is invalid");
  const childId =
    body["childOperationId"] === undefined ? null : messageId(body, "childOperationId");
  const observed = await dependencies.state.readInitialization(message);
  if (initializationTerminal(observed)) {
    if (
      (body["state"] === "initialized" || body["state"] === "failed") &&
      observed.state !== body["state"]
    )
      throw new Error("Managed source initializer result does not match its durable recipe");
    return { status: "completed", jobId, durable: "managed_source_terminal" };
  }
  if (
    body["state"] === "pending" &&
    childId !== null &&
    childId === observed.childOperationId &&
    observed.handoff
  )
    return { status: "completed", jobId, durable: "managed_source_handoff" };
  return { status: "pending", jobId };
}

function initializationTerminal(value: InitializationState): boolean {
  return (
    (value.state === "initialized" &&
      value.childState === "committed" &&
      value.childOperationState === "succeeded") ||
    (value.state === "failed" &&
      (value.childOperationId === null ||
        (value.childState === "failed" && value.childOperationState === "failed")))
  );
}

export function projectClaimedPublication(
  claimed: ClaimedOutboxEvent,
): ManagedSourcePublicationMessageV1 {
  const payload = claimed.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).join(",") !== "environmentId"
  )
    throw new TypeError("Managed source outbox payload contract is invalid");
  return parseManagedSourcePublicationMessage({
    version: 1,
    eventType: claimed.eventType,
    eventId: claimed.eventId,
    organizationId: claimed.organizationId,
    projectId: claimed.projectId,
    operationId: claimed.operationId,
    billingEpochId: claimed.billingEpochId,
    environmentId: payload["environmentId"],
  });
}

function isTerminal(value: PublicationState): boolean {
  return (
    (value.state === "committed" &&
      value.operationState === "succeeded" &&
      (value.initializationState === null || value.initializationState === "initialized")) ||
    (value.state === "failed" &&
      value.operationState === "failed" &&
      (value.initializationState === null || value.initializationState === "failed"))
  );
}

function messageId(body: Record<string, unknown>, key: string): Ulid {
  const value = body[key];
  if (typeof value !== "string") throw new TypeError("Managed source Queue locator must be a ULID");
  return parseUlid(value);
}

export async function sendWithDeadline(
  queue: ProductCommandQueuePort,
  message: string,
): Promise<"sent" | "timeout" | "uncertain"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, 5_000);
  });
  const sent = Promise.resolve()
    .then(() => queue.send(message, { signal: controller.signal }))
    .catch(() => "uncertain" as const);
  try {
    return await Promise.race([sent, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
