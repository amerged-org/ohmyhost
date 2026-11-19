import {
  deterministicProductCommandWorkflowId,
  projectProductCommandMessage,
  type ProductCommandClaimPort,
  type ProductCommandIntentProjection,
  type ProjectProvisioningOutboxPort,
  type ProjectProvisioningMessageV1,
} from "@ohmyhost/orchestrator";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import type { ClaimedOutboxEvent } from "@ohmyhost/database/provisioning-persistence";
import type { ProjectProvisioningWorkflowPersistence } from "./runtime-types.js";
import type {
  ManagedSourceStatePort,
  ManagedSourcePublicationMessageV1,
  InitializationState,
  PublicationState,
} from "./managed-source-jobs.js";

export interface DispatchClaim {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly billingEpochId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}
interface ClaimInput {
  readonly attemptId: string;
  readonly now: string;
}
interface RecoverInput {
  readonly auditEventId: string;
  readonly now: string;
}
interface ExactInput {
  readonly eventId: string;
  readonly attemptId: string;
}
interface FailureInput extends ExactInput {
  readonly auditEventId: string;
  readonly failedAt: string;
  readonly errorCode: string;
  readonly cause?: string;
}
interface Recovery {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
}
interface Failure {
  readonly outcome: "retry_scheduled" | "reconciliation_required";
  readonly attemptNumber: number;
}
export interface ProjectDispatchRuntimeBinding {
  claimProvisioningDispatch(input: ClaimInput): Promise<DispatchClaim | null>;
  recoverProvisioningDispatch(input: RecoverInput): Promise<Recovery | null>;
  acknowledgeProvisioningDispatch(input: ExactInput & { readonly now: string }): Promise<boolean>;
  failProvisioningDispatch(
    input: FailureInput,
  ): Promise<Failure | { readonly attemptNumber: number } | null>;
  claimProductDispatch(input: ClaimInput): Promise<DispatchClaim | null>;
  recoverProductDispatch(input: RecoverInput): Promise<Recovery | null>;
  acknowledgeProductDispatch(input: ExactInput & { readonly now: string }): Promise<boolean>;
  failProductDispatch(input: FailureInput): Promise<Failure | null>;
  claimManagedSourceDispatch(input: ClaimInput): Promise<DispatchClaim | null>;
  recoverManagedSourceDispatch(input: RecoverInput): Promise<Recovery | null>;
  /** Ends one managed publication whose dispatch exhausted; false when none is pending. */
  sweepExhaustedManagedSourceDispatch(input: { readonly now: string }): Promise<boolean>;
  acknowledgeManagedSourceDispatch(input: ExactInput & { readonly now: string }): Promise<boolean>;
  failManagedSourceDispatch(input: FailureInput): Promise<Failure | null>;
  recoverProductExecutionLease(input: { readonly now: string }): Promise<unknown | null>;
  acceptProductDispatch(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly operationId: string;
    readonly eventId: string;
    readonly attemptId: string;
    readonly workflowId: string;
    readonly acceptedAt: string;
  }): Promise<ProductCommandIntentProjection>;
  readProductDispatchIntent(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly operationId: string;
  }): Promise<ProductCommandIntentProjection | null>;
  readManagedSourceDispatchState(
    input: ManagedSourcePublicationMessageV1,
  ): Promise<
    | ({ readonly kind: "initialization" } & InitializationState)
    | ({ readonly kind: "publication" } & PublicationState)
  >;
}
interface Transition {
  readonly eventId: string;
  readonly auditEventId: string;
  readonly occurredAt: string;
}
interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly requestEventId: string;
  readonly workflowId: string;
  readonly serviceActorId: string;
}
export interface ProjectWorkflowRuntimeBinding {
  completeProjectProvisioningHello(
    input: Scope & { readonly started: Transition; readonly succeeded: Transition },
  ): Promise<"applied" | "duplicate">;
  failProjectProvisioningHello(
    input: Scope & {
      readonly started: Transition;
      readonly failed: Transition;
      readonly failure: { readonly code: string; readonly message: string };
    },
  ): Promise<"applied" | "duplicate">;
  reconcileProjectProvisioningHello(
    input: Scope & { readonly auditEventId: string; readonly occurredAt: string },
  ): Promise<"applied" | "duplicate">;
}
export function createCoreProvisioningPersistence(
  binding: ProjectWorkflowRuntimeBinding,
  clock: Clock,
  ids: UlidFactory,
): ProjectProvisioningWorkflowPersistence & {
  readonly reconciliation: {
    requireReconciliationAtomic(input: {
      readonly workflowId: string;
      readonly message: ProjectProvisioningMessageV1;
    }): Promise<"applied" | "duplicate">;
  };
} {
  const scope = (workflowId: string, message: ProjectProvisioningMessageV1): Scope => ({
    organizationId: message.organizationId,
    projectId: message.projectId,
    operationId: message.operationId,
    requestEventId: message.eventId,
    workflowId,
    serviceActorId: "project-provisioning-worker",
  });
  const steps = () => {
    const now = clock.now(),
      next = new Date(now.getTime() + 1);
    return {
      first: { eventId: ids.next(), auditEventId: ids.next(), occurredAt: now.toISOString() },
      second: { eventId: ids.next(), auditEventId: ids.next(), occurredAt: next.toISOString() },
    };
  };
  return Object.freeze<ReturnType<typeof createCoreProvisioningPersistence>>({
    completion: {
      completeAtomic: ({ workflowId, message }) => {
        const s = steps();
        return binding.completeProjectProvisioningHello({
          ...scope(workflowId, message),
          started: s.first,
          succeeded: s.second,
        });
      },
    },
    failure: {
      failAtomic: ({ workflowId, message }) => {
        const s = steps();
        return binding.failProjectProvisioningHello({
          ...scope(workflowId, message),
          started: s.first,
          failed: s.second,
          failure: {
            code: "PROJECT_PROVISIONING_WORKFLOW_FAILED",
            message: "Project provisioning workflow failed",
          },
        });
      },
    },
    reconciliation: {
      requireReconciliationAtomic: ({ workflowId, message }) =>
        binding.reconcileProjectProvisioningHello({
          ...scope(workflowId, message),
          auditEventId: ids.next(),
          occurredAt: clock.now().toISOString(),
        }),
    },
  });
}
function claimed(value: DispatchClaim): ClaimedOutboxEvent {
  return {
    ...value,
    eventId: parseUlid(value.eventId),
    organizationId: parseUlid(value.organizationId),
    projectId: parseUlid(value.projectId),
    operationId: parseUlid(value.operationId),
    billingEpochId: parseUlid(value.billingEpochId),
    attemptId: parseUlid(value.attemptId),
    claimedAt: value.claimedAt,
    leaseExpiresAt: value.leaseExpiresAt,
  };
}
export function createCoreProvisioningOutbox(
  binding: ProjectDispatchRuntimeBinding,
  clock: Clock,
  ids: UlidFactory,
): ProjectProvisioningOutboxPort {
  const fail = async (input: ExactInput, errorCode: string, cause?: string) =>
    binding.failProvisioningDispatch({
      eventId: input.eventId,
      attemptId: input.attemptId,
      errorCode,
      ...(cause === undefined ? {} : { cause }),
      failedAt: clock.now().toISOString(),
      auditEventId: ids.next(),
    });
  return Object.freeze<ProjectProvisioningOutboxPort>({
    recoverExpiredFinalProjectProvisioningClaim: async () => {
      const r = await binding.recoverProvisioningDispatch({
        now: clock.now().toISOString(),
        auditEventId: ids.next(),
      });
      return r === null
        ? null
        : {
            ...r,
            eventId: parseUlid(r.eventId),
            organizationId: parseUlid(r.organizationId),
            projectId: parseUlid(r.projectId),
            operationId: parseUlid(r.operationId),
            attemptId: parseUlid(r.attemptId),
          };
    },
    claimProjectProvisioningRequested: async () => {
      const r = await binding.claimProvisioningDispatch({
        now: clock.now().toISOString(),
        attemptId: ids.next(),
      });
      if (r === null) return null;
      if (r.eventType !== "ProjectProvisioningRequested")
        throw new TypeError("Unsupported provisioning dispatch");
      return { ...claimed(r), eventType: "ProjectProvisioningRequested" as const };
    },
    acknowledgeExact: (input) =>
      binding.acknowledgeProvisioningDispatch({ ...input, now: clock.now().toISOString() }),
    recordDeliveryUncertain: async (input) => {
      const code = deliveryErrorCode(input);
      const r = await fail(input, code, input.cause);
      if (!r || !("outcome" in r)) throw new Error("Provisioning dispatch attempt is stale");
      return r;
    },
    recordQueueConfigurationFailureExact: async (input) => {
      const r = await fail(input, input.errorCode);
      if (r && !("outcome" in r)) throw new TypeError("Provisioning failure result is invalid");
      return r;
    },
    failInvalidExact: async (input) => (await fail(input, input.errorCode)) !== null,
  });
}
export function createCoreProductClaims(
  binding: ProjectDispatchRuntimeBinding,
  clock: Clock,
  ids: UlidFactory,
): ProductCommandClaimPort {
  return Object.freeze<ProductCommandClaimPort>({
    claim: async () => {
      const r = await binding.claimProductDispatch({
        now: clock.now().toISOString(),
        attemptId: ids.next(),
      });
      if (r === null) return null;
      const payload = r.payload;
      if (
        Object.keys(payload).join(",") !== "environmentId" ||
        typeof payload["environmentId"] !== "string"
      )
        throw new TypeError("Product dispatch payload must contain only environmentId");
      const environmentId = parseUlid(payload["environmentId"]);
      const current = await binding.readProductDispatchIntent({
        organizationId: r.organizationId,
        projectId: r.projectId,
        environmentId,
        operationId: r.operationId,
      });
      if (current === null) throw new Error("Claimed product command has no immutable intent");
      const message = projectProductCommandMessage(r, current);
      const intent = await binding.acceptProductDispatch({
        organizationId: r.organizationId,
        projectId: r.projectId,
        environmentId,
        operationId: r.operationId,
        eventId: r.eventId,
        attemptId: r.attemptId,
        workflowId: deterministicProductCommandWorkflowId(message),
        acceptedAt: r.claimedAt,
      });
      if (intent.eventType !== r.eventType)
        throw new TypeError("Product intent event type differs");
      return { ...r, message: projectProductCommandMessage(r, intent) };
    },
    acknowledgeExact: (input) =>
      binding.acknowledgeProductDispatch({ ...input, now: clock.now().toISOString() }),
    recoverExpiredFinalClaim: async () =>
      (await binding.recoverProductDispatch({
        now: clock.now().toISOString(),
        auditEventId: ids.next(),
      })) !== null,
    recordDeliveryFailure: async (input) => {
      const r = await binding.failProductDispatch({
        eventId: input.eventId,
        attemptId: input.attemptId,
        errorCode: "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN",
        failedAt: clock.now().toISOString(),
        auditEventId: ids.next(),
      });
      if (r === null) throw new Error("Product dispatch attempt is stale");
      return r.outcome;
    },
  });
}
export function createCoreManagedSourceState(
  binding: Pick<ProjectDispatchRuntimeBinding, "readManagedSourceDispatchState">,
): ManagedSourceStatePort {
  return {
    readInitialization: async (message) => {
      const result = await binding.readManagedSourceDispatchState(message);
      if (result.kind !== "initialization")
        throw new TypeError("Managed source state family differs");
      return {
        state: result.state,
        childOperationId: result.childOperationId,
        handoff: result.handoff,
        childState: result.childState,
        childOperationState: result.childOperationState,
      };
    },
    readPublication: async (message) => {
      const result = await binding.readManagedSourceDispatchState(message);
      if (result.kind !== "publication") throw new TypeError("Managed source state family differs");
      return {
        state: result.state,
        operationState: result.operationState,
        initializationState: result.initializationState,
      };
    },
  };
}

function deliveryErrorCode(
  input: Parameters<ProjectProvisioningOutboxPort["recordDeliveryUncertain"]>[0],
): string {
  if (input.cause === "timeout") return "PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT";
  if (input.cause === "uncertain") return "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN";
  if ("diagnosticCode" in input) return input.diagnosticCode;
  throw new TypeError("Provisioning uncertainty is invalid");
}
