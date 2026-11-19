import { runCommand } from "../../run-command.js";
import { Buffer } from "node:buffer";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
export type RecoveryRow = Record<string, unknown>;
export interface RecoveryRead {
  readonly sql: string;
  readonly values: readonly unknown[];
}
export interface RecoverySnapshot {
  readonly rows: readonly RecoveryRow[][];
  readonly guards: (db: D1Database) => D1PreparedStatement[];
}
/** Family-local closed query snapshots: exact row sets are rechecked IN the mutation batch. No SQL crosses RPC. */
export async function readRecoverySnapshot(
  db: D1Database,
  reads: readonly RecoveryRead[],
): Promise<RecoverySnapshot> {
  const results = await db.batch(reads.map((r) => db.prepare(r.sql).bind(...r.values)));
  const rows = results.map((r) => r.results);
  return {
    rows,
    guards(db) {
      return reads.flatMap((read, n) => {
        const values = read.values,
          rows = results[n]?.results ?? [];
        return [
          guard(
            db,
            "precondition_changed",
            `(SELECT count(*) FROM(${read.sql}))<>?${values.length + 1}`,
            [...values, rows.length],
          ),
          ...rows.map((row) => {
            const identity = JSON.stringify(row),
              multiplicity = rows.filter((other) => JSON.stringify(other) === identity).length,
              equal = Object.keys(row)
                .map((key, index) => `observed."${key}" IS ?${values.length + index + 1}`)
                .join(" AND ");
            return guard(
              db,
              "precondition_changed",
              `(SELECT count(*) FROM(${read.sql}) observed WHERE ${equal})<>?${values.length + Object.keys(row).length + 1}`,
              [...values, ...Object.values(row), multiplicity],
            );
          }),
        ];
      });
    },
  };
}
const jsonFields = new Set([
  "payload",
  "operation_failure",
  "workflow_terminal_evidence",
  "workflow_intermediate_evidence",
  "terminal_evidence",
  "intermediate_evidence",
  "failure",
  "evidence",
]);
export function recoveryRow<T>(row: RecoveryRow): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value === null
        ? null
        : jsonFields.has(key) && typeof value === "string"
          ? JSON.parse(value)
          : /(?:_at|_until)$/.test(key) && typeof value === "string"
            ? new Date(value)
            : value,
    ]),
  ) as T;
}
export function recoveryAudit(
  db: D1Database,
  row: {
    organizationId: string;
    auditEventId: string;
    projectId: string;
    operationId: string;
    billingEpochId: string;
    eventType: string;
    actorId: string;
    payload: unknown;
    occurredAt: string;
  },
) {
  return db
    .prepare(
      "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,payload,occurred_at)VALUES(?1,?2,?3,?4,?5,?6,'principal',?7,?8,?9)",
    )
    .bind(
      row.organizationId,
      row.auditEventId,
      row.projectId,
      row.operationId,
      row.billingEpochId,
      row.eventType,
      row.actorId,
      JSON.stringify(row.payload),
      row.occurredAt.replace(/\.(\d{3})Z$/u, ".$1000Z"),
    );
}
/** Closed recovery readers collect exact native observations for the command's eventual atomic batch. */
export function recoveryReads(db: D1Database) {
  const observed: RecoverySnapshot[] = [];
  return {
    async select<T>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<{ rows: T[]; rowCount: number }> {
      const state = await readRecoverySnapshot(db, [
        {
          sql,
          values: values.map((v) =>
            v instanceof Date ? v.toISOString().replace(/\.(\d{3})Z$/u, ".$1000Z") : v,
          ),
        },
      ]);
      observed.push(state);
      const rows = (state.rows[0] ?? []).map((row) => recoveryRow<Record<string, unknown>>(row));
      for (const row of rows)
        for (const key of Object.keys(row)) {
          if (
            key === "present" ||
            key === "matches_scope" ||
            key === "exact_ready" ||
            key.endsWith("_present")
          )
            row[key] = row[key] === 1;
          if (key === "idempotency_sha256" && typeof row[key] === "string")
            row[key] = Buffer.from(row[key], "hex");
        }
      return { rows: rows as T[], rowCount: rows.length };
    },
    guards(target: D1Database) {
      return observed.flatMap((s) => s.guards(target));
    },
  };
}
export type RecoveryReads = ReturnType<typeof recoveryReads>;
export async function runRecoveryDecision<T>(
  db: D1Database,
  name: string,
  input: unknown,
  build: (reader: RecoveryReads) => Promise<{ statements: D1PreparedStatement[]; value: T }>,
): Promise<T> {
  return runCommand(db, {
    name,
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["audit_events", "operation_events"],
    read: async (target) => {
      const reader = recoveryReads(target),
        plan = await build(reader);
      return { reader, plan };
    },
    decide: ({ reader, plan }) => ({
      statements: [...reader.guards(db), ...plan.statements],
      result: () => plan.value,
    }),
  });
}
