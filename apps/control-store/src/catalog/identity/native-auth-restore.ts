import { z } from "zod";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

const begin = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: z.string().min(1).max(256),
  restoreId: ulid,
  jobClaimId: z.string().uuid(),
  exportOperationId: ulid,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  delegation: handoffAuthorityInput.optional(),
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
        schemaName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
        revocationEpoch: z.number().int().positive().max(2147483646),
        configurationRevision: z.number().int().positive().max(2147483646),
        dumpOffset: z.number().int().nonnegative().max(268435456),
        dumpBytes: z.number().int().positive().max(268435456),
        dumpSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .min(1)
    .max(2),
});

/** Atomically fences every realm sharing the physical Auth database before import. */
export async function beginNativeAuthRestore(context: CatalogContext, raw: unknown) {
  const i = begin.parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const sha = Uint8Array.from(i.archiveSha256.match(/../gu) ?? [], (hex) =>
    Number.parseInt(hex, 16),
  );
  const job = await db
    .prepare(
      `SELECT native_manifest,native_manifest_sha256 FROM project_recovery_jobs WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND archive_sha256=?4 AND verified_at IS NOT NULL AND failure_code IS NULL`,
    )
    .bind(i.organizationId, i.projectId, i.exportOperationId, sha)
    .first<{ native_manifest: string; native_manifest_sha256: ArrayBuffer }>();
  if (!job || typeof job.native_manifest !== "string" || !job.native_manifest_sha256)
    throw new Error("native_restore_manifest_missing");
  const calculated = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(job.native_manifest)),
  );
  const saved = new Uint8Array(job.native_manifest_sha256);
  if (
    saved.length !== calculated.length ||
    !saved.every((byte, index) => byte === calculated[index])
  )
    throw new Error("native_restore_manifest_invalid");
  const manifest = manifestSchema.parse(JSON.parse(job.native_manifest));
  if (manifest.organizationId !== i.organizationId || manifest.projectId !== i.projectId)
    throw new Error("native_restore_manifest_invalid");
  const environmentIds = manifest.realms.map((realm) => realm.environmentId);
  let expectedOffset = 0;
  for (const realm of manifest.realms) {
    if (realm.dumpOffset !== expectedOffset || expectedOffset + realm.dumpBytes > 268435456)
      throw new Error("native_restore_inventory_invalid");
    expectedOffset += realm.dumpBytes;
  }
  if (
    new Set(environmentIds).size !== environmentIds.length ||
    environmentIds.some((id, index) => index > 0 && id <= (environmentIds[index - 1] ?? ""))
  )
    throw new Error("native_restore_inventory_invalid");
  const ids = [i.organizationId, i.projectId, JSON.stringify(environmentIds)];
  const claimGuard = () =>
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='claimed' AND input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND principal_id=?5 AND delegation IS ?6 AND export_operation_id=?7 AND archive_sha256=?8)`,
      [
        i.organizationId,
        i.projectId,
        i.restoreId,
        i.jobClaimId,
        i.principalId,
        i.delegation === undefined ? null : JSON.stringify(i.delegation),
        i.exportOperationId,
        sha,
      ],
    );
  const authority = environmentIds.flatMap((environmentId) => {
    const scope = {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId,
      principalId: i.principalId,
      action: "auth:manage" as const,
    };
    return [
      canonicalAuthorizationGuard(db, scope),
      ...(i.delegation === undefined
        ? []
        : handoffEffectGuards(db, { ...scope, authority: i.delegation })),
    ];
  });
  const existing = await db
    .prepare(
      `SELECT restore_id FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId)
    .first();
  if (existing) {
    await db.batch([
      ...authority,
      claimGuard(),
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS(SELECT 1 FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND export_operation_id=?4 AND database_id=?5 AND archive_sha256=?6 AND principal_id=?7 AND delegation IS ?8 AND state='restoring')`,
        [
          i.organizationId,
          i.projectId,
          i.restoreId,
          i.exportOperationId,
          manifest.databaseId,
          sha,
          i.principalId,
          i.delegation === undefined ? null : JSON.stringify(i.delegation),
        ],
      ),
    ]);
    for (const environmentId of environmentIds) {
      if (
        !(await readNativeRestore(context, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          environmentId,
          restoreId: i.restoreId,
        }))
      )
        throw new Error("native_restore_authority_invalid");
    }
    return { restoreId: i.restoreId, status: "restoring" as const };
  }
  await db.batch([
    ...authority,
    claimGuard(),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM projects p JOIN native_auth_database_targets t USING(organization_id,project_id) WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND t.database_id=?3 AND t.ended_at IS NULL)`,
      [i.organizationId, i.projectId, manifest.databaseId],
    ),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM project_recovery_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.operation_id=?3 AND j.archive_sha256=?4 AND j.native_manifest=?5 AND j.native_manifest_sha256=?6 AND j.verified_at IS NOT NULL AND j.failure_code IS NULL AND (j.archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') OR EXISTS(SELECT 1 FROM native_auth_restore_pins p WHERE p.organization_id=j.organization_id AND p.project_id=j.project_id AND p.restore_id=?7 AND p.export_operation_id=j.operation_id AND p.archive_sha256=j.archive_sha256 AND p.manifest_sha256=j.native_manifest_sha256 AND p.archive_bytes=j.archive_bytes AND p.bucket=j.archive_bucket AND p.state='verified')) AND EXISTS(SELECT 1 FROM json_each(j.sql_files) WHERE value='auth.sql'))`,
      [
        i.organizationId,
        i.projectId,
        i.exportOperationId,
        sha,
        job.native_manifest,
        saved,
        i.restoreId,
      ],
    ),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_realms r WHERE r.organization_id=?1 AND r.project_id=?2 AND (r.environment_id NOT IN (SELECT value FROM json_each(?3)) OR r.revocation_epoch>=2147483647 OR r.configuration_revision>=2147483647)) OR (SELECT count(*) FROM native_auth_realms r WHERE r.organization_id=?1 AND r.project_id=?2)<>(SELECT count(*) FROM json_each(?3)) OR EXISTS(SELECT 1 FROM json_each(?5,'$.realms') x WHERE NOT EXISTS(SELECT 1 FROM native_auth_registrations reg JOIN native_auth_database_targets t USING(organization_id,project_id,target_version) WHERE reg.organization_id=?1 AND reg.project_id=?2 AND reg.environment_id=json_extract(x.value,'$.environmentId') AND reg.schema_name=json_extract(x.value,'$.schemaName') AND reg.state='active' AND t.database_id=?4 AND t.ended_at IS NULL))`,
      [...ids, manifest.databaseId, job.native_manifest],
    ),
    db
      .prepare(
        `UPDATE native_auth_realms SET enabled=0,revocation_epoch=max(revocation_epoch,(SELECT json_extract(x.value,'$.revocationEpoch') FROM json_each(?4,'$.realms') x WHERE json_extract(x.value,'$.environmentId')=native_auth_realms.environment_id))+1,configuration_revision=max(configuration_revision,(SELECT json_extract(x.value,'$.configurationRevision') FROM json_each(?4,'$.realms') x WHERE json_extract(x.value,'$.environmentId')=native_auth_realms.environment_id))+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id IN (SELECT value FROM json_each(?3))`,
      )
      .bind(...ids, job.native_manifest),
    db
      .prepare(
        `INSERT INTO native_auth_restores(organization_id,project_id,restore_id,export_operation_id,database_id,archive_sha256,principal_id,delegation,restore_generation,captured_at,state) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,COALESCE((SELECT max(restore_generation) FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2),0)+1,j.captured_at,'restoring' FROM project_recovery_jobs j WHERE j.organization_id=?1 AND j.operation_id=?4`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.restoreId,
        i.exportOperationId,
        manifest.databaseId,
        sha,
        i.principalId,
        i.delegation === undefined ? null : JSON.stringify(i.delegation),
      ),
    db
      .prepare(
        `INSERT INTO native_auth_restore_realms(organization_id,project_id,restore_id,environment_id,revocation_epoch,configuration_revision) SELECT organization_id,project_id,?4,environment_id,revocation_epoch,configuration_revision FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id IN (SELECT value FROM json_each(?3))`,
      )
      .bind(...ids, i.restoreId),
  ]);
  return { restoreId: i.restoreId, status: "restoring" as const };
}

/** Private runtime proof; it ceases to exist if Core's fence is no longer exact. */
export async function readNativeRestore(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({ organizationId: ulid, projectId: ulid, environmentId: ulid, restoreId: ulid })
    .parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      `SELECT rr.revocation_epoch,rr.configuration_revision,op.principal_id,op.delegation FROM native_auth_restore_realms rr JOIN native_auth_restores op USING(organization_id,project_id,restore_id) JOIN native_auth_realms r USING(organization_id,project_id,environment_id) JOIN projects p USING(organization_id,project_id) WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.environment_id=?3 AND rr.restore_id=?4 AND op.state='restoring' AND p.owner_state='active' AND p.lifecycle_state='active' AND r.enabled=0 AND r.revocation_epoch=rr.revocation_epoch AND r.configuration_revision=rr.configuration_revision`,
    )
    .bind(i.organizationId, i.projectId, i.environmentId, i.restoreId)
    .first<{
      revocation_epoch: number;
      configuration_revision: number;
      principal_id: string;
      delegation: string | null;
    }>();
  if (row === null) return null;
  const authority = { ...i, principalId: row.principal_id, action: "auth:manage" as const };
  try {
    const delegation =
      row.delegation === null ? undefined : handoffAuthorityInput.parse(JSON.parse(row.delegation));
    await db.batch([
      canonicalAuthorizationGuard(db, authority),
      ...(delegation === undefined
        ? []
        : handoffEffectGuards(db, { ...authority, authority: delegation })),
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS(SELECT 1 FROM native_auth_restore_realms rr JOIN native_auth_restores op USING(organization_id,project_id,restore_id) JOIN native_auth_realms r USING(organization_id,project_id,environment_id) JOIN projects p USING(organization_id,project_id) WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.environment_id=?3 AND rr.restore_id=?4 AND op.state='restoring' AND op.principal_id=?5 AND op.delegation IS ?6 AND p.owner_state='active' AND p.lifecycle_state='active' AND r.enabled=0 AND r.revocation_epoch=rr.revocation_epoch AND r.configuration_revision=rr.configuration_revision AND rr.revocation_epoch=?7 AND rr.configuration_revision=?8)`,
        [
          i.organizationId,
          i.projectId,
          i.environmentId,
          i.restoreId,
          row.principal_id,
          row.delegation,
          row.revocation_epoch,
          row.configuration_revision,
        ],
      ),
    ]);
  } catch {
    return null;
  }
  return {
    scope: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: i.environmentId,
    },
    restoreId: i.restoreId,
    offline: true,
    revocationEpoch: row.revocation_epoch,
    configurationRevision: row.configuration_revision,
    acceptedMutationEpoch: row.revocation_epoch,
  };
}

/** Called only by the private coordinator after receiving an exact runtime acknowledgement. */
export async function acknowledgeNativeRestore(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({
      organizationId: ulid,
      projectId: ulid,
      environmentId: ulid,
      restoreId: ulid,
      kind: z.enum(["offline", "sanitized"]),
      revocationEpoch: z.number().int().positive(),
      configurationRevision: z.number().int().positive(),
    })
    .parse(raw);
  const current = await readNativeRestore(context, {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    restoreId: i.restoreId,
  });
  if (
    !current ||
    current.revocationEpoch !== i.revocationEpoch ||
    current.configurationRevision !== i.configurationRevision
  )
    throw new Error("native_restore_authority_invalid");
  const { db } = await routeOrganization(context, i.organizationId);
  const owner = await db
    .prepare(
      `SELECT principal_id,delegation FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='restoring'`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId)
    .first<{ principal_id: string; delegation: string | null }>();
  if (!owner) throw new Error("native_restore_authority_invalid");
  const authority = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    principalId: owner.principal_id,
    action: "auth:manage" as const,
  };
  const delegation =
    owner.delegation === null
      ? undefined
      : handoffAuthorityInput.parse(JSON.parse(owner.delegation));
  const values = [
    i.organizationId,
    i.projectId,
    i.restoreId,
    i.environmentId,
    i.kind,
    i.revocationEpoch,
    i.configurationRevision,
  ];
  await db.batch([
    canonicalAuthorizationGuard(db, authority),
    ...(delegation === undefined
      ? []
      : handoffEffectGuards(db, { ...authority, authority: delegation })),
    ...(i.kind === "sanitized"
      ? [
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.restore_id=?3 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline'))`,
            values.slice(0, 3),
          ),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO native_auth_restore_acknowledgements(organization_id,project_id,restore_id,environment_id,kind,revocation_epoch,configuration_revision) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO NOTHING`,
      )
      .bind(...values),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND environment_id=?4 AND kind=?5 AND revocation_epoch=?6 AND configuration_revision=?7)`,
      values,
    ),
  ]);
  return { outcome: "acknowledged" as const };
}

/** Sanitization can only follow private OFF acknowledgement for every affected realm. */
export async function readNativeRestoreForSanitization(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({
      organizationId: ulid,
      projectId: ulid,
      environmentId: ulid,
      restoreId: ulid,
      claimId: z.string().uuid(),
    })
    .parse(raw);
  const realm = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    restoreId: i.restoreId,
  };
  if (!(await readNativeRestore(context, realm))) return null;
  const { db } = await routeOrganization(context, i.organizationId);
  const claim = await db
    .prepare(
      `SELECT t.database_id FROM native_auth_restore_jobs j JOIN native_auth_restore_claims c USING(organization_id,project_id,restore_id)
    JOIN native_auth_restores r USING(organization_id,project_id,restore_id)
    JOIN native_auth_database_targets t ON t.organization_id=r.organization_id AND t.project_id=r.project_id AND t.database_id=r.database_id AND t.ended_at IS NULL
    JOIN native_auth_registrations reg ON reg.organization_id=r.organization_id AND reg.project_id=r.project_id AND reg.environment_id=?5 AND reg.database_id=t.database_id AND reg.target_version=t.target_version AND reg.state='active'
    WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND j.claim_id=?4 AND j.state='consumed' AND c.claim_id=j.claim_id AND c.input_generation=j.input_generation`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId, i.claimId, i.environmentId)
    .first<{ database_id: string }>();
  if (!claim) return null;
  const imported = await db
    .prepare(
      `SELECT 1 FROM native_auth_restore_imports WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId)
    .first();
  if (!imported) return null;
  const missing = await db
    .prepare(
      `SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.restore_id=?3 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline' AND a.revocation_epoch=rr.revocation_epoch AND a.configuration_revision=rr.configuration_revision) LIMIT 1`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId)
    .first();
  if (missing) return null;
  const result = await readNativeRestore(context, realm);
  const current = await db
    .prepare(
      `SELECT 1 FROM native_auth_restore_jobs j JOIN native_auth_restore_claims c USING(organization_id,project_id,restore_id)
    JOIN native_auth_restores r USING(organization_id,project_id,restore_id)
    JOIN native_auth_database_targets t ON t.organization_id=r.organization_id AND t.project_id=r.project_id AND t.database_id=r.database_id AND t.ended_at IS NULL
    JOIN native_auth_registrations reg ON reg.organization_id=r.organization_id AND reg.project_id=r.project_id AND reg.environment_id=?5 AND reg.database_id=t.database_id AND reg.target_version=t.target_version AND reg.state='active'
    WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND j.claim_id=?4 AND j.state='consumed' AND c.claim_id=j.claim_id AND c.input_generation=j.input_generation AND t.database_id=?6`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId, i.claimId, i.environmentId, claim.database_id)
    .first();
  return current && result
    ? { ...result, claimId: i.claimId, databaseId: claim.database_id }
    : null;
}

/** Terminal publication never enables a realm; the Owner activates it separately. */
export async function completeNativeAuthRestore(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({
      organizationId: ulid,
      projectId: ulid,
      restoreId: ulid,
      principalId: z.string().min(1).max(256),
      delegation: handoffAuthorityInput.optional(),
    })
    .parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const rows = await db
    .prepare(
      `SELECT environment_id FROM native_auth_restore_realms WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 ORDER BY environment_id`,
    )
    .bind(i.organizationId, i.projectId, i.restoreId)
    .all<{ environment_id: string }>();
  if (rows.results.length < 1 || rows.results.length > 2)
    throw new Error("native_restore_authority_invalid");
  const guards = rows.results.flatMap(({ environment_id }) => {
    const authority = {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: environment_id,
      principalId: i.principalId,
      action: "auth:manage" as const,
    };
    return [
      canonicalAuthorizationGuard(db, authority),
      ...(i.delegation === undefined
        ? []
        : handoffEffectGuards(db, { ...authority, authority: i.delegation })),
    ];
  });
  const values = [
    i.organizationId,
    i.projectId,
    i.restoreId,
    i.principalId,
    i.delegation === undefined ? null : JSON.stringify(i.delegation),
  ];
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restores r JOIN projects p USING(organization_id,project_id) WHERE r.organization_id=?1 AND r.project_id=?2 AND r.restore_id=?3 AND r.principal_id=?4 AND r.delegation IS ?5 AND r.state IN ('restoring','complete') AND p.owner_state='active' AND p.lifecycle_state='active')`,
      values,
    ),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_restore_realms rr JOIN native_auth_realms r USING(organization_id,project_id,environment_id) WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.restore_id=?3 AND (r.enabled<>0 OR r.revocation_epoch<>rr.revocation_epoch OR r.configuration_revision<>rr.configuration_revision))`,
      values.slice(0, 3),
    ),
    db
      .prepare(
        `UPDATE native_auth_restores SET state='complete' WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='restoring'`,
      )
      .bind(...values.slice(0, 3)),
  ]);
  return { status: "complete" as const, restoreId: i.restoreId };
}
