import { handoffAuthorityInput, handoffEffectGuards } from "../identity/handoff-effect.js";
import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Plan } from "../../run-command.js";
import { instant, routeOrganization, sha256Hex, ulid, type CatalogContext } from "../common.js";

/**
 * The GitHub authorization state of the Control API as plain commands on its four tables. Who may link, which
 * project is current and what GitHub proved stay in the caller; these commands only keep the durable state machine
 * (`pending` -> `authorizing` -> `authorized` or `connected`, or `failed`) exact and idempotent. Sealed verifier
 * bytes and digests travel as lowercase hex and return the same way.
 */
const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/u);
const principal = z.string().min(1).max(256);
const key = z.string().min(1).max(128);
const login = z.string().min(1).max(255);
const numeric = z.string().regex(/^[1-9][0-9]*$/u);
const sealed = {
  ciphertext: hex,
  nonce: hex.length(24),
  valueSha256: sha256Hex,
  keyVersion: z.number().int().min(1).max(2147483647),
};
const credential = {
  sessionId: z.string().nullable(),
  userApiKeyId: z.string().nullable(),
  workosOrganizationId: z.string().startsWith("org_"),
  tokenExpiresAt: z.number().int().nullable(),
};

const SOURCE = `authorization_id,organization_id,project_id,environment_id,billing_epoch_id,principal_id,session_id,user_api_key_id,workos_organization_id,token_expires_at,repository_owner,repository_name,idempotency_key,lower(hex(request_sha256)) request_sha256,lower(hex(state_sha256)) state_sha256,lower(hex(ciphertext)) ciphertext,lower(hex(nonce)) nonce,lower(hex(value_sha256)) value_sha256,key_version,state,last_failure,operation_id,github_user_id,installation_id,repository_id,created_at,expires_at FROM github_source_authorizations`;
const CONNECTION_AUTH = `authorization_id,organization_id,principal_id,session_id,user_api_key_id,workos_organization_id,token_expires_at,idempotency_key,lower(hex(state_sha256)) state_sha256,lower(hex(ciphertext)) ciphertext,lower(hex(nonce)) nonce,lower(hex(value_sha256)) value_sha256,key_version,state,flow,installation_id,connection_id,last_failure,created_at,expires_at,handoff_delegation FROM github_connection_authorizations`;
const CONNECTION = `connection_id,organization_id,installation_id,account_id,account_login,account_type,github_user_id,github_user_login,principal_id,settings_url,connected_at,revoked_at FROM github_organization_connections`;
type Row = Record<string, unknown>;

async function shard(context: CatalogContext): Promise<D1Database> {
  await context.router.assertLayout();
  return (await context.router.routeShard(0)).db;
}
/** The organization-fenced database of the row an authorization id names; null when no such row exists. */
async function ownerDb(
  context: CatalogContext,
  table: "github_source_authorizations" | "github_connection_authorizations",
  id: string,
): Promise<D1Database | null> {
  const row = await (await shard(context))
    .prepare(`SELECT organization_id FROM ${table} WHERE authorization_id=?1`)
    .bind(id)
    .first<{ organization_id: string }>();
  return row === null ? null : (await routeOrganization(context, row.organization_id)).db;
}
const first = (reader: D1Database, sql: string, ...values: unknown[]) =>
  reader
    .prepare(`SELECT ${sql}`)
    .bind(...values)
    .first<Row>();
const scalar = async (reader: D1Database, sql: string, ...values: unknown[]) =>
  (
    await reader
      .prepare(sql)
      .bind(...values)
      .first<{ v: number }>()
  )?.v === 1;

// ---------------------------------------------------------------------------------------------------- source links

const sourceKey = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: principal,
  idempotencyKey: key,
});
export async function readGithubSourceAuthorization(context: CatalogContext, raw: unknown) {
  const i = sourceKey.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return first(
    db,
    `${SOURCE} WHERE organization_id=?1 AND project_id=?2 AND principal_id=?3 AND idempotency_key=?4`,
    i.organizationId,
    i.projectId,
    i.principalId,
    i.idempotencyKey,
  );
}
export async function readGithubSourceAuthorizationByState(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ stateSha256: sha256Hex }).parse(raw);
  return first(await shard(context), `${SOURCE} WHERE state_sha256=unhex(?1)`, i.stateSha256);
}
export async function readGithubSourceAuthorizationById(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ authorizationId: ulid }).parse(raw);
  return first(await shard(context), `${SOURCE} WHERE authorization_id=?1`, i.authorizationId);
}

const sourceInsert = sourceKey.extend({
  authorizationId: ulid,
  environmentId: ulid,
  billingEpochId: ulid,
  ...credential,
  repositoryOwner: z.string().min(1).max(255),
  repositoryName: z.string().min(1).max(255),
  requestSha256: sha256Hex,
  stateSha256: sha256Hex,
  ...sealed,
  createdAt: instant,
  expiresAt: instant,
});
/** Stores a new authorization; a repeated key is a no-op (the caller reads the winner back and compares it). */
export async function insertGithubSourceAuthorization(context: CatalogContext, raw: unknown) {
  const i = sourceInsert.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "github.insertSourceAuthorization",
    input: i,
    naturalKeyTables: ["github_source_authorizations"],
    read: (reader) =>
      first(
        reader,
        `1 existing FROM github_source_authorizations WHERE organization_id=?1 AND project_id=?2 AND principal_id=?3 AND idempotency_key=?4`,
        i.organizationId,
        i.projectId,
        i.principalId,
        i.idempotencyKey,
      ),
    decide: (existing) =>
      existing !== null
        ? { replay: false }
        : {
            statements: [
              db
                .prepare(
                  `INSERT INTO github_source_authorizations(authorization_id,organization_id,project_id,environment_id,billing_epoch_id,principal_id,session_id,user_api_key_id,workos_organization_id,token_expires_at,repository_owner,repository_name,idempotency_key,request_sha256,state_sha256,ciphertext,nonce,value_sha256,key_version,created_at,expires_at)
                   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,unhex(?14),unhex(?15),unhex(?16),unhex(?17),unhex(?18),?19,?20,?21)`,
                )
                .bind(
                  i.authorizationId,
                  i.organizationId,
                  i.projectId,
                  i.environmentId,
                  i.billingEpochId,
                  i.principalId,
                  i.sessionId,
                  i.userApiKeyId,
                  i.workosOrganizationId,
                  i.tokenExpiresAt,
                  i.repositoryOwner,
                  i.repositoryName,
                  i.idempotencyKey,
                  i.requestSha256,
                  i.stateSha256,
                  i.ciphertext,
                  i.nonce,
                  i.valueSha256,
                  i.keyVersion,
                  i.createdAt,
                  i.expiresAt,
                ),
            ],
            result: () => true,
          },
  });
}

const authorizationId = z.strictObject({ authorizationId: ulid });
/** `pending` -> `authorizing` (or a denial straight to `failed`), only while unexpired; the row after, or null on a lost race. */
export async function claimGithubSourceAuthorization(context: CatalogContext, raw: unknown) {
  const i = authorizationId.extend({ denied: z.boolean(), now: instant }).parse(raw),
    db = await ownerDb(context, "github_source_authorizations", i.authorizationId);
  if (db === null) return null;
  return runCommand(db, {
    name: "github.claimSourceAuthorization",
    input: i,
    read: (reader) => first(reader, `${SOURCE} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) =>
      current === null ||
      current["state"] !== "pending" ||
      (current["expires_at"] as string) <= i.now
        ? { replay: null }
        : {
            statements: [
              db
                .prepare(
                  `UPDATE github_source_authorizations SET state=?2,last_failure=?4 WHERE authorization_id=?1 AND state='pending' AND expires_at>?3 RETURNING ${SOURCE.split(" FROM ")[0]}`,
                )
                .bind(
                  i.authorizationId,
                  i.denied ? "failed" : "authorizing",
                  i.now,
                  i.denied ? "denied" : null,
                ),
            ],
            result: ([changed]) => (changed?.results[0] ?? null) as Row | null,
          },
  });
}
/** `authorizing` -> `pending` (resumable) or `failed`, with the reason the customer reads. */
export async function releaseGithubSourceAuthorization(context: CatalogContext, raw: unknown) {
  const i = authorizationId
      .extend({
        resumable: z.boolean(),
        failure: z.enum([
          "repository_not_installed",
          "repository_access_required",
          "authorization_code_rejected",
          "provider_unavailable",
          "expired",
          "session_inactive",
          "denied",
          "code_spent",
        ]),
      })
      .parse(raw),
    db = await ownerDb(context, "github_source_authorizations", i.authorizationId);
  if (db === null) return null;
  return runCommand(db, {
    name: "github.releaseSourceAuthorization",
    input: i,
    read: (reader) => first(reader, `${SOURCE} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) =>
      current === null || current["state"] !== "authorizing"
        ? { replay: null }
        : {
            statements: [
              db
                .prepare(
                  "UPDATE github_source_authorizations SET state=?2,last_failure=?3 WHERE authorization_id=?1 AND state='authorizing'",
                )
                .bind(i.authorizationId, i.resumable ? "pending" : "failed", i.failure),
            ],
            result: () => true,
          },
  });
}
/** `authorizing` -> `authorized`, recording the accepted SourceLink operation and what GitHub proved. */
export async function completeGithubSourceAuthorization(context: CatalogContext, raw: unknown) {
  const i = authorizationId
      .extend({
        operationId: ulid,
        githubUserId: numeric,
        installationId: numeric,
        repositoryId: numeric,
      })
      .parse(raw),
    db = await ownerDb(context, "github_source_authorizations", i.authorizationId);
  if (db === null) return null;
  return runCommand(db, {
    name: "github.completeSourceAuthorization",
    input: i,
    read: (reader) => first(reader, `${SOURCE} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) => {
      if (current === null) return { replay: null };
      if (current["state"] === "authorized")
        return current["operation_id"] === i.operationId ? { replay: current } : { replay: null };
      if (current["state"] !== "authorizing") return { replay: null };
      return {
        statements: [
          db
            .prepare(
              `UPDATE github_source_authorizations SET state='authorized',operation_id=?2,github_user_id=?3,installation_id=?4,repository_id=?5 WHERE authorization_id=?1 AND state='authorizing' RETURNING ${SOURCE.split(" FROM ")[0]}`,
            )
            .bind(
              i.authorizationId,
              i.operationId,
              i.githubUserId,
              i.installationId,
              i.repositoryId,
            ),
        ],
        result: ([changed]) => (changed?.results[0] ?? null) as Row | null,
      };
    },
  });
}

// ----------------------------------------------------------------------------------------- organization connection

const orgScope = z.strictObject({ organizationId: ulid });
/** The active WorkOS mapping of an organization: what the credential of a browser flow must name. */
export async function readGithubOrganizationMapping(context: CatalogContext, raw: unknown) {
  const i = orgScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return first(
    db,
    "workos_organization_id workosOrganizationId FROM organizations WHERE organization_id=?1 AND state='active'",
    i.organizationId,
  );
}
/** The newest connection of the organization, revoked or not. */
export async function readGithubConnection(context: CatalogContext, raw: unknown) {
  const i = orgScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return first(
    db,
    `${CONNECTION} WHERE organization_id=?1 ORDER BY connected_at DESC,connection_id DESC LIMIT 1`,
    i.organizationId,
  );
}
export async function readGithubConnectionById(context: CatalogContext, raw: unknown) {
  const i = orgScope.extend({ connectionId: ulid }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return first(
    db,
    `${CONNECTION} WHERE organization_id=?1 AND connection_id=?2`,
    i.organizationId,
    i.connectionId,
  );
}
export async function hasActiveGithubConnection(context: CatalogContext, raw: unknown) {
  const i = orgScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return scalar(
    db,
    "SELECT EXISTS(SELECT 1 FROM github_organization_connections WHERE organization_id=?1 AND revoked_at IS NULL) v",
    i.organizationId,
  );
}
/** At most two distinct installations the principal already authorized for a project: a routing hint only. */
export async function readGithubInstallationHints(context: CatalogContext, raw: unknown) {
  const i = orgScope.extend({ principalId: principal }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    rows = await db
      .prepare(
        "SELECT DISTINCT installation_id FROM github_source_authorizations WHERE organization_id=?1 AND principal_id=?2 AND state='authorized' ORDER BY installation_id LIMIT 2",
      )
      .bind(i.organizationId, i.principalId)
      .all<{ installation_id: string }>();
  return rows.results.map((row) => row.installation_id);
}
/**
 * Marks the organization's connection revoked and records a revocation for every GitHub repository grant of the
 * organization that has none yet, so the runtime stops auto-deploy and linked-source use. Repeating it is harmless.
 */
export async function revokeGithubConnection(context: CatalogContext, raw: unknown) {
  const i = orgScope
      .extend({
        connectionId: ulid,
        now: instant,
        reason: z.enum(["installation_uninstalled", "permission_revoked"]),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "github.revokeConnection",
    input: i,
    read: (reader) =>
      first(
        reader,
        `${CONNECTION} WHERE organization_id=?1 AND connection_id=?2`,
        i.organizationId,
        i.connectionId,
      ),
    decide: (current) =>
      current === null
        ? { replay: null }
        : {
            statements: [
              db
                .prepare(
                  `UPDATE github_organization_connections SET revoked_at=?3 WHERE organization_id=?1 AND connection_id=?2 AND revoked_at IS NULL RETURNING ${CONNECTION.split(" FROM ")[0]}`,
                )
                .bind(i.organizationId, i.connectionId, i.now),
              db
                .prepare(
                  "INSERT INTO repository_grant_revocations(organization_id,revocation_id,grant_id,project_id,reason,revoked_at) SELECT organization_id,grant_id,grant_id,project_id,?2,?3 FROM repository_grants WHERE organization_id=?1 AND provider='github' ON CONFLICT DO NOTHING",
                )
                .bind(i.organizationId, i.reason, i.now),
            ],
            result: ([changed]) => (changed?.results[0] ?? current) as Row | null,
          },
  });
}

const connectionKey = orgScope.extend({ principalId: principal, idempotencyKey: key });
export async function readGithubConnectionAuthorization(context: CatalogContext, raw: unknown) {
  const i = connectionKey.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return first(
    db,
    `${CONNECTION_AUTH} WHERE organization_id=?1 AND principal_id=?2 AND idempotency_key=?3`,
    i.organizationId,
    i.principalId,
    i.idempotencyKey,
  );
}
export async function readGithubConnectionAuthorizationByState(
  context: CatalogContext,
  raw: unknown,
) {
  const i = z.strictObject({ stateSha256: sha256Hex }).parse(raw);
  return first(
    await shard(context),
    `${CONNECTION_AUTH} WHERE state_sha256=unhex(?1)`,
    i.stateSha256,
  );
}
export async function readGithubConnectionAuthorizationById(context: CatalogContext, raw: unknown) {
  const i = authorizationId.parse(raw);
  return first(
    await shard(context),
    `${CONNECTION_AUTH} WHERE authorization_id=?1`,
    i.authorizationId,
  );
}

const connectionInsert = connectionKey.extend({
  authorizationId: ulid,
  ...credential,
  stateSha256: sha256Hex,
  ...sealed,
  createdAt: instant,
  expiresAt: instant,
  installationId: numeric.nullable(),
  flow: z.enum(["installation", "oauth"]),
  handoffDelegation: handoffAuthorityInput.optional(),
});

function connectionGuards(db: D1Database, row: Row) {
  if (row["handoff_delegation"] === null || row["handoff_delegation"] === undefined) return [];
  let authority: z.output<typeof handoffAuthorityInput>;
  try {
    authority = handoffAuthorityInput.parse(JSON.parse(String(row["handoff_delegation"])));
  } catch {
    return [guard(db, "consent_changed", "1")];
  }
  return handoffEffectGuards(db, {
    organizationId: String(row["organization_id"]),
    principalId: String(row["principal_id"]),
    action: "sources:link",
    authority,
  });
}
export async function insertGithubConnectionAuthorization(context: CatalogContext, raw: unknown) {
  const i = connectionInsert.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "github.insertConnectionAuthorization",
    input: i,
    naturalKeyTables: ["github_connection_authorizations"],
    read: (reader) =>
      first(
        reader,
        "1 existing FROM github_connection_authorizations WHERE organization_id=?1 AND principal_id=?2 AND idempotency_key=?3",
        i.organizationId,
        i.principalId,
        i.idempotencyKey,
      ),
    decide: (existing) =>
      existing !== null
        ? { replay: false }
        : {
            statements: [
              ...(i.handoffDelegation === undefined
                ? []
                : handoffEffectGuards(db, {
                    organizationId: i.organizationId,
                    principalId: i.principalId,
                    action: "sources:link",
                    authority: i.handoffDelegation,
                  })),
              db
                .prepare(
                  `INSERT INTO github_connection_authorizations(authorization_id,organization_id,principal_id,session_id,user_api_key_id,workos_organization_id,token_expires_at,idempotency_key,state_sha256,ciphertext,nonce,value_sha256,key_version,created_at,expires_at,installation_id,flow,handoff_delegation)
                   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,unhex(?9),unhex(?10),unhex(?11),unhex(?12),?13,?14,?15,?16,?17,?18)`,
                )
                .bind(
                  i.authorizationId,
                  i.organizationId,
                  i.principalId,
                  i.sessionId,
                  i.userApiKeyId,
                  i.workosOrganizationId,
                  i.tokenExpiresAt,
                  i.idempotencyKey,
                  i.stateSha256,
                  i.ciphertext,
                  i.nonce,
                  i.valueSha256,
                  i.keyVersion,
                  i.createdAt,
                  i.expiresAt,
                  i.installationId,
                  i.flow,
                  i.handoffDelegation === undefined ? null : JSON.stringify(i.handoffDelegation),
                ),
            ],
            result: () => true,
          },
  });
}

const CONNECTION_FAILURES = [
  "installation_access_required",
  "account_admin_required",
  "authorization_code_rejected",
  "provider_unavailable",
  "expired",
  "session_inactive",
  "denied",
  "code_spent",
] as const;
/** Ends an open attempt: back to `pending` for a retryable reason, else `failed`; the row afterwards either way. */
export async function failGithubConnectionAuthorization(context: CatalogContext, raw: unknown) {
  const i = authorizationId
      .extend({ reason: z.enum(CONNECTION_FAILURES), nextState: z.enum(["pending", "failed"]) })
      .parse(raw),
    db = await ownerDb(context, "github_connection_authorizations", i.authorizationId);
  if (db === null) return null;
  return runCommand(db, {
    name: "github.failConnectionAuthorization",
    input: i,
    read: (reader) =>
      first(reader, `${CONNECTION_AUTH} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) =>
      current === null || !["pending", "authorizing"].includes(String(current["state"]))
        ? { replay: current }
        : {
            statements: [
              db
                .prepare(
                  `UPDATE github_connection_authorizations SET state=?3,last_failure=?2 WHERE authorization_id=?1 AND state IN('pending','authorizing') RETURNING ${CONNECTION_AUTH.split(" FROM ")[0]}`,
                )
                .bind(i.authorizationId, i.reason, i.nextState),
            ],
            result: ([changed]) => (changed?.results[0] ?? current) as Row | null,
          },
  });
}
/** A returning installation skips the install page: the attempt moves to the OAuth step with that installation. */
export async function advanceGithubConnectionToOauth(context: CatalogContext, raw: unknown) {
  const i = authorizationId.extend({ installationId: numeric }).parse(raw),
    db = await ownerDb(context, "github_connection_authorizations", i.authorizationId);
  if (db === null) return null;
  return runCommand(db, {
    name: "github.advanceConnectionToOauth",
    input: i,
    read: (reader) =>
      first(reader, `${CONNECTION_AUTH} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) =>
      current === null || current["state"] !== "pending"
        ? { replay: null }
        : {
            statements: [
              ...connectionGuards(db, current),
              db
                .prepare(
                  `UPDATE github_connection_authorizations SET flow='oauth',installation_id=?2 WHERE authorization_id=?1 AND state='pending' RETURNING ${CONNECTION_AUTH.split(" FROM ")[0]}`,
                )
                .bind(i.authorizationId, i.installationId),
            ],
            result: (results) => (results.at(-1)?.results[0] ?? null) as Row | null,
          },
  });
}
/** `pending` -> `authorizing` with the installation the callback named; true when this call claimed it. */
export async function claimGithubConnectionAuthorization(context: CatalogContext, raw: unknown) {
  const i = authorizationId
      .extend({ installationId: numeric, now: instant.optional(), expiresAt: instant.optional() })
      .parse(raw),
    db = await ownerDb(context, "github_connection_authorizations", i.authorizationId);
  if (db === null) return false;
  return runCommand(db, {
    name: "github.claimConnectionAuthorization",
    input: i,
    read: (reader) =>
      first(reader, `${CONNECTION_AUTH} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) =>
      current === null || current["state"] !== "pending"
        ? { replay: false }
        : {
            statements: [
              ...connectionGuards(db, current),
              ...providerLeaseInsert(db, current, i.now, i.expiresAt),
              db
                .prepare(
                  "UPDATE github_connection_authorizations SET state='authorizing',installation_id=?2,last_failure=NULL WHERE authorization_id=?1 AND state='pending'",
                )
                .bind(i.authorizationId, i.installationId),
            ],
            result: (results) => results.at(-1)?.meta.changes === 1,
          },
  });
}

function validLease(now: string | undefined, expiresAt: string | undefined): boolean {
  if (now === undefined || expiresAt === undefined) return false;
  const duration = Date.parse(expiresAt) - Date.parse(now);
  return Number.isFinite(duration) && duration > 0 && duration <= 60_000;
}
function providerLeaseInsert(
  db: D1Database,
  row: Row,
  now: string | undefined,
  expiresAt: string | undefined,
) {
  if (row["handoff_delegation"] == null) return [];
  if (!validLease(now, expiresAt)) return [guard(db, "consent_changed", "1")];
  const authority = handoffAuthorityInput.parse(JSON.parse(String(row["handoff_delegation"])));
  return [
    db
      .prepare(
        `INSERT INTO github_connection_provider_uses(authorization_id,organization_id,user_id,client_id,consent_hash,expires_at) VALUES(?,?,?,?,?,?)`,
      )
      .bind(
        row["authorization_id"],
        row["organization_id"],
        String(row["principal_id"]).slice(5),
        authority.clientId,
        authority.consentHash,
        expiresAt,
      ),
  ];
}
/** A provider use can only be extended while its exact handoff and lease remain current. */
export async function renewGithubConnectionProviderUse(context: CatalogContext, raw: unknown) {
  const i = authorizationId.extend({ now: instant, expiresAt: instant }).parse(raw);
  const db = await ownerDb(context, "github_connection_authorizations", i.authorizationId);
  if (db === null || !validLease(i.now, i.expiresAt)) return false;
  return runCommand(db, {
    name: "github.renewConnectionProviderUse",
    input: i,
    read: (reader) =>
      first(reader, `${CONNECTION_AUTH} WHERE authorization_id=?1`, i.authorizationId),
    decide: (current) =>
      current === null || current["state"] !== "authorizing"
        ? { replay: false }
        : {
            statements: [
              ...connectionGuards(db, current),
              db
                .prepare(
                  "UPDATE github_connection_provider_uses SET expires_at=?2 WHERE authorization_id=?1 AND expires_at>?3",
                )
                .bind(i.authorizationId, i.expiresAt, i.now),
            ],
            result: (results) => results.at(-1)?.meta.changes === 1,
          },
  });
}
/** Called only after the provider request has settled, including uncertain outcomes. */
export async function releaseGithubConnectionProviderUse(context: CatalogContext, raw: unknown) {
  const i = authorizationId.parse(raw);
  const db = await ownerDb(context, "github_connection_authorizations", i.authorizationId);
  if (db === null) return false;
  const result = await db
    .prepare("DELETE FROM github_connection_provider_uses WHERE authorization_id=?")
    .bind(i.authorizationId)
    .run();
  return result.meta.changes === 1;
}

export type ConnectionCompletion =
  | { readonly outcome: "gone" | "expired" | "different_account" }
  | { readonly outcome: "connected"; readonly row: Record<string, unknown> };
const proof = z.strictObject({
  installationId: numeric,
  accountId: numeric,
  accountLogin: login,
  accountType: z.enum(["User", "Organization"]),
  githubUserId: numeric,
  githubUserLogin: login,
  settingsUrl: z.string().url().max(2048),
});
/**
 * Records what GitHub proved: the one active connection of the organization is created (or, when the same account
 * installed it again, kept) and the attempt becomes `connected`. A different account or installation is refused.
 */
export async function completeGithubConnection(context: CatalogContext, raw: unknown) {
  const i = authorizationId
      .extend({
        organizationId: ulid,
        principalId: principal,
        connectionId: ulid,
        now: instant,
        proof,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "github.completeConnection",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["github_organization_connections"],
    read: async (reader) => ({
      attempt: await first(
        reader,
        `${CONNECTION_AUTH} WHERE authorization_id=?1`,
        i.authorizationId,
      ),
      existing: await first(
        reader,
        `${CONNECTION} WHERE organization_id=?1 AND revoked_at IS NULL`,
        i.organizationId,
      ),
    }),
    decide: ({ attempt, existing }): Plan<ConnectionCompletion> => {
      if (attempt === null) return { replay: { outcome: "gone" as const } };
      if (
        attempt["organization_id"] !== i.organizationId ||
        attempt["principal_id"] !== i.principalId
      )
        return { replay: { outcome: "gone" as const } };
      if (attempt["state"] === "connected")
        return { replay: { outcome: "connected" as const, row: attempt } };
      if (attempt["state"] !== "authorizing" || (attempt["expires_at"] as string) <= i.now)
        return { replay: { outcome: "expired" as const } };
      if (
        existing !== null &&
        (existing["installation_id"] !== i.proof.installationId ||
          existing["account_id"] !== i.proof.accountId)
      )
        return { replay: { outcome: "different_account" as const } };
      const id = (existing?.["connection_id"] as string | undefined) ?? i.connectionId;
      return {
        statements: [
          ...connectionGuards(db, attempt),
          ...(attempt["handoff_delegation"] == null
            ? []
            : [
                guard(
                  db,
                  "consent_changed",
                  "NOT EXISTS (SELECT 1 FROM github_connection_provider_uses WHERE authorization_id=? AND expires_at>?)",
                  [i.authorizationId, i.now],
                ),
              ]),
          ...(existing === null
            ? [
                db
                  .prepare(
                    "INSERT INTO github_organization_connections(connection_id,organization_id,installation_id,account_id,account_login,account_type,github_user_id,github_user_login,principal_id,settings_url,connected_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                  )
                  .bind(
                    id,
                    i.organizationId,
                    i.proof.installationId,
                    i.proof.accountId,
                    i.proof.accountLogin,
                    i.proof.accountType,
                    i.proof.githubUserId,
                    i.proof.githubUserLogin,
                    i.principalId,
                    i.proof.settingsUrl,
                    i.now,
                  ),
              ]
            : []),
          db
            .prepare(
              `UPDATE github_connection_authorizations SET state='connected',connection_id=?2,last_failure=NULL WHERE authorization_id=?1 AND state='authorizing' AND expires_at>?3 RETURNING ${CONNECTION_AUTH.split(" FROM ")[0]}`,
            )
            .bind(i.authorizationId, id, i.now),
        ],
        result: (results) => {
          const updated = results[results.length - 1]?.results[0] as Row | undefined;
          return updated === undefined
            ? { outcome: "expired" as const }
            : { outcome: "connected" as const, row: updated };
        },
      };
    },
  });
}

// ----------------------------------------------------------------------------------------------------- link consents

const consentKey = sourceKey;
export async function readGithubRepositoryLinkConsent(context: CatalogContext, raw: unknown) {
  const i = consentKey.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return first(
    db,
    "operation_id operationId,lower(hex(request_sha256)) requestSha256 FROM github_repository_link_consents WHERE organization_id=?1 AND project_id=?2 AND principal_id=?3 AND idempotency_key=?4",
    i.organizationId,
    i.projectId,
    i.principalId,
    i.idempotencyKey,
  );
}
/** Append-only evidence that a connected organization linked one repository through one accepted operation. */
export async function insertGithubRepositoryLinkConsent(context: CatalogContext, raw: unknown) {
  const i = consentKey
      .extend({
        operationId: ulid,
        environmentId: ulid,
        billingEpochId: ulid,
        connectionId: ulid,
        installationId: numeric,
        repositoryId: numeric,
        repositoryOwner: z.string().min(1).max(255),
        repositoryName: z.string().min(1).max(255),
        requestSha256: sha256Hex,
        authorizedAt: instant,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "github.insertRepositoryLinkConsent",
    input: i,
    naturalKeyTables: ["github_repository_link_consents"],
    read: (reader) =>
      first(
        reader,
        "1 existing FROM github_repository_link_consents WHERE operation_id=?1",
        i.operationId,
      ),
    decide: (existing) =>
      existing !== null
        ? { replay: false }
        : {
            statements: [
              db
                .prepare(
                  "INSERT INTO github_repository_link_consents(operation_id,organization_id,project_id,environment_id,billing_epoch_id,connection_id,principal_id,installation_id,repository_id,repository_owner,repository_name,idempotency_key,request_sha256,authorized_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,unhex(?13),?14)",
                )
                .bind(
                  i.operationId,
                  i.organizationId,
                  i.projectId,
                  i.environmentId,
                  i.billingEpochId,
                  i.connectionId,
                  i.principalId,
                  i.installationId,
                  i.repositoryId,
                  i.repositoryOwner,
                  i.repositoryName,
                  i.idempotencyKey,
                  i.requestSha256,
                  i.authorizedAt,
                ),
            ],
            result: () => true,
          },
  });
}
