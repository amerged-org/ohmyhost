import { z } from "zod";
import { classifyFailure, guard } from "../../guards.js";
import { StoreOutcomeUnknownError } from "../../run-command.js";
import { instant, ulid, type CatalogContext } from "../common.js";
import {
  DIAGNOSTIC_ENVIRONMENT_CAP,
  recordWorkflowDiagnostic,
} from "../provisioning/diagnostics.js";

const signedDiagnostic = z.strictObject({
  id: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  deploymentId: ulid,
  source: z.enum(["build", "control", "runtime", "function"]),
  code: z.enum([
    "BUILD_NOT_STARTED",
    "BUILD_FAILED",
    "CONTROL_FAILED",
    "WFP_CANDIDATE_OUTDATED",
    "DEPLOYMENT_FAILED",
    "FUNCTION_FAILED",
    "HEALTH_CHECK_FAILED",
    "RUNTIME_EXCEPTION",
    "RUNTIME_FAILED",
  ]),
  catalogMessage: z.string(),
  occurredAt: instant,
  recordedAt: instant,
});
/** Only the original verified marker projection; no raw exception, request, excerpt or customer text crosses this capability. */
export async function recordConsumerDiagnostic(context: CatalogContext, raw: unknown) {
  const input = signedDiagnostic.parse(raw);
  return recordWorkflowDiagnostic(context, {
    ...input,
    exceptionClass: null,
    sourceFile: null,
    sourceLine: null,
    sourceColumn: null,
    routeTemplate: null,
    requestId: null,
    traceId: null,
    durationMs: null,
    excerpt: null,
    excerptTruncated: null,
    statusCode: null,
  });
}

const purgeInput = z.strictObject({ cutoff: instant, limit: z.number().int().min(1).max(1000) });
/**
 * One bounded global purge: rows past the seven-day cutoff, and each environment's rows beyond its newest cap, oldest
 * first, never more than the page limit in total. A lost response stays unknown; it never silently deletes a second page.
 */
export async function purgeConsumerDiagnostics(
  context: CatalogContext,
  raw: unknown,
): Promise<number> {
  const input = purgeInput.parse(raw),
    { db } = await context.router.routeShard(0);
  try {
    const [result] = await db
      .batch([
        // Retention must not mutate an operator-quarantined bucket while its source is being inspected.
        guard(db, "bucket_fenced", "EXISTS(SELECT 1 FROM bucket_fences)"),
        db
          .prepare(
            `DELETE FROM deployment_diagnostics WHERE diagnostic_event_id IN
        (SELECT diagnostic_event_id FROM (SELECT diagnostic_event_id,occurred_at,recorded_at,ROW_NUMBER() OVER (PARTITION BY organization_id,project_id,environment_id ORDER BY occurred_at DESC,diagnostic_event_id DESC) AS newest FROM deployment_diagnostics)
        WHERE (occurred_at<?1 AND recorded_at<?1) OR newest>?3 ORDER BY occurred_at,diagnostic_event_id LIMIT ?2) RETURNING 1`,
          )
          .bind(input.cutoff, input.limit, DIAGNOSTIC_ENVIRONMENT_CAP),
      ])
      .then((results) => results.slice(1));
    if (result === undefined)
      throw new StoreOutcomeUnknownError("diagnostics.purge: missing batch result");
    return result.meta.changes;
  } catch (error) {
    if (classifyFailure(error).kind === "transient")
      throw new StoreOutcomeUnknownError("diagnostics.purge: outcome unknown");
    throw error;
  }
}
