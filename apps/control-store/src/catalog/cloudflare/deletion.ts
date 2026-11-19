import { Buffer } from "node:buffer";
import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import {
  instant,
  routeOrganization,
  publicTimestamp,
  ulid,
  type CatalogContext,
} from "../common.js";
import { bytesOf } from "../platform-support.js";
import {
  DELETION_AUTHORIZED_SQL,
  deletionParams,
  readCloudflareProjectDomainDeletionState,
} from "../domains-mail/cloudflare-project-domains.js";
import { generalCloudflareGrantDto } from "./authorization.js";
import { unknownOutcome } from "../unknown-outcome.js";
const scope = { organizationId: ulid, projectId: ulid, operationId: ulid };
const rotation = z.strictObject({
  ...scope,
  authorizationId: ulid,
  expectedUpdatedAt: instant,
  accessCiphertext: z.instanceof(Uint8Array),
  accessNonce: z.instanceof(Uint8Array),
  refreshCiphertext: z.instanceof(Uint8Array),
  refreshNonce: z.instanceof(Uint8Array),
  keyVersion: z.number().int().min(1),
  accessExpiresAt: instant,
  rotatedAt: instant,
});
type Row = Record<string, unknown>;
const same = (value: unknown, bytes: Uint8Array) =>
  Buffer.from(bytesOf(value)).equals(Buffer.from(bytes));
/** The deletion authorization with numbered placeholders (?1 organization, ?2 project, ?3 operation) to embed in wider statements. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/gu, () => `?${++n}`);
};
const AUTHORIZED = numbered(DELETION_AUTHORIZED_SQL);
function revocation(row: Row | null) {
  return row
    ? {
        organizationId: row["organization_id"],
        projectId: row["project_id"],
        operationId: row["operation_id"],
        authorizationId: row["authorization_id"],
        refreshTokenSha256: bytesOf(row["refresh_token_sha256"]),
        state: row["state"],
        providerStartedAt: publicTimestamp(String(row["provider_started_at"])),
        readbackStartedAt:
          row["readback_started_at"] === null
            ? null
            : publicTimestamp(String(row["readback_started_at"])),
        confirmedAt:
          row["confirmed_at"] === null ? null : publicTimestamp(String(row["confirmed_at"])),
      }
    : null;
}

export async function readGeneralCloudflareDeletion(context: CatalogContext, raw: unknown) {
  const i = z.strictObject(scope).parse(raw),
    base = await readCloudflareProjectDomainDeletionState(context, i);
  if (!base) return null;
  const { db } = await routeOrganization(context, i.organizationId),
    rows = await db.batch([
      db
        .prepare(
          "SELECT g.*, (SELECT s.declaration_snapshot FROM cloudflare_project_authorization_states s WHERE s.authorization_id=g.authorization_id) AS declaration_snapshot FROM cloudflare_project_dns_grants g WHERE g.organization_id=?1 AND g.project_id=?2",
        )
        .bind(i.organizationId, i.projectId),
      db
        .prepare(
          "SELECT * FROM cloudflare_project_oauth_revocations WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(i.organizationId, i.projectId),
    ]),
    g = rows[0]?.results[0] ?? null,
    r = rows[1]?.results[0] ?? null;
  if (r && r["state"] === "confirmed" && r["operation_id"] !== i.operationId) {
    const previous = await db
      .prepare(
        "SELECT 1 FROM operations o JOIN product_command_intents intent USING(organization_id,project_id,operation_id) WHERE o.organization_id=?1 AND o.project_id=?2 AND o.operation_id=?3 AND o.state='failed' AND intent.event_type='ProjectDeletionRequestedV1'",
      )
      .bind(i.organizationId, i.projectId, r["operation_id"])
      .first();
    if (!previous) return null;
  }
  const newest = new Map<
    string,
    (typeof base.customHostnameDeleteTargets)[number] & { receiptId: string }
  >();
  for (const receipt of base.receipts) {
    if (receipt.kind !== "custom_hostname") continue;
    const env = String(receipt["environmentName"]),
      candidate = {
        environmentName: env as "dev" | "prod",
        customHostnameId: String(receipt.providerResourceId),
        hostname: String(receipt["hostname"]),
        observedAt: receipt.observedAt,
        receiptId: receipt.receiptId,
      };
    const old = newest.get(env);
    if (
      !old ||
      old.observedAt < candidate.observedAt ||
      (old.observedAt === candidate.observedAt && old.receiptId < candidate.receiptId)
    )
      newest.set(env, candidate);
  }
  const targets = [...newest.values()]
    .sort((left, right) => left.environmentName.localeCompare(right.environmentName))
    .map(({ receiptId: _receiptId, ...target }) => {
      void _receiptId;
      return target;
    });
  return {
    ...base,
    grant: generalCloudflareGrantDto(g),
    revocation: revocation(r),
    customHostnameDeleteTargets: targets,
  };
}

export async function rotateGeneralCloudflareDeletionGrant(context: CatalogContext, raw: unknown) {
  const i = rotation.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    db
      .prepare(
        `UPDATE cloudflare_project_dns_grants SET access_ciphertext=?6,access_nonce=?7,refresh_ciphertext=?8,refresh_nonce=?9,key_version=?10,access_expires_at=?11,updated_at=?12 WHERE organization_id=?1 AND project_id=?2 AND authorization_id=?4 AND updated_at=?5 AND status='active' AND scopes='["dns.write","zone.read"]' AND EXISTS(${AUTHORIZED}) RETURNING *`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.operationId,
        i.authorizationId,
        i.expectedUpdatedAt,
        i.accessCiphertext,
        i.accessNonce,
        i.refreshCiphertext,
        i.refreshNonce,
        i.keyVersion,
        i.accessExpiresAt,
        i.rotatedAt,
      ),
  ]);
  return generalCloudflareGrantDto(rows[0]?.results[0] ?? null);
}

/** Only the first committed preparation may revoke; repeated preparation changes to observe/readback. */
export async function prepareGeneralCloudflareRevocation(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        ...scope,
        authorizationId: ulid,
        expectedGrantUpdatedAt: instant,
        refreshTokenSha256: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
        preparedAt: instant,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "cloudflare.prepareRevocation",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["cloudflare_project_oauth_revocations"],
    read: async (reader) => {
      const [auth, g, r] = await reader.batch([
        reader.prepare(DELETION_AUTHORIZED_SQL).bind(...deletionParams(i)),
        reader
          .prepare(
            "SELECT g.*, (SELECT s.declaration_snapshot FROM cloudflare_project_authorization_states s WHERE s.authorization_id=g.authorization_id) AS declaration_snapshot FROM cloudflare_project_dns_grants g WHERE g.organization_id=?1 AND g.project_id=?2",
          )
          .bind(i.organizationId, i.projectId),
        reader
          .prepare(
            "SELECT * FROM cloudflare_project_oauth_revocations WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(i.organizationId, i.projectId),
      ]);
      return {
        authorized: auth?.results.length === 1,
        grant: g?.results[0],
        revocation: r?.results[0],
      };
    },
    decide: (s) => {
      if (!s.authorized) return { replay: "blocked" as const };
      const g = s.grant,
        r = s.revocation;
      if (!r) {
        if (
          !g ||
          g["status"] !== "active" ||
          g["authorization_id"] !== i.authorizationId ||
          g["updated_at"] !== i.expectedGrantUpdatedAt
        )
          return { replay: "blocked" as const };
        return {
          statements: [
            guard(
              db,
              "precondition_changed",
              `NOT EXISTS(${DELETION_AUTHORIZED_SQL})`,
              deletionParams(i),
            ),
            db
              .prepare(
                "INSERT INTO cloudflare_project_oauth_revocations(organization_id,project_id,operation_id,authorization_id,refresh_token_sha256,state,provider_started_at,readback_started_at,confirmed_at) SELECT ?1,?2,?3,?4,?5,'revoke_started',?6,NULL,NULL FROM cloudflare_project_dns_grants WHERE organization_id=?1 AND project_id=?2 AND authorization_id=?4 AND updated_at=?7 AND status='active'",
              )
              .bind(
                i.organizationId,
                i.projectId,
                i.operationId,
                i.authorizationId,
                i.refreshTokenSha256,
                i.preparedAt,
                i.expectedGrantUpdatedAt,
              ),
            guard(db, "precondition_changed", "changes()<>1"),
          ],
          result: () => "revoke" as const,
        };
      }
      if (
        !g ||
        g["status"] !== "active" ||
        g["authorization_id"] !== r["authorization_id"] ||
        r["operation_id"] !== i.operationId ||
        r["authorization_id"] !== i.authorizationId ||
        !same(r["refresh_token_sha256"], i.refreshTokenSha256) ||
        r["state"] !== "revoke_started"
      )
        return { replay: "blocked" as const };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${DELETION_AUTHORIZED_SQL})`,
            deletionParams(i),
          ),
          db
            .prepare(
              "UPDATE cloudflare_project_oauth_revocations SET state='readback_started',readback_started_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='revoke_started' AND authorization_id=?5 AND refresh_token_sha256=?6",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.operationId,
              i.preparedAt,
              i.authorizationId,
              i.refreshTokenSha256,
            ),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        result: () => "readback" as const,
      };
    },
    lookup: unknownOutcome("cloudflare.prepareRevocation"),
  });
}

export async function restartGeneralCloudflareRevocation(context: CatalogContext, raw: unknown) {
  const i = rotation
      .extend({
        expectedRefreshTokenSha256: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
        refreshTokenSha256: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    db
      .prepare(
        `UPDATE cloudflare_project_oauth_revocations SET refresh_token_sha256=?14,state='revoke_started',provider_started_at=?12,readback_started_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND authorization_id=?4 AND state='readback_started' AND refresh_token_sha256=?13 AND EXISTS(${AUTHORIZED}) AND EXISTS(SELECT 1 FROM cloudflare_project_dns_grants g WHERE g.organization_id=?1 AND g.project_id=?2 AND g.authorization_id=?4 AND g.updated_at=?5 AND g.status='active')`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.operationId,
        i.authorizationId,
        i.expectedUpdatedAt,
        i.accessCiphertext,
        i.accessNonce,
        i.refreshCiphertext,
        i.refreshNonce,
        i.keyVersion,
        i.accessExpiresAt,
        i.rotatedAt,
        i.expectedRefreshTokenSha256,
        i.refreshTokenSha256,
      ),
    db
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_ciphertext=?6,access_nonce=?7,refresh_ciphertext=?8,refresh_nonce=?9,key_version=?10,access_expires_at=?11,updated_at=?12 WHERE changes()=1 AND organization_id=?1 AND project_id=?2 AND authorization_id=?4 AND updated_at=?5 AND status='active' RETURNING *",
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.operationId,
        i.authorizationId,
        i.expectedUpdatedAt,
        i.accessCiphertext,
        i.accessNonce,
        i.refreshCiphertext,
        i.refreshNonce,
        i.keyVersion,
        i.accessExpiresAt,
        i.rotatedAt,
      ),
  ]);
  return generalCloudflareGrantDto(rows[1]?.results[0] ?? null);
}

/** Original conditional domain/grant/revocation terminal effects share this one commit. */
export async function finalizeGeneralCloudflareDeletion(
  context: CatalogContext,
  raw: unknown,
  platformOnly = false,
) {
  const i = z.strictObject({ ...scope, finalizedAt: instant }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    db
      .prepare(
        `UPDATE cloudflare_project_domains SET deleted_at=?4 WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND EXISTS(${AUTHORIZED})`,
      )
      .bind(i.organizationId, i.projectId, i.operationId, i.finalizedAt),
    db
      .prepare(
        `SELECT EXISTS(${AUTHORIZED}) AND(NOT EXISTS(SELECT 1 FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2) OR EXISTS(SELECT 1 FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at<=?4)) ok`,
      )
      .bind(i.organizationId, i.projectId, i.operationId, i.finalizedAt),
    ...(!platformOnly
      ? [
          db
            .prepare(
              `UPDATE cloudflare_project_dns_grants SET status='revoked',access_ciphertext=NULL,access_nonce=NULL,refresh_ciphertext=NULL,refresh_nonce=NULL,revoked_at=?4,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND status='active' AND ?4>=updated_at AND EXISTS(${AUTHORIZED}) AND(NOT EXISTS(SELECT 1 FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2) OR EXISTS(SELECT 1 FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at<=?4)) AND EXISTS(SELECT 1 FROM cloudflare_project_oauth_revocations r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.operation_id=?3 AND r.authorization_id=cloudflare_project_dns_grants.authorization_id AND r.state IN('revoke_started','readback_started'))`,
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.finalizedAt),
          db
            .prepare(
              `UPDATE cloudflare_project_oauth_revocations SET state='confirmed',confirmed_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('revoke_started','readback_started') AND EXISTS(${AUTHORIZED}) AND(NOT EXISTS(SELECT 1 FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2) OR EXISTS(SELECT 1 FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at<=?4)) AND EXISTS(SELECT 1 FROM cloudflare_project_dns_grants g WHERE g.organization_id=?1 AND g.project_id=?2 AND g.authorization_id=cloudflare_project_oauth_revocations.authorization_id AND g.status='revoked' AND g.revoked_at=?4)`,
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.finalizedAt),
          db
            .prepare(
              `SELECT EXISTS(${AUTHORIZED}) AND EXISTS(SELECT 1 FROM cloudflare_project_oauth_revocations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='confirmed' AND confirmed_at=?4) ok`,
            )
            .bind(i.organizationId, i.projectId, i.operationId, i.finalizedAt),
        ]
      : []),
  ]);
  return rows.at(-1)?.results[0]?.["ok"] === 1;
}
