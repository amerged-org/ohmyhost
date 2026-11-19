import { z } from "zod";
import { guard } from "../../guards.js";
import type { D1Database } from "../../d1-types.js";
import { handoffAuthorityInput, handoffEffectGuards } from "../identity/handoff-effect.js";
import { routeOrganization, sha256Hex, ulid, type CatalogContext } from "../common.js";
import {
  originatingCredential,
  originatingCredentialGuards,
  type OriginatingCredential,
} from "./origin-credential.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";

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
const subject = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !/[\p{Cc}]/u.test(v));
const registration = z.string().regex(/^[a-z0-9-]{1,64}$/u);
const clock = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
const plus = (minutes: number) =>
  `(strftime('%Y-%m-%dT%H:%M:%f','now','+${minutes} minutes')||'000Z')`;
const browserSession = z.strictObject({
  sessionId: id,
  userId: z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u),
  organizationId: z.string().startsWith("org_").min(5).max(128).nullable(),
  tokenExpiresAt: z.number().int().positive(),
});
const handoff = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid.optional(),
    environmentId: ulid.optional(),
    principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
    sessionId: id,
    browserSession,
    handoffHash: sha256Hex,
    registration,
    originatingDelegation: handoffAuthorityInput.optional(),
    originatingCredential: originatingCredential.optional(),
  })
  .refine(
    (i) =>
      !(i.originatingDelegation && i.originatingCredential) &&
      (i.projectId !== undefined ||
        i.originatingDelegation !== undefined ||
        i.originatingCredential !== undefined) &&
      (i.projectId === undefined) === (i.environmentId === undefined) &&
      i.sessionId === i.browserSession.sessionId &&
      i.principalId === `user:${i.browserSession.userId}`,
  );
type Handoff = z.output<typeof handoff>;
type Row = {
  organization_id: string;
  project_id: string | null;
  environment_id: string | null;
  principal_id: string;
  session_id: string;
  handoff_hash: string;
  registration: string;
  ownership_version: number | null;
  billing_epoch_id: string | null;
  expires_at: string;
  attempt_expires_at: string | null;
  originating_delegation: string | null;
  originating_credential: string | null;
  browser_session: string;
};
function familyDb(db: D1Database, workspace: boolean): D1Database {
  if (!workspace) return db;
  return {
    prepare: (sql) =>
      db.prepare(
        sql.replace(
          /\b(connection_orphan_grants|connection_grants|connection_attempts|connection_handoffs)\b/gu,
          "workspace_$1",
        ),
      ),
    batch: (statements) => db.batch(statements),
  };
}
function authority(
  i: Pick<Handoff, "organizationId" | "projectId" | "environmentId" | "principalId">,
) {
  // Grants belong to the workspace human, independently of the selected project.
  const decision = canonicalAuthorizationCondition({
    organizationId: i.organizationId,
    principalId: i.principalId,
    action: "integrations:manage",
  });
  return {
    sql: decision.sql.replaceAll("?3", "NULL").replaceAll("?4", "NULL"),
    params: [
      i.organizationId,
      i.principalId,
      i.projectId ?? null,
      i.environmentId ?? null,
      null,
      "integrations:manage",
    ],
  };
}
const session = `NOT EXISTS(SELECT 1 FROM revocations r WHERE (r.kind='user' AND r.resource_id=substr(?2,6)) OR (r.kind='session' AND r.resource_id=?7 AND r.workos_user_id=substr(?2,6)))`;
const project = `EXISTS(SELECT 1 FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.environment_id=?4 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL WHERE p.organization_id=?1 AND p.project_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active'`;
function guards(
  db: D1Database,
  i: Pick<Handoff, "organizationId" | "principalId">,
  delegation: unknown,
  credential: unknown,
  rawSession: unknown,
) {
  const browser = browserSession.parse(rawSession);
  const result =
    delegation == null
      ? []
      : handoffEffectGuards(db, {
          organizationId: i.organizationId,
          principalId: i.principalId,
          action: "integrations:manage",
          authority: handoffAuthorityInput.parse(delegation),
        });
  if (i.principalId !== `user:${browser.userId}`) result.push(guard(db, "consent_changed", "1"));
  if (credential != null) result.push(...originatingCredentialGuards(db, i, credential));
  return result;
}
function storedDelegation(r: Row): unknown {
  return r.originating_delegation === null
    ? undefined
    : (JSON.parse(r.originating_delegation) as unknown);
}
function storedSession(r: Row): z.output<typeof browserSession> {
  return browserSession.parse(JSON.parse(r.browser_session));
}
function storedCredential(r: Row): OriginatingCredential | undefined {
  return r.originating_credential === null
    ? undefined
    : originatingCredential.parse(JSON.parse(r.originating_credential));
}
function fromRow(r: Row) {
  return {
    organizationId: r.organization_id,
    ...(r.project_id === null ? {} : { projectId: r.project_id }),
    ...(r.environment_id === null ? {} : { environmentId: r.environment_id }),
    principalId: r.principal_id,
    sessionId: r.session_id,
    handoffHash: r.handoff_hash,
    registration: r.registration,
  };
}
async function read(context: CatalogContext, hash: string): Promise<Row | null> {
  const db = (await context.router.routeShard(0)).db;
  return db
    .prepare(
      "SELECT * FROM connection_handoffs WHERE handoff_hash=?1 UNION ALL SELECT * FROM workspace_connection_handoffs WHERE handoff_hash=?1",
    )
    .bind(hash)
    .first<Row>();
}
export async function createConnectionHandoff(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = handoff.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    a = authority(i),
    workspace = i.projectId === undefined,
    table = workspace ? "workspace_connection_handoffs" : "connection_handoffs";
  const statements = guards(
    db,
    i,
    i.originatingDelegation,
    i.originatingCredential,
    i.browserSession,
  );
  const results = await db.batch([
    ...statements,
    db
      .prepare(
        `INSERT INTO ${table}(handoff_hash,organization_id,project_id,environment_id,principal_id,session_id,registration,ownership_version,billing_epoch_id,created_at,expires_at,originating_delegation,originating_credential,browser_session)
    SELECT ?8,?1,?3,?4,?2,?7,?9,${workspace ? "NULL,NULL" : "p.ownership_version,p.active_billing_epoch_id"},${clock},${plus(5)},?10,?11,?12 ${workspace ? "WHERE" : "FROM projects p WHERE p.organization_id=?1 AND p.project_id=?3 AND"} ${a.sql} AND ${session} AND ${workspace ? "1" : `${project})`} ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...a.params,
        i.sessionId,
        i.handoffHash,
        i.registration,
        i.originatingDelegation === undefined ? null : JSON.stringify(i.originatingDelegation),
        i.originatingCredential === undefined ? null : JSON.stringify(i.originatingCredential),
        JSON.stringify(i.browserSession),
      ),
  ]);
  return results.at(-1)?.meta.changes === 1;
}
export interface ConnectionHandoff {
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  principalId: string;
  sessionId: string;
  handoffHash: string;
  registration: string;
  ownershipVersion?: number;
  billingEpochId?: string;
  attemptExpiresAt: string;
  browserSession: z.output<typeof browserSession>;
  originatingCredential?: OriginatingCredential;
  originatingDelegation?: z.output<typeof handoffAuthorityInput>;
}
function publicHandoff(r: Row): ConnectionHandoff {
  if (r.attempt_expires_at === null) throw new TypeError("Attempt expiry is missing");
  const credential = storedCredential(r);
  const delegation = storedDelegation(r);
  return {
    ...fromRow(r),
    ...(r.ownership_version === null ? {} : { ownershipVersion: r.ownership_version }),
    ...(r.billing_epoch_id === null ? {} : { billingEpochId: r.billing_epoch_id }),
    attemptExpiresAt: r.attempt_expires_at,
    browserSession: storedSession(r),
    ...(credential === undefined ? {} : { originatingCredential: credential }),
    ...(delegation === undefined
      ? {}
      : { originatingDelegation: handoffAuthorityInput.parse(delegation) }),
  };
}
export async function consumeConnectionHandoff(
  context: CatalogContext,
  raw: unknown,
): Promise<ConnectionHandoff | null> {
  const { handoffHash } = z.strictObject({ handoffHash: sha256Hex }).parse(raw),
    row = await read(context, handoffHash);
  if (!row) return null;
  const i = fromRow(row),
    { db } = await routeOrganization(context, i.organizationId),
    a = authority(i),
    workspace = row.project_id === null,
    table = workspace ? "workspace_connection_handoffs" : "connection_handoffs";
  const results = await db.batch([
    ...guards(db, i, storedDelegation(row), storedCredential(row), storedSession(row)),
    db
      .prepare(
        `UPDATE ${table} SET consumed_at=${clock}, attempt_expires_at=${plus(10)} WHERE handoff_hash=?8 AND consumed_at IS NULL AND expires_at>${clock} AND ${a.sql} AND ${session} AND ${workspace ? "1" : `${project} AND p.ownership_version=${table}.ownership_version AND p.active_billing_epoch_id=${table}.billing_epoch_id)`} RETURNING *`,
      )
      .bind(...a.params, i.sessionId, handoffHash),
  ]);
  const claimed = results.at(-1)?.results[0] as Row | undefined;
  return claimed ? publicHandoff(claimed) : null;
}
const attempt = z.strictObject({
  handoffHash: sha256Hex,
  attemptId: ulid,
  stateHash: sha256Hex,
  cookieHash: sha256Hex,
  encryptedVerifier: z.strictObject({
    nonce: hex.length(24),
    ciphertext: hex,
    keyVersion: z.number().int().positive().max(2147483647),
  }),
  oidcNonce: id,
});
export async function createConnectionAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const v = attempt.parse(raw),
    row = await read(context, v.handoffHash);
  if (!row) return false;
  const i = fromRow(row),
    { db } = await routeOrganization(context, i.organizationId),
    a = authority(i),
    workspace = row.project_id === null,
    handoffs = workspace ? "workspace_connection_handoffs" : "connection_handoffs",
    attempts = workspace ? "workspace_connection_attempts" : "connection_attempts";
  const preceding = guards(db, i, storedDelegation(row), storedCredential(row), storedSession(row));
  const results = await db.batch([
    ...preceding,
    db
      .prepare(
        `UPDATE ${handoffs} SET attempt_id=?9 WHERE handoff_hash=?8 AND consumed_at IS NOT NULL AND attempt_id IS NULL AND expires_at>${clock} AND ${a.sql} AND ${session} AND ${workspace ? "1" : `${project} AND p.ownership_version=${handoffs}.ownership_version AND p.active_billing_epoch_id=${handoffs}.billing_epoch_id)`}`,
      )
      .bind(...a.params, i.sessionId, v.handoffHash, v.attemptId),
    db
      .prepare(
        `INSERT INTO ${attempts}(attempt_id,handoff_hash,state_hash,cookie_hash,verifier_nonce,verifier_ciphertext,key_version,oidc_nonce,state,created_at,expires_at) SELECT ?2,?1,?3,?4,?5,?6,?7,?8,'pending',${clock},attempt_expires_at FROM ${handoffs} WHERE handoff_hash=?1 AND attempt_id=?2 ON CONFLICT DO NOTHING`,
      )
      .bind(
        v.handoffHash,
        v.attemptId,
        v.stateHash,
        v.cookieHash,
        v.encryptedVerifier.nonce,
        v.encryptedVerifier.ciphertext,
        v.encryptedVerifier.keyVersion,
        v.oidcNonce,
      ),
  ]);
  return results.at(-2)?.meta.changes === 1 && results.at(-1)?.meta.changes === 1;
}
export async function claimConnectionAttempt(context: CatalogContext, raw: unknown) {
  const v = z
      .strictObject({ stateHash: sha256Hex, cookieHash: sha256Hex, registration })
      .parse(raw),
    db = (await context.router.routeShard(0)).db;
  const row = await db
    .prepare(
      "SELECT h.* FROM connection_handoffs h JOIN connection_attempts a USING(handoff_hash) WHERE a.state_hash=?1 UNION ALL SELECT h.* FROM workspace_connection_handoffs h JOIN workspace_connection_attempts a USING(handoff_hash) WHERE a.state_hash=?1",
    )
    .bind(v.stateHash)
    .first<Row>();
  if (!row) return null;
  const i = fromRow(row),
    a = authority(i),
    workspace = row.project_id === null,
    handoffs = workspace ? "workspace_connection_handoffs" : "connection_handoffs",
    attempts = workspace ? "workspace_connection_attempts" : "connection_attempts",
    tenantDb = (await routeOrganization(context, i.organizationId)).db;
  const results = await tenantDb.batch([
    ...guards(tenantDb, i, storedDelegation(row), storedCredential(row), storedSession(row)),
    ...(workspace
      ? [
          tenantDb
            .prepare(
              `INSERT INTO workspace_connection_slots(organization_id,principal_id,attempt_id) SELECT ?1,?2,a.attempt_id FROM workspace_connection_attempts a JOIN workspace_connection_handoffs h USING(handoff_hash) WHERE a.state_hash=?8 AND a.cookie_hash=?9 AND a.state='pending' AND a.expires_at>${clock} AND h.registration=?10 AND ${a.sql} AND ${session} ON CONFLICT DO NOTHING`,
            )
            .bind(...a.params, i.sessionId, v.stateHash, v.cookieHash, v.registration),
        ]
      : []),
    tenantDb
      .prepare(
        `UPDATE ${attempts} SET state='exchange_claimed' WHERE state_hash=?8 AND cookie_hash=?9 AND state='pending' AND expires_at>${clock} AND EXISTS(SELECT 1 FROM ${handoffs} h WHERE h.handoff_hash=${attempts}.handoff_hash AND h.registration=?10 AND ${a.sql} AND ${session} AND ${workspace ? `EXISTS(SELECT 1 FROM workspace_connection_slots slot WHERE slot.organization_id=?1 AND slot.principal_id=?2 AND slot.attempt_id=${attempts}.attempt_id)` : `${project} AND p.ownership_version=h.ownership_version AND p.active_billing_epoch_id=h.billing_epoch_id)`}) RETURNING *`,
      )
      .bind(...a.params, i.sessionId, v.stateHash, v.cookieHash, v.registration),
  ]);
  const claimed = results.at(-1)?.results[0] as
    | {
        attempt_id: string;
        verifier_nonce: string;
        verifier_ciphertext: string;
        key_version: number;
        oidc_nonce: string;
      }
    | undefined;
  return claimed
    ? {
        ...publicHandoff(row),
        attemptId: claimed.attempt_id,
        encryptedVerifier: {
          nonce: claimed.verifier_nonce,
          ciphertext: claimed.verifier_ciphertext,
          keyVersion: claimed.key_version,
        },
        oidcNonce: claimed.oidc_nonce,
      }
    : null;
}
export async function terminateConnectionAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = z
    .strictObject({ attemptId: ulid, outcome: z.enum(["denied", "outcome_unknown"]) })
    .parse(raw);
  const lookup = (await context.router.routeShard(0)).db;
  const row = await lookup
    .prepare(
      "SELECT h.organization_id,h.project_id FROM connection_attempts a JOIN connection_handoffs h USING(handoff_hash) WHERE a.attempt_id=?1 UNION ALL SELECT h.organization_id,h.project_id FROM workspace_connection_attempts a JOIN workspace_connection_handoffs h USING(handoff_hash) WHERE a.attempt_id=?1",
    )
    .bind(i.attemptId)
    .first<{ organization_id: string; project_id: string | null }>();
  if (!row) return false;
  const db = familyDb(
    (await routeOrganization(context, row.organization_id)).db,
    row.project_id === null,
  );
  const result = await db.batch([
    db
      .prepare(
        "UPDATE connection_attempts SET state=?2 WHERE attempt_id=?1 AND state='exchange_claimed'",
      )
      .bind(i.attemptId, i.outcome),
    ...(row.project_id === null && i.outcome === "denied"
      ? [
          db
            .prepare(
              "DELETE FROM workspace_connection_slots WHERE attempt_id=?1 AND EXISTS(SELECT 1 FROM connection_attempts WHERE attempt_id=?1 AND state='denied')",
            )
            .bind(i.attemptId),
        ]
      : []),
  ]);
  return result[0]?.meta.changes === 1;
}

const callbackKey = z.strictObject({ stateHash: sha256Hex, cookieHash: sha256Hex, registration });
/** An observer receives only immutable identity, never verifier or provider tokens. */
export async function readConnectionAttemptOrigin(
  context: CatalogContext,
  raw: unknown,
): Promise<ConnectionHandoff | null> {
  const v = callbackKey.parse(raw),
    lookup = (await context.router.routeShard(0)).db;
  const row = await lookup
    .prepare(
      `SELECT h.* FROM connection_handoffs h JOIN connection_attempts a USING(handoff_hash) WHERE a.state_hash=?1 AND a.cookie_hash=?2 AND h.registration=?3 AND a.state='pending' AND a.expires_at>${clock} UNION ALL SELECT h.* FROM workspace_connection_handoffs h JOIN workspace_connection_attempts a USING(handoff_hash) WHERE a.state_hash=?1 AND a.cookie_hash=?2 AND h.registration=?3 AND a.state='pending' AND a.expires_at>${clock}`,
    )
    .bind(v.stateHash, v.cookieHash, v.registration)
    .first<Row>();
  return row ? publicHandoff(row) : null;
}
async function attemptOwner(context: CatalogContext, attemptId: string): Promise<Row | null> {
  const db = (await context.router.routeShard(0)).db;
  return db
    .prepare(
      "SELECT h.* FROM connection_handoffs h JOIN connection_attempts a USING(handoff_hash) WHERE a.attempt_id=?1 UNION ALL SELECT h.* FROM workspace_connection_handoffs h JOIN workspace_connection_attempts a USING(handoff_hash) WHERE a.attempt_id=?1",
    )
    .bind(attemptId)
    .first<Row>();
}
const pendingGrant = z.strictObject({
  attemptId: ulid,
  grantId: ulid,
  subject,
  encryptedTokens: z.strictObject({
    nonce: hex.length(24),
    ciphertext: grantCiphertext,
    keyVersion: z.number().int().positive().max(2147483647),
  }),
  resultHash: sha256Hex,
});
export async function persistConnectionPendingGrant(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const v = pendingGrant.parse(raw),
    row = await attemptOwner(context, v.attemptId);
  if (!row) return false;
  const i = fromRow(row),
    { db } = await routeOrganization(context, i.organizationId),
    a = authority(i),
    workspace = row.project_id === null,
    handoffs = workspace ? "workspace_connection_handoffs" : "connection_handoffs",
    attempts = workspace ? "workspace_connection_attempts" : "connection_attempts",
    grants = workspace ? "workspace_connection_grants" : "connection_grants";
  const results = await db.batch([
    ...guards(db, i, storedDelegation(row), storedCredential(row), storedSession(row)),
    db
      .prepare(
        `INSERT INTO ${grants}(grant_id,attempt_id,subject,token_nonce,token_ciphertext,key_version,generation,result_hash,state,confirmation_expires_at,created_at) SELECT ?9,?8,?10,?11,?12,?13,1,?14,'pending',${plus(10)},${clock} FROM ${attempts} attempt JOIN ${handoffs} h USING(handoff_hash) WHERE attempt.attempt_id=?8 AND attempt.state='exchange_claimed' AND attempt.expires_at>${clock} AND ${a.sql} AND ${session} AND ${workspace ? "EXISTS(SELECT 1 FROM workspace_connection_slots WHERE organization_id=?1 AND principal_id=?2 AND attempt_id=?8)" : `${project} AND p.ownership_version=h.ownership_version AND p.active_billing_epoch_id=h.billing_epoch_id)`} ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...a.params,
        i.sessionId,
        v.attemptId,
        v.grantId,
        v.subject,
        v.encryptedTokens.nonce,
        v.encryptedTokens.ciphertext,
        v.encryptedTokens.keyVersion,
        v.resultHash,
      ),
    db
      .prepare(
        `UPDATE ${attempts} SET state='awaiting_confirmation' WHERE attempt_id=?1 AND state='exchange_claimed' AND EXISTS(SELECT 1 FROM ${grants} WHERE attempt_id=?1 AND grant_id=?2 AND result_hash=?3 AND state='pending')`,
      )
      .bind(v.attemptId, v.grantId, v.resultHash),
  ]);
  return results.at(-2)?.meta.changes === 1 && results.at(-1)?.meta.changes === 1;
}
async function confirmationOwner(context: CatalogContext, hash: string): Promise<Row | null> {
  const db = (await context.router.routeShard(0)).db;
  return db
    .prepare(
      `SELECT h.* FROM connection_handoffs h JOIN connection_attempts a USING(handoff_hash) JOIN connection_grants g USING(attempt_id) WHERE g.result_hash=?1 AND ((g.state='pending' AND g.confirmation_expires_at>${clock}) OR g.state='active') UNION ALL SELECT h.* FROM workspace_connection_handoffs h JOIN workspace_connection_attempts a USING(handoff_hash) JOIN workspace_connection_grants g USING(attempt_id) WHERE g.result_hash=?1 AND ((g.state='pending' AND g.confirmation_expires_at>${clock}) OR g.state='active')`,
    )
    .bind(hash)
    .first<Row>();
}
export async function readConnectionConfirmationOrigin(
  context: CatalogContext,
  raw: unknown,
): Promise<ConnectionHandoff | null> {
  const { resultHash } = z.strictObject({ resultHash: sha256Hex }).parse(raw),
    row = await confirmationOwner(context, resultHash);
  return row ? publicHandoff(row) : null;
}
export async function activateConnectionGrant(
  context: CatalogContext,
  raw: unknown,
): Promise<{ state: "active"; grantId: string } | null> {
  const v = z.strictObject({ resultHash: sha256Hex, principalId: id, sessionId: id }).parse(raw),
    row = await confirmationOwner(context, v.resultHash);
  if (!row || row.principal_id !== v.principalId || row.session_id !== v.sessionId) return null;
  const i = fromRow(row),
    { db } = await routeOrganization(context, i.organizationId),
    a = authority(i),
    workspace = row.project_id === null,
    handoffs = workspace ? "workspace_connection_handoffs" : "connection_handoffs",
    attempts = workspace ? "workspace_connection_attempts" : "connection_attempts",
    grants = workspace ? "workspace_connection_grants" : "connection_grants";
  const results = await db.batch([
    ...guards(db, i, storedDelegation(row), storedCredential(row), storedSession(row)),
    db
      .prepare(
        `UPDATE ${grants} SET state='active' WHERE result_hash=?8 AND state='pending' AND confirmation_expires_at>${clock} AND EXISTS(SELECT 1 FROM ${attempts} attempt JOIN ${handoffs} h USING(handoff_hash) WHERE attempt.attempt_id=${grants}.attempt_id AND attempt.state='awaiting_confirmation' AND h.principal_id=?2 AND h.session_id=?7 AND ${a.sql} AND ${session} AND ${workspace ? "1" : `${project} AND p.ownership_version=h.ownership_version AND p.active_billing_epoch_id=h.billing_epoch_id)`}) RETURNING grant_id`,
      )
      .bind(...a.params, i.sessionId, v.resultHash),
    db
      .prepare(
        `UPDATE ${attempts} SET state='active' WHERE state='awaiting_confirmation' AND attempt_id=(SELECT attempt_id FROM ${grants} WHERE result_hash=?1 AND state='active')`,
      )
      .bind(v.resultHash),
    db
      .prepare(
        `SELECT g.grant_id FROM ${grants} g JOIN ${attempts} attempt USING(attempt_id) JOIN ${handoffs} h USING(handoff_hash) WHERE g.result_hash=?8 AND g.state='active' AND attempt.state='active' AND h.principal_id=?2 AND h.session_id=?7 AND ${a.sql} AND ${session} AND ${workspace ? "1" : `${project} AND p.ownership_version=h.ownership_version AND p.active_billing_epoch_id=h.billing_epoch_id)`}`,
      )
      .bind(...a.params, i.sessionId, v.resultHash),
  ]);
  const grant = results.at(-1)?.results[0] as { grant_id: string } | undefined;
  return grant ? { state: "active", grantId: grant.grant_id } : null;
}

const orphan = z.strictObject({
  attemptId: ulid,
  grantId: ulid,
  subject: subject.nullable(),
  encryptedTokens: z.strictObject({
    nonce: hex.length(24),
    ciphertext: grantCiphertext,
    keyVersion: z.number().int().positive().max(2147483647),
  }),
});
/** Retain a successful exchange only for revocation when current authority prevents a pending grant. */
export async function retainConnectionOrphan(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const v = orphan.parse(raw),
    row = await attemptOwner(context, v.attemptId);
  if (!row) return false;
  const db = familyDb(
    (await routeOrganization(context, row.organization_id)).db,
    row.project_id === null,
  );
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO connection_orphan_grants(attempt_id,grant_id,subject,token_nonce,token_ciphertext,key_version,state,created_at) SELECT ?1,?2,?3,?4,?5,?6,'revocation_pending',${clock} FROM connection_attempts WHERE attempt_id=?1 AND state='exchange_claimed' AND NOT EXISTS(SELECT 1 FROM connection_grants WHERE attempt_id=?1) ON CONFLICT DO NOTHING`,
      )
      .bind(
        v.attemptId,
        v.grantId,
        v.subject,
        v.encryptedTokens.nonce,
        v.encryptedTokens.ciphertext,
        v.encryptedTokens.keyVersion,
      ),
    db
      .prepare(
        "UPDATE connection_attempts SET state='outcome_unknown' WHERE attempt_id=?1 AND state='exchange_claimed' AND EXISTS(SELECT 1 FROM connection_orphan_grants WHERE attempt_id=?1 AND grant_id=?2)",
      )
      .bind(v.attemptId, v.grantId),
    db
      .prepare(
        "SELECT 1 FROM connection_orphan_grants WHERE attempt_id=?1 AND grant_id=?2 AND subject IS ?3 AND token_nonce=?4 AND token_ciphertext=?5 AND key_version=?6",
      )
      .bind(
        v.attemptId,
        v.grantId,
        v.subject,
        v.encryptedTokens.nonce,
        v.encryptedTokens.ciphertext,
        v.encryptedTokens.keyVersion,
      ),
  ]);
  return (results.at(-1)?.results.length ?? 0) === 1;
}
/** Broker-only custody read, never offered through public or customer APIs. */
export async function readConnectionOrphan(context: CatalogContext, raw: unknown) {
  const { attemptId } = z.strictObject({ attemptId: ulid }).parse(raw),
    row = await attemptOwner(context, attemptId);
  if (!row) return null;
  const db = familyDb(
    (await routeOrganization(context, row.organization_id)).db,
    row.project_id === null,
  );
  const orphanRow = await db
    .prepare(
      "SELECT grant_id,subject,token_nonce,token_ciphertext,key_version,state FROM connection_orphan_grants WHERE attempt_id=?1",
    )
    .bind(attemptId)
    .first<{
      grant_id: string;
      subject: string | null;
      token_nonce: string;
      token_ciphertext: string;
      key_version: number;
      state: string;
    }>();
  return orphanRow
    ? {
        ...publicHandoff(row),
        attemptId,
        grantId: orphanRow.grant_id,
        subject: orphanRow.subject,
        encryptedTokens: {
          nonce: orphanRow.token_nonce,
          ciphertext: orphanRow.token_ciphertext,
          keyVersion: orphanRow.key_version,
        },
        state: orphanRow.state,
      }
    : null;
}
const orphanClaim = z.strictObject({ attemptId: ulid, claimId: ulid });
export async function claimConnectionOrphanRevocation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = orphanClaim.parse(raw),
    owner = await attemptOwner(context, i.attemptId);
  if (!owner) return false;
  const db = familyDb(
    (await routeOrganization(context, owner.organization_id)).db,
    owner.project_id === null,
  );
  const r = await db.batch([
    db
      .prepare(
        `UPDATE connection_orphan_grants SET state='outcome_unknown' WHERE attempt_id=?1 AND state='revocation_pending' AND revocation_dispatched=1 AND revocation_claim_expires_at<=${clock}`,
      )
      .bind(i.attemptId),
    db
      .prepare(
        `UPDATE connection_orphan_grants SET revocation_claim_id=?2,revocation_claim_expires_at=${plus(1)} WHERE attempt_id=?1 AND state='revocation_pending' AND revocation_dispatched=0 AND (revocation_claim_id IS NULL OR revocation_claim_expires_at<=${clock})`,
      )
      .bind(i.attemptId, i.claimId),
    db
      .prepare(
        `SELECT 1 FROM connection_orphan_grants WHERE attempt_id=?1 AND state='revocation_pending' AND revocation_claim_id=?2 AND revocation_dispatched=0 AND revocation_claim_expires_at>${clock}`,
      )
      .bind(i.attemptId, i.claimId),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}
export async function markConnectionOrphanRevocationDispatched(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = orphanClaim.parse(raw),
    owner = await attemptOwner(context, i.attemptId);
  if (!owner) return false;
  const db = familyDb(
    (await routeOrganization(context, owner.organization_id)).db,
    owner.project_id === null,
  );
  const r = await db
    .prepare(
      `UPDATE connection_orphan_grants SET revocation_dispatched=1 WHERE attempt_id=?1 AND state='revocation_pending' AND revocation_claim_id=?2 AND revocation_dispatched=0 AND revocation_claim_expires_at>${clock}`,
    )
    .bind(i.attemptId, i.claimId)
    .run();
  return r.meta.changes === 1;
}
export async function finishConnectionOrphanRevocation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = orphanClaim.extend({ outcome: z.enum(["revoked", "outcome_unknown"]) }).parse(raw),
    owner = await attemptOwner(context, i.attemptId);
  if (!owner) return false;
  const db = familyDb(
    (await routeOrganization(context, owner.organization_id)).db,
    owner.project_id === null,
  );
  const r = await db.batch([
    db
      .prepare(
        "UPDATE connection_orphan_grants SET state=?3 WHERE attempt_id=?1 AND state IN ('revocation_pending','outcome_unknown') AND revocation_claim_id=?2 AND revocation_dispatched=1 AND (state='revocation_pending' OR ?3='revoked')",
      )
      .bind(i.attemptId, i.claimId, i.outcome),
    ...(owner.project_id === null && i.outcome === "revoked"
      ? [
          db
            .prepare(
              "DELETE FROM workspace_connection_slots WHERE attempt_id=?1 AND EXISTS(SELECT 1 FROM connection_orphan_grants WHERE attempt_id=?1 AND state='revoked')",
            )
            .bind(i.attemptId),
        ]
      : []),
    db
      .prepare(
        "SELECT 1 FROM connection_orphan_grants WHERE attempt_id=?1 AND revocation_claim_id=?2 AND revocation_dispatched=1 AND state=?3",
      )
      .bind(i.attemptId, i.claimId, i.outcome),
  ]);
  return (r.at(-1)?.results.length ?? 0) === 1;
}

/** IDs only, for a private bounded reconciliation sweep. Fenced tenants are retried in a later sweep. */
export async function listConnectionOrphans(
  context: CatalogContext,
  raw: unknown,
): Promise<string[]> {
  const i = z
      .strictObject({ afterAttemptId: ulid.optional(), limit: z.number().int().min(1).max(100) })
      .parse(raw),
    db = (await context.router.routeShard(0)).db;
  const rows = await db
    .prepare(
      "SELECT orphan.attempt_id FROM connection_orphan_grants orphan JOIN connection_attempts a USING(attempt_id) JOIN connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE orphan.state='revocation_pending' AND (?1 IS NULL OR orphan.attempt_id>?1) AND NOT EXISTS(SELECT 1 FROM bucket_fences fence WHERE fence.bucket=o.bucket AND fence.state IN ('moving','moved')) UNION ALL SELECT orphan.attempt_id FROM workspace_connection_orphan_grants orphan JOIN workspace_connection_attempts a USING(attempt_id) JOIN workspace_connection_handoffs h USING(handoff_hash) JOIN organizations o USING(organization_id) WHERE orphan.state='revocation_pending' AND (?1 IS NULL OR orphan.attempt_id>?1) AND NOT EXISTS(SELECT 1 FROM bucket_fences fence WHERE fence.bucket=o.bucket AND fence.state IN ('moving','moved')) ORDER BY 1 LIMIT ?2",
    )
    .bind(i.afterAttemptId ?? null, i.limit)
    .all<{ attempt_id: string }>();
  return rows.results.map((row) => row.attempt_id);
}
