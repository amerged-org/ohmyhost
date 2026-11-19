import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  fenceRaceGuard,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { ProductWorkflowContextConflictError, readProductWorkflowContext } from "./context.js";
import {
  diagnosticInput,
  diagnosticStatements,
  deploymentDiagnosticCatalog,
  migrationDiagnosticMessage,
} from "./diagnostics.js";
import {
  readFailureBuildRelease,
  failureBuildReleaseStatements,
  type FailureBuildRelease,
} from "./failure-build-release.js";
const codes = [
  "BUILD_NOT_STARTED",
  "BUILD_FAILED",
  "DATABASE_MIGRATION_FAILED",
  "PAID_PLAN_REQUIRED",
  "INSUFFICIENT_ORGANIZATION_CREDITS",
  "RUNTIME_CANDIDATE_FAILED",
  "RUNTIME_CANDIDATE_REJECTED",
  "STORAGE_JURISDICTION_CONFLICT",
  "PROMOTION_SOURCE_STALE",
  "PROMOTION_TARGET_STALE",
  "AUTHORIZATION_CHANGED",
] as const;
export const deploymentFailureInput = z
  .strictObject({
    workflowId: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => v.trim() === v),
    reconciliationAttemptId: ulid.optional(),
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    operationId: ulid,
    outboxEventId: ulid,
    startedOperationEventId: ulid,
    operationEventId: ulid,
    auditEventId: ulid,
    actorId: z.literal("deployment-workflow"),
    errorCode: z.enum(codes),
    failure: z.strictObject({ excerpt: z.string(), truncated: z.boolean() }).nullable().optional(),
    migration: z
      .strictObject({
        reason: z.enum(["catalog_changed", "execution_failed", "ledger_conflict", "not_admitted"]),
        path: z
          .string()
          .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/u)
          .max(512)
          .nullable(),
        statementIndex: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        sqlstate: z
          .string()
          .regex(/^[0-9A-Z]{5}$/u)
          .refine((value) => !value.startsWith("08") && !/^57P0[123]$/u.test(value))
          .optional(),
      })
      .superRefine((migration, context) => {
        if (
          (migration.statementIndex === undefined) !== (migration.sqlstate === undefined) ||
          (migration.statementIndex !== undefined &&
            (migration.reason !== "execution_failed" || migration.path === null))
        )
          context.addIssue({ code: "custom", message: "Migration statement metadata is invalid" });
      })
      .nullable()
      .optional(),
    health: z
      .strictObject({
        status: z.number().int().min(100).max(599),
        path: z.string().startsWith("/"),
        excerpt: z.string().nullable(),
        truncated: z.boolean(),
      })
      .nullable()
      .optional(),
    failedAt: z
      .string()
      .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
      .pipe(instant),
  })
  .superRefine((i, c) => {
    if (
      (i.failure != null && i.errorCode !== "BUILD_FAILED") ||
      (i.migration != null && i.errorCode !== "DATABASE_MIGRATION_FAILED") ||
      (i.health != null && i.errorCode !== "RUNTIME_CANDIDATE_FAILED")
    )
      c.addIssue({ code: "custom", message: "Product deployment failure input is invalid" });
  });
type Input = z.output<typeof deploymentFailureInput>;
type Row = Record<string, unknown>;
const SCOPE = `SELECT run.state run_state,run.terminal_evidence,operation.state operation_state,operation.created_at,intent.deployment_id,deployment.status deployment_state,intent.billing_epoch_id,run.active_reconciliation_attempt_id,run.active_replay_attempt_id,intent.event_type
 FROM product_command_intents intent JOIN product_workflow_runs run ON run.workflow_id=?1 AND run.event_id=?2 AND run.organization_id=intent.organization_id AND run.project_id=intent.project_id AND run.environment_id=intent.environment_id AND run.operation_id=intent.operation_id AND run.billing_epoch_id=intent.billing_epoch_id AND run.event_type=intent.event_type
 JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
 JOIN deployments deployment ON deployment.organization_id=intent.organization_id AND deployment.project_id=intent.project_id AND deployment.deployment_id=intent.deployment_id
 WHERE intent.organization_id=?3 AND intent.project_id=?4 AND intent.environment_id=?5 AND intent.operation_id=?6
 AND((intent.event_type='DeploymentRequestedV1' AND ?7 NOT IN('PROMOTION_SOURCE_STALE','PROMOTION_TARGET_STALE')) OR(intent.event_type IN('DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1') AND ?7 IN('DATABASE_MIGRATION_FAILED','PAID_PLAN_REQUIRED','INSUFFICIENT_ORGANIZATION_CREDITS','RUNTIME_CANDIDATE_REJECTED','RUNTIME_CANDIDATE_FAILED','STORAGE_JURISDICTION_CONFLICT','AUTHORIZATION_CHANGED')) OR(intent.event_type='DeploymentPromotionRequestedV1' AND ?7 IN('PROMOTION_SOURCE_STALE','PROMOTION_TARGET_STALE')))`;
const HEALTH = `SELECT 1 FROM deployment_diagnostics WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND deployment_id=(SELECT deployment_id FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4) AND source='runtime' AND code='HEALTH_CHECK_FAILED' AND (?5 IS NULL OR(route_template=?5 AND status_code=?6 AND excerpt IS ?7 AND excerpt_truncated IS ?8)) LIMIT 1`;
const healthParams = (input: Input) => [
  input.organizationId,
  input.projectId,
  input.environmentId,
  input.operationId,
  input.health?.path ?? null,
  input.health?.status ?? null,
  input.health?.excerpt ?? null,
  input.health?.excerpt == null ? null : input.health.truncated ? 1 : 0,
];
const params = (i: Input) => [
  i.workflowId,
  i.outboxEventId,
  i.organizationId,
  i.projectId,
  i.environmentId,
  i.operationId,
  i.errorCode,
];
const conflict = () =>
  new ProductWorkflowContextConflictError("Product deployment failure state changed");
function terminal(row: Row | undefined, i: Input) {
  if (
    !row ||
    row["run_state"] !== "completed" ||
    row["operation_state"] !== "failed" ||
    row["deployment_state"] !== "failed"
  )
    return false;
  const evidence = JSON.parse(String(row["terminal_evidence"]));
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    Object.keys(evidence).join(",") === "errorCode" &&
    evidence.errorCode === i.errorCode
  );
}
/** Original terminal failure, diagnostics and only demonstrably-unstarted Build release commit together. */
export async function failProductDeployment(
  context: CatalogContext,
  raw: unknown,
): Promise<"failed" | "replayed"> {
  const input = deploymentFailureInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  type Snapshot = {
    row: Row | undefined;
    start: Row | undefined;
    health: boolean;
    claim: number;
    build: FailureBuildRelease | null;
    current: Awaited<ReturnType<typeof readProductWorkflowContext>>;
  };
  const command: Command<Snapshot, "failed" | "replayed"> = {
    name: "provisioning.failDeployment",
    input,
    retryOn: ["operation_conflict", "precondition_changed"],
    naturalKeyTables: ["operation_events", "audit_events", "deployment_diagnostics", "credit_log"],
    read: async (reader) => {
      const [scope, start, claims, health] = await reader.batch([
        reader.prepare(SCOPE).bind(...params(input)),
        reader
          .prepare(
            "SELECT event_type,occurred_at FROM operation_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND revision=1",
          )
          .bind(input.organizationId, input.projectId, input.operationId),
        reader
          .prepare(
            "SELECT count(*) n FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(input.organizationId, input.projectId, input.operationId),
        reader.prepare(HEALTH).bind(...healthParams(input)),
      ]);
      const row = scope?.results[0];
      return {
        row,
        start: start?.results[0],
        claim: Number(claims?.results[0]?.["n"] ?? 0),
        health: (health?.results.length ?? 0) > 0,
        build:
          row?.["event_type"] === "DeploymentRequestedV1"
            ? await readFailureBuildRelease(reader, input, input.errorCode, input.failedAt)
            : null,
        current: terminal(row, input)
          ? null
          : await readProductWorkflowContext(context, {
              organizationId: input.organizationId,
              projectId: input.projectId,
              environmentId: input.environmentId,
              operationId: input.operationId,
            }),
      };
    },
    decide: (s) => {
      const row = s.row;
      if (terminal(row, input)) return { replay: "replayed" };
      if (
        !row ||
        !s.current ||
        row["run_state"] !== "queued" ||
        !["queued", "running"].includes(String(row["operation_state"])) ||
        !["queued", "running"].includes(String(row["deployment_state"])) ||
        row["active_reconciliation_attempt_id"] !== (input.reconciliationAttemptId ?? null) ||
        String(row["created_at"]) > input.failedAt
      )
        return { reject: conflict() };
      if (
        s.start &&
        (s.start["event_type"] !== "OperationStarted" ||
          String(s.start["occurred_at"]) > input.failedAt)
      )
        return {
          reject: new ProductWorkflowContextConflictError("Operation start evidence conflicts"),
        };
      const stale =
          row["event_type"] === "DeploymentPromotionRequestedV1" &&
          ["PROMOTION_SOURCE_STALE", "PROMOTION_TARGET_STALE"].includes(input.errorCode),
        allowNoClaim = stale || input.errorCode === "AUTHORIZATION_CHANGED";
      if (s.claim !== 1 && !(allowNoClaim && s.claim === 0)) return { reject: conflict() };
      const failure = {
          code: input.errorCode,
          message: "The deployment could not be completed.",
          ...(input.migration == null
            ? {}
            : {
                diagnostic: {
                  reason: input.migration.reason,
                  file: input.migration.path,
                  ...(input.migration.statementIndex === undefined
                    ? {}
                    : { statement_index: input.migration.statementIndex }),
                  ...(input.migration.sqlstate === undefined
                    ? {}
                    : { sqlstate: input.migration.sqlstate }),
                },
              }),
        },
        org = input.organizationId,
        op = input.operationId,
        project = input.projectId,
        at = input.failedAt;
      const statements = [
        fenceRaceGuard(db, "operation_conflict", org),
        guard(db, "precondition_changed", `(EXISTS(${HEALTH}))<>?9`, [
          ...healthParams(input),
          s.health ? 1 : 0,
        ]),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM(${SCOPE}) WHERE run_state='queued' AND operation_state IN('queued','running') AND deployment_state IN('queued','running') AND active_reconciliation_attempt_id IS ?8 AND active_replay_attempt_id IS ?9)`,
          [
            ...params(input),
            input.reconciliationAttemptId ?? null,
            row["active_replay_attempt_id"],
          ],
        ),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active' AND lifecycle_version=?3)`,
          [org, project, s.current.projectLifecycleVersion],
        ),
      ];
      if (!s.start)
        statements.push(
          db
            .prepare(
              `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6)`,
            )
            .bind(org, input.startedOperationEventId, op, project, `${input.workflowId}:start`, at),
        );
      statements.push(
        db
          .prepare(
            `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,2,'OperationFailed',?5,?6,?7)`,
          )
          .bind(
            org,
            input.operationEventId,
            op,
            project,
            `${input.workflowId}:failed`,
            JSON.stringify({ failure: { code: failure.code, message: failure.message } }),
            at,
          ),
        db
          .prepare(
            `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,?5,'system','deployment-workflow',?6,?7,?8)`,
          )
          .bind(
            org,
            input.auditEventId,
            project,
            op,
            `${row["event_type"]}Failed`,
            JSON.stringify({ code: input.errorCode }),
            at,
            row["billing_epoch_id"],
          ),
        db
          .prepare(
            `UPDATE deployments SET status='failed',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND status IN('queued','running')`,
          )
          .bind(org, project, row["deployment_id"], at),
        guard(db, "operation_conflict", "changes()<>1"),
        db
          .prepare(
            `UPDATE operations SET state='failed',failure=?4,updated_at=?5,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')`,
          )
          .bind(org, project, op, JSON.stringify(failure), at),
        guard(db, "operation_conflict", "changes()<>1"),
        db
          .prepare(
            `UPDATE product_workflow_runs SET state='completed',terminal_evidence=?2,active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,updated_at=?3,completed_at=?3 WHERE workflow_id=?1 AND state='queued' AND active_reconciliation_attempt_id IS ?4 AND active_replay_attempt_id IS ?5`,
          )
          .bind(
            input.workflowId,
            JSON.stringify({ errorCode: input.errorCode }),
            at,
            input.reconciliationAttemptId ?? null,
            row["active_replay_attempt_id"],
          ),
        guard(db, "operation_conflict", "changes()<>1"),
        db
          .prepare(
            "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
          )
          .bind(org, project, op),
        guard(db, "operation_conflict", allowNoClaim ? "changes()>1" : "changes()<>1"),
      );
      if (!(input.errorCode === "RUNTIME_CANDIDATE_FAILED" && s.health)) {
        const health = input.health ?? null,
          migration = input.migration ?? null,
          code =
            input.errorCode === "BUILD_NOT_STARTED"
              ? "BUILD_NOT_STARTED"
              : input.errorCode === "BUILD_FAILED"
                ? "BUILD_FAILED"
                : health
                  ? "HEALTH_CHECK_FAILED"
                  : "DEPLOYMENT_FAILED";
        statements.push(
          ...diagnosticStatements(
            db,
            diagnosticInput.parse({
              id: input.operationEventId,
              organizationId: org,
              projectId: project,
              environmentId: input.environmentId,
              deploymentId: row["deployment_id"],
              source: input.errorCode === "BUILD_FAILED" ? "build" : health ? "runtime" : "control",
              code: migration ? "DATABASE_MIGRATION_FAILED" : code,
              catalogMessage: migration
                ? migrationDiagnosticMessage(migration.reason)
                : deploymentDiagnosticCatalog(code),
              exceptionClass: null,
              sourceFile: migration?.path ?? null,
              sourceLine: null,
              sourceColumn: null,
              routeTemplate: health?.path ?? null,
              requestId: null,
              traceId: null,
              durationMs: null,
              excerpt: input.failure?.excerpt ?? health?.excerpt ?? null,
              excerptTruncated:
                input.failure?.truncated ?? (health?.excerpt == null ? null : health.truncated),
              statusCode: health?.status ?? null,
              occurredAt: at,
              recordedAt: at,
            }),
          ),
        );
      }
      if (s.build)
        statements.push(...failureBuildReleaseStatements(db, s.build, input, input.errorCode, at));
      return { statements, result: () => "failed" };
    },
    lookup: async (reader) => {
      const row = await reader
        .prepare(SCOPE)
        .bind(...params(input))
        .first<Row>();
      return terminal(row ?? undefined, input) ? "replayed" : undefined;
    },
  };
  return runCommand(db, command);
}
