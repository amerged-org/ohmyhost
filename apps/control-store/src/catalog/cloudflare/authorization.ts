import { Buffer } from "node:buffer";
import { z } from "zod";
import { bytesOf } from "../platform-support.js";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import {
  instant,
  publicTimestamp,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { unknownOutcome } from "../unknown-outcome.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";

const scope = { organizationId: ulid, projectId: ulid };
const digest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .transform((value) => Uint8Array.from(Buffer.from(value.slice(7), "hex")));
const bytes = z.instanceof(Uint8Array).refine((value) => value.byteLength === 32);
const domain = z
  .string()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);
const actor = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code <= 31 || code === 127);
      }),
  );
const beginInput = z.strictObject({
  ...scope,
  authorizationId: ulid,
  principalId: actor,
  zoneName: domain,
  idempotencyKeySha256: digest,
  requestSha256: digest,
  stateSha256: bytes,
  issuedAt: instant,
  expiresAt: instant,
});
const consumeInput = z.strictObject({
  authorizationId: ulid,
  stateSha256: bytes,
  principalId: actor,
  consumedAt: instant,
});
const grantInput = z.strictObject({
  ...scope,
  authorizationId: ulid,
  principalId: actor,
  zoneName: domain,
  zoneId: z.string().regex(/^[0-9a-f]{32}$/u),
  accountId: z.string().regex(/^[0-9a-f]{32}$/u),
  scopes: z.tuple([z.literal("dns.write"), z.literal("zone.read")]),
  accessCiphertext: z.string(),
  accessNonce: z.string(),
  refreshCiphertext: z.string(),
  refreshNonce: z.string(),
  keyVersion: z.number().int().min(1).max(2147483647),
  accessExpiresAt: instant,
  connectedAt: instant,
});
const projectActive =
  "EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active')";
const declared = (
  alias: string,
) => `SELECT 'paid' kind,lower(hex(apply_idempotency_sha256)) identity,hostname FROM paid_project_domains WHERE organization_id=${alias}.organization_id AND project_id=${alias}.project_id AND state IN('awaiting_deployment','pending','active') AND(hostname=${alias}.zone_name OR substr(hostname,-length(${alias}.zone_name)-1)='.'||${alias}.zone_name)
 UNION ALL SELECT 'legacy_mail',CAST(declaration_generation AS TEXT),domain FROM project_mail_domains WHERE organization_id=${alias}.organization_id AND project_id=${alias}.project_id AND(domain=${alias}.zone_name OR substr(domain,-length(${alias}.zone_name)-1)='.'||${alias}.zone_name)
 UNION ALL SELECT 'resend_mail',domain_id,domain FROM resend_mail_domains WHERE organization_id=${alias}.organization_id AND project_id=${alias}.project_id AND deleted_at IS NULL AND(domain=${alias}.zone_name OR substr(domain,-length(${alias}.zone_name)-1)='.'||${alias}.zone_name)`;
const declarationCurrent = (alias: string) =>
  `EXISTS(SELECT 1 FROM (${declared(alias)}) current JOIN json_each(${alias}.declaration_snapshot) old ON json_extract(old.value,'$.kind')=current.kind AND json_extract(old.value,'$.identity')=current.identity AND json_extract(old.value,'$.hostname')=current.hostname)`;
type Row = Record<string, unknown>;
const hash = (value: unknown) => "sha256:" + Buffer.from(bytesOf(value)).toString("hex");
const same = (left: unknown, right: Uint8Array) =>
  Buffer.from(bytesOf(left)).equals(Buffer.from(right));
function stateDto(row: Row) {
  return {
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    authorizationId: String(row["authorization_id"]),
    principalId: String(row["principal_id"]),
    zoneName: String(row["zone_name"]),
    stateSha256: bytesOf(row["state_sha256"]),
    idempotencyKeySha256: hash(row["idempotency_key_sha256"]),
    requestSha256: hash(row["request_sha256"]),
    issuedAt: publicTimestamp(String(row["issued_at"])),
    expiresAt: publicTimestamp(String(row["expires_at"])),
  };
}
/** The hostnames the authorization declared when the zone was consented; the grant reaches only these names. */
export function declaredHostnamesOf(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const entries = JSON.parse(value) as unknown;
  return Array.isArray(entries)
    ? entries.map((entry) => String((entry as { hostname: unknown }).hostname))
    : [];
}
export function generalCloudflareGrantDto(row: Row | null) {
  if (!row) return null;
  return {
    ...stateScope(row),
    declaredHostnames: declaredHostnamesOf(row["declaration_snapshot"]),
    zoneId: String(row["zone_id"]),
    accountId: String(row["account_id"]),
    scopes: ["dns.write", "zone.read"] as const,
    keyVersion: Number(row["key_version"]),
    accessExpiresAt: publicTimestamp(String(row["access_expires_at"])),
    connectedAt: publicTimestamp(String(row["connected_at"])),
    // This private token also fences refresh/deletion writes. Keep imported microseconds intact.
    updatedAt: String(row["updated_at"]),
    status: row["status"],
    revokedAt: row["revoked_at"] === null ? null : publicTimestamp(String(row["revoked_at"])),
    accessCiphertext: row["access_ciphertext"],
    accessNonce: row["access_nonce"],
    refreshCiphertext: row["refresh_ciphertext"],
    refreshNonce: row["refresh_nonce"],
  };
}
function stateScope(row: Row) {
  return {
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    authorizationId: String(row["authorization_id"]),
    principalId: String(row["principal_id"]),
    zoneName: String(row["zone_name"]),
  };
}
function namedError(name: string): Error {
  const result = new Error(name);
  result.name = name;
  return result;
}
const conflict = () => namedError("CloudflareProjectDomainConflictError");

/** Original one-transaction declaration check and idempotent authorization creation. */
export async function claimGeneralCloudflareAuthorization(context: CatalogContext, raw: unknown) {
  const i = beginInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const read = (reader: D1Database) =>
    reader
      .prepare(
        "SELECT * FROM cloudflare_project_authorization_states WHERE authorization_id=?1 OR state_sha256=?6 OR(organization_id=?2 AND project_id=?3 AND principal_id=?4 AND idempotency_key_sha256=?5) ORDER BY authorization_id",
      )
      .bind(
        i.authorizationId,
        i.organizationId,
        i.projectId,
        i.principalId,
        i.idempotencyKeySha256,
        i.stateSha256,
      )
      .all();
  const hasDeclaration = async (reader: D1Database) =>
    (await reader
      .prepare(
        `WITH requested AS(SELECT ?1 organization_id,?2 project_id,?3 zone_name) SELECT 1 FROM requested WHERE EXISTS(${declared("requested")})`,
      )
      .bind(i.organizationId, i.projectId, i.zoneName)
      .first()) !== null;
  return runCommand(db, {
    name: "cloudflare.claimAuthorization",
    input: i,
    naturalKeyTables: ["cloudflare_project_authorization_states"],
    retryOn: ["precondition_changed", "scope_inactive"],
    read: async (reader) => ({
      rows: (await read(reader)).results,
      declared: await hasDeclaration(reader),
    }),
    decide: ({ rows, declared: zoneDeclared }) => {
      if (!zoneDeclared) return { reject: namedError("CloudflareZoneNotBoundError") };
      if (rows.length > 1) return { reject: conflict() };
      const row = rows[0];
      if (row) {
        if (
          row["organization_id"] !== i.organizationId ||
          row["project_id"] !== i.projectId ||
          row["principal_id"] !== i.principalId ||
          row["zone_name"] !== i.zoneName ||
          !same(row["idempotency_key_sha256"], i.idempotencyKeySha256) ||
          !same(row["request_sha256"], i.requestSha256) ||
          Date.parse(String(row["issued_at"])) > Date.parse(i.issuedAt)
        )
          return { reject: conflict() };
        if (
          row["consumed_at"] !== null ||
          Date.parse(String(row["expires_at"])) <= Date.parse(i.issuedAt)
        )
          return { reject: namedError("CloudflareAuthorizationClosedError") };
        return { replay: stateDto(row) };
      }
      const snapshot = `SELECT coalesce(json_group_array(json_object('kind',kind,'identity',identity,'hostname',hostname)),'[]') FROM (${declared("requested")})`;
      return {
        statements: [
          guard(db, "scope_inactive", `NOT ${projectActive}`, [i.organizationId, i.projectId]),
          db
            .prepare(
              `WITH requested AS(SELECT ?2 organization_id,?3 project_id,?5 zone_name) INSERT INTO cloudflare_project_authorization_states(authorization_id,organization_id,project_id,principal_id,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at,declaration_snapshot) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,(${snapshot}) FROM requested WHERE EXISTS(${declared("requested")}) ON CONFLICT DO NOTHING`,
            )
            .bind(
              i.authorizationId,
              i.organizationId,
              i.projectId,
              i.principalId,
              i.zoneName,
              i.stateSha256,
              i.idempotencyKeySha256,
              i.requestSha256,
              i.issuedAt,
              i.expiresAt,
            ),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM cloudflare_project_authorization_states WHERE authorization_id=?1)",
            [i.authorizationId],
          ),
          db
            .prepare(
              "SELECT * FROM cloudflare_project_authorization_states WHERE authorization_id=?1",
            )
            .bind(i.authorizationId),
        ],
        result: (results) => stateDto(results[3]?.results[0] ?? {}),
      };
    },
    lookup: async (reader) => {
      if (!(await hasDeclaration(reader))) throw namedError("CloudflareZoneNotBoundError");
      const rows = (await read(reader)).results;
      if (rows.length > 1) throw conflict();
      const row = rows[0];
      if (!row) return undefined;
      if (
        row["organization_id"] !== i.organizationId ||
        row["project_id"] !== i.projectId ||
        row["principal_id"] !== i.principalId ||
        row["zone_name"] !== i.zoneName ||
        !same(row["idempotency_key_sha256"], i.idempotencyKeySha256) ||
        !same(row["request_sha256"], i.requestSha256) ||
        Date.parse(String(row["issued_at"])) > Date.parse(i.issuedAt)
      )
        throw conflict();
      if (
        row["consumed_at"] !== null ||
        Date.parse(String(row["expires_at"])) <= Date.parse(i.issuedAt)
      )
        throw namedError("CloudflareAuthorizationClosedError");
      return stateDto(row);
    },
  });
}

/**
 * This is permission to exchange a one-use OAuth code: an uncertain reply must never recreate success. Only the
 * principal that started the authorization consumes it; for any other the row is untouched and the result is null.
 */
export async function consumeGeneralCloudflareAuthorization(context: CatalogContext, raw: unknown) {
  const i = consumeInput.parse(raw),
    db = context.directory;
  const result = await runCommand(db, {
    name: "cloudflare.consumeAuthorization",
    input: i,
    read: async () => null,
    decide: () => ({
      statements: [
        guard(db, "bucket_fenced", "EXISTS(SELECT 1 FROM bucket_fences)"),
        db
          .prepare(
            `UPDATE cloudflare_project_authorization_states AS state SET consumed_at=?3 WHERE authorization_id=?1 AND state_sha256=?2 AND principal_id=?4 AND consumed_at IS NULL AND issued_at<=?3 AND expires_at>?3 AND EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=state.organization_id AND p.project_id=state.project_id AND p.owner_state='active' AND p.lifecycle_state='active') AND ${declarationCurrent("state")} RETURNING *`,
          )
          .bind(i.authorizationId, i.stateSha256, i.consumedAt, i.principalId),
      ],
      result: (rows) => (rows[1]?.results[0] ? stateScope(rows[1].results[0]) : null),
    }),
    lookup: unknownOutcome("cloudflare.consumeAuthorization"),
  });
  return result;
}

export async function readGeneralCloudflareGrant(context: CatalogContext, raw: unknown) {
  const i = z.strictObject(scope).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      "SELECT g.*, (SELECT s.declaration_snapshot FROM cloudflare_project_authorization_states s WHERE s.authorization_id=g.authorization_id) AS declaration_snapshot FROM cloudflare_project_dns_grants g JOIN projects p USING(organization_id,project_id) WHERE g.organization_id=?1 AND g.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')",
    )
    .bind(i.organizationId, i.projectId)
    .first<Row>();
  if (!row) return null;
  // An active grant reaches DNS only while its consenting user still holds project write authority. A grant
  // consented by an API key or a service principal never had a user membership to recheck.
  if (row["status"] === "active" && !(await consentStillHasWriteAuthority(db, row, i.projectId)))
    return {
      status: "reauthorization_required" as const,
      organizationId: String(row["organization_id"]),
      projectId: String(row["project_id"]),
      authorizationId: String(row["authorization_id"]),
      principalId: String(row["principal_id"]),
      zoneName: String(row["zone_name"]),
    };
  return generalCloudflareGrantDto(row);
}

/** A grant the consenting user no longer has the write authority for; the grant's material stays sealed in Core. */
export type GeneralCloudflareReauthorizationRequired = {
  readonly status: "reauthorization_required";
  readonly organizationId: string;
  readonly projectId: string;
  readonly authorizationId: string;
  readonly principalId: string;
  readonly zoneName: string;
};

function isReauthorizationRequired(
  value: unknown,
): value is GeneralCloudflareReauthorizationRequired {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "reauthorization_required"
  );
}

async function consentStillHasWriteAuthority(
  db: D1Database,
  row: Row,
  projectId: string,
): Promise<boolean> {
  const principalId = String(row["principal_id"]);
  if (!principalId.startsWith("user:")) return true;
  const authority = canonicalAuthorizationCondition({
    organizationId: String(row["organization_id"]),
    principalId,
    projectId,
    action: "projects:write",
  });
  const allowed = await db
    .prepare(`SELECT (${authority.sql}) AS allowed`)
    .bind(...authority.params)
    .first<{ allowed: number }>();
  return allowed?.allowed === 1;
}

/** Cipher envelopes stay sealed in Core. Replacement, authorization and final identity are one batch. */
export async function putGeneralCloudflareGrant(context: CatalogContext, raw: unknown) {
  const i = grantInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    decode = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));
  const access = decode(i.accessCiphertext),
    nonce = decode(i.accessNonce),
    refresh = decode(i.refreshCiphertext),
    refreshNonce = decode(i.refreshNonce);
  if (
    access.byteLength < 17 ||
    refresh.byteLength < 17 ||
    nonce.byteLength !== 12 ||
    refreshNonce.byteLength !== 12
  )
    throw conflict();
  const authorized = `SELECT 1 FROM cloudflare_project_authorization_states state JOIN projects p USING(organization_id,project_id) WHERE state.authorization_id=?1 AND state.organization_id=?2 AND state.project_id=?3 AND state.principal_id=?4 AND state.zone_name=?5 AND state.consumed_at IS NOT NULL AND state.consumed_at<=?6 AND ?6<state.expires_at AND p.owner_state='active' AND p.lifecycle_state='active' AND ${declarationCurrent("state")}`;
  const values = [
    i.authorizationId,
    i.organizationId,
    i.projectId,
    i.principalId,
    i.zoneName,
    i.connectedAt,
  ];
  return runCommand(db, {
    name: "cloudflare.putGrant",
    input: i,
    read: (reader) =>
      reader
        .prepare(
          "SELECT * FROM cloudflare_project_dns_grants WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(i.organizationId, i.projectId)
        .first<Row>(),
    decide: (row) => ({
      statements: [
        guard(db, "precondition_changed", `NOT EXISTS(${authorized})`, values),
        db
          .prepare(
            `DELETE FROM cloudflare_project_dns_grants AS replaced WHERE organization_id=?1 AND project_id=?2 AND authorization_id<>?3 AND((status='revoked' AND access_ciphertext IS NULL AND access_nonce IS NULL AND refresh_ciphertext IS NULL AND refresh_nonce IS NULL AND revoked_at IS NOT NULL AND ?4>updated_at) OR(status='active' AND(access_expires_at<=?4 OR(updated_at>connected_at AND updated_at>=(SELECT issued_at FROM cloudflare_project_authorization_states WHERE authorization_id=?3))) AND NOT EXISTS(SELECT 1 FROM cloudflare_project_oauth_revocations revocation WHERE revocation.organization_id=replaced.organization_id AND revocation.project_id=replaced.project_id AND revocation.authorization_id=replaced.authorization_id)))`,
          )
          .bind(i.organizationId, i.projectId, i.authorizationId, i.connectedAt),
        db
          .prepare(
            "INSERT INTO cloudflare_project_dns_grants(organization_id,project_id,authorization_id,principal_id,zone_id,zone_name,account_id,scopes,access_ciphertext,access_nonce,refresh_ciphertext,refresh_nonce,key_version,access_expires_at,status,connected_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'[\"dns.write\",\"zone.read\"]',?8,?9,?10,?11,?12,?13,'active',?14,?14) ON CONFLICT DO NOTHING",
          )
          .bind(
            i.organizationId,
            i.projectId,
            i.authorizationId,
            i.principalId,
            i.zoneId,
            i.zoneName,
            i.accountId,
            access,
            nonce,
            refresh,
            refreshNonce,
            i.keyVersion,
            i.accessExpiresAt,
            i.connectedAt,
          ),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM cloudflare_project_dns_grants WHERE organization_id=?1 AND project_id=?2 AND authorization_id=?3 AND principal_id=?4 AND zone_id=?5 AND zone_name=?6 AND account_id=?7 AND access_ciphertext=?8 AND access_nonce=?9 AND refresh_ciphertext=?10 AND refresh_nonce=?11 AND key_version=?12 AND substr(access_expires_at,1,23)=substr(?13,1,23) AND substr(connected_at,1,23)=substr(?14,1,23) AND status='active')",
          [
            i.organizationId,
            i.projectId,
            i.authorizationId,
            i.principalId,
            i.zoneId,
            i.zoneName,
            i.accountId,
            access,
            nonce,
            refresh,
            refreshNonce,
            i.keyVersion,
            i.accessExpiresAt,
            i.connectedAt,
          ],
        ),
      ],
      result: () =>
        row?.["authorization_id"] === i.authorizationId
          ? ("existing" as const)
          : ("created" as const),
    }),
  });
}

export async function readGeneralCloudflareStatus(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ ...scope, now: instant }).parse(raw),
    grant = await readGeneralCloudflareGrant(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
    });
  if (isReauthorizationRequired(grant))
    return {
      status: "reauthorization_required" as const,
      zone: grant.zoneName,
      scopes: [] as ("dns.write" | "zone.read")[],
      expiresAt: null,
    };
  if (grant)
    return {
      status:
        grant.status === "revoked"
          ? "revoked"
          : grant.accessExpiresAt <= publicTimestamp(i.now)
            ? "expired"
            : "authorized",
      zone: grant.zoneName,
      scopes: ["dns.write", "zone.read"],
      expiresAt: grant.accessExpiresAt,
    };
  const { db } = await routeOrganization(context, i.organizationId),
    row = await db
      .prepare(
        "SELECT state.* FROM cloudflare_project_authorization_states state JOIN projects p USING(organization_id,project_id) WHERE state.organization_id=?1 AND state.project_id=?2 AND issued_at<=?3 AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting') ORDER BY issued_at DESC,authorization_id DESC LIMIT 1",
      )
      .bind(i.organizationId, i.projectId, i.now)
      .first<Row>();
  return row
    ? {
        status: String(row["expires_at"]) <= i.now ? "expired" : "pending",
        zone: row["zone_name"],
        scopes: ["dns.write", "zone.read"],
        expiresAt: publicTimestamp(String(row["expires_at"])),
      }
    : { status: "not_authorized", zone: null, scopes: [], expiresAt: null };
}
