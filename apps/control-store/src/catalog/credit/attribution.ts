import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import { instant, publicTimestamp } from "../common.js";
import { inventoryDigest } from "../provisioning/lifecycle-inventory.js";
import type { BindCreditCommand } from "./runtime.js";

/*
 * The three reads that attribute provider usage to an organization, a project and an environment for the credit
 * service: PGCF databases (per hour), R2 buckets and lifetime resources (per UTC day). They read only the registries
 * of the Core that outlive the credit tables (serving intervals, bucket receipts, WFP candidate receipts, custom
 * domains, billing epochs) and write nothing.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const boundary = (ms: number) =>
  instant.refine((value) => Date.parse(publicTimestamp(value)) % ms === 0, "not aligned");
const cursor = z.string().min(1).max(200).nullable();

const pgcfInput = z.strictObject({
  databaseIds: z.array(z.string().min(1).max(64)).max(100),
  at: boundary(HOUR_MS),
});
const pendingNativeInput = z
  .strictObject({ from: boundary(HOUR_MS), to: boundary(HOUR_MS) })
  .refine((value) => value.from < value.to);
const pageInput = (max: number) =>
  z.strictObject({
    day: boundary(DAY_MS),
    after: cursor,
    limit: z.number().int().min(1).max(max),
  });

/** The stored form of the instant `ms` after the stored instant `from`. */
const after = (from: string, ms: number): string =>
  `${new Date(Date.parse(publicTimestamp(from)) + ms).toISOString().slice(0, 23)}000Z`;

/*
 * The owner of a project is the organization of its billing epoch that is open at the end of the day (?1): the
 * organization that holds the project when the day closes pays for the whole day. A project whose deletion completed
 * before `cutoff` (?2) is not owned by anybody any more; a deleted project's `updated_at` is the instant its deletion
 * completed. The R2 pass cuts at the start of the day, so the deletion day is billed for the buckets it stored; the
 * resource pass cuts at the end of the day, where a deleted project holds no live resource. `max(started_at)` makes
 * SQLite take the other columns of the latest epoch should a project ever carry two that cover the instant.
 */
const OWNERS = `owner AS (
  SELECT epoch.project_id AS project_id, epoch.organization_id AS organization_id, max(epoch.started_at) AS started_at
  FROM billing_epochs epoch
    JOIN projects project ON project.organization_id = epoch.organization_id AND project.project_id = epoch.project_id
  WHERE epoch.started_at < ?1 AND (epoch.ended_at IS NULL OR epoch.ended_at >= ?1)
    AND NOT (project.lifecycle_state = 'deleted' AND project.updated_at < ?2)
  GROUP BY epoch.project_id
)`;

/** The data environment that a logical environment pointed at when `at` was current. */
const ASSIGNED_AT = (at: string) =>
  `(SELECT x.data_environment_id FROM environment_data_assignments x
     WHERE x.organization_id = a.organization_id AND x.project_id = a.project_id AND x.environment_id = a.environment_id
       AND x.assigned_at <= ${at}
     ORDER BY x.assigned_at DESC, x.assignment_version DESC LIMIT 1)`;

/** Mutable archived names are never historical truth: use the immutable restoration boundary at each instant. */
const ACTIVE_ENVIRONMENT_AT = (
  at: string,
) => `EXISTS(SELECT 1 FROM environments lifetime WHERE lifetime.organization_id=a.organization_id AND lifetime.project_id=a.project_id AND lifetime.environment_id=a.environment_id AND lifetime.created_at<=${at}
 AND(lifetime.name IN('dev','prod') OR EXISTS(SELECT 1 FROM dev_environment_restorations archived WHERE archived.organization_id=lifetime.organization_id AND archived.project_id=lifetime.project_id AND archived.previous_environment_id=lifetime.environment_id AND archived.archived_at>${at}))
 AND NOT EXISTS(SELECT 1 FROM dev_environment_restorations archived WHERE archived.organization_id=lifetime.organization_id AND archived.project_id=lifetime.project_id AND archived.previous_environment_id=lifetime.environment_id AND archived.archived_at<=${at}))`;

/*
 * PGCF databases of one hour (?2 .. ?3): the serving intervals that overlap the hour, grouped by owner. A database is
 * resolved only when one owner holds it for the whole hour, the hour is not before `billable_from`, and the database
 * is not a platform database. App targets begin on the first full hour after activation; Native Auth targets begin
 * at the original dispatch hour. Logical environments apply only to application data targets.
 */
const PGCF_SQL = `WITH wanted AS (SELECT DISTINCT value AS database_id FROM json_each(?1)),
  spans AS (
    SELECT s.database_id AS database_id, s.organization_id AS organization_id, s.project_id AS project_id,
      s.physical_environment_id AS physical_environment_id, min(s.billable_from) AS billable_from,
      'application_database' AS resource_kind
    FROM pgcf_database_serving_intervals s
    WHERE s.database_id IN (SELECT database_id FROM wanted)
      AND s.started_at < ?3 AND (s.ended_at IS NULL OR s.ended_at > ?2)
    GROUP BY s.database_id, s.organization_id, s.project_id, s.physical_environment_id
    UNION ALL
    SELECT target.database_id, epoch.organization_id, target.project_id, NULL, target.billable_from,
      'native_auth_database' AS resource_kind
    FROM native_auth_database_targets target JOIN billing_epochs epoch ON epoch.project_id=target.project_id
    WHERE target.database_id IN (SELECT database_id FROM wanted)
      AND target.started_at < ?3 AND (target.ended_at IS NULL OR target.ended_at > ?2)
      AND epoch.started_at <= CASE WHEN target.started_at>?2 THEN target.started_at ELSE ?2 END
      AND (epoch.ended_at IS NULL OR epoch.ended_at >= CASE WHEN target.ended_at<?3 THEN target.ended_at ELSE ?3 END)
      AND epoch.started_at < COALESCE(target.ended_at, '9999-12-31T23:59:59.999999Z')
      AND (epoch.ended_at IS NULL OR epoch.ended_at > target.started_at)
  )
  SELECT span.database_id AS database_id, span.organization_id AS organization_id, span.project_id AS project_id,
    span.physical_environment_id AS physical_environment_id, span.resource_kind AS resource_kind,
    EXISTS(SELECT 1 FROM dev_environment_restorations changed WHERE changed.organization_id=span.organization_id AND changed.project_id=span.project_id AND changed.archived_at>?2 AND changed.archived_at<?3 AND(changed.physical_environment_id=span.physical_environment_id OR EXISTS(SELECT 1 FROM environment_data_assignments prior WHERE prior.organization_id=changed.organization_id AND prior.project_id=changed.project_id AND prior.environment_id=changed.previous_environment_id AND prior.data_environment_id=span.physical_environment_id))) identity_changed,
    (SELECT json_group_array(environment_id) FROM (
       SELECT DISTINCT a.environment_id AS environment_id FROM environment_data_assignments a
       WHERE a.organization_id = span.organization_id AND a.project_id = span.project_id
         AND ${ASSIGNED_AT("?2")} = span.physical_environment_id
         AND ${ASSIGNED_AT("?4")} = span.physical_environment_id
         AND ${ACTIVE_ENVIRONMENT_AT("?2")} AND ${ACTIVE_ENVIRONMENT_AT("?4")}
       ORDER BY a.environment_id)) AS environment_ids
  FROM spans span
  WHERE span.billable_from <= ?2
    AND (SELECT count(*) FROM spans other WHERE other.database_id = span.database_id) = 1
    AND NOT EXISTS (SELECT 1 FROM pgcf_platform_database_activations platform WHERE platform.database_id = span.database_id)
  ORDER BY span.database_id`;

/** Buckets created before the day closed, whose project was not deleted before the day began. */
const BUCKETS_SQL = `WITH ${OWNERS}
  SELECT r.jurisdiction || '/' || r.bucket_name AS position, r.bucket_name AS bucket_name, r.jurisdiction AS jurisdiction,
    owner.organization_id AS organization_id, r.project_id AS project_id, r.environment_id AS environment_id
  FROM project_r2_bucket_receipts r
    JOIN owner ON owner.project_id = r.project_id
  WHERE r.created_at < ?1 AND (?3 IS NULL OR r.jurisdiction || '/' || r.bucket_name > ?3)
    AND NOT EXISTS(SELECT 1 FROM free_dev_retirement_resources removed WHERE removed.organization_id=r.organization_id AND removed.project_id=r.project_id AND removed.kind='r2-bucket' AND removed.locator=r.bucket_name AND removed.state='removed' AND removed.removed_at<=?2)
  ORDER BY position
  LIMIT CAST(?4 AS INTEGER)`;

/*
 * A WFP candidate script is alive when the day closes (?1) unless it was retired or cleaned up before then. A project
 * deletion removes its scripts without a cleanup receipt; the removal is a cleanup attempt of the script's inventory row,
 * which `withoutRemovedScripts` subtracts.
 */
const SCRIPT_ALIVE = `r.staged_at < ?1
      AND NOT EXISTS(SELECT 1 FROM free_dev_retirement_resources removed WHERE removed.organization_id=r.organization_id AND removed.project_id=r.project_id AND removed.kind='wfp-script' AND removed.locator=r.dispatch_namespace||'/'||r.immutable_script_name AND removed.state='removed' AND removed.removed_at<?1)
      AND NOT EXISTS (
        SELECT 1 FROM wfp_candidate_cleanup_receipts cleaned
        WHERE cleaned.candidate_receipt_id = r.candidate_receipt_id AND cleaned.observed_at < ?1)`;

/*
 * WFP scripts staged before the day closed and not cleaned up by then, and custom hostnames provisioned and not
 * deleted by then. A hostname belongs to the prod environment, which its gateway serves. The project must be alive
 * when the day closes.
 */
const RESOURCES_SQL = `WITH ${OWNERS},
  counted AS (
    SELECT owner.organization_id AS organization_id, r.project_id AS project_id, r.environment_id AS environment_id,
      count(*) AS scripts, 0 AS hostnames
    FROM wfp_candidate_receipts r
      JOIN owner ON owner.project_id = r.project_id
    WHERE ${SCRIPT_ALIVE}
    GROUP BY owner.organization_id, r.project_id, r.environment_id
    UNION ALL
    SELECT owner.organization_id, d.project_id, prod.environment_id, 0, count(DISTINCT d.hostname)
    FROM paid_project_domains d
      JOIN owner ON owner.project_id = d.project_id
      JOIN environments prod ON prod.organization_id = owner.organization_id AND prod.project_id = d.project_id AND prod.name = 'prod'
    WHERE d.custom_hostname_receipt IS NOT NULL AND d.provisioning_started_at < ?1
      AND (d.deleted_at IS NULL OR d.deleted_at >= ?1)
    GROUP BY owner.organization_id, d.project_id, prod.environment_id
  )
  SELECT organization_id, project_id, environment_id, sum(scripts) AS scripts, sum(hostnames) AS hostnames
  FROM counted
  GROUP BY organization_id, project_id, environment_id
  HAVING ?3 IS NULL OR organization_id || '/' || project_id || '/' || environment_id > ?3
  ORDER BY organization_id, project_id, environment_id
  LIMIT CAST(?4 AS INTEGER)`;

/** The inventory rows of WFP scripts of the given organizations (?1) and projects (?3) that a cleanup attempt removed before `?2`. */
const REMOVED_SCRIPTS_SQL = `SELECT inventory.organization_id AS organization_id, inventory.project_id AS project_id,
    lower(hex(inventory.external_ref_hash)) AS hash
  FROM run_resource_inventory inventory
  WHERE inventory.organization_id IN (SELECT value FROM json_each(?1))
    AND inventory.project_id IN (SELECT value FROM json_each(?3))
    AND inventory.provider = 'cloudflare' AND inventory.resource_kind = 'wfp-script'
    AND EXISTS (SELECT 1 FROM run_cleanup_attempts attempt
      WHERE attempt.organization_id = inventory.organization_id AND attempt.project_id = inventory.project_id
        AND attempt.operation_id = inventory.operation_id AND attempt.provider = inventory.provider
        AND attempt.resource_kind = inventory.resource_kind AND attempt.external_ref_hash = inventory.external_ref_hash
        AND attempt.outcome IN ('removed', 'not_found') AND attempt.attempted_at < ?2)`;

/** The WFP candidate scripts alive when the day closes (?1) of the given organizations (?2) and projects (?3). */
const LIVE_SCRIPTS_SQL = `SELECT r.organization_id AS organization_id, r.project_id AS project_id, r.environment_id AS environment_id,
    r.dispatch_namespace AS dispatch_namespace, r.immutable_script_name AS immutable_script_name
  FROM wfp_candidate_receipts r
  WHERE r.organization_id IN (SELECT value FROM json_each(?2)) AND r.project_id IN (SELECT value FROM json_each(?3))
    AND ${SCRIPT_ALIVE}`;

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Takes out of each record the live scripts that a cleanup attempt removed before the day closed (`end`). The scripts
 * stay counted in `RESOURCES_SQL` because their candidate receipts have no cleanup receipt; the attempt of the deletion
 * or the retirement that removed them is the evidence. The records keep their order and length, so paging is unchanged.
 */
async function withoutRemovedScripts(
  db: D1Database,
  records: readonly ResourceRecord[],
  end: string,
): Promise<ResourceRecord[]> {
  // the reads are scoped to the projects of the page, not to every project of its organizations
  const organizations = JSON.stringify([
    ...new Set(records.map((record) => record.organization_id)),
  ]);
  const projects = JSON.stringify([...new Set(records.map((record) => record.project_id))]);
  const removed = new Set(
    (
      await db.prepare(REMOVED_SCRIPTS_SQL).bind(organizations, end, projects).all<{
        organization_id: string;
        project_id: string;
        hash: string;
      }>()
    ).results.map((row) => `${row.organization_id}/${row.project_id}/${row.hash}`),
  );
  if (removed.size === 0) return [...records];
  const cut = new Map<string, number>();
  for (const script of (
    await db.prepare(LIVE_SCRIPTS_SQL).bind(end, organizations, projects).all<{
      organization_id: string;
      project_id: string;
      environment_id: string;
      dispatch_namespace: string;
      immutable_script_name: string;
    }>()
  ).results) {
    const digest = hexOf(
      inventoryDigest(
        "cloudflare",
        "wfp-script",
        `${script.dispatch_namespace}/${script.immutable_script_name}`,
      ),
    );
    if (!removed.has(`${script.organization_id}/${script.project_id}/${digest}`)) continue;
    const key = `${script.organization_id}/${script.project_id}/${script.environment_id}`;
    cut.set(key, (cut.get(key) ?? 0) + 1);
  }
  return records.map((record) => {
    const taken =
      cut.get(`${record.organization_id}/${record.project_id}/${record.environment_id}`) ?? 0;
    return taken === 0 ? record : { ...record, scripts: record.scripts - taken };
  });
}

interface PgcfRecord {
  database_id: string;
  organization_id: string;
  project_id: string;
  physical_environment_id: string | null;
  resource_kind: "application_database" | "native_auth_database";
  environment_ids: string;
  identity_changed: number;
}
interface BucketRecord {
  position: string;
  bucket_name: string;
  jurisdiction: "eu" | "us";
  organization_id: string;
  project_id: string;
  environment_id: string;
}
interface ResourceRecord {
  organization_id: string;
  project_id: string;
  environment_id: string;
  scripts: number;
  hostnames: number;
}

/** A page of `limit` rows and the cursor of its last row when more follow; the queries are asked for one row more. */
function paged<Source, Row>(
  records: readonly Source[],
  limit: number,
  position: (record: Source) => string,
  row: (record: Source) => Row,
): { rows: Row[]; next: string | null } {
  const page = records.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map(row),
    next: records.length > limit && last !== undefined ? position(last) : null,
  };
}

export function createAttributionCommands(bind: BindCreditCommand) {
  return Object.freeze({
    /** Hold the collector at the first unresolved Auth-create dispatch hour until its identity is observed. */
    readPendingNativeDatabaseCreates: bind(async (context, raw) => {
      const input = pendingNativeInput.parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const row = await db
        .prepare(
          "SELECT min(dispatched_at) AS earliest FROM native_auth_database_operations WHERE state='dispatched' AND database_id IS NULL AND dispatched_at<?1",
        )
        .bind(input.to)
        .first<{ earliest: string | null }>();
      if (row?.earliest == null) return { holdFrom: null };
      const floor = `${row.earliest.slice(0, 13)}:00:00.000Z`,
        from = publicTimestamp(input.from);
      return { holdFrom: floor < from ? from : floor };
    }),
    /**
     * The customer owner of each PGCF database during the hour that starts at `at`: databases that are unknown,
     * platform-owned, not yet billable or held by several owners within the hour are left out. Application databases
     * resolve to a logical or physical environment; Native Auth databases remain project-scoped.
     */
    resolvePgcfDatabases: bind(async (context, raw) => {
      const input = pgcfInput.parse(raw);
      const ids = [...new Set(input.databaseIds)];
      if (ids.length === 0) return [];
      const db = (await context.router.routeShard(0)).db;
      // the hour ends at the next full hour; its last microsecond is 999 µs into the last millisecond
      const lastMicrosecond = `${after(input.at, HOUR_MS - 1).slice(0, 23)}999Z`;
      const result = await db
        .prepare(PGCF_SQL)
        .bind(JSON.stringify(ids), input.at, after(input.at, HOUR_MS), lastMicrosecond)
        .all<PgcfRecord>();
      return result.results.map((record) => {
        if (record.resource_kind === "native_auth_database")
          return {
            databaseId: record.database_id,
            organizationId: record.organization_id,
            projectId: record.project_id,
            resourceKind: "native_auth_database" as const,
          };
        const environments = JSON.parse(record.environment_ids) as string[];
        if (record.physical_environment_id === null)
          throw new TypeError("Missing application data environment");
        return {
          databaseId: record.database_id,
          organizationId: record.organization_id,
          projectId: record.project_id,
          environmentId:
            record.identity_changed !== 1 &&
            environments.length === 1 &&
            environments[0] !== undefined
              ? environments[0]
              : record.physical_environment_id,
        };
      });
    }),

    /** Every customer bucket that existed during the UTC day, with its owner at the end of that day. */
    listR2Buckets: bind(async (context, raw) => {
      const input = pageInput(1000).parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const result = await db
        .prepare(BUCKETS_SQL)
        .bind(after(input.day, DAY_MS), input.day, input.after, input.limit + 1)
        .all<BucketRecord>();
      const { rows, next } = paged(
        result.results,
        input.limit,
        (record) => record.position,
        (record) => ({
          bucketName: record.bucket_name,
          jurisdiction: record.jurisdiction,
          organizationId: record.organization_id,
          projectId: record.project_id,
          environmentId: record.environment_id,
        }),
      );
      return { buckets: rows, next };
    }),

    /** The WFP scripts and custom hostnames alive at the end of the UTC day, per organization, project, environment. */
    readResources: bind(async (context, raw) => {
      const input = pageInput(1000).parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const end = after(input.day, DAY_MS);
      const result = await db
        .prepare(RESOURCES_SQL)
        .bind(end, end, input.after, input.limit + 1)
        .all<ResourceRecord>();
      const { rows, next } = paged(
        await withoutRemovedScripts(db, result.results, end),
        input.limit,
        (record) => `${record.organization_id}/${record.project_id}/${record.environment_id}`,
        (record) => ({
          organizationId: record.organization_id,
          projectId: record.project_id,
          environmentId: record.environment_id,
          scripts: record.scripts,
          hostnames: record.hostnames,
        }),
      );
      // a project whose scripts were all removed has nothing left to bill that day; the cursor is the SQL page's
      return { rows: rows.filter((row) => row.scripts > 0 || row.hostnames > 0), next };
    }),
  });
}
