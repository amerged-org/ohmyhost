import { parseUlid, type Ulid } from "@ohmyhost/platform";
import { parseProjectHandle } from "@ohmyhost/project-handles";

interface ProductCommandScopeV1 {
  readonly version: 1;
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}

export interface SourceLinkRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "SourceLinkRequestedV1";
}

export interface DeploymentRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "DeploymentRequestedV1";
  readonly planId: Ulid;
}

export interface DeploymentRollbackRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "DeploymentRollbackRequestedV1";
}

export interface DeploymentPromotionRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "DeploymentPromotionRequestedV1";
}

/** A customer chose a new address for the project; both gateways move before it is stored. */
export interface ProjectHandleChangeRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "ProjectHandleChangeRequestedV1";
  readonly requestedHandle: string;
}

export interface ProjectDeletionRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "ProjectDeletionRequestedV1";
}

export type ProjectDataChangeKind =
  | "isolate_prod_keeps_data"
  | "isolate_dev_keeps_data"
  | "share_prod_keeps_data"
  | "reset_dev";

export interface ProjectDataChangeRequestedV1 extends ProductCommandScopeV1 {
  readonly eventType: "ProjectDataChangeRequestedV1";
  readonly dataChange: ProjectDataChangeKind;
}

export type ProductCommandMessageV1 =
  | SourceLinkRequestedV1
  | DeploymentRequestedV1
  | DeploymentRollbackRequestedV1
  | DeploymentPromotionRequestedV1
  | ProjectHandleChangeRequestedV1
  | ProjectDeletionRequestedV1
  | ProjectDataChangeRequestedV1;

export interface ProductCommandClaimScope {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly billingEpochId: string;
}

export interface ProductCommandIntentProjection {
  readonly eventType: ProductCommandMessageV1["eventType"];
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly billingEpochId: string;
  readonly planId: string | null;
  readonly requestedHandle?: string | null;
  readonly dataChange?: ProjectDataChangeKind | null;
}

export interface ProductCommandWorkflowPort {
  execute(input: {
    readonly workflowId: string;
    readonly message: ProductCommandMessageV1;
  }): Promise<"completed" | "pending" | "uncertain">;
}

export interface ProductCommandClaimPort {
  claim(): Promise<{
    readonly message: ProductCommandMessageV1;
    readonly eventId: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly maxAttempts: number;
  } | null>;
  acknowledgeExact(input: {
    readonly eventId: string;
    readonly attemptId: string;
  }): Promise<boolean>;
  recoverExpiredFinalClaim(): Promise<boolean>;
  recordDeliveryFailure(input: {
    readonly eventId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly maxAttempts: number;
  }): Promise<"retry_scheduled" | "reconciliation_required">;
}

export interface ProductCommandQueuePort {
  send(
    serializedMessage: string,
    options: { readonly signal: AbortSignal },
  ): Promise<"sent" | "timeout" | "uncertain">;
}

export type ProductCommandConsumptionResult =
  | {
      readonly status: "completed";
      readonly workflowId: string;
      readonly durable: "workflow_terminal";
    }
  | { readonly status: "pending"; readonly workflowId: string };

const scopeKeys = [
  "version",
  "eventType",
  "eventId",
  "organizationId",
  "projectId",
  "billingEpochId",
  "environmentId",
  "operationId",
] as const;

export function parseProductCommandMessageV1(value: unknown): ProductCommandMessageV1 {
  if (!isRecord(value)) throw new TypeError("Product command message must be an object");
  if (value["version"] !== 1) throw new TypeError("Product command message version must be 1");
  const scope = parseScope(value);
  switch (value["eventType"]) {
    case "SourceLinkRequestedV1":
      assertExactKeys(value, scopeKeys);
      return Object.freeze({ ...scope, eventType: "SourceLinkRequestedV1" });
    case "DeploymentRequestedV1":
      assertExactKeys(value, [...scopeKeys, "planId"]);
      return Object.freeze({
        ...scope,
        eventType: "DeploymentRequestedV1",
        planId: parseField(value, "planId"),
      });
    case "DeploymentRollbackRequestedV1":
      assertExactKeys(value, scopeKeys);
      return Object.freeze({
        ...scope,
        eventType: "DeploymentRollbackRequestedV1",
      });
    case "ProjectHandleChangeRequestedV1":
      assertExactKeys(value, [...scopeKeys, "requestedHandle"]);
      return Object.freeze({
        ...scope,
        eventType: "ProjectHandleChangeRequestedV1",
        requestedHandle: parseProjectHandle(value["requestedHandle"]),
      });
    case "DeploymentPromotionRequestedV1":
      assertExactKeys(value, scopeKeys);
      return Object.freeze({
        ...scope,
        eventType: "DeploymentPromotionRequestedV1",
      });
    case "ProjectDeletionRequestedV1":
      assertExactKeys(value, scopeKeys);
      return Object.freeze({
        ...scope,
        eventType: "ProjectDeletionRequestedV1",
      });
    case "ProjectDataChangeRequestedV1": {
      assertExactKeys(value, [...scopeKeys, "dataChange"]);
      const change = value["dataChange"];
      if (
        change !== "isolate_prod_keeps_data" &&
        change !== "isolate_dev_keeps_data" &&
        change !== "share_prod_keeps_data" &&
        change !== "reset_dev"
      )
        throw new TypeError("Product data change kind is unsupported");
      return Object.freeze({
        ...scope,
        eventType: "ProjectDataChangeRequestedV1",
        dataChange: change,
      });
    }
    default:
      throw new TypeError("Product command message event type is unsupported");
  }
}

export function serializeProductCommandMessageV1(message: ProductCommandMessageV1): string {
  return JSON.stringify(parseProductCommandMessageV1(message));
}

export function projectProductCommandMessage(
  claim: ProductCommandClaimScope,
  intent: ProductCommandIntentProjection,
): ProductCommandMessageV1 {
  const eventId = parseUlid(claim.eventId);
  const organizationId = parseUlid(claim.organizationId);
  const projectId = parseUlid(claim.projectId);
  const operationId = parseUlid(claim.operationId);
  const billingEpochId = parseUlid(claim.billingEpochId);
  if (
    claim.organizationId !== intent.organizationId ||
    claim.projectId !== intent.projectId ||
    claim.operationId !== intent.operationId ||
    claim.billingEpochId !== intent.billingEpochId
  ) {
    throw new TypeError("Product command intent does not match the claimed outbox scope");
  }
  const common = {
    version: 1 as const,
    eventId,
    organizationId,
    projectId,
    billingEpochId,
    environmentId: parseUlid(intent.environmentId),
    operationId,
  };
  if (intent.eventType === "DeploymentRequestedV1") {
    if (intent.planId === null) throw new TypeError("Deployment intent requires its plan locator");
    return parseProductCommandMessageV1({
      ...common,
      eventType: "DeploymentRequestedV1",
      planId: parseUlid(intent.planId),
    });
  }
  if (intent.planId !== null)
    throw new TypeError("Only deployment intent may contain a plan locator");
  if (intent.eventType === "ProjectHandleChangeRequestedV1") {
    if (intent.requestedHandle === null || intent.requestedHandle === undefined) {
      throw new TypeError("A rename intent requires the requested address");
    }
    return parseProductCommandMessageV1({
      ...common,
      eventType: "ProjectHandleChangeRequestedV1",
      requestedHandle: intent.requestedHandle,
    });
  }
  if (intent.requestedHandle !== null && intent.requestedHandle !== undefined) {
    throw new TypeError("Only a rename intent may contain a requested address");
  }
  if (intent.eventType === "ProjectDataChangeRequestedV1") {
    return parseProductCommandMessageV1({
      ...common,
      eventType: intent.eventType,
      dataChange: intent.dataChange,
    });
  }
  if (intent.dataChange !== null && intent.dataChange !== undefined)
    throw new TypeError("Only a data change intent may contain a data change kind");
  return parseProductCommandMessageV1({ ...common, eventType: intent.eventType });
}

export function deterministicProductCommandWorkflowId(message: ProductCommandMessageV1): string {
  const parsed = parseProductCommandMessageV1(message);
  return `product-command-v1-${workflowKind(parsed.eventType)}-${parsed.eventId}-${parsed.operationId}`;
}

function workflowKind(eventType: ProductCommandMessageV1["eventType"]): string {
  switch (eventType) {
    case "SourceLinkRequestedV1":
      return "source-link";
    case "DeploymentRequestedV1":
      return "deploy";
    case "DeploymentRollbackRequestedV1":
      return "rollback";
    case "DeploymentPromotionRequestedV1":
      return "promotion";
    case "ProjectHandleChangeRequestedV1":
      return "handle-change";
    case "ProjectDeletionRequestedV1":
      return "delete";
    case "ProjectDataChangeRequestedV1":
      return "data-change";
  }
}

export function createProductCommandConsumer(value: unknown): Readonly<{
  consume(serializedMessage: string): Promise<ProductCommandConsumptionResult>;
}> {
  if (!isRecord(value) || typeof value["execute"] !== "function") {
    throw new TypeError("Product command consumer requires a Workflow binding");
  }
  const workflow = value as unknown as ProductCommandWorkflowPort;
  return Object.freeze({
    consume: async (serializedMessage: string): Promise<ProductCommandConsumptionResult> => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(serializedMessage);
      } catch {
        throw new TypeError("Product command Queue message must be valid JSON");
      }
      const message = parseProductCommandMessageV1(decoded);
      const workflowId = deterministicProductCommandWorkflowId(message);
      const outcome = await workflow.execute({ workflowId, message });
      if (outcome === "completed") {
        return { status: "completed", workflowId, durable: "workflow_terminal" };
      }
      if (outcome === "pending" || outcome === "uncertain")
        return { status: "pending", workflowId };
      throw new TypeError("Product command Workflow returned an unsupported outcome");
    },
  });
}

export function createProductCommandPublisher(dependencies: {
  readonly claims: ProductCommandClaimPort;
  readonly queue: ProductCommandQueuePort;
}): Readonly<{
  publishOne(): Promise<{
    readonly status: "idle" | "published" | "retry_scheduled" | "reconciliation_required";
  }>;
}> {
  if (
    !isRecord(dependencies) ||
    !isRecord(dependencies.claims) ||
    typeof dependencies.claims.claim !== "function" ||
    typeof dependencies.claims.acknowledgeExact !== "function" ||
    typeof dependencies.claims.recoverExpiredFinalClaim !== "function" ||
    typeof dependencies.claims.recordDeliveryFailure !== "function" ||
    !isRecord(dependencies.queue) ||
    typeof dependencies.queue.send !== "function"
  ) {
    throw new TypeError("Product command publisher dependencies are invalid");
  }
  return Object.freeze({
    publishOne: async () => {
      if (await dependencies.claims.recoverExpiredFinalClaim())
        return { status: "reconciliation_required" as const };
      const claimed = await dependencies.claims.claim();
      if (claimed === null) return { status: "idle" as const };
      const serialized = serializeProductCommandMessageV1(claimed.message);
      try {
        if (
          (await dependencies.queue.send(serialized, { signal: new AbortController().signal })) !==
          "sent"
        )
          throw new TypeError("Product command Queue returned an unsupported outcome");
      } catch {
        const status = await dependencies.claims.recordDeliveryFailure(claimed);
        return { status };
      }
      const acknowledged = await dependencies.claims.acknowledgeExact({
        eventId: claimed.eventId,
        attemptId: claimed.attemptId,
      });
      if (!acknowledged) throw new Error("Product command outbox delivery attempt is stale");
      return { status: "published" as const };
    },
  });
}

function parseScope(value: Readonly<Record<string, unknown>>): ProductCommandScopeV1 {
  return {
    version: 1,
    eventId: parseField(value, "eventId"),
    organizationId: parseField(value, "organizationId"),
    projectId: parseField(value, "projectId"),
    billingEpochId: parseField(value, "billingEpochId"),
    environmentId: parseField(value, "environmentId"),
    operationId: parseField(value, "operationId"),
  };
}

function parseField(value: Readonly<Record<string, unknown>>, key: string): Ulid {
  if (typeof value[key] !== "string") throw new TypeError(`Product command ${key} must be a ULID`);
  return parseUlid(value[key]);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError("Product command message contains unsupported fields");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
