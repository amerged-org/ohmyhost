import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";
import { originsSql } from "./native-auth-config.js";

const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  principalId: z.string().min(1).max(256),
  configurationRevision: z.number().int().positive().max(2_147_483_647),
  revocationEpoch: z.number().int().positive().max(2_147_483_647),
  enabled: z.boolean(),
  canonicalOrigin: z.string().nullable(),
  handoffDelegation: handoffAuthorityInput.optional(),
});

/**
 * One Core transaction proves a logical realm has never entered a namespace-creating effect.
 * A sibling environment may already use the project's shared database. Core's closed commands
 * retain database/role operation history; registration, preparation and restore receipts also
 * have no-delete guards. Every future realm effect journals its role before dispatch or SQL.
 */
export async function proveNativeAuthUnprovisionedPolicy(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const v = [i.organizationId, i.projectId, i.environmentId];
  const authority = canonicalAuthorizationCondition({ ...i, action: "auth:manage" });
  const guards =
    i.handoffDelegation === undefined
      ? []
      : handoffEffectGuards(db, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          environmentId: i.environmentId,
          principalId: i.principalId,
          action: "auth:manage",
          authority: i.handoffDelegation,
        });
  const result = await db.batch([
    ...guards,
    db.prepare(`SELECT (${authority.sql}) AS allowed`).bind(...authority.params),
    db
      .prepare(
        `SELECT r.configuration_revision,r.revocation_epoch,r.enabled,r.canonical_origin FROM native_auth_realms r
      JOIN projects p ON p.organization_id=r.organization_id AND p.project_id=r.project_id
      JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
      JOIN environments e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.environment_id=r.environment_id
      WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active'`,
      )
      .bind(...v),
    db.prepare(originsSql).bind(...v),
    db
      .prepare(
        `SELECT
      NOT EXISTS(SELECT 1 FROM native_auth_database_operations WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_role_operations WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_preparation_receipts WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_registration_revocations WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_restore_realms WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_restore_import_realms WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms WHERE project_id=?2 AND environment_id=?3)
      AND NOT EXISTS(SELECT 1 FROM native_auth_restores WHERE project_id=?2 AND state='restoring')
      AND NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE project_id=?2 AND state IN ('queued','claimed','consumed')) AS absent`,
      )
      .bind(...v),
  ]);
  const [allowed, realmResult, originsResult, absence] = result.slice(guards.length);
  const row = realmResult?.results[0];
  const absent = absence?.results[0]?.["absent"];
  if (
    allowed?.results[0]?.["allowed"] !== 1 ||
    !row ||
    originsResult?.results.length !== 1 ||
    (absent !== 0 && absent !== 1)
  )
    throw new Error("auth_unavailable");
  const approved: unknown = JSON.parse(String(originsResult.results[0]?.["origins"]));
  if (!Array.isArray(approved)) throw new Error("auth_unavailable");
  const origin =
    typeof row["canonical_origin"] === "string" && approved.includes(row["canonical_origin"])
      ? row["canonical_origin"]
      : null;
  if (
    row["configuration_revision"] !== i.configurationRevision ||
    row["revocation_epoch"] !== i.revocationEpoch ||
    row["enabled"] !== (i.enabled ? 1 : 0) ||
    origin !== i.canonicalOrigin
  )
    throw new Error("auth_unavailable");
  return absent === 1;
}
