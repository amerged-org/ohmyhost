import { parseUlid, type Ulid } from "@ohmyhost/platform";

import { assertOperationalDuration } from "./duration.js";

const INVALID_PROJECT_PROVISIONING_MESSAGE = "INVALID_PROJECT_PROVISIONING_MESSAGE" as const;
const PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR =
  "PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR" as const;
export const PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID =
  "PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID" as const;
export const PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID =
  "PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID" as const;

export interface ProjectProvisioningMessageV1 {
  readonly version: 1;
  readonly eventType: "ProjectProvisioningRequested";
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
}

export interface ProjectProvisioningOutboxPayload {
  readonly projectId: Ulid;
  readonly operationId: Ulid;
}

export interface ClaimedProjectProvisioningRequest {
  readonly eventType: "ProjectProvisioningRequested";
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly payload: unknown;
  readonly attemptId: Ulid;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
}

interface ProjectProvisioningAttemptScope {
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly attemptId: Ulid;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
}

export interface ProjectProvisioningOutboxPort {
  recoverExpiredFinalProjectProvisioningClaim(): Promise<{
    readonly eventId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly attemptId: Ulid;
    readonly attemptNumber: number;
  } | null>;
  claimProjectProvisioningRequested(): Promise<ClaimedProjectProvisioningRequest | null>;
  acknowledgeExact(input: { readonly eventId: Ulid; readonly attemptId: Ulid }): Promise<boolean>;
  recordDeliveryUncertain(input: ProjectProvisioningDeliveryUncertainInput): Promise<{
    readonly outcome: "retry_scheduled" | "reconciliation_required";
    readonly attemptNumber: number;
  }>;
  recordQueueConfigurationFailureExact(
    input: ProjectProvisioningAttemptScope & {
      readonly errorCode: typeof PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR;
    },
  ): Promise<{
    readonly outcome: "retry_scheduled" | "reconciliation_required";
    readonly attemptNumber: number;
  } | null>;
  failInvalidExact(
    input: ProjectProvisioningAttemptScope & {
      readonly errorCode: typeof INVALID_PROJECT_PROVISIONING_MESSAGE;
    },
  ): Promise<boolean>;
}

export type ProjectProvisioningQueueContractViolation =
  | {
      readonly cause: "adapter_contract_invalid";
      readonly diagnosticCode: typeof PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID;
    }
  | {
      readonly cause: "classifier_contract_invalid";
      readonly diagnosticCode: typeof PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID;
    };

type ProjectProvisioningDeliveryUncertainInput =
  | (ProjectProvisioningAttemptScope & {
      readonly cause: "timeout" | "uncertain";
    })
  | (ProjectProvisioningAttemptScope & ProjectProvisioningQueueContractViolation);

export interface ProjectProvisioningQueuePort {
  send(
    serializedMessage: string,
    options: { readonly signal: AbortSignal },
  ): Promise<ProjectProvisioningQueueSendOutcome>;
}

export type ProjectProvisioningQueueSendOutcome = "sent" | "timeout" | "uncertain";

export type ProjectProvisioningQueueErrorClassification = "definitive_configuration" | "uncertain";

export interface ProjectProvisioningPublisherDependencies {
  readonly outbox: ProjectProvisioningOutboxPort;
  readonly queue: ProjectProvisioningQueuePort;
  readonly queueSendTimeoutMilliseconds: number;
  readonly classifyQueueError: (error: unknown) => ProjectProvisioningQueueErrorClassification;
  readonly afterSend?: () => Promise<void> | void;
}

export type ProjectProvisioningPublishResult =
  | { readonly status: "empty" }
  | {
      readonly status: "reconciliation_recovered";
      readonly eventId: Ulid;
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
      readonly operationId: Ulid;
      readonly attemptId: Ulid;
      readonly attemptNumber: number;
    }
  | {
      readonly status: "published";
      readonly eventId: Ulid;
      readonly attemptId: Ulid;
    }
  | {
      readonly status: "retry_scheduled" | "reconciliation_required";
      readonly eventId: Ulid;
      readonly attemptId: Ulid;
      readonly attemptNumber: number;
      readonly cause: "timeout" | "uncertain";
    }
  | {
      readonly status: "invalid_message";
      readonly eventId: Ulid;
      readonly attemptId: Ulid;
      readonly errorCode: typeof INVALID_PROJECT_PROVISIONING_MESSAGE;
    }
  | {
      readonly status: "retry_scheduled" | "reconciliation_required";
      readonly eventId: Ulid;
      readonly attemptId: Ulid;
      readonly attemptNumber: number;
      readonly cause: "definitive_configuration";
      readonly errorCode: typeof PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR;
    }
  | ({
      readonly status: "retry_scheduled" | "reconciliation_required";
      readonly eventId: Ulid;
      readonly attemptId: Ulid;
      readonly attemptNumber: number;
    } & ProjectProvisioningQueueContractViolation);

export interface ProjectProvisioningWorkflowPort {
  execute(input: {
    readonly workflowId: string;
    readonly message: ProjectProvisioningMessageV1;
  }): Promise<ProjectProvisioningWorkflowExecutionOutcome>;
}

export type ProjectProvisioningWorkflowExecutionOutcome =
  | "completed"
  | "pending"
  | "failed"
  | "uncertain";

type ProjectProvisioningAtomicPersistenceOutcome = "applied" | "duplicate";

export interface ProjectProvisioningCompletionPort {
  completeAtomic(input: {
    readonly workflowId: string;
    readonly message: ProjectProvisioningMessageV1;
  }): Promise<ProjectProvisioningAtomicPersistenceOutcome>;
}

export interface ProjectProvisioningFailurePort {
  failAtomic(input: {
    readonly workflowId: string;
    readonly message: ProjectProvisioningMessageV1;
  }): Promise<ProjectProvisioningAtomicPersistenceOutcome>;
}

interface ProjectProvisioningReconciliationPort {
  requireReconciliationAtomic(input: {
    readonly workflowId: string;
    readonly message: ProjectProvisioningMessageV1;
  }): Promise<ProjectProvisioningAtomicPersistenceOutcome>;
}

export interface ProjectProvisioningConsumerDependencies {
  readonly workflow: ProjectProvisioningWorkflowPort;
  readonly completion: ProjectProvisioningCompletionPort;
  readonly failure: ProjectProvisioningFailurePort;
  readonly reconciliation: ProjectProvisioningReconciliationPort;
}

export type ProjectProvisioningConsumptionResult =
  | {
      readonly status: "completed";
      readonly workflowId: string;
      readonly completion: "applied" | "duplicate";
    }
  | {
      readonly status: "failed";
      readonly workflowId: string;
      readonly failure: "applied" | "duplicate";
    }
  | {
      readonly status: "reconciliation_required";
      readonly workflowId: string;
      readonly reconciliation: "applied" | "duplicate";
    }
  | { readonly status: "pending"; readonly workflowId: string };

export function parseProjectProvisioningMessageV1(value: unknown): ProjectProvisioningMessageV1 {
  if (!isRecord(value)) {
    throw new TypeError("Project provisioning message must be an object");
  }
  assertExactKeys(value, [
    "version",
    "eventType",
    "eventId",
    "organizationId",
    "projectId",
    "operationId",
  ]);
  if (value["version"] !== 1) {
    throw new TypeError("Project provisioning message version must be 1");
  }
  if (value["eventType"] !== "ProjectProvisioningRequested") {
    throw new TypeError("Project provisioning message event type is unsupported");
  }
  return Object.freeze({
    version: 1,
    eventType: "ProjectProvisioningRequested",
    eventId: parseMessageUlid(value, "eventId"),
    organizationId: parseMessageUlid(value, "organizationId"),
    projectId: parseMessageUlid(value, "projectId"),
    operationId: parseMessageUlid(value, "operationId"),
  });
}

export function serializeProjectProvisioningMessageV1(
  message: ProjectProvisioningMessageV1,
): string {
  const parsed = parseProjectProvisioningMessageV1(message);
  return JSON.stringify(parsed);
}

export function parseProjectProvisioningOutboxPayload(
  value: unknown,
): ProjectProvisioningOutboxPayload {
  if (!isRecord(value)) {
    throw new TypeError("Project provisioning outbox payload must be an object");
  }
  assertExactKeys(value, ["projectId", "operationId"]);
  return Object.freeze({
    projectId: parseMessageUlid(value, "projectId"),
    operationId: parseMessageUlid(value, "operationId"),
  });
}

export async function publishOneProjectProvisioningRequest(
  dependencies: ProjectProvisioningPublisherDependencies,
): Promise<ProjectProvisioningPublishResult> {
  assertOperationalDuration(
    "queueSendTimeoutMilliseconds",
    dependencies.queueSendTimeoutMilliseconds,
  );
  const recovered = await dependencies.outbox.recoverExpiredFinalProjectProvisioningClaim();
  const claimed = await dependencies.outbox.claimProjectProvisioningRequested();
  if (claimed === null) {
    return recovered === null
      ? { status: "empty" }
      : { status: "reconciliation_recovered", ...recovered };
  }
  let message: ProjectProvisioningMessageV1;
  try {
    message = messageFromClaim(claimed);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const failed = await dependencies.outbox.failInvalidExact({
      ...attemptScope(claimed),
      errorCode: INVALID_PROJECT_PROVISIONING_MESSAGE,
    });
    if (failed !== true) {
      throw new Error("Invalid project provisioning message belongs to a stale outbox attempt");
    }
    return {
      status: "invalid_message",
      eventId: claimed.eventId,
      attemptId: claimed.attemptId,
      errorCode: INVALID_PROJECT_PROVISIONING_MESSAGE,
    };
  }

  const outcome = await sendProjectProvisioningMessage(dependencies, message);
  if (typeof outcome === "object") {
    if (outcome.cause === "adapter_contract_invalid") {
      const durable = parseDeliveryUncertainResult(
        await dependencies.outbox.recordDeliveryUncertain({
          ...attemptScope(claimed),
          cause: outcome.cause,
          diagnosticCode: outcome.diagnosticCode,
        }),
      );
      return {
        status: durable.outcome,
        eventId: claimed.eventId,
        attemptId: claimed.attemptId,
        attemptNumber: durable.attemptNumber,
        cause: outcome.cause,
        diagnosticCode: outcome.diagnosticCode,
      };
    }
    const durable = parseDeliveryUncertainResult(
      await dependencies.outbox.recordDeliveryUncertain({
        ...attemptScope(claimed),
        cause: outcome.cause,
        diagnosticCode: outcome.diagnosticCode,
      }),
    );
    return {
      status: durable.outcome,
      eventId: claimed.eventId,
      attemptId: claimed.attemptId,
      attemptNumber: durable.attemptNumber,
      cause: outcome.cause,
      diagnosticCode: outcome.diagnosticCode,
    };
  }
  if (outcome === "definitive_configuration") {
    const recorded = await dependencies.outbox.recordQueueConfigurationFailureExact({
      ...attemptScope(claimed),
      errorCode: PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR,
    });
    if (recorded === null) {
      throw new Error(
        "Queue configuration failure belongs to a stale project provisioning attempt",
      );
    }
    const durable = parseDeliveryUncertainResult(recorded);
    return {
      status: durable.outcome,
      eventId: claimed.eventId,
      attemptId: claimed.attemptId,
      attemptNumber: durable.attemptNumber,
      cause: "definitive_configuration",
      errorCode: PROJECT_PROVISIONING_QUEUE_CONFIGURATION_ERROR,
    };
  }
  if (outcome !== "sent") {
    const durable = parseDeliveryUncertainResult(
      await dependencies.outbox.recordDeliveryUncertain({
        ...attemptScope(claimed),
        cause: outcome,
      }),
    );
    return {
      status: durable.outcome,
      eventId: claimed.eventId,
      attemptId: claimed.attemptId,
      attemptNumber: durable.attemptNumber,
      cause: outcome,
    };
  }

  await dependencies.afterSend?.();
  const acknowledged = await dependencies.outbox.acknowledgeExact({
    eventId: claimed.eventId,
    attemptId: claimed.attemptId,
  });
  if (acknowledged !== true) {
    throw new Error("Project provisioning queue send succeeded but its outbox attempt is stale");
  }
  return { status: "published", eventId: claimed.eventId, attemptId: claimed.attemptId };
}

export function createProjectProvisioningPublisher(value: unknown): Readonly<{
  publishOne(): Promise<ProjectProvisioningPublishResult>;
}> {
  if (
    !isRecord(value) ||
    !isRecord(value["outbox"]) ||
    typeof value["outbox"]["recoverExpiredFinalProjectProvisioningClaim"] !== "function" ||
    typeof value["outbox"]["claimProjectProvisioningRequested"] !== "function" ||
    typeof value["outbox"]["acknowledgeExact"] !== "function" ||
    typeof value["outbox"]["recordDeliveryUncertain"] !== "function" ||
    typeof value["outbox"]["recordQueueConfigurationFailureExact"] !== "function" ||
    typeof value["outbox"]["failInvalidExact"] !== "function"
  ) {
    throw new TypeError("Project provisioning publisher requires an outbox binding");
  }
  if (!isRecord(value["queue"]) || typeof value["queue"]["send"] !== "function") {
    throw new TypeError("Project provisioning publisher requires a queue binding");
  }
  assertOperationalDuration(
    "queueSendTimeoutMilliseconds",
    value["queueSendTimeoutMilliseconds"] as number,
  );
  if (typeof value["classifyQueueError"] !== "function") {
    throw new TypeError("Project provisioning publisher requires a queue error classifier");
  }
  if (value["afterSend"] !== undefined && typeof value["afterSend"] !== "function") {
    throw new TypeError("Project provisioning publisher afterSend hook must be a function");
  }
  const dependencies = value as unknown as ProjectProvisioningPublisherDependencies;
  return Object.freeze({
    publishOne: publishOneProjectProvisioningRequest.bind(undefined, dependencies),
  });
}

export function deterministicProjectProvisioningWorkflowId(
  message: ProjectProvisioningMessageV1,
): string {
  return `project-provisioning-v1-${message.eventId}-${message.operationId}`;
}

export async function consumeProjectProvisioningMessage(
  dependencies: ProjectProvisioningConsumerDependencies,
  serializedMessage: string,
): Promise<ProjectProvisioningConsumptionResult> {
  const message = parseSerializedMessage(serializedMessage);
  const workflowId = deterministicProjectProvisioningWorkflowId(message);
  const outcome = await dependencies.workflow.execute({ workflowId, message });
  return handleWorkflowOutcome(dependencies, workflowId, message, outcome);
}

export function createProjectProvisioningConsumer(value: unknown): Readonly<{
  consume(serializedMessage: string): Promise<ProjectProvisioningConsumptionResult>;
}> {
  if (!isRecord(value) || !isRecord(value["workflow"])) {
    throw new TypeError("Project provisioning consumer requires a workflow binding");
  }
  if (typeof value["workflow"]["execute"] !== "function") {
    throw new TypeError("Project provisioning consumer requires a workflow binding");
  }
  if (
    !isRecord(value["completion"]) ||
    typeof value["completion"]["completeAtomic"] !== "function"
  ) {
    throw new TypeError("Project provisioning consumer requires an atomic completion binding");
  }
  if (!isRecord(value["failure"]) || typeof value["failure"]["failAtomic"] !== "function") {
    throw new TypeError("Project provisioning consumer requires an atomic failure binding");
  }
  if (
    !isRecord(value["reconciliation"]) ||
    typeof value["reconciliation"]["requireReconciliationAtomic"] !== "function"
  ) {
    throw new TypeError("Project provisioning consumer requires an atomic reconciliation binding");
  }
  const dependencies = value as unknown as ProjectProvisioningConsumerDependencies;
  return Object.freeze({
    consume: consumeProjectProvisioningMessage.bind(undefined, dependencies),
  });
}

async function completeProjectProvisioning(
  completion: ProjectProvisioningCompletionPort,
  workflowId: string,
  message: ProjectProvisioningMessageV1,
): Promise<ProjectProvisioningConsumptionResult> {
  const result = parseAtomicPersistenceResult(
    await completion.completeAtomic({ workflowId, message }),
    "completion",
  );
  return { status: "completed", workflowId, completion: result };
}

async function handleWorkflowOutcome(
  dependencies: Pick<
    ProjectProvisioningConsumerDependencies,
    "completion" | "failure" | "reconciliation"
  >,
  workflowId: string,
  message: ProjectProvisioningMessageV1,
  outcome: unknown,
): Promise<ProjectProvisioningConsumptionResult> {
  switch (outcome) {
    case "completed":
      return completeProjectProvisioning(dependencies.completion, workflowId, message);
    case "pending":
      return { status: "pending", workflowId };
    case "failed": {
      const failure = parseAtomicPersistenceResult(
        await dependencies.failure.failAtomic({ workflowId, message }),
        "failure",
      );
      return { status: "failed", workflowId, failure };
    }
    case "uncertain": {
      const reconciliation = parseAtomicPersistenceResult(
        await dependencies.reconciliation.requireReconciliationAtomic({
          workflowId,
          message,
        }),
        "reconciliation",
      );
      return { status: "reconciliation_required", workflowId, reconciliation };
    }
  }
  throw new TypeError("Project provisioning workflow returned an unsupported outcome");
}

function parseAtomicPersistenceResult(
  value: unknown,
  port: "completion" | "failure" | "reconciliation",
): "applied" | "duplicate" {
  if (value !== "applied" && value !== "duplicate") {
    throw new TypeError(`Project provisioning ${port} port returned an unsupported outcome`);
  }
  return value;
}

async function sendProjectProvisioningMessage(
  dependencies: ProjectProvisioningPublisherDependencies,
  message: ProjectProvisioningMessageV1,
): Promise<
  | "sent"
  | "timeout"
  | "uncertain"
  | "definitive_configuration"
  | ProjectProvisioningQueueContractViolation
> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve("timeout");
      controller.abort();
    }, dependencies.queueSendTimeoutMilliseconds);
  });
  const send = Promise.resolve()
    .then(() =>
      dependencies.queue.send(serializeProjectProvisioningMessageV1(message), {
        signal: controller.signal,
      }),
    )
    .then(parseQueueSendOutcome)
    .catch((error: unknown) => {
      const classification = dependencies.classifyQueueError(error);
      if (classification === "definitive_configuration") return classification;
      if (classification === "uncertain") return "uncertain" as const;
      return {
        cause: "classifier_contract_invalid",
        diagnosticCode: PROJECT_PROVISIONING_QUEUE_CLASSIFIER_CONTRACT_INVALID,
      } as const;
    });
  try {
    return await Promise.race([send, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function parseQueueSendOutcome(
  value: unknown,
): "sent" | "timeout" | "uncertain" | ProjectProvisioningQueueContractViolation {
  if (value === "sent" || value === "timeout" || value === "uncertain") return value;
  return {
    cause: "adapter_contract_invalid",
    diagnosticCode: PROJECT_PROVISIONING_QUEUE_ADAPTER_CONTRACT_INVALID,
  };
}

function parseDeliveryUncertainResult(value: unknown): {
  readonly outcome: "retry_scheduled" | "reconciliation_required";
  readonly attemptNumber: number;
} {
  if (
    !isRecord(value) ||
    (value["outcome"] !== "retry_scheduled" && value["outcome"] !== "reconciliation_required") ||
    !Number.isSafeInteger(value["attemptNumber"]) ||
    (value["attemptNumber"] as number) < 1
  ) {
    throw new TypeError("Project provisioning outbox returned an invalid uncertainty outcome");
  }
  return {
    outcome: value["outcome"],
    attemptNumber: value["attemptNumber"] as number,
  };
}

function messageFromClaim(
  claimed: ClaimedProjectProvisioningRequest,
): ProjectProvisioningMessageV1 {
  if (claimed.eventType !== "ProjectProvisioningRequested") {
    throw new TypeError("Project provisioning claim contains an unsupported event type");
  }
  const payload = parseProjectProvisioningOutboxPayload(claimed.payload);
  assertPayloadScope(claimed, payload);
  return parseProjectProvisioningMessageV1({
    version: 1,
    eventType: "ProjectProvisioningRequested",
    eventId: claimed.eventId,
    organizationId: claimed.organizationId,
    projectId: claimed.projectId,
    operationId: claimed.operationId,
  });
}

function attemptScope(claimed: ClaimedProjectProvisioningRequest): ProjectProvisioningAttemptScope {
  return {
    eventId: claimed.eventId,
    organizationId: claimed.organizationId,
    projectId: claimed.projectId,
    operationId: claimed.operationId,
    attemptId: claimed.attemptId,
    attemptNumber: claimed.attemptNumber,
    maxAttempts: claimed.maxAttempts,
  };
}

function parseSerializedMessage(serializedMessage: string): ProjectProvisioningMessageV1 {
  let value: unknown;
  try {
    value = JSON.parse(serializedMessage);
  } catch (error) {
    throw new TypeError("Project provisioning queue message must be valid JSON", { cause: error });
  }
  return parseProjectProvisioningMessageV1(value);
}

function assertPayloadScope(
  claimed: ClaimedProjectProvisioningRequest,
  payload: ProjectProvisioningOutboxPayload,
): void {
  if (claimed.projectId !== payload.projectId || claimed.operationId !== payload.operationId) {
    throw new TypeError("Project provisioning payload scope does not match its outbox claim");
  }
}

function parseMessageUlid(
  value: Readonly<Record<string, unknown>>,
  name: "eventId" | "organizationId" | "projectId" | "operationId",
): Ulid {
  const candidate = value[name];
  if (typeof candidate !== "string") {
    throw new TypeError(`Project provisioning message ${name} must be a canonical ULID`);
  }
  return parseUlid(candidate);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError("Project provisioning message contains unexpected fields");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
