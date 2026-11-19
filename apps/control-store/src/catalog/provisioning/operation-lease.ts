import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import { routeOrganization, ulid, fenceRaceGuard, type CatalogContext } from "../common.js";

const input = z.strictObject({
  organizationId: ulid,
  operationId: ulid,
  workflowId: z.string(),
  physicalWorkflowId: z.string(),
  now: z.string().refine((v) => {
    const n = Date.parse(v);
    return Number.isFinite(n) && new Date(n).toISOString() === v;
  }),
  durationMilliseconds: z.number().int().min(900_000).max(4_500_000),
});
const ACTIVE = `SELECT 1 FROM operations operation JOIN product_workflow_runs run
 ON run.organization_id=operation.organization_id AND run.operation_id=operation.operation_id
 WHERE operation.organization_id=?1 AND operation.operation_id=?2 AND run.workflow_id=?5 AND run.state='queued'
 AND ?6=CASE WHEN run.active_reconciliation_attempt_id IS NOT NULL
 THEN 'product-provider-reconcile-v1-'||run.active_reconciliation_attempt_id
 WHEN run.active_replay_attempt_id IS NOT NULL THEN 'product-command-replay-v1-'||run.active_replay_attempt_id
 ELSE run.workflow_id END
 AND operation.state IN('queued','running')
 AND(operation.lease_expires_at IS NULL OR operation.lease_expires_at>?3)`;
const SUCCEEDED =
  "SELECT 1 FROM operations WHERE organization_id=?1 AND operation_id=?2 AND state='succeeded'";

/** Original step lease fence. Success may finish cleanup; an expired execution cannot renew itself. */
export async function renewProductOperationLease(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const at = new Date(i.now).toISOString().replace(/Z$/u, "000Z");
  const expires = new Date(Date.parse(i.now) + i.durationMilliseconds)
    .toISOString()
    .replace(/Z$/u, "000Z");
  const values = [i.organizationId, i.operationId, at, expires, i.workflowId, i.physicalWorkflowId];
  const command: Command<{ active: boolean; succeeded: boolean }, true> = {
    name: "provisioning.renewOperationLease",
    input: i,
    retryOn: ["operation_conflict"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(ACTIVE).bind(...values),
        reader.prepare(SUCCEEDED).bind(i.organizationId, i.operationId),
      ]);
      return {
        active: (rows[0]?.results.length ?? 0) !== 0,
        succeeded: (rows[1]?.results.length ?? 0) !== 0,
      };
    },
    decide: (s) => {
      if (s.succeeded) return { replay: true };
      if (!s.active) return { reject: new Error("Operation lease is no longer active") };
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", i.organizationId),
          guard(db, "operation_conflict", `NOT EXISTS(${ACTIVE})`, values),
          db
            .prepare(
              `UPDATE operations SET lease_expires_at=?4 WHERE organization_id=?1 AND operation_id=?2 AND EXISTS(${ACTIVE})`,
            )
            .bind(...values),
          guard(db, "operation_conflict", "changes()<>1"),
        ],
        result: () => true,
      };
    },
    lookup: async (reader) => {
      if (await reader.prepare(SUCCEEDED).bind(i.organizationId, i.operationId).first())
        return true;
      const current = await reader
        .prepare(
          `SELECT 1 FROM operations WHERE organization_id=?1 AND operation_id=?2 AND lease_expires_at=?4 AND EXISTS(${ACTIVE})`,
        )
        .bind(...values)
        .first();
      return current === null ? undefined : true;
    },
  };
  await runCommand(db, command);
}
