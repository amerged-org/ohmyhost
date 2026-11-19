import { z } from "zod";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readSnapshot } from "../platform-support.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";

const inputSchema = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  restoreId: ulid,
  claimId: z.uuid(),
  principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
  exportOperationId: ulid,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal("ohmyhost.native-auth-inventory/v1"),
  organizationId: ulid,
  projectId: ulid,
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  migrationVersion: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_VERSION),
  migrationDigest: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_SHA256),
  realms: z
    .array(
      z.strictObject({
        environmentId: ulid,
        schemaName: z.string(),
        revocationEpoch: z.number().int().positive(),
        configurationRevision: z.number().int().positive(),
        dumpOffset: z.number().int().nonnegative(),
        dumpBytes: z.number().int().positive(),
        dumpSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .min(1)
    .max(2),
});
const snapshotSql = `SELECT archive.native_manifest,lower(hex(archive.native_manifest_sha256)) manifest_digest,
  archive.archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AS archive_fresh,
  CASE WHEN job.restore_id IS NULL THEN NULL ELSE json_object('principalId',job.principal_id,'delegation',job.delegation,
    'exportOperationId',job.export_operation_id,'archiveSha256',lower(hex(job.archive_sha256)),
    'claimId',job.claim_id,'state',job.state,'inputFresh',job.input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),
    'currentClaim',EXISTS(SELECT 1 FROM native_auth_restore_claims c WHERE c.organization_id=job.organization_id
      AND c.project_id=job.project_id AND c.restore_id=job.restore_id AND c.claim_id=job.claim_id AND c.input_generation=job.input_generation)) END AS job,
  CASE WHEN restore.restore_id IS NULL THEN NULL ELSE json_object('principalId',restore.principal_id,'delegation',restore.delegation,
    'exportOperationId',restore.export_operation_id,'archiveSha256',lower(hex(restore.archive_sha256)),
    'databaseId',restore.database_id,'state',restore.state) END AS restore,
  CASE WHEN pin.restore_id IS NULL THEN NULL ELSE json_object('state',pin.state,'exact',
    pin.export_operation_id=archive.operation_id AND pin.archive_sha256=archive.archive_sha256
    AND EXISTS(SELECT 1 FROM native_auth_restore_claims c WHERE c.organization_id=pin.organization_id AND c.project_id=pin.project_id
      AND c.restore_id=pin.restore_id AND c.claim_id=pin.claim_id AND c.input_generation<=job.input_generation)
    AND pin.bucket=archive.archive_bucket AND pin.archive_bytes=archive.archive_bytes
    AND pin.manifest_sha256=archive.native_manifest_sha256
    AND pin.object_key='restore-pins/'||archive.organization_id||'/'||archive.project_id||'/'||?3||'.zip') END AS pin,
  EXISTS(SELECT 1 FROM native_auth_restore_imports imported WHERE imported.organization_id=archive.organization_id
    AND imported.project_id=archive.project_id AND imported.restore_id=?3) AS imported,
  EXISTS(SELECT 1 FROM native_auth_restore_pin_absences absent WHERE absent.organization_id=archive.organization_id
    AND absent.project_id=archive.project_id AND absent.restore_id=?3 AND absent.bucket=pin.bucket
    AND absent.object_key=pin.object_key AND absent.source='restore-complete') AS pin_absent
 FROM project_recovery_jobs archive JOIN projects project USING(organization_id,project_id)
 JOIN native_auth_database_targets target ON target.organization_id=archive.organization_id AND target.project_id=archive.project_id
   AND target.database_id=json_extract(archive.native_manifest,'$.databaseId') AND target.ended_at IS NULL
 LEFT JOIN native_auth_restore_jobs job ON job.organization_id=archive.organization_id AND job.project_id=archive.project_id AND job.restore_id=?3
 LEFT JOIN native_auth_restores restore ON restore.organization_id=archive.organization_id AND restore.project_id=archive.project_id AND restore.restore_id=?3
 LEFT JOIN native_auth_restore_pins pin ON pin.organization_id=archive.organization_id AND pin.project_id=archive.project_id AND pin.restore_id=?3
 WHERE archive.organization_id=?1 AND archive.project_id=?2 AND archive.operation_id=?5 AND lower(hex(archive.archive_sha256))=?6
   AND archive.verified_at IS NOT NULL AND archive.failure_code IS NULL AND archive.native_manifest IS NOT NULL
   AND project.owner_state='active' AND project.lifecycle_state='active'`;

/**
 * Private Owner-only metadata observation, never a proof that an executor has stopped.
 * The per-restore Sandbox must separately prove quiescence before exposing a resumable result.
 */
export async function observeNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = inputSchema.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const values = [
    i.organizationId,
    i.projectId,
    i.restoreId,
    i.claimId,
    i.exportOperationId,
    i.archiveSha256,
  ];
  const read = async () => (await readSnapshot(db, [[snapshotSql, ...values]]))[0];
  const before = await read();
  const row = before?.[0];
  if (before?.length !== 1 || row === undefined)
    throw new Error("native_restore_observation_unavailable");
  const manifest = manifestSchema.parse(JSON.parse(String(row["native_manifest"])));
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(String(row["native_manifest"])),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (
    digest !== row["manifest_digest"] ||
    manifest.organizationId !== i.organizationId ||
    manifest.projectId !== i.projectId ||
    manifest.realms.some(
      (realm, index) =>
        realm.schemaName !== `omh_auth_${realm.environmentId.toLowerCase()}` ||
        (index > 0 && realm.environmentId <= (manifest.realms[index - 1]?.environmentId ?? "")),
    )
  )
    throw new Error("native_restore_observation_unavailable");
  await db.batch(
    manifest.realms.map(({ environmentId }) =>
      canonicalAuthorizationGuard(db, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        environmentId,
        principalId: i.principalId,
        action: "auth:manage",
      }),
    ),
  );
  if (JSON.stringify(before) !== JSON.stringify(await read()))
    throw new Error("native_restore_observation_unavailable");
  const job =
    row["job"] === null ? null : (JSON.parse(String(row["job"])) as Record<string, unknown>);
  const restore =
    row["restore"] === null
      ? null
      : (JSON.parse(String(row["restore"])) as Record<string, unknown>);
  const pin =
    row["pin"] === null
      ? null
      : (JSON.parse(String(row["pin"])) as { state: string; exact: number });
  const result = (
    status:
      | "absent"
      | "complete"
      | "resume-input"
      | "resume-consumed"
      | "resume-cleanup"
      | "rearm-input"
      | "unknown",
  ) => ({ status, restoreId: i.restoreId, claimId: i.claimId });
  if (job === null)
    return result(
      restore === null && pin === null && row["archive_fresh"] === 1 ? "absent" : "unknown",
    );
  const exact = (value: Record<string, unknown>) =>
    value["principalId"] === i.principalId &&
    value["delegation"] === null &&
    value["exportOperationId"] === i.exportOperationId &&
    value["archiveSha256"] === i.archiveSha256;
  if (
    !exact(job) ||
    job["claimId"] !== i.claimId ||
    job["currentClaim"] !== 1 ||
    (restore !== null && (!exact(restore) || restore["databaseId"] !== manifest.databaseId))
  )
    throw new Error("native_restore_observation_unavailable");
  if (pin !== null && (pin.exact !== 1 || pin.state !== "verified")) return result("unknown");
  if (
    (job["state"] === "expired" || (job["state"] === "claimed" && job["inputFresh"] === 0)) &&
    pin?.exact === 1 &&
    row["imported"] === 0 &&
    (restore === null || restore["state"] === "restoring")
  )
    return result("rearm-input");
  if (
    job["state"] === "complete" &&
    restore?.["state"] === "complete" &&
    pin?.exact === 1 &&
    row["pin_absent"] === 1
  )
    return result("complete");
  if (
    job["state"] === "complete" &&
    restore?.["state"] === "complete" &&
    pin?.exact === 1 &&
    row["pin_absent"] === 0
  )
    return result("resume-cleanup");
  if (
    job["state"] === "consumed" &&
    pin?.exact === 1 &&
    ((restore?.["state"] === "restoring" && row["imported"] === 1) ||
      restore?.["state"] === "complete")
  )
    return result("resume-consumed");
  if (
    job["state"] === "claimed" &&
    job["inputFresh"] === 1 &&
    (restore === null || restore["state"] === "restoring") &&
    (pin !== null || row["archive_fresh"] === 1)
  )
    return result("resume-input");
  return result("unknown");
}
