import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  instant,
  fenceRaceGuard,
  type CatalogContext,
} from "../common.js";
import { ProductWorkflowContextConflictError, readProductWorkflowContext } from "./context.js";
import { diagnosticInput, diagnosticStatements } from "./diagnostics.js";

const inputSchema = z.strictObject({
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
  diagnosticEventId: ulid,
  health: z.strictObject({
    status: z.number().int().min(100).max(599),
    path: z.string().startsWith("/"),
    excerpt: z.string().nullable(),
    truncated: z.boolean(),
  }),
  recordedAt: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
});
const SCOPE = `SELECT intent.deployment_id,project.lifecycle_version FROM product_command_intents intent
JOIN product_workflow_runs run ON run.workflow_id=?1 AND run.event_id=?2 AND run.organization_id=intent.organization_id AND run.project_id=intent.project_id AND run.environment_id=intent.environment_id AND run.operation_id=intent.operation_id AND run.billing_epoch_id=intent.billing_epoch_id AND run.event_type=intent.event_type
JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
JOIN deployments deployment ON deployment.organization_id=intent.organization_id AND deployment.project_id=intent.project_id AND deployment.deployment_id=intent.deployment_id
JOIN projects project ON project.organization_id=intent.organization_id AND project.project_id=intent.project_id AND project.owner_state='active' AND project.lifecycle_state='active'
WHERE intent.organization_id=?3 AND intent.project_id=?4 AND intent.environment_id=?5 AND intent.operation_id=?6 AND intent.event_type IN('DeploymentRequestedV1','DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1')
AND run.state='queued' AND run.active_reconciliation_attempt_id IS ?7 AND operation.state IN('queued','running') AND deployment.status IN('queued','running')`;
type Row = Record<string, unknown>;
/** Persist the unhealthy candidate's primary verdict before compensation, under its exact accepted run. */
export async function recordRuntimeHealthDiagnostic(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = inputSchema.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    values = [
      i.workflowId,
      i.outboxEventId,
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
      i.reconciliationAttemptId ?? null,
    ];
  const conflict = () =>
    new ProductWorkflowContextConflictError("Product deployment health verdict scope changed");
  const command: Command<
    {
      scope: Row | null;
      existing: Row | null;
      current: Awaited<ReturnType<typeof readProductWorkflowContext>>;
    },
    "created" | "existing"
  > = {
    name: "provisioning.recordHealthDiagnostic",
    input: i,
    retryOn: ["operation_conflict", "precondition_changed"],
    naturalKeyTables: ["deployment_diagnostics"],
    read: async (reader) => ({
      scope: await reader
        .prepare(SCOPE)
        .bind(...values)
        .first<Row>(),
      existing: await reader
        .prepare("SELECT * FROM deployment_diagnostics WHERE diagnostic_event_id=?1")
        .bind(i.diagnosticEventId)
        .first<Row>(),
      current: await readProductWorkflowContext(context, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        environmentId: i.environmentId,
        operationId: i.operationId,
      }),
    }),
    decide: (s) => {
      if (!s.scope || !s.current || s.current.promotionStale !== undefined)
        return { reject: conflict() };
      const expected = {
        organization_id: i.organizationId,
        project_id: i.projectId,
        environment_id: i.environmentId,
        deployment_id: s.scope["deployment_id"],
        source: "runtime",
        code: "HEALTH_CHECK_FAILED",
        route_template: i.health.path,
        status_code: i.health.status,
        excerpt: i.health.excerpt,
        excerpt_truncated: i.health.excerpt === null ? null : i.health.truncated ? 1 : 0,
      };
      if (
        s.existing &&
        Object.entries(expected).some(([key, value]) => s.existing?.[key] !== value)
      )
        return {
          reject: new ProductWorkflowContextConflictError(
            "Product deployment health verdict changed",
          ),
        };
      const statements = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM(${SCOPE}) WHERE lifecycle_version=?8)`,
          [...values, s.current.projectLifecycleVersion],
        ),
      ];
      if (s.existing) return { statements, result: () => "existing" };
      statements.push(
        ...diagnosticStatements(
          db,
          diagnosticInput.parse({
            id: i.diagnosticEventId,
            organizationId: i.organizationId,
            projectId: i.projectId,
            environmentId: i.environmentId,
            deploymentId: s.scope["deployment_id"],
            source: "runtime",
            code: "HEALTH_CHECK_FAILED",
            catalogMessage: "CUSTOMER_HEALTH_CHECK_FAILED",
            exceptionClass: null,
            sourceFile: null,
            sourceLine: null,
            sourceColumn: null,
            routeTemplate: i.health.path,
            requestId: null,
            traceId: null,
            durationMs: null,
            excerpt: i.health.excerpt,
            excerptTruncated: i.health.excerpt === null ? null : i.health.truncated,
            statusCode: i.health.status,
            occurredAt: i.recordedAt,
            recordedAt: i.recordedAt,
          }),
        ),
      );
      return { statements, result: () => "created" };
    },
    lookup: async (reader) => {
      const row = await reader
        .prepare(
          `SELECT 1 FROM(${SCOPE}) scope JOIN deployment_diagnostics diagnostic ON diagnostic.deployment_id=scope.deployment_id WHERE diagnostic.diagnostic_event_id=?8 AND diagnostic.organization_id=?3 AND diagnostic.project_id=?4 AND diagnostic.environment_id=?5 AND diagnostic.source='runtime' AND diagnostic.code='HEALTH_CHECK_FAILED' AND diagnostic.route_template=?9 AND diagnostic.status_code=?10 AND diagnostic.excerpt IS ?11 AND diagnostic.excerpt_truncated IS ?12`,
        )
        .bind(
          ...values,
          i.diagnosticEventId,
          i.health.path,
          i.health.status,
          i.health.excerpt,
          i.health.excerpt === null ? null : i.health.truncated ? 1 : 0,
        )
        .first();
      return row === null ? undefined : "existing";
    },
  };
  return runCommand(db, command);
}
