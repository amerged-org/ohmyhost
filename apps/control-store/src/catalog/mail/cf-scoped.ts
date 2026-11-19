import { z } from "zod";
import { classifyCustomerMailDomain } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { routeOrganization, ulid, publicTimestamp, type CatalogContext } from "../common.js";
import { mailInput, mailHash, mailTime } from "./auth.js";
import {
  cfAuthorityInput,
  cfAuthorityGuard,
  cfAuthorityHolds,
  type CfAuthority,
} from "./cf-authority.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";

const scope = z.strictObject({
    organizationId: ulid,
    purpose: z.enum(["application_identity", "workspace_mail"]),
    resourceId: ulid,
  }),
  revision = z.number().refine((value) => Number.isInteger(value) && value > 0),
  authorizationInput = cfAuthorityInput.extend({
    authorizationId: ulid,
    resourceRevision: revision,
    zoneName: z.string(),
    idempotencyKeySha256: mailHash,
    requestSha256: mailHash,
    stateSha256: mailHash,
    issuedAt: mailTime,
    expiresAt: mailTime,
  }),
  clockedScope = scope.extend({ now: mailTime }),
  useInput = scope.extend({
    leaseToken: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  }),
  leased = useInput.extend({ now: mailTime }),
  NOW = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",
  LEASE_UNTIL = "(strftime('%Y-%m-%dT%H:%M:%f','now','+2 minutes')||'000Z')",
  AUTH =
    "SELECT a.*,(SELECT original_delegation FROM mcp_dns_authority_conversion c WHERE c.authorization_id=a.authorization_id) signed_delegation,CAST(a.resource_revision AS TEXT) resource_revision,lower(hex(a.state_sha256)) state_sha256,lower(hex(a.idempotency_key_sha256)) idempotency_key_sha256,lower(hex(a.request_sha256)) request_sha256 FROM scoped_customer_dns_authorizations a",
  GRANT =
    "SELECT g.*,CAST(g.resource_revision AS TEXT) resource_revision,lower(hex(g.access_ciphertext)) access_ciphertext,lower(hex(g.access_nonce)) access_nonce,lower(hex(g.refresh_ciphertext)) refresh_ciphertext,lower(hex(g.refresh_nonce)) refresh_nonce,a.issued_at,a.expires_at,a.delegation,(SELECT original_delegation FROM mcp_dns_authority_conversion c WHERE c.authorization_id=a.authorization_id) signed_delegation,lower(hex(a.state_sha256)) state_sha256,lower(hex(a.idempotency_key_sha256)) idempotency_key_sha256,lower(hex(a.request_sha256)) request_sha256,a.revoked_at authorization_revoked_at FROM scoped_customer_dns_grants g JOIN scoped_customer_dns_authorizations a USING(authorization_id)",
  KEY = "organization_id=?1 AND purpose=?2 AND resource_id=?3";
type Scope = z.output<typeof scope>;
type Row = Record<string, unknown>;
const values = (input: Scope) => [input.organizationId, input.purpose, input.resourceId];
/** `lookup` of every command here: a lost reply stays explicitly unknown, named after the command it is called on. */
async function unknownLookup(this: { name: string }): Promise<never> {
  throw new StoreOutcomeUnknownError(`${this.name}: store_outcome_unknown`);
}
function authOf(row: Row): CfAuthority {
  return cfAuthorityInput.parse({
    organizationId: row["organization_id"],
    purpose: row["purpose"],
    resourceId: row["resource_id"],
    principalId: row["principal_id"],
    delegation: row["delegation"] === null ? null : JSON.parse(String(row["delegation"])),
  });
}
function authWire(row: Row) {
  return {
    organizationId: row["organization_id"],
    purpose: row["purpose"],
    resourceId: row["resource_id"],
    resourceRevision: Number(row["resource_revision"]),
    authorizationId: row["authorization_id"],
    principalId: row["principal_id"],
    zoneName: row["zone_name"],
    idempotencyKeySha256: row["idempotency_key_sha256"],
    requestSha256: row["request_sha256"],
    stateSha256: row["state_sha256"],
    issuedAt: row["issued_at"],
    expiresAt: row["expires_at"],
    delegation: row["delegation"] === null ? null : JSON.parse(String(row["delegation"])),
    ...(row["signed_delegation"] == null
      ? {}
      : { signedDelegation: JSON.parse(String(row["signed_delegation"])) }),
  };
}
function grantWire(row: Row) {
  return {
    ...authWire(row),
    zoneId: row["zone_id"],
    accountId: row["account_id"],
    accessCiphertext: row["access_ciphertext"],
    accessNonce: row["access_nonce"],
    refreshCiphertext: row["refresh_ciphertext"],
    refreshNonce: row["refresh_nonce"],
    keyVersion: row["key_version"],
    accessExpiresAt: row["access_expires_at"],
    connectedAt: row["connected_at"],
    revokedAt: row["revoked_at"] ?? row["authorization_revoked_at"],
    dnsReceipts: row["dns_receipts"],
  };
}
function resourceSql(input: Scope, cleanup: boolean) {
  return input.purpose === "application_identity"
    ? "SELECT hostname,CAST(revision AS TEXT) revision,challenge_name,challenge_value FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?3 AND state IN('pending','verified')"
    : `SELECT domain hostname,CAST(revision AS TEXT) revision,NULL challenge_name,NULL challenge_value FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?3 AND status IN(${cleanup ? "'active','retiring'" : "'active'"})`;
}
function currentSql() {
  return `CASE ?2 WHEN 'application_identity' THEN EXISTS(SELECT 1 FROM project_application_domain_identities i JOIN projects p ON p.project_id=i.project_id AND p.organization_id=i.organization_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE i.organization_id=?1 AND i.project_id=?3 AND i.revision=?4 AND i.state IN('pending','verified') AND(i.state='verified' OR i.expires_at>${NOW}) AND(i.hostname=?5 OR substr(i.hostname,-length(?5)-1)='.'||?5)) WHEN 'workspace_mail' THEN EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.organization_id=?1 AND w.domain_id=?3 AND w.revision=?4 AND w.status IN('active','retiring') AND(w.domain=?5 OR substr(w.domain,-length(?5)-1)='.'||?5)) ELSE 0 END`;
}
const currentValues = (input: Scope & { resourceRevision: number; zoneName: string }) => [
  ...values(input),
  input.resourceRevision,
  input.zoneName,
];
function currentGuard(
  db: D1Database,
  input: Scope & { resourceRevision: number; zoneName: string },
) {
  return guard(db, "precondition_changed", `NOT(${currentSql()})`, currentValues(input));
}
function requireCurrent(
  db: D1Database,
  input: Scope & { resourceRevision: number; zoneName: string },
) {
  return db
    .prepare(`SELECT 1 WHERE ${currentSql()}`)
    .bind(...currentValues(input))
    .first();
}
const leaseSql = `SELECT * FROM scoped_dns_provider_uses WHERE ${KEY} AND lease_token=?4 AND lease_until>${NOW}`;
function leaseGuard(db: D1Database, input: z.output<typeof useInput>) {
  return guard(db, "precondition_changed", `NOT EXISTS(${leaseSql})`, [
    ...values(input),
    input.leaseToken,
  ]);
}
function clearLease(db: D1Database, input: z.output<typeof useInput>) {
  return db
    .prepare(`DELETE FROM scoped_dns_provider_uses WHERE ${KEY} AND lease_token=?4`)
    .bind(...values(input), input.leaseToken);
}

/** Callback lookup contains no token material and is also the existing narrow binding probe. */
export async function readCfScopedAuthorization(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ authorizationId: ulid }), raw);
  await context.router.assertLayout();
  const owner = await context.directory
    .prepare(
      "SELECT organization_id FROM scoped_customer_dns_authorizations WHERE authorization_id=?",
    )
    .bind(input.authorizationId)
    .first<{ organization_id: string }>();
  if (!owner) return null;
  const { db } = await routeOrganization(context, owner.organization_id),
    row = await db
      .prepare(`${AUTH} WHERE a.authorization_id=?`)
      .bind(input.authorizationId)
      .first();
  return row === null ? null : authWire(row);
}
export async function issueCfScopedAuthorization(context: CatalogContext, raw: unknown) {
  const input = mailInput(authorizationInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    auth = { ...input },
    delegation = input.delegation === null ? null : mailMetadataJsonb(input.delegation),
    prior = `${AUTH} WHERE a.organization_id=?1 AND a.purpose=?2 AND a.resource_id=?3 AND a.idempotency_key_sha256=unhex(?4)`;
  if (
    Date.parse(input.expiresAt) <= Date.parse(input.issuedAt) ||
    Date.parse(input.expiresAt) - Date.parse(input.issuedAt) > 600000
  )
    throw new TypeError("Invalid scoped DNS expiry");
  return runCommand(db, {
    name: "cf.issueScopedAuthorization",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["scoped_customer_dns_authorizations"],
    read: async (r) => ({
      row: await r
        .prepare(prior)
        .bind(...values(input), input.idempotencyKeySha256)
        .first(),
      allowed: await cfAuthorityHolds(r, auth),
      current: await requireCurrent(r, input),
      resource: await r
        .prepare(resourceSql(input, true))
        .bind(...values(input))
        .first(),
    }),
    decide: (s) => {
      if (!s.allowed) throw new Error("dns_authority_revoked");
      if (!s.current) throw new Error("dns_resource_stale");
      if (s.resource) classifyCustomerMailDomain(String(s.resource["hostname"]));
      if (s.row) {
        const row = s.row;
        if (
          row["request_sha256"] !== input.requestSha256 ||
          Number(row["resource_revision"]) !== input.resourceRevision ||
          row["principal_id"] !== input.principalId ||
          JSON.stringify(authOf(row).delegation) !== JSON.stringify(input.delegation) ||
          row["zone_name"] !== input.zoneName ||
          row["revoked_at"] !== null ||
          row["consumed_at"] !== null ||
          String(row["expires_at"]) <= input.issuedAt
        )
          throw new Error("authorization_closed");
        return { replay: authWire(row) };
      }
      return {
        statements: [
          currentGuard(db, input),
          cfAuthorityGuard(db, auth),
          guard(db, "precondition_changed", `EXISTS(${prior})`, [
            ...values(input),
            input.idempotencyKeySha256,
          ]),
          db
            .prepare(
              `UPDATE scoped_customer_dns_authorizations SET revoked_at=?4 WHERE ${KEY} AND revoked_at IS NULL`,
            )
            .bind(...values(input), input.issuedAt),
          db
            .prepare(
              "INSERT INTO scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision,principal_id,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at,delegation)VALUES(?1,?2,?3,?4,?5,?6,?7,unhex(?8),unhex(?9),unhex(?10),?11,?12,?13)",
            )
            .bind(
              input.authorizationId,
              input.organizationId,
              input.purpose,
              input.resourceId,
              input.resourceRevision,
              input.principalId,
              input.zoneName,
              input.stateSha256,
              input.idempotencyKeySha256,
              input.requestSha256,
              input.issuedAt,
              input.expiresAt,
              delegation,
            ),
        ],
        result: () => ({ ...input }),
      };
    },
  });
}
export async function readCfScopedStatus(context: CatalogContext, raw: unknown) {
  const input = mailInput(clockedScope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    resource = await db
      .prepare(resourceSql(input, true))
      .bind(...values(input))
      .first();
  if (!resource) throw new Error("dns_resource_unavailable");
  const latest = await db
      .prepare(
        `${AUTH} WHERE a.organization_id=?1 AND a.purpose=?2 AND a.resource_id=?3 AND a.resource_revision=?4 ORDER BY a.issued_at DESC,a.authorization_id DESC LIMIT 1`,
      )
      .bind(...values(input), resource["revision"])
      .first(),
    grant = await db
      .prepare(`${GRANT} WHERE g.organization_id=?1 AND g.purpose=?2 AND g.resource_id=?3`)
      .bind(...values(input))
      .first();
  const active =
    grant !== null &&
    String(grant["resource_revision"]) === String(resource["revision"]) &&
    latest?.["authorization_id"] === grant["authorization_id"];
  const row = active ? grant : latest;
  if (!row) return { status: "not_authorized", zone: null, scopes: [], expiresAt: null };
  const revoked =
      row["revoked_at"] !== null ||
      (active && row["authorization_revoked_at"] !== null) ||
      !(await cfAuthorityHolds(db, authOf(row))),
    expires = String(row[active ? "access_expires_at" : "expires_at"]);
  return {
    status: revoked
      ? "revoked"
      : expires <= input.now
        ? "expired"
        : active
          ? "authorized"
          : "pending",
    zone: row["zone_name"],
    scopes: ["dns.write", "zone.read"],
    expiresAt: expires,
  };
}
export async function consumeCfScopedAuthorization(context: CatalogContext, raw: unknown) {
  const input = mailInput(
    z.strictObject({
      authorizationId: ulid,
      stateSha256: mailHash,
      principalId: cfAuthorityInput.shape.principalId,
      now: mailTime,
    }),
    raw,
  );
  await context.router.assertLayout();
  const owner = await context.directory
    .prepare(
      "SELECT organization_id FROM scoped_customer_dns_authorizations WHERE authorization_id=?",
    )
    .bind(input.authorizationId)
    .first<{ organization_id: string }>();
  if (!owner) return null;
  const { db } = await routeOrganization(context, owner.organization_id),
    sql = `${AUTH} WHERE a.authorization_id=?1`;
  return runCommand(db, {
    name: "cf.consumeScopedAuthorization",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    read: async (r) => {
      const row = await r.prepare(sql).bind(input.authorizationId).first();
      if (
        !row ||
        row["state_sha256"] !== input.stateSha256 ||
        row["principal_id"] !== input.principalId ||
        row["consumed_at"] !== null ||
        row["revoked_at"] !== null ||
        String(row["expires_at"]) <= input.now
      )
        return { row, current: false, allowed: false };
      const auth = authOf(row),
        current = {
          ...auth,
          resourceRevision: Number(row["resource_revision"]),
          zoneName: String(row["zone_name"]),
        };
      return {
        row,
        current: (await requireCurrent(r, current)) !== null,
        resource: await r
          .prepare(resourceSql(auth, true))
          .bind(...values(auth))
          .first(),
        allowed: await cfAuthorityHolds(r, auth),
      };
    },
    decide: (snapshot) => {
      const row = snapshot.row;
      if ("resource" in snapshot && snapshot.resource)
        classifyCustomerMailDomain(String(snapshot.resource["hostname"]));
      if (
        !row ||
        row["state_sha256"] !== input.stateSha256 ||
        row["principal_id"] !== input.principalId ||
        row["consumed_at"] !== null ||
        row["revoked_at"] !== null ||
        String(row["expires_at"]) <= input.now
      )
        return { replay: null };
      const auth = authOf(row),
        current = {
          ...auth,
          resourceRevision: Number(row["resource_revision"]),
          zoneName: String(row["zone_name"]),
        };
      if (!snapshot.current || !snapshot.allowed) return { replay: null };
      return {
        statements: [
          currentGuard(db, current),
          cfAuthorityGuard(db, auth),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations WHERE authorization_id=?1 AND state_sha256=unhex(?2) AND principal_id=?4 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?3)",
            [input.authorizationId, input.stateSha256, input.now, input.principalId],
          ),
          db
            .prepare(
              "UPDATE scoped_customer_dns_authorizations SET consumed_at=?2 WHERE authorization_id=?1",
            )
            .bind(input.authorizationId, input.now),
        ],
        result: () => authWire(row),
      };
    },
  });
}

const tokens = z.strictObject({
  accessCiphertext: z.string().regex(/^(?:[a-f0-9]{2})*$/u),
  accessNonce: z.string().regex(/^[a-f0-9]{24}$/u),
  refreshCiphertext: z.string().regex(/^(?:[a-f0-9]{2})*$/u),
  refreshNonce: z.string().regex(/^[a-f0-9]{24}$/u),
  keyVersion: z.number().int().min(1).max(2147483647),
  accessExpiresAt: mailTime,
});
export async function saveCfScopedGrant(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(
      authorizationInput.extend({
        ...tokens.shape,
        zoneId: z.string().regex(/^[a-f0-9]{32}$/u),
        accountId: z.string().regex(/^[a-f0-9]{32}$/u),
        connectedAt: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId);
  await runCommand(db, {
    name: "cf.saveScopedGrant",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    read: async () => null,
    decide: () => ({
      statements: [
        cfAuthorityGuard(db, input),
        currentGuard(db, input),
        // A live refresh token that this authorization replaces is recorded for the sweep, which revokes it upstream.
        db
          .prepare(
            `INSERT INTO scoped_customer_dns_displaced_tokens(displaced_id,organization_id,purpose,resource_id,resource_revision,authorization_id,key_version,refresh_ciphertext,refresh_nonce,displaced_at)
             SELECT lower(hex(randomblob(13))),organization_id,purpose,resource_id,resource_revision,authorization_id,key_version,refresh_ciphertext,refresh_nonce,?5
             FROM scoped_customer_dns_grants WHERE organization_id=?1 AND purpose=?2 AND resource_id=?3 AND authorization_id<>?4 AND revoked_at IS NULL AND length(refresh_ciphertext)>0`,
          )
          .bind(
            input.organizationId,
            input.purpose,
            input.resourceId,
            input.authorizationId,
            input.connectedAt,
          ),
        db
          .prepare(
            `INSERT INTO scoped_customer_dns_grants(organization_id,purpose,resource_id,resource_revision,authorization_id,principal_id,zone_name,zone_id,account_id,access_ciphertext,access_nonce,refresh_ciphertext,refresh_nonce,key_version,access_expires_at,connected_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,unhex(?10),unhex(?11),unhex(?12),unhex(?13),?14,?15,?16)
 ON CONFLICT(organization_id,purpose,resource_id) DO UPDATE SET resource_revision=excluded.resource_revision,authorization_id=excluded.authorization_id,principal_id=excluded.principal_id,zone_name=excluded.zone_name,zone_id=excluded.zone_id,account_id=excluded.account_id,access_ciphertext=excluded.access_ciphertext,access_nonce=excluded.access_nonce,refresh_ciphertext=excluded.refresh_ciphertext,refresh_nonce=excluded.refresh_nonce,key_version=excluded.key_version,access_expires_at=excluded.access_expires_at,connected_at=excluded.connected_at,revoked_at=NULL`,
          )
          .bind(
            ...values(input),
            input.resourceRevision,
            input.authorizationId,
            input.principalId,
            input.zoneName,
            input.zoneId,
            input.accountId,
            input.accessCiphertext,
            input.accessNonce,
            input.refreshCiphertext,
            input.refreshNonce,
            input.keyVersion,
            input.accessExpiresAt,
            input.connectedAt,
          ),
      ],
      result: () => undefined,
    }),
  });
}

export async function revokeCfScopedAuthorization(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      cfAuthorityInput.extend({
        resourceRevision: revision,
        idempotencyKeySha256: mailHash,
        requestSha256: mailHash,
        now: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    prior =
      "SELECT lower(hex(request_sha256)) request_sha256,CAST(resource_revision AS TEXT) resource_revision,principal_id,response FROM scoped_customer_dns_revocations WHERE " +
      KEY +
      " AND idempotency_key_sha256=unhex(?4)",
    latest = `SELECT a.zone_name,a.expires_at,g.access_expires_at FROM scoped_customer_dns_authorizations a LEFT JOIN scoped_customer_dns_grants g USING(authorization_id) WHERE a.organization_id=?1 AND a.purpose=?2 AND a.resource_id=?3 AND a.resource_revision=?4 ORDER BY a.issued_at DESC,a.authorization_id DESC LIMIT 1`;
  return runCommand(db, {
    name: "cf.revokeScopedAuthorization",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["scoped_customer_dns_revocations"],
    read: async (r) => ({
      resource: await r
        .prepare(resourceSql(input, true))
        .bind(...values(input))
        .first(),
      allowed: await cfAuthorityHolds(r, input),
      prior: await r
        .prepare(prior)
        .bind(...values(input), input.idempotencyKeySha256)
        .first(),
      latest: await r
        .prepare(latest)
        .bind(...values(input), input.resourceRevision)
        .first(),
      count: await r
        .prepare(`SELECT count(*) size FROM scoped_customer_dns_authorizations WHERE ${KEY}`)
        .bind(...values(input))
        .first<{ size: number }>(),
    }),
    decide: (s) => {
      if (!s.resource || Number(s.resource["revision"]) !== input.resourceRevision)
        throw new Error("dns_resource_stale");
      if (!s.allowed) throw new Error("dns_authority_revoked");
      if (s.prior) {
        if (
          s.prior["request_sha256"] !== input.requestSha256 ||
          Number(s.prior["resource_revision"]) !== input.resourceRevision ||
          s.prior["principal_id"] !== input.principalId
        )
          throw new Error("idempotency_key_reused");
        return { replay: JSON.parse(String(s.prior["response"])) as Row };
      }
      const response = s.latest
        ? {
            status: "revoked",
            zone: s.latest["zone_name"],
            scopes: ["dns.write", "zone.read"],
            expiresAt: publicTimestamp(
              String(s.latest["access_expires_at"] ?? s.latest["expires_at"]),
            ),
          }
        : { status: "not_authorized", zone: null, scopes: [], expiresAt: null };
      return {
        statements: [
          cfAuthorityGuard(db, input),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${resourceSql(input, true)}) current WHERE current.revision=?4)`,
            [...values(input), String(input.resourceRevision)],
          ),
          guard(
            db,
            "precondition_changed",
            `(SELECT count(*) FROM scoped_customer_dns_authorizations WHERE ${KEY})<>?4`,
            [...values(input), s.count?.size ?? 0],
          ),
          db
            .prepare(
              `UPDATE scoped_customer_dns_authorizations SET revoked_at=?4 WHERE ${KEY} AND revoked_at IS NULL`,
            )
            .bind(...values(input), input.now),
          db
            .prepare(
              `UPDATE scoped_customer_dns_grants SET revoked_at=?4 WHERE ${KEY} AND revoked_at IS NULL`,
            )
            .bind(...values(input), input.now),
          db
            .prepare(
              "INSERT INTO scoped_customer_dns_revocations(organization_id,purpose,resource_id,resource_revision,principal_id,idempotency_key_sha256,request_sha256,revoked_at,response)VALUES(?1,?2,?3,?4,?5,unhex(?6),unhex(?7),?8,?9)",
            )
            .bind(
              ...values(input),
              input.resourceRevision,
              input.principalId,
              input.idempotencyKeySha256,
              input.requestSha256,
              input.now,
              mailMetadataJsonb(response),
            ),
        ],
        result: () => response,
      };
    },
  });
}

const REVOKED_GRANTS = `${GRANT} WHERE g.revoked_at IS NOT NULL AND length(g.refresh_ciphertext)>0 ORDER BY random() LIMIT ?1`;
/** Revoked grants that still store a sealed refresh token, in random order so rows Cloudflare keeps refusing cannot starve the others; the Domain Management sweep revokes that token at Cloudflare, then wipes it. A grant only superseded by a new authorization is not revoked and keeps its tokens. */
export async function listRevokedCfScopedGrants(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ limit: z.number().int().min(1).max(20) }), raw),
    { db } = await context.router.routeShard(0),
    rows = (await db.prepare(REVOKED_GRANTS).bind(input.limit).all()).results;
  return rows.map(grantWire);
}
const wipeInput = scope.extend({
  authorizationId: ulid,
  refreshCiphertext: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
});
/** Wipes both sealed tokens of one revoked grant, only while its stored refresh token is still the one the sweep revoked. */
export async function wipeRevokedCfScopedGrantTokens(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(wipeInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    result = await db
      .prepare(
        "UPDATE scoped_customer_dns_grants SET access_ciphertext=x'',refresh_ciphertext=x'' WHERE organization_id=?1 AND purpose=?2 AND resource_id=?3 AND authorization_id=?4 AND lower(hex(refresh_ciphertext))=?5 AND revoked_at IS NOT NULL",
      )
      .bind(...values(input), input.authorizationId, input.refreshCiphertext)
      .run();
  return result.meta.changes === 1;
}
async function readCleanup(db: D1Database, input: Scope) {
  const row = await db
    .prepare(
      "SELECT domain,custody_project_id,status,dns_receipts,legacy_domain_id FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?3 AND status IN('retiring','retired')",
    )
    .bind(...values(input))
    .first();
  if (!row) throw new Error("mail_retirement_unavailable");
  let stored = String(row["dns_receipts"]),
    receipt = JSON.parse(stored) as Row;
  if (
    !Object.hasOwn(receipt, "records") &&
    !Object.hasOwn(receipt, "cleanup") &&
    row["legacy_domain_id"] !== null
  ) {
    const legacy = await db
      .prepare(
        "SELECT dns_receipts FROM resend_mail_domains WHERE domain_id=?1 AND organization_id=?2",
      )
      .bind(row["legacy_domain_id"], input.organizationId)
      .first();
    if (!legacy) throw new Error("mail_dns_receipt_changed");
    stored = String(legacy["dns_receipts"]);
    receipt = JSON.parse(stored) as Row;
  }
  const records = receipt["records"] ?? [];
  if (
    !Array.isArray(records) ||
    records.length > 32 ||
    records.some(
      (record) =>
        typeof record !== "object" ||
        record === null ||
        (record as Row)["comment"] !== `ohmyhost:${String(row["custody_project_id"])}:mail:v1` ||
        typeof (record as Row)["name"] !== "string" ||
        !(
          (record as Row)["name"] === row["domain"] ||
          String((record as Row)["name"]).endsWith(`.${String(row["domain"])}`)
        ),
    )
  )
    throw new Error("mail_dns_receipt_changed");
  const cleanup = receipt["cleanup"] as Row | undefined;
  if (cleanup !== undefined) {
    if (
      cleanup["status"] !== "deleted" ||
      !Array.isArray(cleanup["recordIds"]) ||
      [...cleanup["recordIds"]].sort().join(",") !==
        records
          .map((record) => (record as Row)["id"])
          .sort()
          .join(",") ||
      typeof cleanup["observedAt"] !== "string" ||
      !Number.isFinite(Date.parse(cleanup["observedAt"]))
    )
      throw new Error("mail_dns_receipt_changed");
    return {
      records,
      zoneId: receipt["zoneId"],
      zoneName: receipt["zoneName"],
      cleanup: { status: "deleted", recordIds: cleanup["recordIds"] },
      receipt: stored,
    };
  }
  const claim = await db
    .prepare(
      `SELECT 1 FROM workspace_mail_commands WHERE organization_id=?1 AND domain_id=?3 AND operation='retire' AND response IS NULL AND lease_until>${NOW} LIMIT 1`,
    )
    .bind(...values(input))
    .first();
  if (row["status"] !== "retiring" || !claim) throw new Error("mail_retirement_unavailable");
  return {
    records,
    zoneId: receipt["zoneId"],
    zoneName: receipt["zoneName"],
    cleanup: null,
    receipt: stored,
  };
}
export async function readCfScopedMailCleanup(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope, raw);
  if (input.purpose !== "workspace_mail") throw new TypeError("Invalid mail cleanup");
  const { db } = await routeOrganization(context, input.organizationId);
  return readCleanup(db, input);
}
function cleanupStatements(
  db: D1Database,
  input: Scope,
  receipt: string,
  recordIds: readonly string[],
  observedAt: string,
): D1PreparedStatement[] {
  const cleanup = {
      status: "deleted",
      recordIds: [...recordIds],
      observedAt: observedAt.slice(0, 23) + "Z",
    },
    fresh = mailMetadataJsonb({ ...(JSON.parse(receipt) as Row), cleanup });
  // This is an actual new cleanup effect, not capture conversion: retain the original JS-to-JSONB write behavior.
  return [
    db
      .prepare(
        "UPDATE workspace_mail_domains SET dns_receipts=?4 WHERE organization_id=?1 AND domain_id=?3 AND status='retiring'",
      )
      .bind(...values(input), fresh),
    db
      .prepare(
        `UPDATE scoped_customer_dns_authorizations SET revoked_at=?4 WHERE ${KEY} AND revoked_at IS NULL`,
      )
      .bind(...values(input), observedAt),
    db
      .prepare(
        `UPDATE scoped_customer_dns_grants SET revoked_at=?4 WHERE ${KEY} AND revoked_at IS NULL`,
      )
      .bind(...values(input), observedAt),
  ];
}
function cleanupGuard(db: D1Database, input: Scope, expectedReceipt: string) {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.organization_id=?1 AND w.domain_id=?3 AND w.status='retiring' AND
 CASE WHEN json_type(w.dns_receipts,'$.records') IS NULL AND json_type(w.dns_receipts,'$.cleanup') IS NULL AND w.legacy_domain_id IS NOT NULL THEN(SELECT d.dns_receipts FROM resend_mail_domains d WHERE d.domain_id=w.legacy_domain_id AND d.organization_id=w.organization_id) ELSE w.dns_receipts END=?4
 AND EXISTS(SELECT 1 FROM workspace_mail_commands c WHERE c.organization_id=w.organization_id AND c.domain_id=w.domain_id AND c.operation='retire' AND c.response IS NULL AND c.lease_until>${NOW}))`,
    [...values(input), expectedReceipt],
  );
}
export async function completeEmptyCfScopedMailCleanup(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope.extend({ expectedReceipt: z.string(), now: mailTime }), raw);
  if (input.purpose !== "workspace_mail") throw new TypeError("Invalid mail cleanup");
  const { db } = await routeOrganization(context, input.organizationId);
  return runCommand(db, {
    name: "cf.completeEmptyMailCleanup",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    read: (r) => readCleanup(r, input),
    decide: (current) => {
      if (current.cleanup !== null) return { replay: current.cleanup };
      if (current.records.length !== 0 || current.receipt !== input.expectedReceipt)
        throw new Error("mail_dns_receipt_changed");
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM scoped_dns_provider_uses WHERE ${KEY} AND lease_until>${NOW})`,
            values(input),
          ),
          cleanupGuard(db, input, input.expectedReceipt),
          ...cleanupStatements(db, input, current.receipt, [], input.now),
        ],
        result: () => ({ status: "deleted", recordIds: [] }),
      };
    },
  });
}

function grantSnapshotGuard(db: D1Database, input: Scope, row: Row) {
  const fields = [
      "authorization_id",
      "resource_revision",
      "principal_id",
      "zone_name",
      "zone_id",
      "account_id",
      "key_version",
      "access_expires_at",
      "connected_at",
      "revoked_at",
      "dns_receipts",
    ],
    blobs = ["access_ciphertext", "access_nonce", "refresh_ciphertext", "refresh_nonce"],
    params: unknown[] = [...values(input)],
    conditions: string[] = [];
  for (const field of fields) {
    params.push(field === "resource_revision" ? Number(row[field]) : row[field]);
    conditions.push(`g.${field} IS ?${params.length}`);
  }
  for (const field of blobs) {
    params.push(row[field]);
    conditions.push(`g.${field} IS unhex(?${params.length})`);
  }
  params.push(row["authorization_revoked_at"]);
  conditions.push(`a.revoked_at IS ?${params.length}`);
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM scoped_customer_dns_grants g JOIN scoped_customer_dns_authorizations a USING(authorization_id) WHERE g.organization_id=?1 AND g.purpose=?2 AND g.resource_id=?3 AND ${conditions.join(" AND ")})`,
    params,
  );
}
/** Acquiring this technical lease grants only this one real resource/grant use; it records no provider fact. */
export async function claimCfScopedDnsUse(context: CatalogContext, raw: unknown) {
  const input = mailInput(leased.extend({ cleanup: z.boolean() }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    grantSql = `${GRANT} WHERE g.organization_id=?1 AND g.purpose=?2 AND g.resource_id=?3`;
  return runCommand(db, {
    name: "cf.claimScopedDnsUse",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    read: async (r) => {
      const resource = await r
          .prepare(resourceSql(input, input.cleanup))
          .bind(...values(input))
          .first(),
        grant = await r
          .prepare(grantSql)
          .bind(...values(input))
          .first();
      if (!resource || !grant)
        return { resource, grant, allowed: false, current: false, pending: false };
      const authority = authOf(grant),
        current = {
          ...authority,
          resourceRevision: Number(grant["resource_revision"]),
          zoneName: String(grant["zone_name"]),
        };
      return {
        resource,
        grant,
        allowed: await cfAuthorityHolds(r, authority),
        current: (await requireCurrent(r, current)) !== null,
        pending:
          (await r
            .prepare(
              "SELECT 1 FROM scoped_customer_dns_authorizations WHERE " +
                KEY +
                " AND authorization_id<>?4 AND issued_at>=?5 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?6 LIMIT 1",
            )
            .bind(...values(input), grant["authorization_id"], grant["issued_at"], input.now)
            .first()) !== null,
      };
    },
    decide: (s) => {
      if (!s.resource) throw new Error("dns_resource_unavailable");
      if (!input.cleanup) classifyCustomerMailDomain(String(s.resource["hostname"]));
      const g = s.grant;
      if (
        !g ||
        g["revoked_at"] !== null ||
        g["authorization_revoked_at"] !== null ||
        String(g["resource_revision"]) !== String(s.resource["revision"])
      )
        return { replay: null };
      if (!s.current) throw new Error("dns_resource_stale");
      if (!s.allowed) return { replay: null };
      if (s.pending) throw new Error("authorization_pending");
      const authority = authOf(g),
        current = {
          ...authority,
          resourceRevision: Number(g["resource_revision"]),
          zoneName: String(g["zone_name"]),
        };
      return {
        statements: [
          currentGuard(db, current),
          cfAuthorityGuard(db, authority),
          grantSnapshotGuard(db, input, g),
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM scoped_dns_provider_uses WHERE ${KEY} AND lease_until>${NOW})`,
            values(input),
          ),
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM scoped_customer_dns_authorizations WHERE ${KEY} AND authorization_id<>?4 AND issued_at>=?5 AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?6)`,
            [...values(input), g["authorization_id"], g["issued_at"], input.now],
          ),
          db.prepare(`DELETE FROM scoped_dns_provider_uses WHERE ${KEY}`).bind(...values(input)),
          db
            .prepare(
              `INSERT INTO scoped_dns_provider_uses(organization_id,purpose,resource_id,authorization_id,principal_id,delegation_grant_id,lease_token,created_at,lease_until)VALUES(?1,?2,?3,?4,?5,?6,?7,${NOW},${LEASE_UNTIL})`,
            )
            .bind(
              ...values(input),
              g["authorization_id"],
              g["principal_id"],
              authority.delegation?.grantId ?? null,
              input.leaseToken,
            ),
        ],
        result: () => ({
          leaseToken: input.leaseToken,
          resource: {
            organizationId: input.organizationId,
            purpose: input.purpose,
            resourceId: input.resourceId,
            revision: Number(s.resource?.["revision"]),
            hostname: s.resource?.["hostname"],
            challengeName: s.resource?.["challenge_name"],
            challengeValue: s.resource?.["challenge_value"],
          },
          grant: grantWire(g),
        }),
      };
    },
  });
}
/** Every actual provider HTTP request renews before it starts; an expired or unknown renewal permits no request. */
export async function renewCfScopedDnsUse(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(useInput, raw),
    { db } = await routeOrganization(context, input.organizationId);
  await runCommand(db, {
    name: "cf.renewScopedDnsUse",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    read: async () => null,
    decide: () => ({
      statements: [
        leaseGuard(db, input),
        db
          .prepare(
            `UPDATE scoped_dns_provider_uses SET lease_until=${LEASE_UNTIL} WHERE ${KEY} AND lease_token=?4`,
          )
          .bind(...values(input), input.leaseToken),
      ],
      result: () => undefined,
    }),
  });
}
/** This is the original post-refresh terminal/membership/MCP recheck, immediately before DNS starts. */
export async function authorizeCfScopedDnsUse(context: CatalogContext, raw: unknown) {
  const input = mailInput(useInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    lease = await db
      .prepare(leaseSql)
      .bind(...values(input), input.leaseToken)
      .first();
  if (!lease) throw new Error("dns_use_lease_lost");
  const row = await db
    .prepare(
      `${GRANT} WHERE g.organization_id=?1 AND g.purpose=?2 AND g.resource_id=?3 AND g.authorization_id=?4`,
    )
    .bind(...values(input), lease["authorization_id"])
    .first();
  return (
    row !== null &&
    row["revoked_at"] === null &&
    row["authorization_revoked_at"] === null &&
    (await cfAuthorityHolds(db, authOf(row)))
  );
}
const dnsRecord = z.strictObject({
    id: z.string(),
    type: z.enum(["CNAME", "NS", "TXT", "MX"]),
    name: z.string(),
    content: z.string(),
    ttl: z.number(),
    proxied: z.boolean(),
    comment: z.string(),
    priority: z.number().optional(),
  }),
  applied = z.strictObject({
    kind: z.literal("applied"),
    tokens: tokens.nullable(),
    records: z.array(dnsRecord).optional(),
    authorizationReceipt: z
      .strictObject({ zoneId: z.string(), zoneName: z.string(), records: z.array(dnsRecord) })
      .optional(),
    cleanup: z
      .strictObject({
        recordIds: z.array(z.string()),
        observedAt: mailTime,
        expectedReceipt: z.string(),
      })
      .optional(),
  }),
  outcome = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("revoked"), revokedAt: mailTime }),
    applied,
  ]);
/** Release the row fences and commit exactly the original token/receipt/cleanup compound in one D1 batch. */
export async function finishCfScopedDnsUse(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(useInput.extend({ result: outcome }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  await runCommand(db, {
    name: "cf.finishScopedDnsUse",
    input,
    lookup: unknownLookup,
    retryOn: ["precondition_changed"],
    read: async (r) => ({
      lease: await r
        .prepare(leaseSql)
        .bind(...values(input), input.leaseToken)
        .first(),
      cleanup:
        input.result.kind === "applied" && input.result.cleanup
          ? await readCleanup(r, input)
          : null,
    }),
    decide: (s) => {
      if (!s.lease) throw new Error("dns_use_lease_lost");
      const statements: D1PreparedStatement[] = [leaseGuard(db, input), clearLease(db, input)],
        result = input.result;
      if (result.kind === "revoked")
        statements.push(
          db
            .prepare(`UPDATE scoped_customer_dns_grants SET revoked_at=?4 WHERE ${KEY}`)
            .bind(...values(input), result.revokedAt),
        );
      else {
        if (result.tokens) {
          const t = result.tokens;
          statements.push(
            db
              .prepare(
                `UPDATE scoped_customer_dns_grants SET access_ciphertext=unhex(?4),access_nonce=unhex(?5),refresh_ciphertext=unhex(?6),refresh_nonce=unhex(?7),key_version=?8,access_expires_at=?9 WHERE ${KEY} AND authorization_id=?10 AND revoked_at IS NULL`,
              )
              .bind(
                ...values(input),
                t.accessCiphertext,
                t.accessNonce,
                t.refreshCiphertext,
                t.refreshNonce,
                t.keyVersion,
                t.accessExpiresAt,
                s.lease["authorization_id"],
              ),
          );
        }
        if (result.records !== undefined)
          statements.push(
            db
              .prepare(`UPDATE scoped_customer_dns_grants SET dns_receipts=?4 WHERE ${KEY}`)
              .bind(...values(input), mailMetadataJsonb(result.records)),
          );
        if (result.authorizationReceipt !== undefined)
          statements.push(
            db
              .prepare(
                "UPDATE scoped_customer_dns_authorizations SET dns_receipts=?2 WHERE authorization_id=?1",
              )
              .bind(s.lease["authorization_id"], mailMetadataJsonb(result.authorizationReceipt)),
          );
        if (result.cleanup) {
          const c = result.cleanup;
          if (
            !s.cleanup ||
            s.cleanup.cleanup !== null ||
            s.cleanup.receipt !== c.expectedReceipt ||
            s.cleanup.records
              .map((r) => String((r as Row)["id"]))
              .sort()
              .join(",") !== [...c.recordIds].sort().join(",")
          )
            throw new Error("mail_dns_receipt_changed");
          statements.push(
            cleanupGuard(db, input, c.expectedReceipt),
            ...cleanupStatements(db, input, c.expectedReceipt, c.recordIds, c.observedAt),
          );
        }
      }
      return { statements, result: () => undefined };
    },
  });
}
export async function releaseCfScopedDnsUse(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(useInput, raw),
    { db } = await routeOrganization(context, input.organizationId);
  await runCommand(db, {
    name: "cf.releaseScopedDnsUse",
    input,
    lookup: unknownLookup,
    read: async () => null,
    decide: () => ({ statements: [clearLease(db, input)], result: () => undefined }),
  });
}
const DISPLACED_TOKENS = `SELECT displaced_id,organization_id,purpose,resource_id,CAST(resource_revision AS TEXT) resource_revision,authorization_id,key_version,lower(hex(refresh_ciphertext)) refresh_ciphertext,lower(hex(refresh_nonce)) refresh_nonce FROM scoped_customer_dns_displaced_tokens ORDER BY random() LIMIT ?1`;
/** Refresh tokens a re-authorization displaced, in random order; the Domain Management sweep revokes each one at Cloudflare and then deletes its row. */
export async function listDisplacedCfScopedTokens(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ limit: z.number().int().min(1).max(20) }), raw),
    { db } = await context.router.routeShard(0),
    rows = (await db.prepare(DISPLACED_TOKENS).bind(input.limit).all()).results;
  return rows.map((row) => ({
    displacedId: row["displaced_id"],
    organizationId: row["organization_id"],
    purpose: row["purpose"],
    resourceId: row["resource_id"],
    resourceRevision: Number(row["resource_revision"]),
    authorizationId: row["authorization_id"],
    keyVersion: row["key_version"],
    refreshCiphertext: row["refresh_ciphertext"],
    refreshNonce: row["refresh_nonce"],
  }));
}
const completeDisplacedInput = scope.extend({
  displacedId: z.string().regex(/^[0-9a-f]{26}$/u),
  refreshCiphertext: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
});
/** Deletes one displaced token pair, only after its refresh token was revoked and only while the row still holds that token. */
export async function completeDisplacedCfScopedToken(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(completeDisplacedInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    result = await db
      .prepare(
        "DELETE FROM scoped_customer_dns_displaced_tokens WHERE displaced_id=?1 AND organization_id=?2 AND lower(hex(refresh_ciphertext))=?3",
      )
      .bind(input.displacedId, input.organizationId, input.refreshCiphertext)
      .run();
  return result.meta.changes === 1;
}
