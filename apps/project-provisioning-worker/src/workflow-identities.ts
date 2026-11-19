import { parseUlid, type Ulid } from "@ohmyhost/platform";
import type { ProductCommandMessageV1 as Command } from "@ohmyhost/orchestrator";
import { deterministicUlid } from "./deterministic-ulid.js";

export async function completionCommon(
  workflowId: string,
  executionId: string,
  command: Command,
  now: () => Date,
) {
  const ids = await derivedIds(executionId);
  return {
    workflowId,
    ...reconciliationAttempt(workflowId, executionId),
    organizationId: command.organizationId,
    projectId: command.projectId,
    environmentId: command.environmentId,
    operationId: command.operationId,
    outboxEventId: command.eventId,
    startedOperationEventId: ids.startedOperationEventId,
    operationEventId: ids.operationEventId,
    auditEventId: ids.completionAuditEventId,
    actorId: "deployment-workflow",
    completedAt: canonicalDate(now),
  } as const;
}

export function reconciliationAttempt(
  workflowId: string,
  executionId: string,
): Readonly<{ reconciliationAttemptId?: Ulid; replayAttemptId?: Ulid }> {
  if (executionId === workflowId) return {};
  const reconciliationPrefix = "product-provider-reconcile-v1-";
  if (executionId.startsWith(reconciliationPrefix)) {
    return Object.freeze({
      reconciliationAttemptId: parseUlid(executionId.slice(reconciliationPrefix.length)),
    });
  }
  const replayPrefix = "product-command-replay-v1-";
  if (executionId.startsWith(replayPrefix)) {
    return Object.freeze({ replayAttemptId: parseUlid(executionId.slice(replayPrefix.length)) });
  }
  throw new TypeError("Product Workflow execution identity is invalid");
}

export async function derivedIds(seed: string): Promise<{
  startedOperationEventId: Ulid;
  operationEventId: Ulid;
  completionAuditEventId: Ulid;
  reconciliationAuditEventId: Ulid;
}> {
  return {
    startedOperationEventId: await deterministicUlid(`${seed}:operation-started-event`),
    operationEventId: await deterministicUlid(`${seed}:operation-event`),
    completionAuditEventId: await deterministicUlid(`${seed}:completion-audit-event`),
    reconciliationAuditEventId: await deterministicUlid(`${seed}:reconciliation-audit-event`),
  };
}

export function canonicalDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new TypeError("Scheduled cleanup clock is invalid");
  return value.toISOString();
}
