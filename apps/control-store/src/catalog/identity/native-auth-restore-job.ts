import { z } from "zod";
import { guard } from "../../guards.js";
import { bytesOf } from "../platform-support.js";
import { publicTimestamp, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";
import {
  acknowledgeNativeRestore,
  beginNativeAuthRestore,
  completeNativeAuthRestore,
  readNativeRestore,
} from "./native-auth-restore.js";
import { resolveNativeAuthAdminAuthority } from "./native-auth-authority.js";
import type { D1Database } from "../../d1-types.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

const scope = z.strictObject({ organizationId: ulid, projectId: ulid, restoreId: ulid });
const claimScope = scope.extend({ claimId: z.string().uuid() });
const reconcileScope = scope.extend({
  principalId: z.string().min(1).max(256),
  delegation: handoffAuthorityInput.optional(),
});
const admission = scope.extend({
  principalId: z.string().min(1).max(256),
  exportOperationId: ulid,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  delegation: handoffAuthorityInput.optional(),
  rearm: z
    .strictObject({ expectedPreviousClaimId: z.string().uuid(), claimId: z.string().uuid() })
    .refine((v) => v.expectedPreviousClaimId !== v.claimId)
    .optional(),
  inputDigest: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
  sealedInput: z.strictObject({
    ciphertext: z.instanceof(Uint8Array).refine((v) => v.byteLength >= 17 && v.byteLength <= 8208),
    nonce: z.instanceof(Uint8Array).refine((v) => v.byteLength === 12),
    keyVersion: z.number().int().positive(),
  }),
});
type Scope = z.output<typeof scope>;
const ids = (i: Scope) => [i.organizationId, i.projectId, i.restoreId];
const unavailable = () => new Error("native_restore_job_unavailable");
const liveClaimGuard = (db: D1Database, i: z.output<typeof claimScope>) =>
  guard(
    db,
    "precondition_changed",
    "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='claimed' AND input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))",
    [...ids(i), i.claimId],
  );

/** Current accepted Owner/delegation and all frozen realm generations, for every private effect. */
async function authority(context: CatalogContext, db: D1Database, i: Scope) {
  const job = await db
    .prepare(
      "SELECT principal_id,delegation,export_operation_id,lower(hex(archive_sha256)) archive_sha256 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(...ids(i))
    .first<{
      principal_id: string;
      delegation: string | null;
      export_operation_id: string;
      archive_sha256: string;
    }>();
  if (!job) throw unavailable();
  const stored = await db
    .prepare(
      "SELECT state FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(...ids(i))
    .first<{ state: string }>();
  const restore = { ...job, state: stored?.state ?? "preflight" };
  const realms =
    restore.state === "preflight"
      ? (
          await db
            .prepare(
              `SELECT value->>'$.environmentId' AS environment_id, CAST(value->>'$.revocationEpoch' AS INTEGER) AS revocation_epoch, CAST(value->>'$.configurationRevision' AS INTEGER) AS configuration_revision FROM project_recovery_jobs archive,json_each(archive.native_manifest,'$.realms') WHERE archive.organization_id=?1 AND archive.project_id=?2 AND archive.operation_id=?3 ORDER BY environment_id`,
            )
            .bind(i.organizationId, i.projectId, job.export_operation_id)
            .all<{
              environment_id: string;
              revocation_epoch: number;
              configuration_revision: number;
            }>()
        ).results
      : (
          await db
            .prepare(
              "SELECT environment_id,revocation_epoch,configuration_revision FROM native_auth_restore_realms WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 ORDER BY environment_id",
            )
            .bind(...ids(i))
            .all<{
              environment_id: string;
              revocation_epoch: number;
              configuration_revision: number;
            }>()
        ).results;
  if (realms.length < 1 || realms.length > 2) throw unavailable();
  const delegation =
    restore.delegation === null
      ? undefined
      : handoffAuthorityInput.parse(JSON.parse(restore.delegation));
  const guards = realms.flatMap((realm) => {
    const s = {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: realm.environment_id,
      principalId: restore.principal_id,
      action: "auth:manage" as const,
    };
    return [
      canonicalAuthorizationGuard(db, s),
      ...(delegation === undefined ? [] : handoffEffectGuards(db, { ...s, authority: delegation })),
      ...(restore.state === "restoring"
        ? [
            guard(
              db,
              "precondition_changed",
              "NOT EXISTS(SELECT 1 FROM native_auth_realms r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.enabled=0 AND r.revocation_epoch=?4 AND r.configuration_revision=?5)",
              [
                i.organizationId,
                i.projectId,
                realm.environment_id,
                realm.revocation_epoch,
                realm.configuration_revision,
              ],
            ),
          ]
        : []),
    ];
  });
  guards.push(
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs j JOIN projects p USING(organization_id,project_id) WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND j.principal_id=?4 AND j.delegation IS ?5 AND p.owner_state='active' AND p.lifecycle_state='active')",
      [...ids(i), restore.principal_id, restore.delegation],
    ),
  );
  guards.push(
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs job
    JOIN project_recovery_jobs archive ON archive.organization_id=job.organization_id AND archive.project_id=job.project_id AND archive.operation_id=job.export_operation_id AND archive.archive_sha256=job.archive_sha256
    JOIN native_auth_database_targets target ON target.organization_id=job.organization_id AND target.project_id=job.project_id AND target.database_id=json_extract(archive.native_manifest,'$.databaseId') AND target.ended_at IS NULL
    WHERE job.organization_id=?1 AND job.project_id=?2 AND job.restore_id=?3 AND archive.verified_at IS NOT NULL AND archive.failure_code IS NULL
      AND (archive.archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') OR EXISTS(SELECT 1 FROM native_auth_restore_pins pinned WHERE pinned.organization_id=job.organization_id AND pinned.project_id=job.project_id AND pinned.restore_id=job.restore_id AND pinned.export_operation_id=job.export_operation_id AND pinned.archive_sha256=job.archive_sha256 AND pinned.state='verified')))`,
      ids(i),
    ),
  );
  if (restore.state !== "preflight")
    guards.push(
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND principal_id=?4 AND delegation IS ?5 AND state=?6)",
        [...ids(i), restore.principal_id, restore.delegation, restore.state],
      ),
    );
  return { restore, realms, guards };
}

/** Admission stores a sealed input against a verified export without taking the realm offline. */
export async function authorizeNativeRestoreAdmission(context: CatalogContext, raw: unknown) {
  const i = admission.extend({ proposedClaimId: z.string().uuid() }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const archive = await db
    .prepare(
      `SELECT native_manifest FROM project_recovery_jobs WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND lower(hex(archive_sha256))=?4 AND verified_at IS NOT NULL AND failure_code IS NULL AND native_manifest IS NOT NULL`,
    )
    .bind(i.organizationId, i.projectId, i.exportOperationId, i.archiveSha256)
    .first<{ native_manifest: string }>();
  if (!archive) throw unavailable();
  const manifest = z
    .object({
      organizationId: ulid,
      projectId: ulid,
      realms: z
        .array(z.object({ environmentId: ulid }))
        .min(1)
        .max(2),
    })
    .parse(JSON.parse(archive.native_manifest));
  if (manifest.organizationId !== i.organizationId || manifest.projectId !== i.projectId)
    throw unavailable();
  const guards = manifest.realms.flatMap(({ environmentId }) => {
    const s = {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId,
      principalId: i.principalId,
      action: "auth:manage" as const,
    };
    return [
      canonicalAuthorizationGuard(db, s),
      ...(i.delegation === undefined
        ? []
        : handoffEffectGuards(db, { ...s, authority: i.delegation })),
    ];
  });
  const archiveBytes = Uint8Array.from(i.archiveSha256.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active')",
      [i.organizationId, i.projectId],
    ),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_restore_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND (j.principal_id<>?4 OR j.delegation IS NOT ?5 OR j.export_operation_id<>?6 OR j.archive_sha256 IS NOT ?7 OR j.input_digest IS NOT ?8))`,
      [
        ...ids(i),
        i.principalId,
        i.delegation === undefined ? null : JSON.stringify(i.delegation),
        i.exportOperationId,
        archiveBytes,
        i.inputDigest,
      ],
    ),
    ...(i.rearm === undefined
      ? [
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM native_auth_restore_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND j.state IN('claimed','consumed','complete') AND j.claim_id<>?4)`,
            [...ids(i), i.proposedClaimId],
          ),
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM native_auth_restore_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND (j.state IN('expired','failed') OR (j.state='claimed' AND j.input_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))))`,
            ids(i),
          ),
        ]
      : []),
    ...(i.rearm === undefined
      ? []
      : [
          guard(db, "precondition_changed", "?1<>?2", [i.rearm.claimId, i.proposedClaimId]),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND (((j.state='expired' OR (j.state='claimed' AND j.input_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))) AND j.claim_id=?4 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_claims c WHERE c.organization_id=j.organization_id AND c.project_id=j.project_id AND c.restore_id=j.restore_id AND c.claim_id=?5)) OR (j.state IN('queued','claimed') AND (j.claim_id IS NULL OR j.claim_id=?5) AND EXISTS(SELECT 1 FROM native_auth_restore_claims c WHERE c.organization_id=j.organization_id AND c.project_id=j.project_id AND c.restore_id=j.restore_id AND c.claim_id=?5 AND c.previous_claim_id=?4 AND c.input_generation=j.input_generation))))`,
            [...ids(i), i.rearm.expectedPreviousClaimId, i.rearm.claimId],
          ),
        ]),
  ]);
  return { authorized: true as const };
}

export async function acceptNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = admission.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const archive = await db
    .prepare(
      `SELECT native_manifest,lower(hex(native_manifest_sha256)) manifest_hash FROM project_recovery_jobs WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND lower(hex(archive_sha256))=?4 AND verified_at IS NOT NULL AND failure_code IS NULL AND native_manifest IS NOT NULL AND (archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') OR EXISTS(SELECT 1 FROM native_auth_restore_pins pinned WHERE pinned.organization_id=?1 AND pinned.project_id=?2 AND pinned.restore_id=?5 AND pinned.export_operation_id=?3 AND lower(hex(pinned.archive_sha256))=?4 AND pinned.state='verified'))`,
    )
    .bind(i.organizationId, i.projectId, i.exportOperationId, i.archiveSha256, i.restoreId)
    .first<{ native_manifest: string; manifest_hash: string }>();
  if (!archive) throw unavailable();
  const manifest = z
    .strictObject({
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
    })
    .parse(JSON.parse(archive.native_manifest));
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(archive.native_manifest)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (
    digest !== archive.manifest_hash ||
    manifest.organizationId !== i.organizationId ||
    manifest.projectId !== i.projectId ||
    new Set(manifest.realms.map((r) => r.environmentId)).size !== manifest.realms.length ||
    manifest.realms.some(
      (r, n) =>
        r.schemaName !== `omh_auth_${r.environmentId.toLowerCase()}` ||
        (n > 0 && r.environmentId <= (manifest.realms[n - 1]?.environmentId ?? "")),
    )
  )
    throw unavailable();
  const guards = manifest.realms.flatMap((realm) => {
    const s = {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: realm.environmentId,
      principalId: i.principalId,
      action: "auth:manage" as const,
    };
    return [
      canonicalAuthorizationGuard(db, s),
      ...(i.delegation === undefined
        ? []
        : handoffEffectGuards(db, { ...s, authority: i.delegation })),
    ];
  });
  const archiveBytes = Uint8Array.from(i.archiveSha256.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_recovery_jobs j JOIN projects p USING(organization_id,project_id) JOIN native_auth_database_targets t ON t.organization_id=p.organization_id AND t.project_id=p.project_id AND t.database_id=?5 AND t.ended_at IS NULL WHERE j.organization_id=?1 AND j.project_id=?2 AND j.operation_id=?3 AND j.archive_sha256=?4 AND j.native_manifest=?6 AND j.verified_at IS NOT NULL AND j.failure_code IS NULL AND (j.archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') OR EXISTS(SELECT 1 FROM native_auth_restore_pins pinned WHERE pinned.organization_id=?1 AND pinned.project_id=?2 AND pinned.restore_id=?7 AND pinned.export_operation_id=?3 AND pinned.archive_sha256=?4 AND pinned.state='verified')) AND p.owner_state='active' AND p.lifecycle_state='active')",
      [
        i.organizationId,
        i.projectId,
        i.exportOperationId,
        archiveBytes,
        manifest.databaseId,
        archive.native_manifest,
        i.restoreId,
      ],
    ),
    db
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,delegation,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,state)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),(strftime('%Y-%m-%dT%H:%M:%f','now','+1 hour')||'000Z'),'queued') ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...ids(i),
        i.exportOperationId,
        archiveBytes,
        i.principalId,
        i.delegation === undefined ? null : JSON.stringify(i.delegation),
        i.sealedInput.ciphertext,
        i.sealedInput.nonce,
        i.sealedInput.keyVersion,
        i.inputDigest,
      ),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND export_operation_id=?4 AND archive_sha256=?5 AND principal_id=?6 AND delegation IS ?7 AND input_digest=?8)",
      [
        ...ids(i),
        i.exportOperationId,
        archiveBytes,
        i.principalId,
        i.delegation === undefined ? null : JSON.stringify(i.delegation),
        i.inputDigest,
      ],
    ),
    db
      .prepare(
        `UPDATE native_auth_restore_jobs SET state='expired',input_ciphertext=NULL,input_nonce=NULL,input_key_version=NULL WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state IN('queued','claimed') AND input_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`,
      )
      .bind(...ids(i)),
    ...(i.rearm === undefined
      ? [
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='expired')",
            ids(i),
          ),
        ]
      : [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='verified')",
            ids(i),
          ),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND ((j.state='expired' AND j.claim_id=?4 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_claims c WHERE c.organization_id=j.organization_id AND c.project_id=j.project_id AND c.restore_id=j.restore_id AND c.claim_id=?5)) OR (j.state IN('queued','claimed') AND (j.claim_id IS NULL OR j.claim_id=?5) AND EXISTS(SELECT 1 FROM native_auth_restore_claims c WHERE c.organization_id=j.organization_id AND c.project_id=j.project_id AND c.restore_id=j.restore_id AND c.claim_id=?5 AND c.previous_claim_id=?4 AND c.input_generation=j.input_generation))))`,
            [...ids(i), i.rearm.expectedPreviousClaimId, i.rearm.claimId],
          ),
          db
            .prepare(
              `UPDATE native_auth_restore_jobs SET state='queued',claim_id=NULL,input_generation=input_generation+1,input_ciphertext=?4,input_nonce=?5,input_key_version=?6,input_expires_at=(strftime('%Y-%m-%dT%H:%M:%f','now','+1 hour')||'000Z') WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='expired' AND claim_id=?7 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_imports WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3)`,
            )
            .bind(
              ...ids(i),
              i.sealedInput.ciphertext,
              i.sealedInput.nonce,
              i.sealedInput.keyVersion,
              i.rearm.expectedPreviousClaimId,
            ),
          db
            .prepare(
              `INSERT INTO native_auth_restore_claims(organization_id,project_id,restore_id,claim_id,input_generation,previous_claim_id) SELECT organization_id,project_id,restore_id,?4,input_generation,?5 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='queued' ON CONFLICT DO NOTHING`,
            )
            .bind(...ids(i), i.rearm.claimId, i.rearm.expectedPreviousClaimId),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs j JOIN native_auth_restore_claims c USING(organization_id,project_id,restore_id) WHERE j.organization_id=?1 AND j.project_id=?2 AND j.restore_id=?3 AND j.state IN('queued','claimed') AND (j.claim_id IS NULL OR j.claim_id=?4) AND c.claim_id=?4 AND c.input_generation=j.input_generation)`,
            [...ids(i), i.rearm.claimId],
          ),
        ]),
  ]);
  const row = await db
    .prepare(
      "SELECT state FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(...ids(i))
    .first<{ state: string }>();
  if (!row) throw unavailable();
  return { status: row.state };
}

/** One immutable claim owns the sealed password; other claims cannot take over an uncertain restore. */
export async function claimNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    a = await authority(context, db, i);
  if (a.restore.state === "complete") return completeNativeRestoreJob(context, i);
  if (a.restore.state !== "restoring" && a.restore.state !== "preflight") throw unavailable();
  await db.batch([
    ...a.guards,
    db
      .prepare(
        `INSERT INTO native_auth_restore_claims(organization_id,project_id,restore_id,claim_id,input_generation)
      SELECT organization_id,project_id,restore_id,?4,input_generation FROM native_auth_restore_jobs
      WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND (state='queued' OR (state='claimed' AND claim_id=?4)) AND input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ON CONFLICT DO NOTHING`,
      )
      .bind(...ids(i), i.claimId),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_claims c JOIN native_auth_restore_jobs j USING(organization_id,project_id,restore_id) WHERE c.organization_id=?1 AND c.project_id=?2 AND c.restore_id=?3 AND c.claim_id=?4 AND c.input_generation=j.input_generation)",
      [...ids(i), i.claimId],
    ),
    db
      .prepare(
        "UPDATE native_auth_restore_jobs SET state='claimed',claim_id=?4 WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='queued' AND input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",
      )
      .bind(...ids(i), i.claimId),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state IN('claimed','consumed') AND (state='consumed' OR input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')))",
      [...ids(i), i.claimId],
    ),
  ]);
  return { status: "claimed" as const };
}

async function claimed(context: CatalogContext, db: D1Database, i: z.output<typeof claimScope>) {
  const a = await authority(context, db, i);
  if (a.restore.state !== "restoring" && a.restore.state !== "preflight") throw unavailable();
  const row = await db
    .prepare(
      "SELECT state,input_ciphertext,input_nonce,input_key_version FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state IN('claimed','consumed') AND (state='consumed' OR input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'))",
    )
    .bind(...ids(i), i.claimId)
    .first<Record<string, unknown>>();
  if (!row) throw unavailable();
  await db.batch([
    ...a.guards,
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state IN('claimed','consumed') AND (state='consumed' OR input_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')))",
      [...ids(i), i.claimId],
    ),
  ]);
  return { ...a, row };
}

export async function readNativeRestoreJobInput(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (s.row["state"] !== "claimed") throw unavailable();
  return {
    ciphertext: bytesOf(s.row["input_ciphertext"]),
    nonce: bytesOf(s.row["input_nonce"]),
    keyVersion: Number(s.row["input_key_version"]),
  };
}

/** Reserve the exact object before a potentially uncertain provider copy. */
export async function reserveNativeRestorePin(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (s.restore.state !== "preflight" || s.row["state"] !== "claimed") throw unavailable();
  const results = await db.batch([
    ...s.guards,
    liveClaimGuard(db, i),
    db
      .prepare(
        `INSERT INTO native_auth_restore_pins(organization_id,project_id,restore_id,export_operation_id,claim_id,bucket,object_key,archive_bytes,archive_sha256,manifest_sha256,state)
      SELECT job.organization_id,job.project_id,job.restore_id,job.export_operation_id,job.claim_id,archive.archive_bucket,
        'restore-pins/'||job.organization_id||'/'||job.project_id||'/'||job.restore_id||'.zip',archive.archive_bytes,archive.archive_sha256,archive.native_manifest_sha256,'reserved'
      FROM native_auth_restore_jobs job JOIN project_recovery_jobs archive ON archive.organization_id=job.organization_id AND archive.project_id=job.project_id AND archive.operation_id=job.export_operation_id AND archive.archive_sha256=job.archive_sha256
      WHERE job.organization_id=?1 AND job.project_id=?2 AND job.restore_id=?3 AND job.claim_id=?4 AND job.state='claimed' AND archive.verified_at IS NOT NULL AND archive.failure_code IS NULL AND archive.archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
      ON CONFLICT DO NOTHING`,
      )
      .bind(...ids(i), i.claimId),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_restore_pins p JOIN native_auth_restore_jobs j USING(organization_id,project_id,restore_id)
      JOIN project_recovery_jobs a ON a.organization_id=j.organization_id AND a.project_id=j.project_id AND a.operation_id=j.export_operation_id
      WHERE p.organization_id=?1 AND p.project_id=?2 AND p.restore_id=?3 AND j.claim_id=?4 AND j.state='claimed'
       AND p.export_operation_id=j.export_operation_id AND p.archive_sha256=j.archive_sha256 AND p.archive_sha256=a.archive_sha256
       AND p.manifest_sha256=a.native_manifest_sha256 AND p.archive_bytes=a.archive_bytes AND p.bucket=a.archive_bucket)`,
      [...ids(i), i.claimId],
    ),
  ]);
  const p = await db
    .prepare(
      "SELECT bucket,object_key,archive_bytes,lower(hex(archive_sha256)) sha256,state FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(...ids(i))
    .first<{
      bucket: string;
      object_key: string;
      archive_bytes: number;
      sha256: string;
      state: string;
    }>();
  if (!p) throw unavailable();
  return {
    bucket: p.bucket,
    key: p.object_key,
    bytes: p.archive_bytes,
    sha256: p.sha256,
    state: p.state,
    created: results[s.guards.length + 1]?.meta.changes === 1,
  };
}

/** Called only after the private executor verifies lifecycle and the copied encrypted bytes. */
export async function recordNativeRestorePin(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (s.restore.state !== "preflight" || s.row["state"] !== "claimed") throw unavailable();
  await db.batch([
    ...s.guards,
    liveClaimGuard(db, i),
    db
      .prepare(
        "UPDATE native_auth_restore_pins SET state='verified' WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='reserved'",
      )
      .bind(...ids(i)),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='verified')",
      ids(i),
    ),
  ]);
  return { status: "recorded" as const };
}

async function reconciliationAuthority(
  context: CatalogContext,
  i: z.output<typeof reconcileScope>,
) {
  const { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      `SELECT p.bucket,p.object_key,p.archive_bytes,lower(hex(p.archive_sha256)) sha256,p.state,a.native_manifest
    FROM native_auth_restore_pins p JOIN native_auth_restore_jobs j USING(organization_id,project_id,restore_id)
    JOIN project_recovery_jobs a ON a.organization_id=j.organization_id AND a.project_id=j.project_id AND a.operation_id=j.export_operation_id AND a.archive_sha256=j.archive_sha256
    JOIN projects project ON project.organization_id=j.organization_id AND project.project_id=j.project_id
    WHERE p.organization_id=?1 AND p.project_id=?2 AND p.restore_id=?3 AND p.state IN('reserved','verified','tombstoned') AND project.owner_state='active' AND project.lifecycle_state='active'
      AND NOT EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=j.organization_id AND r.project_id=j.project_id AND r.restore_id=j.restore_id)`,
    )
    .bind(...ids(i))
    .first<{
      bucket: string;
      object_key: string;
      archive_bytes: number;
      sha256: string;
      state: string;
      native_manifest: string;
    }>();
  if (!row) throw unavailable();
  const manifest = z
    .object({
      realms: z
        .array(z.object({ environmentId: ulid }))
        .min(1)
        .max(2),
    })
    .parse(JSON.parse(row.native_manifest));
  const guards = manifest.realms.flatMap(({ environmentId }) => {
    const s = {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId,
      principalId: i.principalId,
      action: "auth:manage" as const,
    };
    return [
      canonicalAuthorizationGuard(db, s),
      ...(i.delegation === undefined
        ? []
        : handoffEffectGuards(db, { ...s, authority: i.delegation })),
    ];
  });
  guards.push(
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active') OR EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.restore_id=?3)",
      ids(i),
    ),
  );
  return { db, row, guards };
}

/** Restricted to the original locator after the per-restore Sandbox has drained its old executor. */
export async function readNativeRestorePinReconciliation(context: CatalogContext, raw: unknown) {
  const i = reconcileScope.parse(raw),
    { db, row, guards } = await reconciliationAuthority(context, i);
  await db.batch(guards);
  return {
    bucket: row.bucket,
    key: row.object_key,
    bytes: row.archive_bytes,
    sha256: row.sha256,
    state: row.state,
  };
}

export async function completeNativeRestorePinReconciliation(
  context: CatalogContext,
  raw: unknown,
) {
  const i = reconcileScope.extend({ outcome: z.enum(["verified", "tombstoned"]) }).parse(raw),
    { db, guards } = await reconciliationAuthority(context, i);
  await db.batch([
    ...guards,
    db
      .prepare(
        "UPDATE native_auth_restore_pins SET state=?4 WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='reserved'",
      )
      .bind(...ids(i), i.outcome),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state=?4)",
      [...ids(i), i.outcome],
    ),
    ...(i.outcome === "tombstoned"
      ? [
          db
            .prepare(
              "UPDATE native_auth_restore_jobs SET state='failed',input_ciphertext=NULL,input_nonce=NULL,input_key_version=NULL WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state IN('queued','claimed','expired')",
            )
            .bind(...ids(i)),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='failed')",
            ids(i),
          ),
          db
            .prepare(
              `INSERT INTO native_auth_restore_pin_tombstones(organization_id,project_id,restore_id,recorded_at) SELECT organization_id,project_id,restore_id,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='tombstoned' ON CONFLICT DO NOTHING`,
            )
            .bind(...ids(i)),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM native_auth_restore_pin_tombstones WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3)",
            ids(i),
          ),
        ]
      : []),
  ]);
  return { status: i.outcome };
}

/** Every importer transaction rechecks the original exclusive claim and all offline acknowledgements. */
export async function assertNativeRestoreImportAllowed(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (s.row["state"] !== "claimed" || s.restore.state !== "restoring") throw unavailable();
  await db.batch([
    ...s.guards,
    liveClaimGuard(db, i),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.restore_id=?3 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline')) OR EXISTS(SELECT 1 FROM native_auth_restore_imports WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3)`,
      ids(i),
    ),
  ]);
  return { allowed: true as const };
}

/** Called after the private container has authenticated the exact encrypted archive and password. */
export async function beginNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (s.row["state"] !== "claimed") throw unavailable();
  if (s.restore.state === "preflight") {
    const pin = await db
      .prepare(
        "SELECT 1 FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='verified'",
      )
      .bind(...ids(i))
      .first();
    if (!pin) throw unavailable();
    const delegation =
      s.restore.delegation === null
        ? undefined
        : handoffAuthorityInput.parse(JSON.parse(s.restore.delegation));
    await beginNativeAuthRestore(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      restoreId: i.restoreId,
      jobClaimId: i.claimId,
      principalId: s.restore.principal_id,
      exportOperationId: s.restore.export_operation_id,
      archiveSha256: s.restore.archive_sha256,
      ...(delegation === undefined ? {} : { delegation }),
    });
  }
  return readNativeRestoreJobClaim(context, i);
}

const realmClaim = claimScope.extend({ environmentId: ulid });
/** Replay reads only this claim's frozen realm journal. */
export async function isNativeRestoreRealmImported(context: CatalogContext, raw: unknown) {
  const i = realmClaim.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (
    s.restore.state !== "restoring" ||
    !s.realms.some((r) => r.environment_id === i.environmentId)
  )
    throw unavailable();
  const row = await db
    .prepare(
      "SELECT 1 FROM native_auth_restore_import_realms WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND environment_id=?4",
    )
    .bind(...ids(i), i.environmentId)
    .first();
  return { imported: row !== null };
}

/** Called only after that realm's exact authenticated import transaction succeeds. */
export async function markNativeRestoreRealmImported(context: CatalogContext, raw: unknown) {
  const i = realmClaim.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (
    s.restore.state !== "restoring" ||
    s.row["state"] !== "claimed" ||
    !s.realms.some((r) => r.environment_id === i.environmentId)
  )
    throw unavailable();
  await db.batch([
    ...s.guards,
    liveClaimGuard(db, i),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_restore_realms rr WHERE rr.organization_id=?1 AND rr.project_id=?2 AND rr.restore_id=?3 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_acknowledgements a WHERE a.organization_id=rr.organization_id AND a.project_id=rr.project_id AND a.restore_id=rr.restore_id AND a.environment_id=rr.environment_id AND a.kind='offline')) OR EXISTS(SELECT 1 FROM native_auth_restore_imports WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3)`,
      ids(i),
    ),
    db
      .prepare(
        "INSERT INTO native_auth_restore_import_realms(organization_id,project_id,restore_id,environment_id,imported_at) VALUES(?1,?2,?3,?4,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) ON CONFLICT DO NOTHING",
      )
      .bind(...ids(i), i.environmentId),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_import_realms WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND environment_id=?4)",
      [...ids(i), i.environmentId],
    ),
  ]);
  return { imported: true as const };
}

export async function isNativeRestoreAcknowledged(context: CatalogContext, raw: unknown) {
  const i = realmClaim.extend({ kind: z.enum(["offline", "sanitized"]) }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  const realm = s.realms.find((r) => r.environment_id === i.environmentId);
  if (s.restore.state !== "restoring" || !realm) throw unavailable();
  const row = await db
    .prepare(
      "SELECT 1 FROM native_auth_restore_acknowledgements WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND environment_id=?4 AND kind=?5 AND revocation_epoch=?6 AND configuration_revision=?7",
    )
    .bind(...ids(i), i.environmentId, i.kind, realm.revocation_epoch, realm.configuration_revision)
    .first();
  return { acknowledged: row !== null };
}

export async function acknowledgeNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = realmClaim
      .extend({
        kind: z.enum(["offline", "sanitized"]),
        revocationEpoch: z.number().int().positive(),
        configurationRevision: z.number().int().positive(),
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  const realm = s.realms.find((r) => r.environment_id === i.environmentId);
  if (
    s.restore.state !== "restoring" ||
    !realm ||
    realm.revocation_epoch !== i.revocationEpoch ||
    realm.configuration_revision !== i.configurationRevision
  )
    throw unavailable();
  await acknowledgeNativeRestore(context, {
    organizationId: i.organizationId,
    projectId: i.projectId,
    restoreId: i.restoreId,
    environmentId: i.environmentId,
    kind: i.kind,
    revocationEpoch: i.revocationEpoch,
    configurationRevision: i.configurationRevision,
  });
  return { acknowledged: true as const };
}

export async function finishNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    a = await authority(context, db, i);
  const row = await db
    .prepare(
      "SELECT state FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state IN('consumed','complete')",
    )
    .bind(...ids(i), i.claimId)
    .first<{ state: string }>();
  if (!row) throw unavailable();
  if (a.restore.state !== "complete") {
    const delegation =
      a.restore.delegation === null
        ? undefined
        : handoffAuthorityInput.parse(JSON.parse(a.restore.delegation));
    await completeNativeAuthRestore(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      restoreId: i.restoreId,
      principalId: a.restore.principal_id,
      ...(delegation === undefined ? {} : { delegation }),
    });
  }
  return completeNativeRestoreJob(context, i);
}

/** Finalize all realm imports and erase the sealed password in the same Core batch. */
export async function consumeNativeRestoreJobInput(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    s = await claimed(context, db, i);
  if (s.restore.state !== "restoring") throw unavailable();
  await db.batch([
    ...s.guards,
    ...(s.row["state"] === "claimed" ? [liveClaimGuard(db, i)] : []),
    db
      .prepare(
        "INSERT INTO native_auth_restore_imports(organization_id,project_id,restore_id,imported_at) VALUES(?1,?2,?3,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) ON CONFLICT DO NOTHING",
      )
      .bind(...ids(i)),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_imports WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3)",
      ids(i),
    ),
    db
      .prepare(
        "UPDATE native_auth_restore_jobs SET state='consumed',input_ciphertext=NULL,input_nonce=NULL,input_key_version=NULL WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='claimed'",
      )
      .bind(...ids(i), i.claimId),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='consumed')",
      [...ids(i), i.claimId],
    ),
  ]);
  return { status: "consumed" as const };
}

/** No locator or target is chosen by the Container; all come from the accepted verified archive and current Core. */
export async function readNativeRestoreJobClaim(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    initial = await authority(context, db, i);
  if (initial.restore.state === "complete") {
    await db.batch([
      ...initial.guards,
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state IN('consumed','complete'))",
        [...ids(i), i.claimId],
      ),
    ]);
    const pin = await db
      .prepare(
        "SELECT bucket,object_key,archive_bytes,lower(hex(archive_sha256)) sha256,state FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
      )
      .bind(...ids(i))
      .first<{
        bucket: string;
        object_key: string;
        archive_bytes: number;
        sha256: string;
        state: string;
      }>();
    if (!pin || pin.state !== "verified") throw unavailable();
    return {
      scope: { organizationId: i.organizationId, projectId: i.projectId, restoreId: i.restoreId },
      completed: true as const,
      pin: {
        bucket: pin.bucket,
        key: pin.object_key,
        bytes: pin.archive_bytes,
        sha256: pin.sha256,
        state: pin.state,
      },
    };
  }
  const s = await claimed(context, db, i);
  const row = await db
    .prepare(
      `SELECT t.database_id,j.archive_bucket,'native-exports/'||j.organization_id||'/'||j.project_id||'/'||j.operation_id||'.zip' AS archive_key,j.archive_bytes,lower(hex(j.archive_sha256)) archive_sha256,j.native_manifest,lower(hex(j.native_manifest_sha256)) manifest_sha256,j.captured_at,t.provider_project_id,t.region_id
    FROM native_auth_restore_jobs job JOIN project_recovery_jobs j ON j.organization_id=job.organization_id AND j.project_id=job.project_id AND j.operation_id=job.export_operation_id AND j.archive_sha256=job.archive_sha256
    JOIN native_auth_database_targets t ON t.organization_id=job.organization_id AND t.project_id=job.project_id AND t.database_id=json_extract(j.native_manifest,'$.databaseId') AND t.ended_at IS NULL
    WHERE job.organization_id=?1 AND job.project_id=?2 AND job.restore_id=?3 AND j.verified_at IS NOT NULL AND j.failure_code IS NULL AND (j.archive_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') OR EXISTS(SELECT 1 FROM native_auth_restore_pins pinned WHERE pinned.organization_id=job.organization_id AND pinned.project_id=job.project_id AND pinned.restore_id=job.restore_id AND pinned.export_operation_id=job.export_operation_id AND pinned.archive_sha256=job.archive_sha256 AND pinned.state='verified'))`,
    )
    .bind(...ids(i))
    .first<Record<string, unknown>>();
  if (!row) throw unavailable();
  const realms = [];
  for (const realm of s.restore.state === "preflight" ? [] : s.realms) {
    if (
      !(await readNativeRestore(context, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        restoreId: i.restoreId,
        environmentId: realm.environment_id,
      }))
    )
      throw unavailable();
    const policy = await resolveNativeAuthAdminAuthority(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environmentId: realm.environment_id,
    });
    realms.push({
      environmentId: realm.environment_id,
      revocationEpoch: realm.revocation_epoch,
      configurationRevision: realm.configuration_revision,
      canonicalOrigin: policy.realm.canonicalOrigin,
    });
  }
  const imported = await db
    .prepare(
      "SELECT 1 FROM native_auth_restore_imports WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(...ids(i))
    .first();
  await claimed(context, db, i);
  const pin = await db
    .prepare(
      "SELECT bucket,object_key,archive_bytes,lower(hex(archive_sha256)) sha256,state FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(...ids(i))
    .first<{
      bucket: string;
      object_key: string;
      archive_bytes: number;
      sha256: string;
      state: string;
    }>();
  return {
    scope: { organizationId: i.organizationId, projectId: i.projectId, restoreId: i.restoreId },
    completed: false as const,
    phase: s.restore.state === "preflight" ? ("preflight" as const) : ("restoring" as const),
    inputState: s.row["state"] === "claimed" ? ("claimed" as const) : ("consumed" as const),
    imported: imported !== null,
    pin:
      pin === null
        ? null
        : {
            bucket: pin.bucket,
            key: pin.object_key,
            bytes: pin.archive_bytes,
            sha256: pin.sha256,
            state: pin.state,
          },
    archive: {
      bucket: String(row["archive_bucket"]),
      key: String(row["archive_key"]),
      bytes: Number(row["archive_bytes"]),
      sha256: String(row["archive_sha256"]),
      nativeManifest: String(row["native_manifest"]),
      nativeManifestSha256: String(row["manifest_sha256"]),
      capturedAt: publicTimestamp(String(row["captured_at"])),
    },
    target: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      databaseId: String(row["database_id"]),
      providerProjectId: String(row["provider_project_id"]),
      regionId: String(row["region_id"]),
    },
    realms,
  };
}

/** Receipt written only after the scoped private executor has deleted and observed the pin absent. */
export async function recordNativeRestorePinAbsent(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    a = await authority(context, db, i);
  if (a.restore.state !== "complete") throw unavailable();
  await db.batch([
    ...a.guards,
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='complete')",
      [...ids(i), i.claimId],
    ),
    db
      .prepare(
        `INSERT INTO native_auth_restore_pin_absences(organization_id,project_id,restore_id,bucket,object_key,absent_at,source)
      SELECT organization_id,project_id,restore_id,bucket,object_key,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),'restore-complete' FROM native_auth_restore_pins
      WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND state='verified' ON CONFLICT DO NOTHING`,
      )
      .bind(...ids(i)),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_pin_absences WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3)",
      ids(i),
    ),
  ]);
  return { status: "recorded" as const };
}

/** Mark the claimed job terminal only after the fenced Core restore is complete and the secret erased. */
export async function completeNativeRestoreJob(context: CatalogContext, raw: unknown) {
  const i = claimScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    a = await authority(context, db, i);
  if (a.restore.state !== "complete") throw unavailable();
  await db.batch([
    ...a.guards,
    db
      .prepare(
        "UPDATE native_auth_restore_jobs SET state='complete' WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='consumed'",
      )
      .bind(...ids(i), i.claimId),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3 AND claim_id=?4 AND state='complete')",
      [...ids(i), i.claimId],
    ),
  ]);
  return { status: "complete" as const };
}

/** Bounded maintenance scrub, driven by Core's clock; no expired ciphertext remains usable. */
export async function expireNativeRestoreInputs(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ limit: z.number().int().min(1).max(1000) }).parse(raw),
    db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(
      `UPDATE native_auth_restore_jobs SET state='expired',input_ciphertext=NULL,input_nonce=NULL,input_key_version=NULL
    WHERE (organization_id,project_id,restore_id) IN(SELECT organization_id,project_id,restore_id FROM native_auth_restore_jobs
      WHERE state IN('queued','claimed') AND input_expires_at<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ORDER BY input_expires_at LIMIT ?1)`,
    )
    .bind(i.limit)
    .run();
  return { expired: result.meta.changes };
}
