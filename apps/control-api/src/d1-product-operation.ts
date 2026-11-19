import { z } from "zod";
import { parseUlid, parseOperationResult, type Ulid } from "@ohmyhost/platform";
import { parseOperationFailureDiagnostic } from "@ohmyhost/contracts/operation-failure";
import type { ControlApiPersistence, OperationView } from "./contracts.js";
import { recoveryOperationView } from "./d1-recovery-operation.js";
/** One complete serving read, with no SQL, clocks, callbacks or mutation authority. */
export interface D1ProductOperationRuntime {
  readApiProductOperation(input: unknown): Promise<unknown>;
}
const id = z.string().transform(parseUlid),
  instant = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  failure = z.strictObject({
    code: z.string().refine((v) => v.trim() !== ""),
    message: z.string().refine((v) => v.trim() !== ""),
  });
const event = z.strictObject({
  eventId: id,
  operationId: id,
  projectId: id,
  revision: z.number().int().nonnegative(),
  type: z.enum([
    "OperationQueued",
    "OperationStarted",
    "OperationSucceeded",
    "OperationFailed",
    "OperationCancelled",
  ]),
  idempotencyKey: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: instant,
});
const observed = z.strictObject({
  buildCompletedAt: instant.optional(),
  deploymentId: id,
  projectId: id,
  phase: z.enum(["queued", "building", "publishing"]),
  mailRequired: z.boolean(),
});
const wire = z.strictObject({
  operation: z.strictObject({
    organizationId: id,
    operationId: id,
    projectId: id,
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    failure: failure.nullable(),
    createdAt: instant,
    updatedAt: instant,
    events: z.array(event),
  }),
  failureDiagnostic: z.unknown(),
  deploymentId: id.nullable(),
  blockingOperationId: id.nullable(),
  reconciliation: z
    .strictObject({
      state: z.enum(["required", "pending"]),
      attempt_id: id.nullable(),
      observed_at: instant,
    })
    .nullable(),
  deploymentObservation: observed.nullable(),
});
function assertNativeEvent(
  e: z.output<typeof event>,
  operationId: Ulid,
  projectId: Ulid,
  index: number,
): void {
  if (e.operationId !== operationId || e.projectId !== projectId || e.revision !== index)
    throw new Error("Product operation event scope is inconsistent");
  const keys = Object.keys(e.payload).sort().join(",");
  if (e.type === "OperationQueued") {
    if (e.idempotencyKey !== null || keys !== "")
      throw new TypeError("Queued operation event payload is invalid");
    return;
  }
  if (e.idempotencyKey === null)
    throw new TypeError("Operation transition idempotency key is required");
  if (e.type === "OperationFailed") {
    if (keys !== "failure") throw new TypeError("Operation failure payload is invalid");
    failure.parse(e.payload["failure"]);
    return;
  }
  if (e.type === "OperationSucceeded") {
    if (keys !== "" && keys !== "result")
      throw new TypeError("Operation result payload is invalid");
    if (keys === "result") parseOperationResult(e.payload["result"]);
    return;
  }
  if (keys !== "") throw new TypeError("Operation transition payload is invalid");
}
/** Rehydrates the full original immutable events before adding deployment/reconciliation observations. */
export function productOperationView(
  raw: unknown,
  organizationId: Ulid,
  operationId: Ulid,
): OperationView {
  const r = wire.parse(raw),
    s = r.operation;
  if (s.organizationId !== organizationId || s.operationId !== operationId)
    throw new Error("Product operation response escaped its requested scope");
  s.events.forEach((e, index) => assertNativeEvent(e, operationId, s.projectId, index));
  const operation = recoveryOperationView(s, null),
    diagnostic = parseOperationFailureDiagnostic(r.failureDiagnostic),
    open = operation.state === "queued" || operation.state === "running";
  if (
    !open &&
    (r.blockingOperationId !== null ||
      r.reconciliation !== null ||
      r.deploymentObservation !== null)
  )
    throw new Error("Terminal operation has an open-state observation");
  const deployment = r.deploymentObservation;
  if (deployment !== null) {
    if (
      deployment.projectId !== operation.projectId ||
      deployment.deploymentId !== r.deploymentId ||
      (operation.state === "queued" && deployment.phase !== "queued") ||
      (operation.state === "running" &&
        (deployment.phase === "queued" ||
          (deployment.buildCompletedAt !== undefined && deployment.phase !== "publishing")))
    )
      throw new Error("Deployment observation scope is inconsistent");
  }
  return {
    ...operation,
    ...(diagnostic === null ? {} : { failureDiagnostic: diagnostic }),
    ...(r.deploymentId === null ? {} : { deploymentId: r.deploymentId }),
    ...(r.blockingOperationId === null ? {} : { blockingOperationId: r.blockingOperationId }),
    ...(r.reconciliation === null ? {} : { reconciliation: r.reconciliation }),
    ...(deployment === null ? {} : { deploymentObservation: deployment }),
  };
}
export function createD1ProductOperationReader(
  runtime: D1ProductOperationRuntime,
): ControlApiPersistence["getOperation"] {
  if (typeof runtime?.readApiProductOperation !== "function")
    throw new Error("product_operation_binding_required");
  return async (organizationId, operationId) => {
    const raw = await runtime.readApiProductOperation({ organizationId, operationId });
    return raw === null ? null : productOperationView(raw, organizationId, operationId);
  };
}
