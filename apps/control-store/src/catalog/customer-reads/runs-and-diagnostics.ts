import { z } from "zod";
import { instant, publicTimestamp, routeOrganization, ulid, addMilliseconds } from "../common.js";
import type { CatalogContext } from "../common.js";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const canonical = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});

const runsInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  limit: z.number().int().min(1).max(100),
});
interface RunRow {
  run_id: string;
  deployment_id: string;
  cron: string;
  scheduled_at: string;
  state: "due" | "running" | "retry" | "succeeded" | "failed" | "skipped";
  attempt: number;
  status_code: number | null;
  started_at: string | null;
  finished_at: string | null;
}
const optional = (stored: string | null) => (stored === null ? null : publicTimestamp(stored));

/** The newest scheduled runs of one environment, tenant-scoped; the customer verifies its crons here. */
export async function readEnvironmentFunctionRuns(context: CatalogContext, raw: unknown) {
  const input = runsInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    rows = await db
      .prepare(
        `SELECT run_id,deployment_id,cron,scheduled_at,state,attempt,status_code,started_at,finished_at
         FROM function_runs WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3
         ORDER BY scheduled_at DESC,cron ASC LIMIT ?4`,
      )
      .bind(input.organizationId, input.projectId, input.environmentId, input.limit)
      .all<RunRow>();
  return rows.results.map((row) => ({
    runId: row.run_id,
    deploymentId: row.deployment_id,
    cron: row.cron,
    scheduledAt: publicTimestamp(row.scheduled_at),
    state: row.state,
    attempt: row.attempt,
    statusCode: row.status_code,
    startedAt: optional(row.started_at),
    finishedAt: optional(row.finished_at),
  }));
}

const diagnosticsInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  deploymentId: ulid,
  /** The reader's clock bounds the seven-day window; the catalog samples none. */
  now: instant,
  before: z.strictObject({ occurredAt: canonical, id: ulid }).optional(),
  limit: z.number().int().min(1).max(100),
});
interface DiagnosticRow {
  diagnostic_event_id: string;
  source: "build" | "control" | "runtime" | "function";
  code: string;
  catalog_message: string;
  exception_class: string | null;
  source_file: string | null;
  source_line: number | null;
  source_column: number | null;
  route_template: string | null;
  request_id: string | null;
  trace_id: string | null;
  duration_ms: number | null;
  excerpt: string | null;
  excerpt_truncated: number | null;
  status_code: number | null;
  occurred_at: string;
}

/**
 * One page of a deployment's diagnostics, newest first, inside the seven-day window. Ordering and the cursor use the
 * public millisecond form of the instant plus the event id, so a page boundary never splits one public instant.
 */
export async function readDeploymentDiagnostics(context: CatalogContext, raw: unknown) {
  const input = diagnosticsInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    cursor = input.before === undefined ? null : input.before.occurredAt.slice(0, 23),
    rows = (
      await db
        .prepare(
          `SELECT diagnostic_event_id,source,code,catalog_message,exception_class,source_file,source_line,source_column,
                  route_template,request_id,trace_id,duration_ms,excerpt,excerpt_truncated,status_code,occurred_at
           FROM deployment_diagnostics
           WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND occurred_at>=?4
             AND (?5 IS NULL OR substr(occurred_at,1,23)<?5 OR (substr(occurred_at,1,23)=?5 AND diagnostic_event_id<?6))
           ORDER BY substr(occurred_at,1,23) DESC,diagnostic_event_id DESC LIMIT ?7`,
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.deploymentId,
          addMilliseconds(input.now, -SEVEN_DAYS),
          cursor,
          input.before?.id ?? null,
          input.limit + 1,
        )
        .all<DiagnosticRow>()
    ).results,
    page = rows.slice(0, input.limit),
    last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.diagnostic_event_id,
      source: row.source,
      code: row.code,
      catalogMessage: row.catalog_message,
      exceptionClass: row.exception_class,
      sourceFile: row.source_file,
      sourceLine: row.source_line,
      sourceColumn: row.source_column,
      routeTemplate: row.route_template,
      requestId: row.request_id,
      traceId: row.trace_id,
      durationMs: row.duration_ms,
      excerpt: row.excerpt,
      excerptTruncated: row.excerpt_truncated === null ? null : row.excerpt_truncated === 1,
      statusCode: row.status_code,
      occurredAt: publicTimestamp(row.occurred_at),
    })),
    nextBefore:
      rows.length > input.limit && last !== undefined
        ? { occurredAt: publicTimestamp(last.occurred_at), id: last.diagnostic_event_id }
        : null,
  };
}
