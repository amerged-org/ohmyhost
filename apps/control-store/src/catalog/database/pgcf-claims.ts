import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { CommandConflictError } from "../../run-command.js";
import { addMilliseconds } from "../common.js";
import { instant, isoOf, ulid, type PlatformContext } from "../platform-support.js";

/** A reservation that its activating command has not confirmed within this time is settled by the sweep. */
export const PGCF_CLAIM_TTL_MS = 10 * 60_000;

const providerProjectId = z.string().regex(/^prj_[a-z0-9]{20}$/u);
const databaseId = z.string().regex(/^[a-z][a-z0-9]{19}$/u);

/**
 * The exclusive claim of one PGCF physical database identity. `claimId` is the stable id of the reserving operation
 * (`<operationId>:<targetVersion>`), identical on every retry, and is what the abort tombstone is written under.
 */
export const pgcfClaimInput = z.strictObject({
  providerProjectId,
  databaseId,
  organizationId: ulid,
  projectId: ulid,
  physicalEnvironmentId: ulid,
  targetVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  claimId: z.string().min(1).max(128),
  now: instant,
});
export type PgcfClaim = z.output<typeof pgcfClaimInput>;

/** The physical database identity is held by another owner (or by this owner's other version): never adopted. */
export class PgcfDatabaseTakenError extends CommandConflictError {
  constructor() {
    super("pgcf_database_taken", "The PGCF database identity is claimed by another owner");
    this.name = "PgcfDatabaseTakenError";
  }
}

/** The claim was closed by the sweep or the release: the same claim never commits a head again. */
export class PgcfDatabaseClaimClosedError extends CommandConflictError {
  constructor() {
    super("pgcf_database_claim_closed", "The PGCF database claim expired and was closed");
    this.name = "PgcfDatabaseClaimClosedError";
  }
}

const SAME_OWNER = `pgcf_database_claims.organization_id = excluded.organization_id AND pgcf_database_claims.project_id = excluded.project_id
  AND pgcf_database_claims.physical_environment_id = excluded.physical_environment_id AND pgcf_database_claims.target_version = excluded.target_version
  AND pgcf_database_claims.claim_id = excluded.claim_id`;

/** An active physical identity joins its target revision/head in the caller's ONE shared-Core batch. */
export function activePgcfClaimStatements(db: D1Database, claim: PgcfClaim): D1PreparedStatement[] {
  const values = [
    claim.providerProjectId,
    claim.databaseId,
    claim.organizationId,
    claim.projectId,
    claim.physicalEnvironmentId,
    claim.targetVersion,
    claim.claimId,
    claim.now,
  ];
  return [
    db
      .prepare(
        `INSERT INTO pgcf_database_claims(provider_project_id,database_id,organization_id,project_id,physical_environment_id,target_version,claim_id,state,expires_at,created_at,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,'active',NULL,?8,?8)
    ON CONFLICT(provider_project_id,database_id) DO UPDATE SET updated_at=CASE WHEN pgcf_database_claims.state='reserved' THEN excluded.updated_at ELSE pgcf_database_claims.updated_at END,state='active',expires_at=NULL WHERE ${SAME_OWNER}`,
      )
      .bind(...values),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM pgcf_database_claims WHERE provider_project_id=?1 AND database_id=?2 AND organization_id=?3 AND project_id=?4 AND physical_environment_id=?5 AND target_version=?6 AND claim_id=?7 AND state='active')",
      values.slice(0, 7),
    ),
  ];
}

/**
 * Step 1 of the saga: reserves the physical identity globally before the head is written in the owner's shard.
 * The same owner, version and claim id may reserve again (extends an unconfirmed reservation, leaves a confirmed one
 * untouched); any other claimant gets `PgcfDatabaseTakenError`. A reservation is never adopted by another owner.
 */
export async function reservePgcfDatabaseClaim(
  directory: D1Database,
  claim: PgcfClaim,
): Promise<void> {
  const reserved = await directory
    .prepare(
      `INSERT INTO pgcf_database_claims(provider_project_id, database_id, organization_id, project_id, physical_environment_id, target_version, claim_id, state, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reserved', ?8, ?9, ?9)
       ON CONFLICT (provider_project_id, database_id) DO UPDATE SET
         expires_at = CASE WHEN pgcf_database_claims.state = 'reserved' THEN excluded.expires_at ELSE pgcf_database_claims.expires_at END,
         updated_at = CASE WHEN pgcf_database_claims.state = 'reserved' THEN excluded.updated_at ELSE pgcf_database_claims.updated_at END
        WHERE ${SAME_OWNER}
       RETURNING state`,
    )
    .bind(
      claim.providerProjectId,
      claim.databaseId,
      claim.organizationId,
      claim.projectId,
      claim.physicalEnvironmentId,
      claim.targetVersion,
      claim.claimId,
      addMilliseconds(claim.now, PGCF_CLAIM_TTL_MS),
      claim.now,
    )
    .all();
  if (reserved.results.length !== 1) throw new PgcfDatabaseTakenError();
}

/** An ACTIVE head of the claim's own owner, version and database proves the claim has a live backing row. */
const BACKING_SQL = `SELECT 1 FROM database_provider_target_heads h
  JOIN database_provider_target_revisions r ON r.organization_id = h.organization_id AND r.project_id = h.project_id AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
 WHERE h.organization_id = ?1 AND h.project_id = ?2 AND h.physical_environment_id = ?3 AND h.target_version = ?6 AND h.state = 'active'
   AND r.provider = 'pgcf' AND r.provider_project_id = ?4 AND r.database_id = ?5`;

interface ClaimRow {
  provider_project_id: string;
  database_id: string;
  organization_id: string;
  project_id: string;
  physical_environment_id: string;
  target_version: number;
  claim_id: string;
  state: "reserved" | "active";
}

/**
 * Settles one directory claim against the owner's shard in ONE batch, the pattern of the domain reservation sweep:
 * the batch writes the abort tombstone of the claim only when no ACTIVE head backs it, then reports whether one does.
 * A backing head confirms the claim. No backing head releases it, and the tombstone now fences every shard write of
 * that claim, so a claimant that was only delayed can never commit a head after the identity became reusable.
 * The directory and the shard are different databases: this is a fence, not an atomic transaction.
 */
async function settleClaim(
  context: PlatformContext,
  row: ClaimRow,
  now: string,
): Promise<"confirmed" | "released" | "unchanged"> {
  const shard = (await context.router.routeOrganization(row.organization_id)).db;
  const scope = [
    row.organization_id,
    row.project_id,
    row.physical_environment_id,
    row.provider_project_id,
    row.database_id,
    row.target_version,
  ];
  const [, backing] = await shard.batch([
    shard
      .prepare(
        `INSERT OR IGNORE INTO pgcf_database_claim_aborts(provider_project_id, database_id, organization_id, claim_id, aborted_at)
         SELECT ?4, ?5, ?1, ?7, ?8 WHERE NOT EXISTS (${BACKING_SQL})`,
      )
      .bind(...scope, row.claim_id, now),
    shard.prepare(BACKING_SQL).bind(...scope),
  ]);
  const backed = (backing?.results.length ?? 0) > 0;
  const identity = [row.provider_project_id, row.database_id, row.organization_id, row.claim_id];
  if (backed) {
    const changed = await context.directory
      .prepare(
        `UPDATE pgcf_database_claims SET state = 'active', expires_at = NULL, updated_at = ?5
          WHERE provider_project_id = ?1 AND database_id = ?2 AND organization_id = ?3 AND claim_id = ?4 AND state = 'reserved'`,
      )
      .bind(...identity, now)
      .run();
    return changed.meta.changes === 1 ? "confirmed" : "unchanged";
  }
  const changed = await context.directory
    .prepare(
      `DELETE FROM pgcf_database_claims
        WHERE provider_project_id = ?1 AND database_id = ?2 AND organization_id = ?3 AND claim_id = ?4 AND state = ?5`,
    )
    .bind(...identity, row.state)
    .run();
  return changed.meta.changes === 1 ? "released" : "unchanged";
}

export const settlePgcfDatabaseClaimsInput = z.strictObject({
  now: instant,
  limit: z.number().int().min(1).max(500).default(100),
});

/**
 * Repair sweep: every reservation past its expiry is settled against its shard. Only `reserved` rows are touched; a
 * confirmed claim is released solely by `releasePgcfDatabaseClaim` after its head has retired.
 */
export async function settlePgcfDatabaseClaims(
  context: PlatformContext,
  raw: unknown,
): Promise<{ readonly confirmed: number; readonly released: number }> {
  const input = settlePgcfDatabaseClaimsInput.parse(raw);
  const due = await context.directory
    .prepare(
      `SELECT provider_project_id, database_id, organization_id, project_id, physical_environment_id, target_version, claim_id, state
         FROM pgcf_database_claims WHERE state = 'reserved' AND expires_at < ?1 ORDER BY expires_at, provider_project_id, database_id LIMIT ?2`,
    )
    .bind(input.now, input.limit)
    .all<ClaimRow>();
  let confirmed = 0;
  let released = 0;
  for (const row of due.results) {
    const outcome = await settleClaim(context, row, input.now);
    if (outcome === "confirmed") confirmed += 1;
    if (outcome === "released") released += 1;
  }
  return { confirmed, released };
}

export const releasePgcfDatabaseClaimInput = z.strictObject({
  providerProjectId,
  databaseId,
  now: instant,
});

/**
 * Makes a physical identity reusable after its head retired: the shard batch tombstones the claim unless an ACTIVE
 * head still backs it (then the claim is kept and `held` is reported). Idempotent; an identity nobody holds is `absent`.
 */
export async function releasePgcfDatabaseClaim(
  context: PlatformContext,
  raw: unknown,
): Promise<"released" | "held" | "absent"> {
  const input = releasePgcfDatabaseClaimInput.parse(raw);
  const row = await context.directory
    .prepare(
      `SELECT provider_project_id, database_id, organization_id, project_id, physical_environment_id, target_version, claim_id, state
         FROM pgcf_database_claims WHERE provider_project_id = ?1 AND database_id = ?2`,
    )
    .bind(input.providerProjectId, input.databaseId)
    .first<ClaimRow>();
  if (row === null) return "absent";
  const outcome = await settleClaim(context, row, input.now);
  return outcome === "released" ? "released" : "held";
}

/** The owner of an identity, for diagnostics and the inventory of held claims. */
export async function readPgcfDatabaseClaim(
  context: PlatformContext,
  raw: unknown,
): Promise<{
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly targetVersion: number;
  readonly claimId: string;
  readonly state: "reserved" | "active";
  readonly expiresAt: string | null;
} | null> {
  const input = z.strictObject({ providerProjectId, databaseId }).parse(raw);
  const row = await context.directory
    .prepare(
      `SELECT organization_id, project_id, physical_environment_id, target_version, claim_id, state, expires_at FROM pgcf_database_claims WHERE provider_project_id = ?1 AND database_id = ?2`,
    )
    .bind(input.providerProjectId, input.databaseId)
    .first<ClaimRow & { expires_at: string | null }>();
  return row === null
    ? null
    : {
        organizationId: row.organization_id,
        projectId: row.project_id,
        physicalEnvironmentId: row.physical_environment_id,
        targetVersion: row.target_version,
        claimId: row.claim_id,
        state: row.state,
        expiresAt: row.expires_at === null ? null : isoOf(row.expires_at),
      };
}
