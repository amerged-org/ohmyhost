import { publicTimestamp, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { monthPeriod } from "../credit/account.js";
import { publicCreditInput } from "./public-reads.js";

const inputSchema = publicCreditInput.extend({ projectId: ulid.optional() });

/** The report stays bounded: no organization lists more projects than this. */
const MAX_PROJECTS = 1000;

/**
 * What each project of the organization used this UTC month, from its `project_credit` row. The daily lines of the
 * credit log (rotated to R2 after midnight) come from the credit service; the Core only holds the month's total.
 * A project whose count belongs to an earlier month has used nothing yet.
 */
export async function readCreditUsage(context: CatalogContext, raw: unknown) {
  const input = inputSchema.parse(raw);
  const db = (await routeOrganization(context, input.organizationId)).db;
  const period = monthPeriod(input.now);
  const rows = await db
    .prepare(
      `SELECT project_id, used_micros FROM project_credit
       WHERE organization_id = ?1 AND period = ?2 AND used_micros > 0 AND (?3 IS NULL OR project_id = ?3)
       ORDER BY project_id LIMIT ${MAX_PROJECTS}`,
    )
    .bind(input.organizationId, period, input.projectId ?? null)
    .all<{ project_id: string; used_micros: number }>();
  return {
    organization_id: input.organizationId,
    as_of: publicTimestamp(input.now),
    unit: "microcredits" as const,
    period,
    projects: rows.results.map((row) => ({
      project_id: row.project_id,
      used_micros: String(row.used_micros),
    })),
  };
}
