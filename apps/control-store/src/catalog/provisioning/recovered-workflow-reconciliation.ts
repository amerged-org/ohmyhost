import { z } from "zod";
import { ulid, type CatalogContext } from "../common.js";
import { reconcileProductWorkflowOutcome } from "./deployment-reconciliation.js";

const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  outboxEventId: ulid,
  auditEventId: ulid,
  workflowId: z.string().min(1).max(255),
  attemptId: z.never().optional(),
  reconciliationAttemptId: ulid.optional(),
  replayAttemptId: ulid.optional(),
  actorId: z.string().min(1).max(255),
  errorCode: z.literal("WORKFLOW_TERMINAL_BEFORE_RECONCILIATION"),
  reconciledAt: z.string(),
  providerReconciliation: z.unknown().optional(),
});

/** The one original initial-terminal recovery caller; shared outcome SQL remains server-local and unchanged. */
export function reconcileRecoveredProductWorkflow(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw);
  const payload = Object.fromEntries(
    Object.entries(i).filter(([key]) => !["actorId", "errorCode", "attemptId"].includes(key)),
  );
  return reconcileProductWorkflowOutcome(
    context,
    { ...payload, bindingsOutdated: false },
    { actorId: i.actorId, errorCode: i.errorCode },
  );
}
