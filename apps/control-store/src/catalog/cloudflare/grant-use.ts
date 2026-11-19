import { Buffer } from "node:buffer";
import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, StoreBusyError, StoreOutcomeUnknownError } from "../../run-command.js";
import {
  instant,
  addMilliseconds,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { generalCloudflareGrantDto } from "./authorization.js";
import { unknownOutcome } from "../unknown-outcome.js";
const input = z.strictObject({ organizationId: ulid, projectId: ulid, useId: ulid, now: instant });
const rotated = input.extend({
  authorizationId: ulid,
  expectedUpdatedAt: instant,
  accessCiphertext: z.string(),
  accessNonce: z.string(),
  refreshCiphertext: z.string(),
  refreshNonce: z.string(),
  keyVersion: z.number().int().min(1).max(2147483647),
  accessExpiresAt: instant,
});
const live = `EXISTS(SELECT 1 FROM cloudflare_general_grant_uses use JOIN cloudflare_project_dns_grants g USING(organization_id,project_id) JOIN projects p USING(organization_id,project_id) WHERE use.organization_id=?1 AND use.project_id=?2 AND use.use_id=?3 AND use.expires_at>?4 AND g.authorization_id=use.authorization_id AND g.updated_at=use.grant_updated_at AND p.owner_state='active' AND p.lifecycle_state='active')`;
/** Initial claim includes the original pending-authorization exclusion. A lost reply cannot authorize refresh. */
export async function claimGeneralCloudflareGrantUse(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand<
    {
      active: boolean;
      grant: Record<string, unknown> | undefined;
      pending: boolean;
      use: Record<string, unknown> | undefined;
    },
    | { status: "closed" }
    | { status: "absent" }
    | { status: "claimed"; grant: ReturnType<typeof generalCloudflareGrantDto> }
  >(db, {
    name: "cloudflare.claimGrantUse",
    input: i,
    read: async (reader) => {
      const [project, grant, pending, use] = await reader.batch([
        reader
          .prepare(
            "SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active'",
          )
          .bind(i.organizationId, i.projectId),
        reader
          .prepare(
            "SELECT g.*, (SELECT s.declaration_snapshot FROM cloudflare_project_authorization_states s WHERE s.authorization_id=g.authorization_id) AS declaration_snapshot FROM cloudflare_project_dns_grants g WHERE g.organization_id=?1 AND g.project_id=?2",
          )
          .bind(i.organizationId, i.projectId),
        reader
          .prepare(
            "SELECT 1 FROM cloudflare_project_authorization_states s JOIN cloudflare_project_dns_grants g USING(organization_id,project_id) WHERE s.organization_id=?1 AND s.project_id=?2 AND s.authorization_id<>g.authorization_id AND s.issued_at<=?3 AND s.expires_at>?3",
          )
          .bind(i.organizationId, i.projectId, i.now),
        reader
          .prepare(
            "SELECT use_id,expires_at FROM cloudflare_general_grant_uses WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(i.organizationId, i.projectId),
      ]);
      return {
        active: !!project?.results.length,
        grant: grant?.results[0],
        pending: !!pending?.results.length,
        use: use?.results[0],
      };
    },
    decide: (s) => {
      if (!s.active || s.pending) return { replay: { status: "closed" as const } };
      if (!s.grant) return { replay: { status: "absent" as const } };
      if (s.use && String(s.use["expires_at"]) > i.now)
        return {
          reject:
            s.use["use_id"] === i.useId
              ? new StoreOutcomeUnknownError("cloudflare.claimGrantUse: store_outcome_unknown")
              : new StoreBusyError("General Cloudflare grant is already in use"),
        };
      const authorization = s.grant["authorization_id"],
        updated = s.grant["updated_at"];
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM projects p JOIN cloudflare_project_dns_grants g USING(organization_id,project_id) WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND g.authorization_id=?3 AND g.updated_at=?4)",
            [i.organizationId, i.projectId, authorization, updated],
          ),
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM cloudflare_project_authorization_states s WHERE s.organization_id=?1 AND s.project_id=?2 AND s.authorization_id<>?3 AND s.issued_at<=?4 AND s.expires_at>?4)",
            [i.organizationId, i.projectId, authorization, i.now],
          ),
          db
            .prepare(
              "INSERT INTO cloudflare_general_grant_uses(organization_id,project_id,use_id,authorization_id,grant_updated_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(organization_id,project_id) DO UPDATE SET use_id=excluded.use_id,authorization_id=excluded.authorization_id,grant_updated_at=excluded.grant_updated_at,expires_at=excluded.expires_at WHERE cloudflare_general_grant_uses.expires_at<=?7",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.useId,
              authorization,
              updated,
              addMilliseconds(i.now, 30000),
              i.now,
            ),
          guard(db, "precondition_changed", `NOT ${live}`, [
            i.organizationId,
            i.projectId,
            i.useId,
            i.now,
          ]),
        ],
        result: () => ({
          status: "claimed" as const,
          grant: generalCloudflareGrantDto(s.grant ?? null),
        }),
      };
    },
    lookup: unknownOutcome("cloudflare.claimGrantUse"),
  });
}
/** Renew before each bounded provider request; no arbitrary cap over a valid paged operation. */
export async function renewGeneralCloudflareGrantUse(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  await db.batch([
    guard(db, "precondition_changed", `NOT ${live}`, [
      i.organizationId,
      i.projectId,
      i.useId,
      i.now,
    ]),
    db
      .prepare(
        "UPDATE cloudflare_general_grant_uses SET expires_at=?4 WHERE organization_id=?1 AND project_id=?2 AND use_id=?3",
      )
      .bind(i.organizationId, i.projectId, i.useId, addMilliseconds(i.now, 30000)),
  ]);
}
export async function releaseGeneralCloudflareGrantUse(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  await db
    .prepare(
      "DELETE FROM cloudflare_general_grant_uses WHERE organization_id=?1 AND project_id=?2 AND use_id=?3",
    )
    .bind(i.organizationId, i.projectId, i.useId)
    .run();
}
/** Release our exclusion and store the refreshed sealed pair in the SAME guarded commit. */
export async function finishGeneralCloudflareGrantUse(context: CatalogContext, raw: unknown) {
  const i = rotated.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    decode = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));
  const a = decode(i.accessCiphertext),
    n = decode(i.accessNonce),
    r = decode(i.refreshCiphertext),
    rn = decode(i.refreshNonce);
  if (a.byteLength < 17 || r.byteLength < 17 || n.byteLength !== 12 || rn.byteLength !== 12)
    throw new TypeError("Invalid sealed Cloudflare grant");
  const results = await db.batch([
    guard(db, "precondition_changed", `NOT ${live}`, [
      i.organizationId,
      i.projectId,
      i.useId,
      i.now,
    ]),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM cloudflare_general_grant_uses WHERE organization_id=?1 AND project_id=?2 AND use_id=?3 AND authorization_id=?4 AND grant_updated_at=?5)",
      [i.organizationId, i.projectId, i.useId, i.authorizationId, i.expectedUpdatedAt],
    ),
    db
      .prepare(
        "DELETE FROM cloudflare_general_grant_uses WHERE organization_id=?1 AND project_id=?2 AND use_id=?3",
      )
      .bind(i.organizationId, i.projectId, i.useId),
    db
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_ciphertext=?5,access_nonce=?6,refresh_ciphertext=?7,refresh_nonce=?8,key_version=?9,access_expires_at=?10,updated_at=?11 WHERE organization_id=?1 AND project_id=?2 AND authorization_id=?3 AND updated_at=?4 AND status='active' AND scopes='[\"dns.write\",\"zone.read\"]' RETURNING *",
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.authorizationId,
        i.expectedUpdatedAt,
        a,
        n,
        r,
        rn,
        i.keyVersion,
        i.accessExpiresAt,
        i.now,
      ),
    guard(db, "precondition_changed", "changes()<>1"),
  ]);
  const row = results[3]?.results[0];
  if (!row) throw new StoreOutcomeUnknownError("cloudflare.finishGrantUse: missing committed row");
  return generalCloudflareGrantDto(row);
}
