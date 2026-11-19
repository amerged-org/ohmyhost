import { readOperation } from "../operations/operation-store.js";
import { readBlockingProductOperation } from "../operations/operation-leases.js";
import { z } from "zod";
import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import type { ProjectDatabaseWriteReceipt } from "@ohmyhost/contracts/database-access";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import {
  addMilliseconds,
  auditStatement,
  hexBytes,
  instant,
  publicTimestamp,
  queuedOperationStatements,
  newUlid,
  notFencedOrganization,
  fenceRaceGuard,
  ulid,
  type CatalogContext,
} from "../common.js";
import { readSnapshot } from "../platform-support.js";
import { OrganizationCreditError } from "../billing/errors.js";
import { readRuntimeDecision, type RuntimeDecision } from "../credit/index.js";
import {
  admissionRefusal,
  DATA_CHANGE_PENDING,
  ProductDatabaseError,
  productTransition,
  SQL_TARGET,
  targetGuard,
  targetParams,
  type SqlTargetRow,
} from "./product-common.js";
import { suspendedWithoutPaid } from "./product-access.js";
import { runOnOrganization } from "./run.js";

const scope = { organizationId: ulid, projectId: ulid };
const failure = z.enum([
  "DATABASE_WRITE_REJECTED",
  "DATABASE_WRITE_UNAVAILABLE",
  "DATABASE_WRITE_OUTCOME_UNKNOWN",
]);
const completion = {
  now: instant,
  operationEventId: ulid,
  auditEventId: ulid,
  completionAuditEventId: ulid,
};
const finishInput = z
  .strictObject({
    ...scope,
    operationId: ulid,
    ...completion,
    command: z.enum(["INSERT", "UPDATE", "DELETE"]).optional(),
    affectedRows: z.number().int().min(0).max(1000).optional(),
    failureCode: failure.optional(),
  })
  .refine((i) =>
    i.failureCode !== undefined
      ? i.command === undefined && i.affectedRows === undefined
      : i.command !== undefined && i.affectedRows !== undefined,
  );
const acceptInput = z.strictObject({
  ...scope,
  environment: z.enum(["dev", "prod"]),
  principalId: z.string().min(1).max(256),
  requestId: z.string(),
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .refine((v) => v.trim() === v && !/\p{Cc}/u.test(v)),
  canonicalRequestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: ulid,
  queuedEventId: ulid,
  startedEventId: ulid,
  startedAuditEventId: ulid,
  writeAuditEventId: ulid,
  ...completion,
});
interface WriteRow {
  operation_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  environment: "dev" | "prod";
  data_environment_id: string;
  billing_epoch_id: string;
  provider_project_id: string;
  default_branch_id: string | null;
  provider: "pgcf" | "neon";
  database_id: string | null;
  request_sha256: string;
  started_at: string;
  deadline_at: string;
  completed_at: string | null;
  command: "INSERT" | "UPDATE" | "DELETE" | null;
  affected_rows: number | null;
  failure_code: string | null;
  op_state: string;
  event_count: number;
}
const ROW = `SELECT w.*,lower(hex(w.request_sha256)) digest,(SELECT state FROM operations op WHERE op.organization_id=w.organization_id AND op.project_id=w.project_id AND op.operation_id=w.operation_id) op_state,(SELECT count(*) FROM operation_events ev WHERE ev.organization_id=w.organization_id AND ev.operation_id=w.operation_id) event_count FROM project_database_writes w`;
const RETRY = [
  "precondition_changed",
  "row_version_conflict",
  "owner_changed",
  "scope_inactive",
  "operation_conflict",
] as const;
/** The execute answer of an admitted write: the same whether it is admitted now or replayed to its own caller. */
function executeAnswer(
  operationId: string,
  environment: "dev" | "prod",
  target: SqlTargetRow,
  deadlineAt: string,
) {
  return {
    mode: "execute" as const,
    receipt: {
      operation_id: operationId,
      environment,
      state: "running" as const,
      command: null,
      affected_rows: null,
      error: null,
    },
    target: {
      provider: "pgcf" as const,
      providerProjectId: target.provider_project_id,
      databaseId: target.database_id,
      dataEnvironmentId: target.physical_environment_id,
      originHost: target.origin_host,
      roleName: `ohmyho_rw_${target.physical_environment_id.toLowerCase()}`,
      deadlineAt: publicTimestamp(deadlineAt),
    },
  };
}
function receipt(row: WriteRow): ProjectDatabaseWriteReceipt {
  return {
    operation_id: row.operation_id,
    environment: row.environment,
    state: row.completed_at ? (row.failure_code ? "failed" : "succeeded") : "running",
    command: row.command,
    affected_rows: row.affected_rows,
    error: row.failure_code ? publicOperationFailure(row.failure_code) : null,
  };
}
const OWNED = `SELECT e.environment_id,p.active_billing_epoch_id FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id WHERE p.organization_id=?1 AND p.project_id=?2 AND e.name=?3 AND p.owner_state='active' AND p.lifecycle_state='active' AND NOT ${DATA_CHANGE_PENDING}`;
function completionStatements(
  db: D1Database,
  row: WriteRow,
  input: z.output<typeof finishInput>,
): D1PreparedStatement[] {
  if (row.op_state !== "running") throw new ProductDatabaseError("scope");
  const scope = {
    organizationId: row.organization_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    billingEpochId: row.billing_epoch_id,
  };
  return [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM project_database_writes WHERE organization_id=?1 AND operation_id=?2 AND completed_at IS NULL)`,
      [row.organization_id, row.operation_id],
    ),
    ...productTransition(db, scope, {
      action: input.failureCode ? "fail" : "succeed",
      eventCount: row.event_count,
      operationEventId: input.operationEventId,
      auditEventId: input.auditEventId,
      now: input.now,
      kind: "write",
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    }),
    db
      .prepare(
        "UPDATE project_database_writes SET completed_at=?3,command=?4,affected_rows=?5,failure_code=?6 WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(
        row.organization_id,
        row.operation_id,
        input.now,
        input.command ?? null,
        input.affectedRows ?? null,
        input.failureCode ?? null,
      ),
    auditStatement(db, row.organization_id, {
      auditEventId: input.completionAuditEventId,
      projectId: row.project_id,
      operationId: row.operation_id,
      billingEpochId: row.billing_epoch_id,
      eventType: "ProjectDatabaseWriteCompleted",
      actorType: "service",
      actorId: "database-write",
      payload: {
        command: input.command ?? null,
        affected_rows: input.affectedRows ?? null,
        failure_code: input.failureCode ?? null,
      },
      occurredAt: input.now,
    }),
  ];
}
/** Original117: replay lookup precedes target/provider access, while current owner/lifecycle still gates the call. */
export async function acceptProductDatabaseWrite(context: CatalogContext, raw: unknown) {
  const input = acceptInput.parse(raw);
  try {
    const result = await runOnOrganization(
      context,
      input.organizationId,
      (db) => {
        const command: Command<
          {
            owned: boolean;
            previous: (WriteRow & { digest: string }) | null;
            target: SqlTargetRow | null;
            financial: RuntimeDecision | null;
            suspended: boolean;
          },
          unknown
        > = {
          name: "database.acceptProductWrite",
          input,
          retryOn: RETRY,
          naturalKeyTables: ["project_database_writes", "operations"],
          read: async (reader) => {
            const [owned, previous, targets] = await readSnapshot(reader, [
              [OWNED, ...targetParams(input)],
              [
                `${ROW} WHERE w.organization_id=?1 AND w.principal_id=?2 AND w.idempotency_key=?3`,
                input.organizationId,
                input.principalId,
                input.idempotencyKey,
              ],
              [SQL_TARGET, ...targetParams(input)],
            ]);
            const row = previous?.[0] as unknown as (WriteRow & { digest: string }) | undefined,
              target = targets?.[0] as unknown as SqlTargetRow | undefined;
            return {
              owned: owned?.length === 1,
              previous: row ?? null,
              target: target ?? null,
              financial:
                !row && target
                  ? await readRuntimeDecision(reader, {
                      organizationId: input.organizationId,
                      projectId: input.projectId,
                      environmentId: target.environment_id,
                      now: input.now,
                    })
                  : null,
              suspended: !row && target ? await suspendedWithoutPaid(reader, input, target) : false,
            };
          },
          decide: ({ owned, previous, target, financial, suspended }) => {
            if (!owned) return { reject: new ProductDatabaseError("scope") };
            const owner = guard(
              db,
              "precondition_changed",
              `NOT EXISTS(${OWNED})`,
              targetParams(input),
            );
            if (previous) {
              if (
                previous.project_id !== input.projectId ||
                previous.digest !== input.canonicalRequestDigest
              )
                return { reject: new ProductDatabaseError("idempotency") };
              if (
                previous.completed_at === null &&
                publicTimestamp(previous.deadline_at) <= publicTimestamp(input.now)
              ) {
                const expired = {
                  ...input,
                  operationId: previous.operation_id,
                  failureCode: "DATABASE_WRITE_OUTCOME_UNKNOWN" as const,
                };
                const completed = {
                  ...previous,
                  completed_at: input.now,
                  failure_code: expired.failureCode,
                };
                return {
                  statements: [owner, ...completionStatements(db, previous, expired)],
                  result: () => ({ mode: "observe", receipt: receipt(completed) }),
                };
              }
              // The caller's own admission committed before its reply was lost: it runs its write now, exactly once.
              // The admitted target must still be the current one, or the write is refused and expires unexecuted.
              if (previous.completed_at === null && previous.operation_id === input.operationId) {
                if (
                  !target ||
                  target.provider_project_id !== previous.provider_project_id ||
                  target.database_id !== previous.database_id ||
                  target.physical_environment_id !== previous.data_environment_id
                )
                  return { reject: new ProductDatabaseError("scope") };
                return {
                  replay: executeAnswer(
                    input.operationId,
                    input.environment,
                    target,
                    previous.deadline_at,
                  ),
                };
              }
              return { replay: { mode: "observe", receipt: receipt(previous) } };
            }
            if (!target || !financial) return { reject: new ProductDatabaseError("scope") };
            const refusal = admissionRefusal(financial);
            if (refusal !== null) return { reject: refusal };
            // A database suspended for lack of Paid coverage cannot run the write: refused before the operation exists.
            if (suspended) return { reject: new ProductDatabaseError("paid_plan_required") };
            const deadlineAt = addMilliseconds(input.now, 60000),
              scope = {
                organizationId: input.organizationId,
                projectId: input.projectId,
                operationId: input.operationId,
                billingEpochId: target.active_billing_epoch_id,
              };
            const result = executeAnswer(input.operationId, input.environment, target, deadlineAt);
            return {
              statements: [
                owner,
                targetGuard(db, input, target),
                ...queuedOperationStatements(db, scope, {
                  eventId: input.queuedEventId,
                  occurredAt: input.now,
                }),
                ...productTransition(db, scope, {
                  action: "start",
                  eventCount: 1,
                  operationEventId: input.startedEventId,
                  auditEventId: input.startedAuditEventId,
                  now: input.now,
                  kind: "write",
                  principalId: input.principalId,
                }),
                db
                  .prepare(
                    `INSERT INTO project_database_writes(operation_id,organization_id,project_id,environment_id,environment,data_environment_id,billing_epoch_id,provider_project_id,default_branch_id,principal_id,idempotency_key,request_sha256,started_at,deadline_at,provider,database_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?10,?11,?12,?13,'pgcf',?14)`,
                  )
                  .bind(
                    input.operationId,
                    input.organizationId,
                    input.projectId,
                    target.environment_id,
                    input.environment,
                    target.physical_environment_id,
                    target.active_billing_epoch_id,
                    target.provider_project_id,
                    input.principalId,
                    input.idempotencyKey,
                    hexBytes(input.canonicalRequestDigest),
                    input.now,
                    deadlineAt,
                    target.database_id,
                  ),
                auditStatement(db, input.organizationId, {
                  auditEventId: input.writeAuditEventId,
                  projectId: input.projectId,
                  operationId: input.operationId,
                  billingEpochId: target.active_billing_epoch_id,
                  eventType: "ProjectDatabaseWriteStarted",
                  actorType: "principal",
                  actorId: input.principalId,
                  payload: { environment: input.environment },
                  occurredAt: input.now,
                }),
              ],
              result: () => result,
            };
          },
        };
        return command;
      },
      {},
    );
    return { status: "accepted" as const, result };
  } catch (error) {
    if (error instanceof ProductDatabaseError || error instanceof OrganizationCreditError)
      return { status: "rejected" as const, code: error.code };
    throw error;
  }
}
/** A terminal receipt is immutable. A late confirmed COMMIT cannot overwrite maintenance's unknown outcome. */
export async function finishProductDatabaseWrite(
  context: CatalogContext,
  raw: unknown,
): Promise<ProjectDatabaseWriteReceipt> {
  const input = finishInput.parse(raw);
  return runOnOrganization<WriteRow | null, ProjectDatabaseWriteReceipt>(
    context,
    input.organizationId,
    (db) => ({
      name: "database.finishProductWrite",
      input,
      retryOn: RETRY,
      naturalKeyTables: ["operation_events", "audit_events"],
      read: (reader) =>
        reader
          .prepare(`${ROW} WHERE w.organization_id=?1 AND w.project_id=?2 AND w.operation_id=?3`)
          .bind(input.organizationId, input.projectId, input.operationId)
          .first<WriteRow>(),
      decide: (row) => {
        if (!row) return { reject: new ProductDatabaseError("scope") };
        if (row.completed_at !== null) return { replay: receipt(row) };
        return {
          statements: completionStatements(db, row, input),
          result: () =>
            receipt({
              ...row,
              completed_at: input.now,
              command: input.command ?? null,
              affected_rows: input.affectedRows ?? null,
              failure_code: input.failureCode ?? null,
            }),
        };
      },
    }),
    {},
  );
}
/** The original bounded deadline list; each exact receipt is completed by the same closed terminal command. */
export async function readExpiredProductDatabaseWrites(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ now: instant }).parse(raw);
  const db = (await context.router.routeShard(0)).db;
  return (
    await db
      .prepare(
        "SELECT organization_id,project_id,operation_id FROM project_database_writes WHERE completed_at IS NULL AND deadline_at<=? ORDER BY deadline_at LIMIT 20",
      )
      .bind(input.now)
      .all<{ organization_id: string; project_id: string; operation_id: string }>()
  ).results.map((row) => ({
    organizationId: row.organization_id,
    projectId: row.project_id,
    operationId: row.operation_id,
  }));
}

/** Original database-product operation history includes retained Neon compute facts; reads confer no provider transport. */
export async function readProductDatabaseOperation(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ organizationId: ulid, operationId: ulid }).parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const owned = await db
    .prepare(
      "SELECT 1 WHERE EXISTS(SELECT 1 FROM project_database_writes WHERE organization_id=?1 AND operation_id=?2) OR EXISTS(SELECT 1 FROM pgcf_database_compute_changes WHERE organization_id=?1 AND operation_id=?2) OR EXISTS(SELECT 1 FROM project_database_compute_changes WHERE organization_id=?1 AND operation_id=?2)",
    )
    .bind(input.organizationId, input.operationId)
    .all();
  if (owned.results.length !== 1) return { outcome: "absent" as const };
  const operation = await readOperation(db, input.organizationId, input.operationId);
  if (!operation) throw new ProductDatabaseError("scope");
  return {
    outcome: "ready" as const,
    operation,
    blockingOperationId: await readBlockingProductOperation(context, input),
  };
}

/** Original deadline sweep is ONE transaction for at most20 receipts, including all operation/audit effects. */
export async function expireProductDatabaseWrites(
  context: CatalogContext,
  raw: unknown,
): Promise<number> {
  const input = z.strictObject({ now: instant, passId: ulid }).parse(raw),
    db = (await context.router.routeShard(0)).db;
  type Sweep = {
    rows: WriteRow[];
    effects: { operationEventId: string; auditEventId: string; completionAuditEventId: string }[];
  };
  const command: Command<Sweep, number> = {
    name: "database.expireProductWrites",
    input,
    commandId: `database-expire:${input.passId}`,
    fromLog: (logged) => z.number().int().min(0).max(20).parse(logged),
    retryOn: RETRY,
    naturalKeyTables: ["operation_events", "audit_events"],
    read: async (reader) => {
      const rows = (
        await reader
          .prepare(
            `${ROW} WHERE w.completed_at IS NULL AND w.deadline_at<=?1 AND ${notFencedOrganization("w.organization_id")} ORDER BY w.deadline_at,w.operation_id LIMIT 20`,
          )
          .bind(input.now)
          .all<WriteRow>()
      ).results;
      const time = Date.parse(input.now);
      return {
        rows,
        effects: rows.map(() => ({
          operationEventId: newUlid(time),
          auditEventId: newUlid(time),
          completionAuditEventId: newUlid(time),
        })),
      };
    },
    decide: (snapshot) => {
      if (snapshot.rows.length === 0) return { replay: 0 };
      const statements: D1PreparedStatement[] = [];
      snapshot.rows.forEach((row, index) => {
        const effects = snapshot.effects[index];
        if (!effects) throw new Error("Missing database expiry identity");
        statements.push(
          fenceRaceGuard(db, "operation_conflict", row.organization_id),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_database_writes WHERE organization_id=?1 AND operation_id=?2 AND completed_at IS NULL AND deadline_at<=?3)",
            [row.organization_id, row.operation_id, input.now],
          ),
          ...completionStatements(db, row, {
            organizationId: row.organization_id,
            projectId: row.project_id,
            operationId: row.operation_id,
            now: input.now,
            ...effects,
            failureCode: "DATABASE_WRITE_OUTCOME_UNKNOWN",
          }),
        );
      });
      return { statements, result: () => snapshot.rows.length, logResult: snapshot.rows.length };
    },
  };
  return runCommand(db, command);
}
