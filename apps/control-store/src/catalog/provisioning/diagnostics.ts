import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
const CATALOG = {
  BUILD_NOT_STARTED: "PLATFORM_BUILD_NOT_STARTED",
  BUILD_FAILED: "CUSTOMER_BUILD_FAILED",
  CONTROL_FAILED: "CONTROL_OPERATION_FAILED",
  WFP_CANDIDATE_OUTDATED: "FINISH_CANDIDATE_RECONCILIATION_THEN_REDEPLOY_CURRENT_SOURCE",
  DEPLOYMENT_FAILED: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
  FUNCTION_FAILED: "CUSTOMER_FUNCTION_FAILED",
  HEALTH_CHECK_FAILED: "CUSTOMER_HEALTH_CHECK_FAILED",
  RUNTIME_EXCEPTION: "CUSTOMER_RUNTIME_FAILED",
  RUNTIME_FAILED: "CUSTOMER_RUNTIME_FAILED",
} as const;
const MIGRATIONS = {
  catalog_changed: "MIGRATION_CHANGED_EXISTING_SCHEMA",
  execution_failed: "MIGRATION_EXECUTION_FAILED",
  ledger_conflict: "APPLIED_MIGRATION_CHANGED",
  not_admitted: "MIGRATION_SQL_NOT_ADMITTED",
} as const;
export const diagnosticInput = z
  .strictObject({
    id: ulid,
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    deploymentId: ulid,
    source: z.enum(["build", "control", "runtime", "function"]),
    code: z.string(),
    catalogMessage: z.string(),
    exceptionClass: z.string().nullable(),
    sourceFile: z.string().nullable(),
    sourceLine: z.number().int().nullable(),
    sourceColumn: z.number().int().nullable(),
    routeTemplate: z.string().nullable(),
    requestId: z.string().nullable(),
    traceId: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    excerpt: z.string().nullable(),
    excerptTruncated: z.boolean().nullable(),
    statusCode: z.number().int().nullable().optional(),
    occurredAt: instant,
    recordedAt: instant,
  })
  .superRefine((input, ctx) => {
    const catalog =
      input.code === "DATABASE_MIGRATION_FAILED"
        ? Object.values(MIGRATIONS).includes(
            input.catalogMessage as (typeof MIGRATIONS)[keyof typeof MIGRATIONS],
          )
        : Object.hasOwn(CATALOG, input.code) &&
          CATALOG[input.code as keyof typeof CATALOG] === input.catalogMessage;
    if (!catalog)
      ctx.addIssue({ code: "custom", message: "Diagnostic catalog fields are invalid" });
    if ((input.excerpt === null) !== (input.excerptTruncated === null))
      ctx.addIssue({ code: "custom", message: "Diagnostic excerpt fields are incomplete" });
    if (
      input.excerpt !== null &&
      ((input.code !== "BUILD_FAILED" && input.code !== "HEALTH_CHECK_FAILED") ||
        input.excerpt.length === 0 ||
        input.excerpt.length > 16384 ||
        input.excerpt !== input.excerpt.trimEnd() ||
        /(?![\t\n])\p{Cc}|\p{Cs}/u.test(input.excerpt))
    )
      ctx.addIssue({ code: "custom", message: "Diagnostic excerpt is invalid" });
  });
export type DiagnosticInput = z.output<typeof diagnosticInput>;
const columns = [
  "diagnostic_event_id",
  "organization_id",
  "project_id",
  "environment_id",
  "deployment_id",
  "source",
  "code",
  "catalog_message",
  "exception_class",
  "source_file",
  "source_line",
  "source_column",
  "route_template",
  "request_id",
  "trace_id",
  "duration_ms",
  "occurred_at",
  "excerpt",
  "excerpt_truncated",
  "status_code",
] as const;
function values(input: DiagnosticInput): unknown[] {
  return [
    input.id,
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.deploymentId,
    input.source,
    input.code,
    input.catalogMessage,
    input.exceptionClass,
    input.sourceFile,
    input.sourceLine,
    input.sourceColumn,
    input.routeTemplate,
    input.requestId,
    input.traceId,
    input.durationMs,
    input.occurredAt,
    input.excerpt,
    input.excerptTruncated === null ? null : input.excerptTruncated ? 1 : 0,
    input.statusCode ?? null,
  ];
}
/** Newest diagnostics kept per environment; the purge enforces it one bounded page at a time, never on a write. */
export const DIAGNOSTIC_ENVIRONMENT_CAP = 10_000;

/** Original scoped purge/immutable identity policy, composed inside a parent effect batch. */
export function diagnosticStatements(
  db: D1Database,
  input: DiagnosticInput,
): D1PreparedStatement[] {
  const params = values(input);
  return [
    db
      .prepare(
        `DELETE FROM deployment_diagnostics WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND occurred_at<?4`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId,
        new Date(Date.parse(input.recordedAt) - 7 * 86_400_000).toISOString().slice(0, 19) +
          input.recordedAt.slice(19),
      ),
    db
      .prepare(
        `INSERT INTO deployment_diagnostics(${columns.join(",")},recorded_at) VALUES(${params.map((_, i) => `?${i + 1}`).join(",")},?21) ON CONFLICT(diagnostic_event_id) DO NOTHING`,
      )
      .bind(...params, input.recordedAt),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM deployment_diagnostics WHERE ${columns.map((name, i) => `${name} IS ?${i + 1}`).join(" AND ")})`,
      params,
    ),
  ];
}
/** Closed existing catalog writer; no arbitrary diagnostic body or SQL dispatcher crosses a runtime boundary. */
export async function recordWorkflowDiagnostic(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = diagnosticInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const params = values(input);
  const command: Command<Record<string, unknown> | null, "created" | "existing"> = {
    name: "provisioning.recordDiagnostic",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["deployment_diagnostics"],
    read: (reader) =>
      reader
        .prepare("SELECT * FROM deployment_diagnostics WHERE diagnostic_event_id=?1")
        .bind(input.id)
        .first<Record<string, unknown>>(),
    decide: (existing) => {
      if (existing && columns.some((name, i) => existing[name] !== params[i]))
        return { reject: new Error("Diagnostic event identity conflicts") };
      return {
        statements: diagnosticStatements(db, input),
        result: () => (existing === null ? "created" : "existing"),
      };
    },
    lookup: async (reader) => {
      const row = await reader
        .prepare(
          `SELECT 1 FROM deployment_diagnostics WHERE ${columns.map((name, i) => `${name} IS ?${i + 1}`).join(" AND ")}`,
        )
        .bind(...params)
        .first();
      return row === null ? undefined : "existing";
    },
  };
  return runCommand(db, command);
}
export function migrationDiagnosticMessage(reason: keyof typeof MIGRATIONS): string {
  return MIGRATIONS[reason];
}
export function deploymentDiagnosticCatalog(code: keyof typeof CATALOG): string {
  return CATALOG[code];
}
