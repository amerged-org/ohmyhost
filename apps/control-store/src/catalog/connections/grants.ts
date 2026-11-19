import { z } from "zod";
import { classifyFailure, guard } from "../../guards.js";
import { digestOf, IdempotencyConflictError, runCommand } from "../../run-command.js";
import { integrationMutationGuards, mutationAuthority } from "./mutation-authority.js";
import type { D1Database } from "../../d1-types.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import {
  canonicalAuthorizationCondition,
  canonicalAuthorizationGuard,
} from "../projects/customer-projects-access.js";

const id = z.string().min(1).max(256);
const hex = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/u)
  .max(16384);
// 256 KiB of sealed token JSON plus the 16-byte AES-GCM tag, represented as hex.
const grantCiphertext = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/u)
  .max(524_320);
const sealed = z.strictObject({
  nonce: hex.length(24),
  ciphertext: grantCiphertext,
  keyVersion: z.number().int().positive().max(2147483647),
});
const now = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
type Owner = {
  organization_id: string;
  principal_id: string;
  workspace: number;
};
function familyDb(db: D1Database, o: Owner): D1Database {
  if (!o.workspace) return db;
  return {
    prepare: (sql) =>
      db.prepare(
        sql.replace(
          /\b(connection_refresh_orphans|connection_grants|connection_attempts|connection_handoffs)\b/gu,
          "workspace_$1",
        ),
      ),
    batch: (statements) => db.batch(statements),
  };
}
async function owner(context: CatalogContext, grantId: string): Promise<Owner | null> {
  const db = (await context.router.routeShard(0)).db;
  return db
    .prepare(
      "SELECT h.organization_id,h.principal_id,0 AS workspace FROM connection_grants g JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) WHERE g.grant_id=?1 UNION ALL SELECT h.organization_id,h.principal_id,1 AS workspace FROM workspace_connection_grants g JOIN workspace_connection_attempts a USING(attempt_id) JOIN workspace_connection_handoffs h USING(handoff_hash) WHERE g.grant_id=?1",
    )
    .bind(grantId)
    .first<Owner>();
}
function ownerGuards(db: D1Database, o: Owner) {
  const scope = {
    organizationId: o.organization_id,
    principalId: o.principal_id,
    action: "integrations:manage" as const,
  };
  return [
    canonicalAuthorizationGuard(db, scope),
    guard(
      db,
      "consent_changed",
      "EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(?1,6))",
      [o.principal_id],
    ),
  ];
}
const claim = z.strictObject({ grantId: ulid, claimId: ulid });
/** Claims one token generation. A timed-out dispatched claim can never be redeemed a second time. */
export async function claimConnectionRefresh(context: CatalogContext, raw: unknown) {
  const i = claim.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return null;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    ...ownerGuards(db, o),
    db
      .prepare(
        `UPDATE connection_grants SET state='reconnect_required' WHERE grant_id=?1 AND state='refreshing' AND refresh_dispatched=1 AND refresh_claim_expires_at<=${now}`,
      )
      .bind(i.grantId),
    db
      .prepare(
        `UPDATE connection_grants SET state='refreshing',refresh_claim_id=?2,refresh_claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now','+1 minutes')||'000Z'),refresh_dispatched=0 WHERE grant_id=?1 AND (state='active' OR (state='refreshing' AND refresh_dispatched=0 AND refresh_claim_expires_at<=${now}))`,
      )
      .bind(i.grantId, i.claimId),
    db
      .prepare(
        `SELECT g.grant_id,g.generation,g.token_nonce,g.token_ciphertext,g.key_version,h.organization_id,h.project_id,h.environment_id,h.principal_id,h.registration FROM connection_grants g JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) WHERE g.grant_id=?1 AND g.state='refreshing' AND g.refresh_claim_id=?2 AND g.refresh_dispatched=0 AND g.refresh_claim_expires_at>${now}`,
      )
      .bind(i.grantId, i.claimId),
  ]);
  const row = r.at(-1)?.results[0] as
    | {
        grant_id: string;
        generation: number;
        token_nonce: string;
        token_ciphertext: string;
        key_version: number;
        organization_id: string;
        project_id: string | null;
        environment_id: string | null;
        principal_id: string;
        registration: string;
      }
    | undefined;
  return row
    ? {
        grantId: row.grant_id,
        claimId: i.claimId,
        generation: row.generation,
        organizationId: row.organization_id,
        ...(row.project_id === null ? {} : { projectId: row.project_id }),
        ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
        principalId: row.principal_id,
        registration: row.registration,
        encryptedTokens: {
          nonce: row.token_nonce,
          ciphertext: row.token_ciphertext,
          keyVersion: row.key_version,
        },
      }
    : null;
}
const transition = claim.extend({ generation: z.number().int().positive().max(2147483647) });
/** Dispatch is a one-way marker: a lost response must not cause a second provider call. */
export async function markConnectionRefreshDispatched(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = transition.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    ...ownerGuards(db, o),
    db
      .prepare(
        `UPDATE connection_grants SET refresh_dispatched=1 WHERE grant_id=?1 AND state='refreshing' AND refresh_claim_id=?2 AND generation=?3 AND refresh_dispatched=0 AND refresh_claim_expires_at>${now}`,
      )
      .bind(i.grantId, i.claimId, i.generation),
  ]);
  return r.at(-1)?.meta.changes === 1;
}
export async function commitConnectionRefresh(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = transition.extend({ encryptedTokens: sealed }).parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    ...ownerGuards(db, o),
    db
      .prepare(
        "UPDATE connection_grants SET state='active',generation=generation+1,token_nonce=?4,token_ciphertext=?5,key_version=?6,refresh_committed_claim_id=?2,refresh_claim_id=NULL,refresh_claim_expires_at=NULL,refresh_dispatched=0 WHERE grant_id=?1 AND state='refreshing' AND refresh_claim_id=?2 AND generation=?3 AND refresh_dispatched=1 AND generation<2147483647 AND NOT EXISTS(SELECT 1 FROM connection_refresh_orphans orphan WHERE orphan.grant_id=connection_grants.grant_id AND orphan.claim_id=?2)",
      )
      .bind(
        i.grantId,
        i.claimId,
        i.generation,
        i.encryptedTokens.nonce,
        i.encryptedTokens.ciphertext,
        i.encryptedTokens.keyVersion,
      ),
    db
      .prepare(
        "SELECT 1 FROM connection_grants WHERE grant_id=?1 AND state='active' AND generation=?3+1 AND refresh_committed_claim_id=?2 AND token_nonce=?4 AND token_ciphertext=?5 AND key_version=?6",
      )
      .bind(
        i.grantId,
        i.claimId,
        i.generation,
        i.encryptedTokens.nonce,
        i.encryptedTokens.ciphertext,
        i.encryptedTokens.keyVersion,
      ),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}
export async function failConnectionRefresh(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = transition
      .extend({ outcome: z.enum(["invalid_grant", "outcome_unknown", "rate_limited"]) })
      .parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    ...ownerGuards(db, o),
    db
      .prepare(
        "UPDATE connection_grants SET state=CASE WHEN ?4='rate_limited' THEN 'active' ELSE 'reconnect_required' END, refresh_claim_id=CASE WHEN ?4='rate_limited' THEN NULL ELSE refresh_claim_id END, refresh_claim_expires_at=CASE WHEN ?4='rate_limited' THEN NULL ELSE refresh_claim_expires_at END, refresh_dispatched=CASE WHEN ?4='rate_limited' THEN 0 ELSE refresh_dispatched END WHERE grant_id=?1 AND state='refreshing' AND refresh_claim_id=?2 AND generation=?3 AND refresh_dispatched=1",
      )
      .bind(i.grantId, i.claimId, i.generation, i.outcome),
  ]);
  return r.at(-1)?.meta.changes === 1;
}
export async function disconnectConnectionGrant(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = z
      .strictObject({
        organizationId: ulid,
        grantId: ulid,
        principalId: id,
        idempotencyKey: z.string().min(1).max(256),
        mutationAuthority,
      })
      .parse(raw),
    o = await owner(context, i.grantId);
  if (!o || o.organization_id !== i.organizationId || o.principal_id !== i.principalId)
    return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const guards = () => [...ownerGuards(db, o), ...integrationMutationGuards(db, i)];
  const current = async () => {
    try {
      await db.batch(guards());
      return true;
    } catch (error) {
      if (classifyFailure(error).kind === "guard") return false;
      throw error;
    }
  };
  if (!(await current())) return false;
  const commandId = await digestOf({
    namespace: "integration-disconnect",
    organizationId: i.organizationId,
    principalId: i.principalId,
    idempotencyKey: i.idempotencyKey,
  });
  // Session renewal changes only token expiry; it must not create a new mutation identity.
  const commandAuthority =
    i.mutationAuthority.kind === "session"
      ? Object.fromEntries(
          Object.entries(i.mutationAuthority).filter(([key]) => key !== "tokenExpiresAt"),
        )
      : i.mutationAuthority;
  try {
    const result = await runCommand(db, {
      name: "connections.disconnectGrant",
      input: { ...i, mutationAuthority: commandAuthority },
      commandId,
      read: async () => null,
      decide: () => ({
        statements: [
          ...guards(),
          db
            .prepare(
              "UPDATE connection_grants SET state='disconnecting',revocation_status='pending' WHERE grant_id=?1 AND state IN ('pending','active','refreshing','reconnect_required')",
            )
            .bind(i.grantId),
          guard(db, "operation_conflict", "changes()<>1"),
        ],
        result: () => true,
        logResult: true,
      }),
      fromLog: (value) => value === true,
    });
    return result && (await current());
  } catch (error) {
    if (error instanceof IdempotencyConflictError)
      throw new Error("integration_idempotency_conflict");
    const failure = classifyFailure(error);
    if (
      failure.kind === "guard" &&
      (failure.code === "operation_conflict" || failure.code === "consent_changed")
    )
      return false;
    throw error;
  }
}

/** Disconnect retains its encrypted grant only for provider revocation and reconciliation. */
export async function readConnectionGrantForRevocation(context: CatalogContext, raw: unknown) {
  const { grantId } = z.strictObject({ grantId: ulid }).parse(raw),
    o = await owner(context, grantId);
  if (!o) return null;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const row = await db
    .prepare(
      "SELECT g.generation,g.subject,g.token_nonce,g.token_ciphertext,g.key_version,g.revocation_status,h.organization_id,h.project_id,h.environment_id,h.principal_id,h.registration FROM connection_grants g JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) WHERE g.grant_id=?1 AND g.state='disconnecting'",
    )
    .bind(grantId)
    .first<{
      generation: number;
      subject: string;
      token_nonce: string;
      token_ciphertext: string;
      key_version: number;
      revocation_status: string;
      organization_id: string;
      project_id: string | null;
      environment_id: string | null;
      principal_id: string;
      registration: string;
    }>();
  return row
    ? {
        grantId,
        generation: row.generation,
        subject: row.subject,
        organizationId: row.organization_id,
        ...(row.project_id === null ? {} : { projectId: row.project_id }),
        ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
        principalId: row.principal_id,
        registration: row.registration,
        revocationStatus: row.revocation_status,
        encryptedTokens: {
          nonce: row.token_nonce,
          ciphertext: row.token_ciphertext,
          keyVersion: row.key_version,
        },
      }
    : null;
}
const revocationClaim = z.strictObject({ grantId: ulid, claimId: ulid });
export async function claimConnectionRevocation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = revocationClaim.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    db
      .prepare(
        `UPDATE connection_grants SET revocation_status='outcome_unknown' WHERE grant_id=?1 AND state='disconnecting' AND revocation_status='pending' AND revocation_dispatched=1 AND revocation_claim_expires_at<=${now}`,
      )
      .bind(i.grantId),
    db
      .prepare(
        `UPDATE connection_grants SET revocation_claim_id=?2,revocation_claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now','+1 minutes')||'000Z') WHERE grant_id=?1 AND state='disconnecting' AND revocation_status='pending' AND revocation_dispatched=0 AND (revocation_claim_id IS NULL OR revocation_claim_expires_at<=${now})`,
      )
      .bind(i.grantId, i.claimId),
    db
      .prepare(
        `SELECT 1 FROM connection_grants WHERE grant_id=?1 AND state='disconnecting' AND revocation_status='pending' AND revocation_claim_id=?2 AND revocation_dispatched=0 AND revocation_claim_expires_at>${now}`,
      )
      .bind(i.grantId, i.claimId),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}
export async function markConnectionRevocationDispatched(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = revocationClaim.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db
    .prepare(
      `UPDATE connection_grants SET revocation_dispatched=1 WHERE grant_id=?1 AND state='disconnecting' AND revocation_status='pending' AND revocation_claim_id=?2 AND revocation_dispatched=0 AND revocation_claim_expires_at>${now}`,
    )
    .bind(i.grantId, i.claimId)
    .run();
  return r.meta.changes === 1;
}
export async function finishConnectionDisconnect(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = revocationClaim.extend({ outcome: z.enum(["revoked", "outcome_unknown"]) }).parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    db
      .prepare(
        "UPDATE connection_grants SET state=CASE WHEN ?3='revoked' THEN 'disconnected' ELSE 'disconnecting' END,revocation_status=?3 WHERE grant_id=?1 AND state='disconnecting' AND revocation_status IN ('pending','outcome_unknown') AND revocation_claim_id=?2 AND revocation_dispatched=1 AND (revocation_status='pending' OR ?3='revoked')",
      )
      .bind(i.grantId, i.claimId, i.outcome),
    ...(o.workspace && i.outcome === "revoked"
      ? [
          db
            .prepare(
              "DELETE FROM workspace_connection_slots WHERE attempt_id=(SELECT attempt_id FROM connection_grants WHERE grant_id=?1 AND state='disconnected' AND revocation_status='revoked')",
            )
            .bind(i.grantId),
        ]
      : []),
    db
      .prepare(
        "SELECT 1 FROM connection_grants WHERE grant_id=?1 AND revocation_claim_id=?2 AND revocation_dispatched=1 AND revocation_status=?3",
      )
      .bind(i.grantId, i.claimId, i.outcome),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}
export async function listDisconnectingConnectionGrants(
  context: CatalogContext,
  raw: unknown,
): Promise<string[]> {
  const i = z
      .strictObject({ afterGrantId: ulid.optional(), limit: z.number().int().min(1).max(100) })
      .parse(raw),
    db = (await context.router.routeShard(0)).db;
  const rows = await db
    .prepare(
      "SELECT g.grant_id FROM connection_grants g JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE g.state='disconnecting' AND g.revocation_status='pending' AND (?1 IS NULL OR g.grant_id>?1) AND NOT EXISTS(SELECT 1 FROM bucket_fences fence WHERE fence.bucket=o.bucket AND fence.state IN ('moving','moved')) UNION ALL SELECT g.grant_id FROM workspace_connection_grants g JOIN workspace_connection_attempts a USING(attempt_id) JOIN workspace_connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE g.state='disconnecting' AND g.revocation_status='pending' AND (?1 IS NULL OR g.grant_id>?1) AND NOT EXISTS(SELECT 1 FROM bucket_fences fence WHERE fence.bucket=o.bucket AND fence.state IN ('moving','moved')) ORDER BY 1 LIMIT ?2",
    )
    .bind(i.afterGrantId ?? null, i.limit)
    .all<{ grant_id: string }>();
  return rows.results.map((row) => row.grant_id);
}

/** IDs only for private bounded cleanup of grants abandoned before browser confirmation. */
export async function listExpiredConnectionGrants(
  context: CatalogContext,
  raw: unknown,
): Promise<string[]> {
  const i = z
      .strictObject({ afterGrantId: ulid.optional(), limit: z.number().int().min(1).max(100) })
      .parse(raw),
    db = (await context.router.routeShard(0)).db;
  const rows = await db
    .prepare(
      `SELECT g.grant_id FROM connection_grants g JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE g.state='pending' AND g.confirmation_expires_at<=${now} AND (?1 IS NULL OR g.grant_id>?1) AND NOT EXISTS(SELECT 1 FROM bucket_fences fence WHERE fence.bucket=o.bucket AND fence.state IN ('moving','moved')) UNION ALL SELECT g.grant_id FROM workspace_connection_grants g JOIN workspace_connection_attempts a USING(attempt_id) JOIN workspace_connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE g.state='pending' AND g.confirmation_expires_at<=${now} AND (?1 IS NULL OR g.grant_id>?1) AND NOT EXISTS(SELECT 1 FROM bucket_fences fence WHERE fence.bucket=o.bucket AND fence.state IN ('moving','moved')) ORDER BY 1 LIMIT ?2`,
    )
    .bind(i.afterGrantId ?? null, i.limit)
    .all<{ grant_id: string }>();
  return rows.results.map((row) => row.grant_id);
}
/** Expired grants can only enter revocation custody, never activation or execution. */
export async function claimExpiredConnectionGrant(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const { grantId } = z.strictObject({ grantId: ulid }).parse(raw),
    o = await owner(context, grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const result = await db
    .prepare(
      `UPDATE connection_grants SET state='disconnecting',revocation_status='pending' WHERE grant_id=?1 AND state='pending' AND confirmation_expires_at<=${now}`,
    )
    .bind(grantId)
    .run();
  return result.meta.changes === 1;
}

/** Private broker-only credential custody for an active grant, rechecked against its current workspace Owner. */
export async function readActiveConnectionGrant(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ organizationId: ulid, principalId: id, grantId: ulid }).parse(raw),
    o = await owner(context, i.grantId);
  if (!o || o.organization_id !== i.organizationId || o.principal_id !== i.principalId) return null;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    ...ownerGuards(db, o),
    db
      .prepare(
        "SELECT g.generation,g.subject,g.token_nonce,g.token_ciphertext,g.key_version,h.project_id,h.environment_id,h.registration FROM connection_grants g JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) WHERE g.grant_id=?1 AND g.state='active'",
      )
      .bind(i.grantId),
  ]);
  const row = r.at(-1)?.results[0] as
    | {
        generation: number;
        subject: string;
        token_nonce: string;
        token_ciphertext: string;
        key_version: number;
        project_id: string | null;
        environment_id: string | null;
        registration: string;
      }
    | undefined;
  return row
    ? {
        grantId: i.grantId,
        organizationId: i.organizationId,
        principalId: i.principalId,
        ...(row.project_id === null ? {} : { projectId: row.project_id }),
        ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
        registration: row.registration,
        generation: row.generation,
        subject: row.subject,
        encryptedTokens: {
          nonce: row.token_nonce,
          ciphertext: row.token_ciphertext,
          keyVersion: row.key_version,
        },
      }
    : null;
}

const refreshOrphan = transition.extend({ encryptedTokens: sealed });
/** A rotated response that cannot commit is retained solely for revocation, never reattached to an active grant. */
export async function retainConnectionRefreshOrphan(
  context: CatalogContext,
  raw: unknown,
): Promise<"retained" | "committed" | "conflict"> {
  const i = refreshOrphan.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return "conflict";
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const params = [
    i.grantId,
    i.claimId,
    i.generation,
    i.encryptedTokens.nonce,
    i.encryptedTokens.ciphertext,
    i.encryptedTokens.keyVersion,
  ];
  const r = await db.batch([
    db
      .prepare(
        `INSERT INTO connection_refresh_orphans(grant_id,claim_id,previous_generation,token_nonce,token_ciphertext,key_version,state,created_at) SELECT ?1,?2,?3,?4,?5,?6,'revocation_pending',${now} FROM connection_grants WHERE grant_id=?1 AND state IN ('refreshing','disconnecting','disconnected','reconnect_required') AND refresh_claim_id=?2 AND generation=?3 AND refresh_dispatched=1 ON CONFLICT DO NOTHING`,
      )
      .bind(...params),
    db
      .prepare(
        "UPDATE connection_grants SET state=CASE WHEN state IN ('disconnecting','disconnected') THEN state ELSE 'reconnect_required' END WHERE grant_id=?1 AND refresh_claim_id=?2 AND generation=?3 AND EXISTS(SELECT 1 FROM connection_refresh_orphans orphan WHERE orphan.grant_id=?1 AND orphan.claim_id=?2 AND orphan.previous_generation=?3 AND orphan.token_nonce=?4 AND orphan.token_ciphertext=?5 AND orphan.key_version=?6)",
      )
      .bind(...params),
    db
      .prepare(
        "SELECT CASE WHEN EXISTS(SELECT 1 FROM connection_refresh_orphans WHERE grant_id=?1 AND claim_id=?2 AND previous_generation=?3 AND token_nonce=?4 AND token_ciphertext=?5 AND key_version=?6) THEN 'retained' WHEN EXISTS(SELECT 1 FROM connection_grants WHERE grant_id=?1 AND refresh_committed_claim_id=?2 AND generation=?3+1 AND token_nonce=?4 AND token_ciphertext=?5 AND key_version=?6) THEN 'committed' ELSE 'conflict' END AS result",
      )
      .bind(...params),
  ]);
  return (
    (r.at(-1)?.results[0] as { result: "retained" | "committed" | "conflict" } | undefined)
      ?.result ?? "conflict"
  );
}
const refreshOrphanKey = z.strictObject({ grantId: ulid, claimId: ulid });
export async function readConnectionRefreshOrphan(context: CatalogContext, raw: unknown) {
  const i = refreshOrphanKey.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return null;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const row = await db
    .prepare(
      "SELECT x.previous_generation,x.token_nonce,x.token_ciphertext,x.key_version,x.state,h.project_id,h.environment_id,h.registration FROM connection_refresh_orphans x JOIN connection_grants g USING(grant_id) JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) WHERE x.grant_id=?1 AND x.claim_id=?2",
    )
    .bind(i.grantId, i.claimId)
    .first<{
      previous_generation: number;
      token_nonce: string;
      token_ciphertext: string;
      key_version: number;
      state: string;
      project_id: string | null;
      environment_id: string | null;
      registration: string;
    }>();
  return row
    ? {
        ...i,
        organizationId: o.organization_id,
        principalId: o.principal_id,
        ...(row.project_id === null ? {} : { projectId: row.project_id }),
        ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
        registration: row.registration,
        generation: row.previous_generation + 1,
        state: row.state,
        encryptedTokens: {
          nonce: row.token_nonce,
          ciphertext: row.token_ciphertext,
          keyVersion: row.key_version,
        },
      }
    : null;
}
export async function listConnectionRefreshOrphans(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        after: z.strictObject({ grantId: ulid, claimId: ulid }).optional(),
        limit: z.number().int().min(1).max(100),
      })
      .parse(raw),
    db = (await context.router.routeShard(0)).db;
  const r = await db
    .prepare(
      "SELECT x.grant_id,x.claim_id FROM connection_refresh_orphans x JOIN connection_grants g USING(grant_id) JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE x.state='revocation_pending' AND (?1 IS NULL OR x.grant_id>?1 OR (x.grant_id=?1 AND x.claim_id>?2)) AND NOT EXISTS(SELECT 1 FROM bucket_fences f WHERE f.bucket=o.bucket AND f.state IN ('moving','moved')) UNION ALL SELECT x.grant_id,x.claim_id FROM workspace_connection_refresh_orphans x JOIN workspace_connection_grants g USING(grant_id) JOIN workspace_connection_attempts a USING(attempt_id) JOIN workspace_connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE x.state='revocation_pending' AND (?1 IS NULL OR x.grant_id>?1 OR (x.grant_id=?1 AND x.claim_id>?2)) AND NOT EXISTS(SELECT 1 FROM bucket_fences f WHERE f.bucket=o.bucket AND f.state IN ('moving','moved')) ORDER BY 1,2 LIMIT ?3",
    )
    .bind(i.after?.grantId ?? null, i.after?.claimId ?? null, i.limit)
    .all<{ grant_id: string; claim_id: string }>();
  return r.results.map((row) => ({ grantId: row.grant_id, claimId: row.claim_id }));
}
const refreshRevoke = refreshOrphanKey.extend({ revocationClaimId: ulid });
export async function claimConnectionRefreshOrphanRevocation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = refreshRevoke.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    db
      .prepare(
        `UPDATE connection_refresh_orphans SET state='outcome_unknown' WHERE grant_id=?1 AND claim_id=?2 AND state='revocation_pending' AND revocation_dispatched=1 AND revocation_claim_expires_at<=${now}`,
      )
      .bind(i.grantId, i.claimId),
    db
      .prepare(
        `UPDATE connection_refresh_orphans SET revocation_claim_id=?3,revocation_claim_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now','+1 minutes')||'000Z') WHERE grant_id=?1 AND claim_id=?2 AND state='revocation_pending' AND revocation_dispatched=0 AND (revocation_claim_id IS NULL OR revocation_claim_expires_at<=${now})`,
      )
      .bind(i.grantId, i.claimId, i.revocationClaimId),
    db
      .prepare(
        `SELECT 1 FROM connection_refresh_orphans WHERE grant_id=?1 AND claim_id=?2 AND state='revocation_pending' AND revocation_claim_id=?3 AND revocation_dispatched=0 AND revocation_claim_expires_at>${now}`,
      )
      .bind(i.grantId, i.claimId, i.revocationClaimId),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}
export async function markConnectionRefreshOrphanRevocationDispatched(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = refreshRevoke.parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db
    .prepare(
      `UPDATE connection_refresh_orphans SET revocation_dispatched=1 WHERE grant_id=?1 AND claim_id=?2 AND state='revocation_pending' AND revocation_claim_id=?3 AND revocation_dispatched=0 AND revocation_claim_expires_at>${now}`,
    )
    .bind(i.grantId, i.claimId, i.revocationClaimId)
    .run();
  return r.meta.changes === 1;
}
export async function finishConnectionRefreshOrphanRevocation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = refreshRevoke.extend({ outcome: z.enum(["revoked", "outcome_unknown"]) }).parse(raw),
    o = await owner(context, i.grantId);
  if (!o) return false;
  const db = familyDb((await routeOrganization(context, o.organization_id)).db, o);
  const r = await db.batch([
    db
      .prepare(
        "UPDATE connection_refresh_orphans SET state=?4 WHERE grant_id=?1 AND claim_id=?2 AND state IN ('revocation_pending','outcome_unknown') AND revocation_claim_id=?3 AND revocation_dispatched=1 AND (state='revocation_pending' OR ?4='revoked')",
      )
      .bind(i.grantId, i.claimId, i.revocationClaimId, i.outcome),
    db
      .prepare(
        "SELECT 1 FROM connection_refresh_orphans WHERE grant_id=?1 AND claim_id=?2 AND revocation_claim_id=?3 AND revocation_dispatched=1 AND state=?4",
      )
      .bind(i.grantId, i.claimId, i.revocationClaimId, i.outcome),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}

/** Public-safe workspace metadata only; ciphertext, provider subject and originating proof stay private. */
export async function listConnectionGrantMetadata(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        organizationId: ulid,
        principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
        workspaceOnly: z.boolean().optional(),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const a = canonicalAuthorizationCondition({ ...i, action: "integrations:read" });
  const owner = canonicalAuthorizationCondition({ ...i, action: "integrations:manage" })
    .sql.replaceAll("?2", "h.principal_id")
    .replaceAll("?6", "'integrations:manage'");
  const query = `SELECT g.grant_id AS grantId,'make' AS provider,CASE WHEN g.state IN ('active','refreshing') AND (NOT (${owner}) OR EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(h.principal_id,6))) THEN 'reconnect_required' ELSE g.state END AS state,g.created_at AS createdAt FROM connection_grants g JOIN connection_attempts attempt USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) WHERE h.organization_id=?1 AND h.registration IN ('make-development-1','make-production-1','make-development-2','make-production-2','make-development-3','make-production-3') AND g.state<>'pending' AND ${a.sql} AND NOT EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(?2,6))`;
  const selectedDb = i.workspaceOnly
    ? familyDb(db, { organization_id: i.organizationId, principal_id: i.principalId, workspace: 1 })
    : db;
  const rows = await selectedDb
    .prepare(
      i.workspaceOnly
        ? `${query} AND h.principal_id=?2 ORDER BY g.created_at,g.grant_id`
        : `${query} ORDER BY g.created_at,g.grant_id`,
    )
    .bind(...a.params)
    .all<{ grantId: string; provider: "make"; state: string; createdAt: string }>();
  return rows.results;
}

/** Owner-only status read supports truthful disconnect replays without exposing credential custody. */
export async function readConnectionGrantStatus(
  context: CatalogContext,
  raw: unknown,
): Promise<{ state: string } | null> {
  const i = z
      .strictObject({ organizationId: ulid, principalId: id, grantId: ulid, mutationAuthority })
      .parse(raw),
    o = await owner(context, i.grantId);
  if (!o || o.organization_id !== i.organizationId || o.principal_id !== i.principalId) return null;
  const db = familyDb((await routeOrganization(context, i.organizationId)).db, o);
  try {
    const r = await db.batch([
      ...ownerGuards(db, o),
      ...integrationMutationGuards(db, i),
      db.prepare("SELECT state FROM connection_grants WHERE grant_id=?1").bind(i.grantId),
    ]);
    const row = r.at(-1)?.results[0] as { state: string } | undefined;
    return row ? { state: row.state } : null;
  } catch (error) {
    if (classifyFailure(error).kind === "guard") return null;
    throw error;
  }
}
