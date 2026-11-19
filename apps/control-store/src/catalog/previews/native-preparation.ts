import {
  PREVIEW_NATIVE_POLICY_SCHEMA_SHA256,
  PREVIEW_NATIVE_POLICY_SCHEMA_VERSION,
} from "@ohmyhost/contracts/previews";
import { z } from "zod";
import type { CatalogContext } from "../common.js";
import { instant, newUlid, routeOrganization, ulid } from "../common.js";
import { guard } from "../../guards.js";
import { nativeAuthLaunchAllowed } from "../identity/native-auth-launch-policy.js";
import { nativeAuthEffectGuards } from "../identity/native-auth-resource-operations.js";
import { readNativeAuthRegistration } from "../identity/native-auth-registration.js";
import { authorizePreviewRuntime } from "./runtime.js";
import {
  fail,
  nowOf,
  rowById,
  runtimeFence,
  runtimeGuard,
  sourceVersion,
  type PreviewRow,
} from "./common.js";

const clock = { now: instant.optional(), clock: z.literal("execution").optional() };
const fence = runtimeFence.omit({ now: true, clock: true });
const queue = z.strictObject({
  fence,
  source: sourceVersion,
  buildPlanSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  authProvider: z.literal("omh-native"),
  ...clock,
});
const operation = z.strictObject({ operationId: ulid, ...clock });
const finish = operation.extend({
  outcome: z.enum(["succeeded", "uncertain", "failed"]),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/u)
    .nullable(),
});
function result(r: PreviewRow) {
  return {
    operationId: String(r["operation_id"]),
    claimId: String(r["claim_id"]),
    previewId: String(r["preview_id"]),
    runtimeGeneration: Number(r["runtime_generation"]),
    tokenGeneration: Number(r["token_generation"]),
    authGeneration: Number(r["auth_generation"]),
    state: r["state"] as "pending" | "running" | "uncertain" | "succeeded" | "failed",
    errorCode: r["error_code"] === null ? null : String(r["error_code"]),
  };
}
async function hasCurrentPreviewNativePolicy(
  db: CatalogContext["directory"],
  preview: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    previewId: string;
    authGeneration: number;
  },
) {
  return db
    .prepare(
      `SELECT 1 FROM native_auth_realms realm JOIN native_auth_registrations registration USING(organization_id,project_id,environment_id) JOIN project_preview_native_policy_receipts policy ON policy.preview_id=?4 AND policy.auth_generation=?5 AND policy.configuration_revision=realm.configuration_revision AND policy.revocation_epoch=realm.revocation_epoch AND policy.registry_version=registration.registry_version WHERE realm.organization_id=?1 AND realm.project_id=?2 AND realm.environment_id=?3 AND registration.state='active' AND policy.schema_version=?6 AND policy.schema_sha256=?7`,
    )
    .bind(
      preview.organizationId,
      preview.projectId,
      preview.environmentId,
      preview.previewId,
      preview.authGeneration,
      PREVIEW_NATIVE_POLICY_SCHEMA_VERSION,
      PREVIEW_NATIVE_POLICY_SCHEMA_SHA256,
    )
    .first();
}
async function job(context: CatalogContext, id: string) {
  return context.directory
    .prepare("SELECT * FROM project_preview_native_preparations WHERE operation_id=?1")
    .bind(id)
    .first<PreviewRow>();
}

/** Only the trusted source-inspection runtime can submit a source-bound Native plan receipt. */
export async function queuePreviewNativePreparation(context: CatalogContext, raw: unknown) {
  const i = queue.parse(raw),
    now = nowOf(i),
    scope = {
      ...i.fence,
      ...(i.now ? { now: i.now } : {}),
      ...(i.clock ? { clock: i.clock } : {}),
    };
  const current = await authorizePreviewRuntime(context, scope),
    db = context.directory,
    row = await rowById(db, i.fence.previewId);
  if (
    !current ||
    !row ||
    !nativeAuthLaunchAllowed(context, current.organizationId, current.projectId) ||
    !current.paidUntil ||
    current.paidUntil <= now ||
    JSON.stringify(current.targetSource) !== JSON.stringify(i.source)
  )
    fail("native_prepare_unavailable");
  const operationId = newUlid(),
    claimId = newUlid();
  await db.batch([
    runtimeGuard(db, row, now, true),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM credit_account WHERE organization_id=?1 AND paid_until>?2)",
      [current.organizationId, now],
    ),
    db
      .prepare(
        `INSERT INTO project_preview_native_preparations(operation_id,claim_id,preview_id,organization_id,project_id,environment_id,billing_epoch_id,runtime_generation,token_generation,auth_generation,source_connection_id,source_generation,source_sequence,commit_sha,build_plan_sha256,state,created_at,updated_at)
 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
 CASE WHEN EXISTS(SELECT 1 FROM project_preview_native_preparations prior
  JOIN native_auth_realms realm ON realm.organization_id=prior.organization_id AND realm.project_id=prior.project_id AND realm.environment_id=prior.environment_id
  JOIN native_auth_registrations registration ON registration.organization_id=realm.organization_id AND registration.project_id=realm.project_id AND registration.environment_id=realm.environment_id AND registration.state='active'
  JOIN project_preview_native_policy_receipts policy ON policy.preview_id=prior.preview_id AND policy.auth_generation=prior.auth_generation AND policy.configuration_revision=realm.configuration_revision AND policy.revocation_epoch=realm.revocation_epoch AND policy.registry_version=registration.registry_version
  WHERE prior.preview_id=?3 AND prior.auth_generation=?10 AND prior.build_plan_sha256=?15 AND prior.state='succeeded' AND realm.enabled=1 AND policy.schema_version=${PREVIEW_NATIVE_POLICY_SCHEMA_VERSION} AND policy.schema_sha256='${PREVIEW_NATIVE_POLICY_SCHEMA_SHA256}') THEN 'succeeded' ELSE 'pending' END,
 ?16,?16) ON CONFLICT(preview_id,source_sequence,auth_generation) DO NOTHING`,
      )
      .bind(
        operationId,
        claimId,
        current.previewId,
        current.organizationId,
        current.projectId,
        current.environmentId,
        current.billingEpochId,
        current.runtimeGeneration,
        current.tokenGeneration,
        current.authGeneration,
        i.source.sourceConnectionId,
        i.source.sourceGeneration,
        i.source.sequence,
        i.source.commitSha,
        i.buildPlanSha256,
        now,
      ),
  ]);
  const existing = await db
    .prepare(
      "SELECT * FROM project_preview_native_preparations WHERE preview_id=?1 AND source_sequence=?2 AND auth_generation=?3",
    )
    .bind(current.previewId, i.source.sequence, current.authGeneration)
    .first<PreviewRow>();
  if (
    !existing ||
    existing["source_connection_id"] !== i.source.sourceConnectionId ||
    Number(existing["source_generation"]) !== i.source.sourceGeneration ||
    existing["commit_sha"] !== i.source.commitSha ||
    existing["build_plan_sha256"] !== i.buildPlanSha256
  )
    fail("native_prepare_conflict");
  const matchingPolicy =
    existing["state"] === "succeeded" ? await hasCurrentPreviewNativePolicy(db, current) : null;
  if (
    ["failed", "pending", "succeeded"].includes(String(existing["state"])) &&
    (existing["state"] === "failed" ||
      (existing["state"] === "succeeded" && !matchingPolicy) ||
      (existing["state"] === "pending" &&
        (Number(existing["runtime_generation"]) !== current.runtimeGeneration ||
          Number(existing["token_generation"]) !== current.tokenGeneration)))
  ) {
    await db.batch([
      runtimeGuard(db, row, now, true),
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM native_auth_database_operations WHERE operation_id=?1 AND state='dispatched') OR EXISTS(SELECT 1 FROM native_auth_role_operations WHERE operation_id=?1 AND state='dispatched')",
        [existing["operation_id"]],
      ),
      db
        .prepare(
          "UPDATE project_preview_native_preparations SET state='pending',error_code=NULL,runtime_generation=?2,token_generation=?3,updated_at=?4 WHERE operation_id=?1 AND state IN ('pending','failed','succeeded')",
        )
        .bind(existing["operation_id"], current.runtimeGeneration, current.tokenGeneration, now),
    ]);
    const retried = await job(context, String(existing["operation_id"]));
    if (!retried) fail("native_prepare_unavailable");
    return result(retried);
  }
  return result(existing);
}
/** Runtime may inspect only its own durable job state. */
export async function readPreviewNativePreparation(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ previewId: ulid, sourceSequence: z.number().int().positive().safe() })
      .parse(raw),
    r = await context.directory
      .prepare(
        `SELECT j.* FROM project_preview_native_preparations j JOIN project_previews v ON v.preview_id=j.preview_id AND v.auth_generation=j.auth_generation AND v.retirement='none' AND v.target_connection_id=j.source_connection_id AND v.target_generation=j.source_generation AND v.target_sequence=j.source_sequence AND v.target_commit=j.commit_sha WHERE j.preview_id=?1 AND j.source_sequence=?2`,
      )
      .bind(i.previewId, i.sourceSequence)
      .first<PreviewRow>();
  if (!r) return null;
  if (r["state"] !== "succeeded") return result(r);
  const row = await rowById(context.directory, i.previewId);
  if (!row) return null;
  const fence = {
    previewId: i.previewId,
    runtimeGeneration: Number(row["runtime_generation"]),
    tokenGeneration: Number(row["token_generation"]),
  };
  const current = await authorizePreviewRuntime(context, fence);
  if (!current?.targetSource || current.targetSource.sequence !== i.sourceSequence) return null;
  if (await hasCurrentPreviewNativePolicy(context.directory, current)) return result(r);
  return queuePreviewNativePreparation(context, {
    fence,
    source: current.targetSource,
    buildPlanSha256: String(r["build_plan_sha256"]),
    authProvider: "omh-native",
  });
}
/** Private database manager claims one project at a time; competing formal provider work blocks the claim. */
export async function claimPreviewNativePreparation(context: CatalogContext, raw: unknown) {
  const i = operation.parse(raw),
    now = nowOf(i),
    r = await job(context, i.operationId);
  if (!r) fail("native_prepare_unavailable");
  const { db } = await routeOrganization(context, String(r["organization_id"]));
  if (r["state"] === "succeeded" || r["state"] === "failed")
    return {
      ...result(r),
      organizationId: String(r["organization_id"]),
      projectId: String(r["project_id"]),
      environmentId: String(r["environment_id"]),
    };
  const previewRow = await rowById(db, String(r["preview_id"]));
  const authority =
    previewRow &&
    Number(previewRow["token_generation"]) === Number(r["token_generation"]) &&
    Number(previewRow["auth_generation"]) === Number(r["auth_generation"])
      ? await authorizePreviewRuntime(context, {
          previewId: r["preview_id"],
          runtimeGeneration: previewRow["runtime_generation"],
          tokenGeneration: r["token_generation"],
          ...(i.now ? { now: i.now } : {}),
          ...(i.clock ? { clock: i.clock } : {}),
        })
      : null;
  const matches =
    authority &&
    authority.targetSource?.sourceConnectionId === r["source_connection_id"] &&
    authority.targetSource?.sourceGeneration === Number(r["source_generation"]) &&
    authority.targetSource?.sequence === Number(r["source_sequence"]) &&
    authority.targetSource?.commitSha === r["commit_sha"];
  if (r["state"] === "pending" && !matches) {
    await db
      .prepare(
        "UPDATE project_preview_native_preparations SET state='failed',error_code='NATIVE_PREPARE_AUTHORITY_CHANGED',updated_at=?2 WHERE operation_id=?1 AND state='pending'",
      )
      .bind(i.operationId, now)
      .run();
  } else if (!matches && ["running", "uncertain"].includes(String(r["state"]))) {
    // Retain attribution for dispatched effects without retaining permission to provision.
    await db
      .prepare(
        "UPDATE project_preview_native_preparations SET state='uncertain',error_code='NATIVE_PREPARE_AUTHORITY_CHANGED',updated_at=?2 WHERE operation_id=?1 AND state IN ('running','uncertain')",
      )
      .bind(i.operationId, now)
      .run();
  } else if (matches && previewRow) {
    const checks = [
      runtimeGuard(db, previewRow, now, true),
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND target_connection_id=?2 AND target_generation=?3 AND target_sequence=?4 AND target_commit=?5 AND token_generation=?6 AND auth_generation=?7)",
        [
          r["preview_id"],
          r["source_connection_id"],
          r["source_generation"],
          r["source_sequence"],
          r["commit_sha"],
          r["token_generation"],
          r["auth_generation"],
        ],
      ),
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM credit_account WHERE organization_id=?1 AND paid_until>?2)",
        [r["organization_id"], now],
      ),
    ];
    if (r["state"] === "pending" || r["state"] === "uncertain")
      checks.push(
        db
          .prepare(
            `UPDATE project_preview_native_preparations SET state='uncertain',error_code='NATIVE_PREPARE_AUTHORITY_CHANGED',updated_at=?4
 WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3 AND state='running'
 AND NOT EXISTS(SELECT 1 FROM project_previews v WHERE v.preview_id=project_preview_native_preparations.preview_id
 AND v.retirement='none' AND v.token_generation=project_preview_native_preparations.token_generation AND v.auth_generation=project_preview_native_preparations.auth_generation
 AND v.target_connection_id=project_preview_native_preparations.source_connection_id AND v.target_generation=project_preview_native_preparations.source_generation AND v.target_sequence=project_preview_native_preparations.source_sequence AND v.target_commit=project_preview_native_preparations.commit_sha)`,
          )
          .bind(r["organization_id"], r["project_id"], i.operationId, now),
        guard(
          db,
          "precondition_changed",
          "EXISTS(SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2) OR EXISTS(SELECT 1 FROM project_preview_native_preparations WHERE project_id=?2 AND operation_id<>?3 AND state='running')",
          [r["organization_id"], r["project_id"], i.operationId],
        ),
      );
    await db.batch([
      ...checks,
      db
        .prepare(
          "UPDATE project_preview_native_preparations SET state='running',runtime_generation=?2,updated_at=?3 WHERE operation_id=?1 AND state IN ('pending','running','uncertain')",
        )
        .bind(i.operationId, authority.runtimeGeneration, now),
    ]);
  }
  const current = await job(context, i.operationId);
  if (!current) fail("native_prepare_unavailable");
  return {
    ...result(current),
    organizationId: String(current["organization_id"]),
    projectId: String(current["project_id"]),
    environmentId: String(current["environment_id"]),
  };
}
/** Mark success only when the existing Native registration authority returns a real active receipt. */
export async function finishPreviewNativePreparation(context: CatalogContext, raw: unknown) {
  const i = finish.parse(raw),
    now = nowOf(i),
    r = await job(context, i.operationId);
  if (!r) fail("native_prepare_unavailable");
  const { db } = await routeOrganization(context, String(r["organization_id"]));
  if (r["state"] === "succeeded") return result(r);
  if (!["running", "uncertain"].includes(String(r["state"]))) fail("native_prepare_conflict");
  if (i.outcome === "succeeded") {
    if (i.errorCode !== null) fail("native_prepare_conflict");
    const registration = await readNativeAuthRegistration(context, {
      projectId: r["project_id"],
      environmentId: r["environment_id"],
    });
    if (!registration || registration.organizationId !== r["organization_id"])
      fail("native_registration_unavailable");
  } else if (i.errorCode === null) fail("native_prepare_conflict");
  const effectGuards =
    i.outcome === "succeeded"
      ? await nativeAuthEffectGuards(context, db, {
          organizationId: String(r["organization_id"]),
          projectId: String(r["project_id"]),
          environmentId: String(r["environment_id"]),
          operationId: i.operationId,
          claimId: String(r["claim_id"]),
        })
      : [];
  const guards =
    i.outcome === "succeeded"
      ? [
          ...effectGuards,
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM native_auth_registrations registration JOIN native_auth_realms realm USING(organization_id,project_id,environment_id) JOIN project_preview_native_policy_receipts policy ON policy.preview_id=?4 AND policy.auth_generation=?5 AND policy.configuration_revision=realm.configuration_revision AND policy.revocation_epoch=realm.revocation_epoch AND policy.registry_version=registration.registry_version WHERE registration.organization_id=?1 AND registration.project_id=?2 AND registration.environment_id=?3 AND registration.state='active' AND policy.schema_version=?6 AND policy.schema_sha256=?7)`,
            [
              r["organization_id"],
              r["project_id"],
              r["environment_id"],
              r["preview_id"],
              r["auth_generation"],
              PREVIEW_NATIVE_POLICY_SCHEMA_VERSION,
              PREVIEW_NATIVE_POLICY_SCHEMA_SHA256,
            ],
          ),
        ]
      : [];
  await db.batch([
    ...guards,
    ...(i.outcome === "failed"
      ? [
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='dispatched') OR EXISTS(SELECT 1 FROM native_auth_role_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='dispatched')",
            [r["organization_id"], r["project_id"], i.operationId],
          ),
        ]
      : []),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_preview_native_preparations WHERE operation_id=?1 AND claim_id=?2 AND state IN ('running','uncertain'))",
      [i.operationId, r["claim_id"]],
    ),
    db
      .prepare(
        "UPDATE project_preview_native_preparations SET state=?2,error_code=?3,updated_at=?4 WHERE operation_id=?1 AND state IN ('running','uncertain')",
      )
      .bind(i.operationId, i.outcome, i.errorCode, now),
  ]);
  const next = await job(context, i.operationId);
  if (!next) fail("native_prepare_unavailable");
  return result(next);
}

/** Paginated pending work and a durable cursor make uncertain provider effects retryable. */
export async function listPendingPreviewNativePreparations(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({ limit: z.number().int().min(1).max(100), after: ulid.optional() })
    .parse(raw);
  const rows = await context.directory
    .prepare(
      "SELECT operation_id,preview_id,source_sequence,state FROM project_preview_native_preparations WHERE state IN ('pending','running','uncertain') AND (?1 IS NULL OR operation_id>?1) ORDER BY operation_id LIMIT ?2",
    )
    .bind(i.after ?? null, i.limit)
    .all<PreviewRow>();
  return rows.results.map((r) => ({
    operationId: String(r["operation_id"]),
    previewId: String(r["preview_id"]),
    sourceSequence: Number(r["source_sequence"]),
    state: r["state"] as "pending" | "running" | "uncertain",
  }));
}
export async function getPreviewNativePreparationCursor(context: CatalogContext, raw: unknown) {
  z.undefined().parse(raw);
  const row = await context.directory
    .prepare("SELECT operation_id FROM project_preview_native_cursor WHERE singleton=1")
    .first<{ operation_id: string | null }>();
  return row?.operation_id ?? null;
}
export async function setPreviewNativePreparationCursor(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ expected: ulid.nullable(), next: ulid.nullable() }).parse(raw),
    db = context.directory;
  await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_preview_native_cursor WHERE singleton=1 AND operation_id IS ?1)",
      [i.expected],
    ),
    db
      .prepare("UPDATE project_preview_native_cursor SET operation_id=?1 WHERE singleton=1")
      .bind(i.next),
  ]);
}

/** Trusted Native manager records a policy only after the private realm confirms its exact SQL upsert. */
export async function recordPreviewNativePolicy(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        operationId: ulid,
        authGeneration: z.number().int().positive().safe(),
        configurationRevision: z.number().int().positive().safe(),
        revocationEpoch: z.number().int().positive().safe(),
        registryVersion: z.number().int().positive().safe(),
        ...clock,
      })
      .parse(raw),
    now = nowOf(i),
    r = await job(context, i.operationId);
  if (
    !r ||
    Number(r["auth_generation"]) !== i.authGeneration ||
    !["running", "uncertain"].includes(String(r["state"]))
  )
    fail("native_prepare_conflict");
  const { db } = await routeOrganization(context, String(r["organization_id"])),
    scope = {
      organizationId: String(r["organization_id"]),
      projectId: String(r["project_id"]),
      environmentId: String(r["environment_id"]),
      operationId: i.operationId,
      claimId: String(r["claim_id"]),
    };
  const checks = await nativeAuthEffectGuards(context, db, scope);
  await db.batch([
    ...checks,
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM native_auth_realms realm JOIN native_auth_registrations reg USING(organization_id,project_id,environment_id) WHERE realm.organization_id=?1 AND realm.project_id=?2 AND realm.environment_id=?3 AND realm.configuration_revision=?4 AND realm.revocation_epoch=?5 AND reg.registry_version=?6 AND reg.state='active')",
      [
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        i.configurationRevision,
        i.revocationEpoch,
        i.registryVersion,
      ],
    ),
    db
      .prepare(
        "INSERT INTO project_preview_native_policy_receipts(preview_id,auth_generation,configuration_revision,revocation_epoch,registry_version,schema_version,schema_sha256,operation_id,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT DO NOTHING",
      )
      .bind(
        r["preview_id"],
        i.authGeneration,
        i.configurationRevision,
        i.revocationEpoch,
        i.registryVersion,
        PREVIEW_NATIVE_POLICY_SCHEMA_VERSION,
        PREVIEW_NATIVE_POLICY_SCHEMA_SHA256,
        i.operationId,
        now,
      ),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_preview_native_policy_receipts WHERE preview_id=?1 AND auth_generation=?2 AND configuration_revision=?3 AND revocation_epoch=?4 AND registry_version=?5 AND schema_version=?6 AND schema_sha256=?7)",
      [
        r["preview_id"],
        i.authGeneration,
        i.configurationRevision,
        i.revocationEpoch,
        i.registryVersion,
        PREVIEW_NATIVE_POLICY_SCHEMA_VERSION,
        PREVIEW_NATIVE_POLICY_SCHEMA_SHA256,
      ],
    ),
  ]);
}
