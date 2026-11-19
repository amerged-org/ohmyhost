import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { ProjectExportBinding } from "./project-exports.js";
import { ProductSurfaceUnavailableError } from "./product-surface.js";

interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
}
interface Attempt extends Scope {
  readonly eventId: string;
  readonly attemptId: string;
}
type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "absent";
interface Runtime {
  prepareProjectRecoveryDispatch(
    input: unknown,
  ): Promise<{ status: Status; command: unknown | null }>;
  readProjectRecoveryState(input: Scope): Promise<{ status: Status } | null>;
  acknowledgeProjectRecoveryOutbox(input: Attempt): Promise<boolean>;
  recordProjectRecoveryDispatchFailure(input: unknown): Promise<{
    outcome:
      | "waiting"
      | "acknowledged"
      | "claim_changed"
      | "retry_scheduled"
      | "reconciliation_required";
  }>;
}
interface Maintenance {
  prepareProjectRecoveryMaintenance(input: { auditEventId: string }): Promise<{
    cleared: number;
    terminal: Attempt | null;
    expired: (Scope & { dispatchFailed: boolean })[];
    dueNativeArchivePurges?: (Scope & { exportId: string })[];
  }>;
  claimProjectRecoveryOutbox(input: {
    attemptId: string;
  }): Promise<(Attempt & { attemptNumber: number; maxAttempts: number }) | null>;
}
function bound<T>(value: unknown): T {
  if (
    value === undefined ||
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    throw new ProductSurfaceUnavailableError();
  return value as T;
}

/** The actual original bounded recovery dispatch loop, over closed capabilities. Provider invocation stays outside
 * authoritative writes; the exhausted job transition and delivery failure are one backend D1 command/batch. No SQL
 * configuration, time supplied to a global drain, or error-driven fallback is reachable here. */
export async function dispatchD1ProjectRecovery(input: {
  readonly runtime: unknown;
  readonly maintenance: unknown;
  readonly clock: Clock;
  readonly ids: Pick<UlidFactory, "next">;
  readonly uuid: () => string;
  readonly binding?: ProjectExportBinding;
}) {
  const runtime = bound<Runtime>(input.runtime),
    maintenance = bound<Maintenance>(input.maintenance);
  const preparedMaintenance = await maintenance.prepareProjectRecoveryMaintenance({
    auditEventId: input.ids.next(),
  });
  const { cleared, terminal } = preparedMaintenance;
  if (terminal !== null) {
    const acknowledged = await runtime.acknowledgeProjectRecoveryOutbox(terminal);
    return {
      status: acknowledged ? ("acknowledged" as const) : ("claim_changed" as const),
      operationId: terminal.operationId,
      cleared,
    };
  }
  const mutation = (scope: Scope) => ({
    ...scope,
    claimId: input.uuid(),
    occurredAt: input.clock.now().toISOString(),
    operationEventId: input.ids.next(),
    auditEventId: input.ids.next(),
    terminalOperationEventId: input.ids.next(),
    terminalAuditEventId: input.ids.next(),
  });
  for (const job of preparedMaintenance.expired) {
    const scope = {
      organizationId: job.organizationId,
      projectId: job.projectId,
      operationId: job.operationId,
    };
    await runtime.prepareProjectRecoveryDispatch({
      ...mutation(scope),
      ...(job.dispatchFailed ? { failureCode: "RECOVERY_DISPATCH_FAILED" } : {}),
    });
  }
  if (input.binding === undefined) return { status: "disabled" as const, cleared };
  // Core selects a bounded due effect and rechecks its expiry on every private purge request.
  // A failed or unknown invocation remains due; the next maintenance pass retries it.
  for (const purge of preparedMaintenance.dueNativeArchivePurges ?? []) {
    try {
      await input.binding.invokeRecovery({ action: "purge", ...purge });
    } catch {
      // Retain the durable effect for the next pass; do not infer object absence.
    }
  }
  const event = await maintenance.claimProjectRecoveryOutbox({ attemptId: input.ids.next() });
  if (event === null) return { status: "idle" as const, cleared };
  const scope = {
    organizationId: event.organizationId,
    projectId: event.projectId,
    operationId: event.operationId,
  };
  let errorCode = "RECOVERY_DISPATCH_INCOMPLETE";
  try {
    const prepared = await runtime.prepareProjectRecoveryDispatch(mutation(scope));
    if (prepared.command !== null) {
      const response = await input.binding.invokeRecovery(prepared.command);
      if (
        typeof response !== "object" ||
        response === null ||
        Array.isArray(response) ||
        Object.keys(response).join(",") !== "status" ||
        !["absent", "queued", "running", "succeeded", "failed", "cancelled"].includes(
          String(Reflect.get(response, "status")),
        )
      )
        throw new Error("Invalid executor response");
    }
  } catch {
    errorCode = "RECOVERY_DISPATCH_UNAVAILABLE";
  }
  const state = await runtime.readProjectRecoveryState(scope);
  if (state !== null && ["succeeded", "failed", "cancelled"].includes(state.status)) {
    const acknowledged = await runtime.acknowledgeProjectRecoveryOutbox({
      ...scope,
      eventId: event.eventId,
      attemptId: event.attemptId,
    });
    return {
      status: acknowledged ? ("acknowledged" as const) : ("claim_changed" as const),
      operationId: scope.operationId,
      cleared,
    };
  }
  const failure = await runtime.recordProjectRecoveryDispatchFailure({
    ...mutation(scope),
    eventId: event.eventId,
    attemptId: event.attemptId,
    deliveryAuditEventId: input.ids.next(),
    errorCode,
  });
  return { status: failure.outcome, operationId: scope.operationId, cleared };
}
