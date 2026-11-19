import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import type { CatalogContext } from "../common.js";
import { nativeAuthLaunchAllowed } from "../identity/native-auth-launch-policy.js";
import { resolveNativeAuthAdminAuthority } from "../identity/native-auth-authority.js";
import {
  readNativeAuthRegistration,
  nativeRegistrationFromRow,
} from "../identity/native-auth-registration.js";
import { nowOf, previewAuthorityFingerprint, runtimeFence } from "./common.js";
import { authorizePreviewRuntime } from "./runtime.js";

/** Preview source capability and origin are attested by trusted runtime, not an active deployment. */
export async function resolvePreviewNativeAuth(context: CatalogContext, raw: unknown) {
  const i = runtimeFence.parse(raw),
    before = await authorizePreviewRuntime(context, i);
  if (!before) return null;
  const source = before.targetSource;
  if (!source) return null;
  const attested = await context.directory
    .prepare(
      "SELECT 1 FROM project_preview_native_preparations WHERE preview_id=?1 AND auth_generation=?2 AND source_connection_id=?3 AND source_generation=?4 AND source_sequence=?5 AND commit_sha=?6 AND state IN ('running','uncertain','succeeded')",
    )
    .bind(
      before.previewId,
      before.authGeneration,
      source.sourceConnectionId,
      source.sourceGeneration,
      source.sequence,
      source.commitSha,
    )
    .first();
  if (!attested) return null;
  const scope = {
    organizationId: before.organizationId,
    projectId: before.projectId,
    environmentId: before.environmentId,
  };
  const authority = await resolveNativeAuthAdminAuthority(context, scope);
  const registration = await readNativeAuthRegistration(context, {
    projectId: before.projectId,
    environmentId: before.environmentId,
  });
  const after = await authorizePreviewRuntime(context, i);
  if (!after || previewAuthorityFingerprint(after) !== previewAuthorityFingerprint(before))
    return null;
  return {
    preview: after,
    authority,
    registration,
    launchAllowed: nativeAuthLaunchAllowed(context, before.organizationId, before.projectId),
  };
}

/** Cleanup can drain the previously active realm even after source, Paid or owner authority is gone. */
export async function resolvePreviewNativeDrain(context: CatalogContext, raw: unknown) {
  const i = runtimeFence.parse(raw),
    row = await context.directory
      .prepare(
        `SELECT v.preview_id,v.runtime_generation,v.token_generation,CASE WHEN v.retirement='suspended' THEN v.auth_generation-1 ELSE v.auth_generation END auth_generation,v.organization_id,v.project_id,v.environment_id,p.region,
 EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.organization_id=v.organization_id AND r.project_id=v.project_id AND r.environment_id=v.environment_id AND r.state='active') has_registration
 FROM project_previews v JOIN projects p ON p.organization_id=v.organization_id AND p.project_id=v.project_id
 WHERE v.preview_id=?1 AND v.runtime_generation=?2 AND v.token_generation=?3 AND v.retirement IN ('rotating','destroying','suspended')`,
      )
      .bind(i.previewId, i.runtimeGeneration, i.tokenGeneration)
      .first<Record<string, unknown>>();
  if (!row) return null;
  await context.router.routeOrganization(String(row["organization_id"]));
  const registrations = await context.directory
    .prepare(
      "SELECT * FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND state='active'",
    )
    .bind(row["organization_id"], row["project_id"], row["environment_id"])
    .all<Record<string, unknown>>();
  if (
    registrations.results.length > 1 ||
    (row["has_registration"] === 1 && registrations.results.length !== 1)
  )
    throw new Error("preview_native_drain_unavailable");
  const registration = registrations.results[0]
    ? nativeRegistrationFromRow(registrations.results[0])
    : null;
  const after = await context.directory
    .prepare(
      "SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement IN ('rotating','destroying','suspended') AND (CASE WHEN retirement='suspended' THEN auth_generation-1 ELSE auth_generation END)=?4",
    )
    .bind(i.previewId, i.runtimeGeneration, i.tokenGeneration, row["auth_generation"])
    .first();
  if (!after) return null;
  return {
    registration,
    previewId: i.previewId,
    runtimeGeneration: i.runtimeGeneration,
    tokenGeneration: i.tokenGeneration,
    authGeneration: Number(row["auth_generation"]),
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    region: row["region"] as "eu" | "us",
    hasRegistration: row["has_registration"] === 1,
  };
}

/** Called only by Native after both SQL locks were committed; no guest can write this receipt. */
export async function recordPreviewNativeDrain(context: CatalogContext, raw: unknown) {
  const i = runtimeFence.extend({ authGeneration: z.number().int().positive().safe() }).parse(raw),
    now = nowOf(i),
    db = context.directory;
  const scope = {
    previewId: i.previewId,
    runtimeGeneration: i.runtimeGeneration,
    tokenGeneration: i.tokenGeneration,
    ...(i.now ? { now: i.now } : {}),
    ...(i.clock ? { clock: i.clock } : {}),
  };
  const current = await resolvePreviewNativeDrain(context, scope);
  if (!current || current.authGeneration !== i.authGeneration)
    throw new Error("preview_native_drain_unavailable");
  await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement IN ('rotating','destroying','suspended') AND (CASE WHEN retirement='suspended' THEN auth_generation-1 ELSE auth_generation END)=?4)",
      [i.previewId, i.runtimeGeneration, i.tokenGeneration, i.authGeneration],
    ),
    db
      .prepare(
        "INSERT INTO project_preview_native_drains(preview_id,runtime_generation,token_generation,auth_generation,completed_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
      )
      .bind(i.previewId, i.runtimeGeneration, i.tokenGeneration, i.authGeneration, now),
  ]);
}
/** Retirement cannot report success before the active Native realm has drained. */
export function previewNativeDrainGuard(
  db: D1Database,
  previewId: string,
  runtimeGeneration: number,
  tokenGeneration: number,
) {
  return guard(
    db,
    "precondition_changed",
    `EXISTS(SELECT 1 FROM project_previews v WHERE v.preview_id=?1 AND EXISTS(SELECT 1 FROM native_auth_registrations r WHERE r.organization_id=v.organization_id AND r.project_id=v.project_id AND r.environment_id=v.environment_id AND r.state='active') AND NOT EXISTS(SELECT 1 FROM project_preview_native_drains d WHERE d.preview_id=v.preview_id AND d.runtime_generation=?2 AND d.token_generation=?3 AND d.auth_generation=v.auth_generation))`,
    [previewId, runtimeGeneration, tokenGeneration],
  );
}
