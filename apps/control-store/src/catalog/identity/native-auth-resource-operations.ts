import {
  LIVE_ROW as PREVIEW_LIVE_ROW,
  LIVE_SOURCE as PREVIEW_LIVE_SOURCE,
} from "../previews/common.js";
import { assertNativeAuthLaunchAllowed } from "./native-auth-launch-policy.js";
import { z } from "zod";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { guard } from "../../guards.js";
import { digestOf } from "../../run-command.js";
import type { D1Database } from "../../d1-types.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { assertOperationDelegationCurrent } from "./operation-delegations.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "../provisioning/authority.js";
import { SENDER_SQL, senderOf } from "../mail/auth.js";
import { storedTimestamp } from "../../timestamps.js";
import { originsSql } from "./native-auth-config.js";

const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  claimId: ulid,
});
const reserveInput = scope.extend({
  providerProjectId: z.string().regex(/^prj_[a-z0-9]{20}$/u),
  name: z.string(),
  regionId: z.enum(["us-dev", "eu-dev"]),
  sizeClassId: z.literal("r256-s500m"),
});
const observedInput = scope.extend({
  providerProjectId: z.string().regex(/^prj_[a-z0-9]{20}$/u),
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  providerOperationId: z.string().regex(/^op_[a-z0-9]{20}$/u),
});
const roleInput = scope.extend({
  providerProjectId: z.string().regex(/^prj_[a-z0-9]{20}$/u),
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  roleName: z.string(),
});
const roleObservationInput = roleInput.extend({
  idempotencyKey: z.string().regex(/^omh-[a-f0-9]{64}$/u),
  providerOperationId: z
    .string()
    .regex(/^op_[a-z0-9]{20}$/u)
    .nullable(),
  state: z.enum(["dispatched", "succeeded", "failed"]),
});
const preparationInput = scope.extend({
  providerProjectId: z.string().regex(/^prj_[a-z0-9]{20}$/u),
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  targetVersion: z.number().int().min(1).max(2147483647),
  schema: z.string(),
  runtimeRole: z.string(),
  migratorRole: z.string(),
  backupRole: z.string(),
  migrationDigest: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_SHA256),
  migrationVersion: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_VERSION),
});
const NOW = `(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`;
const sender = SENDER_SQL.replaceAll("?4", NOW);
const CLAIM_AUTHORITY = `SELECT 1 FROM product_provider_mutation_claims c
 JOIN projects p ON p.organization_id=c.organization_id AND p.project_id=c.project_id
 JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
 JOIN operations op ON op.organization_id=c.organization_id AND op.project_id=c.project_id AND op.operation_id=c.operation_id
 JOIN billing_epochs epoch ON epoch.organization_id=p.organization_id AND epoch.project_id=p.project_id AND epoch.billing_epoch_id=p.active_billing_epoch_id AND epoch.ended_at IS NULL
 JOIN product_command_intents i ON i.organization_id=c.organization_id AND i.project_id=c.project_id AND i.environment_id=c.environment_id AND i.operation_id=c.operation_id AND i.event_type=c.event_type AND i.billing_epoch_id=c.billing_epoch_id
 LEFT JOIN deployment_revisions r ON r.organization_id=i.organization_id AND r.project_id=i.project_id AND ((i.event_type='DeploymentPromotionRequestedV1' AND r.deployment_id=i.source_deployment_id AND r.revision_id=i.source_revision_id AND r.artifact_id=i.source_artifact_id) OR (i.event_type='DeploymentRollbackRequestedV1' AND r.deployment_id=i.target_deployment_id AND r.revision_id=i.target_revision_id AND r.artifact_id=i.target_artifact_id))
 JOIN deployment_plans plan ON plan.organization_id=i.organization_id AND plan.project_id=i.project_id AND plan.plan_id=CASE WHEN i.event_type='DeploymentRequestedV1' THEN i.plan_id ELSE r.plan_id END
 WHERE c.organization_id=?1 AND c.project_id=?2 AND c.environment_id=?3 AND c.operation_id=?4 AND c.claim_id=?5
 AND c.event_type IN('DeploymentRequestedV1','DeploymentPromotionRequestedV1')
 AND p.owner_state='active' AND p.lifecycle_state='active' AND p.lifecycle_version=c.accepted_lifecycle_version
 AND p.active_billing_epoch_id=c.billing_epoch_id AND op.billing_epoch_id=c.billing_epoch_id AND op.state IN('queued','running')
 AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native'
 AND json_extract(plan.framework_plan,'$.auth.routePath')='/api/auth/v1' AND json_extract(plan.framework_plan,'$.auth.bindingName')='OHMYHOST_AUTH'
`;
const PREVIEW_CLAIM = `SELECT 1 FROM project_preview_native_preparations j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.environment_id=?3 AND j.operation_id=?4 AND j.claim_id=?5 AND j.state IN ('running','uncertain')`;
const PREVIEW_EFFECT = `SELECT 1 FROM project_preview_native_preparations j JOIN project_previews v ON v.preview_id=j.preview_id
 WHERE j.organization_id=?1 AND j.project_id=?2 AND j.environment_id=?3 AND j.operation_id=?4 AND j.claim_id=?5 AND j.state='running'
 AND v.retirement='none' AND v.token_generation=j.token_generation AND v.auth_generation=j.auth_generation
 AND v.organization_id=j.organization_id AND v.project_id=j.project_id AND v.environment_id=j.environment_id AND v.billing_epoch_id=j.billing_epoch_id
 AND v.target_connection_id=j.source_connection_id AND v.target_generation=j.source_generation AND v.target_sequence=j.source_sequence AND v.target_commit=j.commit_sha
 AND ${PREVIEW_LIVE_ROW.replaceAll("?2", NOW)} AND ${PREVIEW_LIVE_SOURCE}
 AND EXISTS(SELECT 1 FROM credit_account account WHERE account.organization_id=j.organization_id AND account.paid_until>${NOW}
 AND (account.monthly_ends_at<=${NOW} OR account.monthly_micros+account.onetime_micros>account.reserved_micros OR account.exhausted_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%f',account.exhausted_at,'+7 days')||'000Z')>${NOW}))
 AND NOT EXISTS(SELECT 1 FROM project_credit pc WHERE pc.organization_id=j.organization_id AND pc.project_id=j.project_id AND pc.budget_mode='stop' AND pc.budget_micros IS NOT NULL AND (CASE WHEN pc.period=substr(${NOW},1,7) THEN pc.used_micros ELSE 0 END)+(SELECT COALESCE(sum(amount_micros),0) FROM credit_reservation cr WHERE cr.organization_id=j.organization_id AND cr.project_id=j.project_id)>=pc.budget_micros)
 AND NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims claim WHERE claim.organization_id=j.organization_id AND claim.project_id=j.project_id)
 AND EXISTS(SELECT 1 FROM (${sender}) sender WHERE sender.ciphertext IS NOT NULL AND sender.nonce IS NOT NULL AND sender.valueSha256 IS NOT NULL AND sender.keyVersion IS NOT NULL AND sender.reputationState<>'suspended')`;
const AUTHORITY = `${CLAIM_AUTHORITY}
 AND (c.event_type='DeploymentRequestedV1' OR (c.event_type='DeploymentPromotionRequestedV1' AND EXISTS(
   SELECT 1 FROM environments src JOIN environments dst ON dst.organization_id=src.organization_id AND dst.project_id=src.project_id
   JOIN deployments d ON d.organization_id=src.organization_id AND d.project_id=src.project_id AND d.environment_id=src.environment_id AND d.deployment_id=i.source_deployment_id AND d.active_revision_id=i.source_revision_id AND d.status='succeeded'
   JOIN build_artifacts a ON a.organization_id=i.organization_id AND a.project_id=i.project_id AND a.artifact_id=i.source_artifact_id AND a.artifact_sha256=i.source_artifact_sha256
   WHERE src.organization_id=i.organization_id AND src.project_id=i.project_id AND src.environment_id=i.source_environment_id AND src.name='dev' AND src.active_deployment_id=i.source_deployment_id AND src.active_revision_id=i.source_revision_id AND src.head_version=i.expected_source_head_version AND dst.environment_id=i.environment_id AND dst.name='prod' AND dst.head_version=i.expected_target_head_version)))
 AND EXISTS(SELECT 1 FROM credit_account a WHERE a.organization_id=p.organization_id AND a.paid_until>${NOW}
 AND (a.monthly_ends_at<=${NOW} OR a.monthly_micros+a.onetime_micros>a.reserved_micros OR a.exhausted_at IS NULL OR (strftime('%Y-%m-%dT%H:%M:%f',a.exhausted_at,'+7 days')||'000Z')>${NOW}))
 AND NOT EXISTS(SELECT 1 FROM project_credit pc WHERE pc.organization_id=p.organization_id AND pc.project_id=p.project_id AND pc.budget_mode='stop' AND pc.budget_micros IS NOT NULL AND (CASE WHEN pc.period=substr(${NOW},1,7) THEN pc.used_micros ELSE 0 END)+(SELECT COALESCE(sum(amount_micros),0) FROM credit_reservation cr WHERE cr.organization_id=p.organization_id AND cr.project_id=p.project_id)>=pc.budget_micros)
 AND EXISTS(SELECT 1 FROM (${sender}) sender WHERE sender.ciphertext IS NOT NULL AND sender.nonce IS NOT NULL AND sender.valueSha256 IS NOT NULL AND sender.keyVersion IS NOT NULL AND sender.reputationState<>'suspended')`;
const values = (i: z.output<typeof scope>) => [
  i.organizationId,
  i.projectId,
  i.environmentId,
  i.operationId,
  i.claimId,
];
const fail = () => new Error("native_auth_resource_conflict");

export async function nativeAuthEffectGuards(
  context: CatalogContext,
  db: D1Database,
  i: z.output<typeof scope>,
) {
  const preview = await db
    .prepare(PREVIEW_CLAIM)
    .bind(...values(i))
    .first();
  if (preview) assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  else
    await assertOperationDelegationCurrent(context, {
      organizationId: i.organizationId,
      operationId: i.operationId,
    });
  const senderRows = await db
    .prepare(SENDER_SQL)
    .bind(i.organizationId, i.projectId, i.environmentId, storedTimestamp(new Date().toISOString()))
    .all<Record<string, unknown>>();
  if (senderRows.results.length !== 1) throw fail();
  const senderRow = senderRows.results[0];
  senderOf(senderRow);
  if (!senderRow) throw fail();
  const proof = preview ? null : await readWorkflowDelegation(db, i);
  return [
    guard(db, "claim_lost", `NOT EXISTS(${preview ? PREVIEW_EFFECT : AUTHORITY})`, values(i)),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM (${sender}) s WHERE s.domain_id IS ?4 AND s.domain IS ?5 AND s.registrableDomain IS ?6 AND s.applicationHostname IS ?7 AND s.bindingRevision IS ?8 AND s.valueSha256 IS ?9 AND s.keyVersion IS ?10 AND s.reputationState IS ?11 AND s.legacy IS ?12)`,
      [
        i.organizationId,
        i.projectId,
        i.environmentId,
        senderRow["domain_id"],
        senderRow["domain"],
        senderRow["registrableDomain"],
        senderRow["applicationHostname"],
        senderRow["bindingRevision"],
        senderRow["valueSha256"],
        senderRow["keyVersion"],
        senderRow["reputationState"],
        senderRow["legacy"],
      ],
    ),
    ...(preview ? [] : workflowExecutionGuards(db, i, proof)),
  ];
}

/** Resolves the region only from the current, authorized project. */
export async function resolveNativeAuthDatabaseClaim(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const result = await db.batch([
    ...guards,
    db
      .prepare("SELECT region FROM projects WHERE organization_id=?1 AND project_id=?2")
      .bind(i.organizationId, i.projectId),
  ]);
  const region = result.at(-1)?.results[0]?.["region"];
  if (region !== "us" && region !== "eu") throw fail();
  return { ...i, regionId: `${region}-dev` as "us-dev" | "eu-dev" };
}

/** Only an already dispatched request may outlive Paid/sender admission; this grants no new resource authority. */
export async function readNativeAuthDatabaseReconciliation(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const key = `omh-${await digestOf([i.organizationId, i.projectId, i.operationId, "native-auth-database.create"])}`;
  const row = await db
    .prepare(
      `SELECT o.provider_project_id,o.name,o.region_id,o.size_class_id,o.idempotency_key
    FROM native_auth_database_operations o
    WHERE o.organization_id=?1 AND o.project_id=?2 AND o.environment_id=?3 AND o.operation_id=?4 AND o.claim_id=?5
      AND o.state='dispatched' AND o.database_id IS NULL AND o.provider_operation_id IS NULL
      AND o.idempotency_key=?6 AND o.name='ohmyho-auth-'||lower(?2)
      AND (EXISTS(${CLAIM_AUTHORITY}) OR EXISTS(${PREVIEW_CLAIM}))
      AND EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.region||'-dev'=o.region_id)
      AND NOT EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.project_id=?2 AND t.ended_at IS NULL)`,
    )
    .bind(...values(i), key)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  return {
    claim: { ...i, regionId: z.enum(["us-dev", "eu-dev"]).parse(row["region_id"]) },
    providerProjectId: z
      .string()
      .regex(/^prj_[a-z0-9]{20}$/u)
      .parse(row["provider_project_id"]),
    name: String(row["name"]),
    sizeClassId: z.literal("r256-s500m").parse(row["size_class_id"]),
    operation: { idempotencyKey: key, databaseId: null, providerOperationId: null },
  };
}

/** Private read-only attribution survives source/entitlement revocation; it never grants dispatch. */
export async function readNativeAuthPreviewReconciliation(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    guard(db, "claim_lost", `NOT EXISTS(${PREVIEW_CLAIM})`, values(i)),
    db
      .prepare(
        "SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND state='dispatched'",
      )
      .bind(...values(i)),
    db
      .prepare(
        "SELECT provider_project_id,database_id,role_name,idempotency_key,provider_operation_id FROM native_auth_role_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND state='dispatched' ORDER BY role_name",
      )
      .bind(...values(i)),
  ]);
  return {
    databasePending: (rows[1]?.results.length ?? 0) !== 0,
    roles: (rows[2]?.results ?? []).map((row) => ({
      ...i,
      providerProjectId: String(row["provider_project_id"]),
      databaseId: String(row["database_id"]),
      roleName: String(row["role_name"]),
      idempotencyKey: String(row["idempotency_key"]),
      providerOperationId:
        row["provider_operation_id"] === null ? null : String(row["provider_operation_id"]),
    })),
  };
}

/** First activation initializes defaults once; existing owner policy, including pause, is never overwritten. */
export async function initializeNativeAuthRealm(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const project = await db
    .prepare("SELECT name FROM projects WHERE organization_id=?1 AND project_id=?2")
    .bind(i.organizationId, i.projectId)
    .first<{ name: string }>();
  const name = project?.name;
  if (
    typeof name !== "string" ||
    name.trim().length < 1 ||
    name.trim().length > 128 ||
    // eslint-disable-next-line no-control-regex -- Display names must reject ASCII and C1 controls.
    /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  )
    throw fail();
  const result = await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND name=?3)",
      [i.organizationId, i.projectId, name],
    ),
    db
      .prepare(
        `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch,canonical_origin,allowed_redirect_paths,reset_password_path,invitation_path)
      SELECT ?1,?2,?3,1,'open',trim(p.name),1,1,json_extract((${originsSql}),'$[0]'),json_array('/','/login','/reset-password','/accept-invitation'),'/reset-password','/accept-invitation'
      FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND length(trim(p.name))>0 ON CONFLICT DO NOTHING`,
      )
      .bind(i.organizationId, i.projectId, i.environmentId),
    db
      .prepare(
        `INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at)
         VALUES(?1,?2,'active',${NOW},1,${NOW}) ON CONFLICT(organization_id,project_id) DO NOTHING`,
      )
      .bind(i.organizationId, i.projectId),
    db
      .prepare(
        `SELECT enabled,configuration_revision,revocation_epoch,canonical_origin,(${originsSql}) AS approved_origins FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3`,
      )
      .bind(i.organizationId, i.projectId, i.environmentId),
  ]);
  const realm = result.at(-1)?.results[0];
  if (!realm) throw fail();
  const approved = JSON.parse(String(realm["approved_origins"])) as unknown;
  const origin = realm["canonical_origin"];
  return {
    status:
      typeof origin === "string" && Array.isArray(approved) && approved.includes(origin)
        ? ("ready" as const)
        : ("origin_pending" as const),
    enabled: realm["enabled"] === 1,
    configurationRevision: Number(realm["configuration_revision"]),
    revocationEpoch: Number(realm["revocation_epoch"]),
    canonicalOrigin:
      typeof origin === "string" && Array.isArray(approved) && approved.includes(origin)
        ? origin
        : null,
  };
}

/** Commits the exact source-bound create identity before any provider effect. */
export async function reserveNativeAuthDatabaseOperation(context: CatalogContext, raw: unknown) {
  const i = reserveInput.parse(raw);
  if (i.name !== `ohmyho-auth-${i.projectId.toLowerCase()}`) throw fail();
  const { db } = await routeOrganization(context, i.organizationId);
  const key = `omh-${await digestOf([i.organizationId, i.projectId, i.operationId, "native-auth-database.create"])}`;
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const result = await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND region||'-dev'=?3) OR EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.project_id=?2 AND t.ended_at IS NULL AND NOT EXISTS(SELECT 1 FROM native_auth_database_operations o WHERE o.organization_id=?1 AND o.project_id=t.project_id AND o.environment_id=?4 AND o.operation_id=?5 AND o.claim_id=?6 AND o.state='observed' AND o.database_id=t.database_id AND o.provider_operation_id=t.provider_operation_id))`,
      [i.organizationId, i.projectId, i.regionId, i.environmentId, i.operationId, i.claimId],
    ),
    db
      .prepare(
        `UPDATE native_auth_database_operations SET state='cancelled' WHERE project_id=?1 AND state='reserved' AND NOT (organization_id=?2 AND operation_id=?3 AND claim_id=?4) AND NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims c JOIN operations op ON op.organization_id=c.organization_id AND op.project_id=c.project_id AND op.operation_id=c.operation_id WHERE c.organization_id=native_auth_database_operations.organization_id AND c.project_id=native_auth_database_operations.project_id AND c.environment_id=native_auth_database_operations.environment_id AND c.operation_id=native_auth_database_operations.operation_id AND c.claim_id=native_auth_database_operations.claim_id AND op.state IN('queued','running')) AND NOT EXISTS(SELECT 1 FROM project_preview_native_preparations j WHERE j.organization_id=native_auth_database_operations.organization_id AND j.project_id=native_auth_database_operations.project_id AND j.environment_id=native_auth_database_operations.environment_id AND j.operation_id=native_auth_database_operations.operation_id AND j.claim_id=native_auth_database_operations.claim_id AND j.state IN('running','uncertain'))`,
      )
      .bind(i.projectId, i.organizationId, i.operationId, i.claimId),
    db
      .prepare(
        `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'reserved') ON CONFLICT DO NOTHING`,
      )
      .bind(...values(i), i.providerProjectId, i.name, i.regionId, i.sizeClassId, key),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND provider_project_id=?6 AND name=?7 AND region_id=?8 AND size_class_id=?9 AND idempotency_key=?10)`,
      [...values(i), i.providerProjectId, i.name, i.regionId, i.sizeClassId, key],
    ),
    db
      .prepare(
        `SELECT idempotency_key,state,provider_operation_id,database_id FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
      )
      .bind(i.organizationId, i.projectId, i.operationId),
  ]);
  const row = result.at(-1)?.results[0];
  if (!row) throw fail();
  return {
    idempotencyKey: String(row["idempotency_key"]),
    state: String(row["state"]),
    providerOperationId: row["provider_operation_id"] as string | null,
    databaseId: row["database_id"] as string | null,
  };
}

/** Commits dispatch authority before the caller makes or replays the provider request. */
export async function beginNativeAuthDatabaseOperation(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const result = await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5)`,
      values(i),
    ),
    db
      .prepare(
        `UPDATE native_auth_database_operations SET state='dispatched',dispatched_at=${NOW} WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND state='reserved'`,
      )
      .bind(...values(i)),
    db
      .prepare(
        `SELECT state FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5`,
      )
      .bind(...values(i)),
  ]);
  const row = result.at(-1)?.results[0];
  if (!row) throw fail();
  if (row["state"] !== "dispatched" && row["state"] !== "observed") throw fail();
  return result[guards.length + 1]?.meta.changes === 1
    ? ("dispatch" as const)
    : ("observe" as const);
}

/** An already dispatched effect remains attributable even if its claim or ownership changed afterwards. */
export async function recordNativeAuthDatabaseObservation(context: CatalogContext, raw: unknown) {
  const i = observedInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const result = await db.batch([
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND provider_project_id=?6 AND state IN('dispatched','observed') AND (database_id IS NULL OR (database_id=?7 AND provider_operation_id=?8)))`,
      [...values(i), i.providerProjectId, i.databaseId, i.providerOperationId],
    ),
    db
      .prepare(
        `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) SELECT o.organization_id,o.project_id,o.provider_project_id,?7,?8,o.region_id,o.size_class_id,COALESCE((SELECT max(target_version) FROM native_auth_database_targets WHERE project_id=o.project_id),0)+1,o.dispatched_at,strftime('%Y-%m-%dT%H:00:00.000000Z',o.dispatched_at) FROM native_auth_database_operations o WHERE o.organization_id=?1 AND o.project_id=?2 AND o.environment_id=?3 AND o.operation_id=?4 AND o.claim_id=?5 AND o.provider_project_id=?6 AND o.state IN('dispatched','observed') ON CONFLICT DO NOTHING`,
      )
      .bind(...values(i), i.providerProjectId, i.databaseId, i.providerOperationId),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_targets WHERE organization_id=?1 AND project_id=?2 AND provider_project_id=?3 AND database_id=?4 AND provider_operation_id=?5 AND ended_at IS NULL)`,
      [i.organizationId, i.projectId, i.providerProjectId, i.databaseId, i.providerOperationId],
    ),
    db
      .prepare(
        `UPDATE native_auth_database_operations SET state='observed', database_id=?6, provider_operation_id=?7 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND state IN('dispatched','observed')`,
      )
      .bind(...values(i), i.databaseId, i.providerOperationId),
    db
      .prepare(
        `SELECT region_id,size_class_id,target_version FROM native_auth_database_targets WHERE organization_id=?1 AND project_id=?2 AND provider_project_id=?3 AND database_id=?4 AND provider_operation_id=?5 AND ended_at IS NULL`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.providerProjectId,
        i.databaseId,
        i.providerOperationId,
      ),
  ]);
  const target = result.at(-1)?.results[0];
  if (!target) throw fail();
  return {
    organizationId: i.organizationId,
    projectId: i.projectId,
    providerProjectId: i.providerProjectId,
    databaseId: i.databaseId,
    providerOperationId: i.providerOperationId,
    regionId: target["region_id"],
    sizeClassId: target["size_class_id"],
    targetVersion: target["target_version"],
  };
}

function validateRole(i: z.output<typeof roleInput>): void {
  const environment = i.environmentId.toLowerCase(),
    project = i.projectId.toLowerCase();
  if (![`omh_ar_${environment}`, `omh_am_${environment}`, `omh_ab_${project}`].includes(i.roleName))
    throw fail();
}
const roleIdentity = (i: z.output<typeof roleInput>) => [
  i.projectId,
  i.providerProjectId,
  i.databaseId,
  i.roleName,
];
const roleTargetGuard = (db: D1Database, i: z.output<typeof roleInput>) =>
  guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM native_auth_database_targets WHERE project_id=?1 AND provider_project_id=?2 AND database_id=?3 AND ended_at IS NULL)`,
    roleIdentity(i).slice(0, 3),
  );

/** One original role identity per project database and role, shared by later deployment claims. */
export async function reserveNativeAuthRoleOperation(context: CatalogContext, raw: unknown) {
  const i = roleInput.parse(raw);
  validateRole(i);
  const { db } = await routeOrganization(context, i.organizationId);
  const key = `omh-${await digestOf([i.projectId, i.databaseId, i.roleName, "native-auth-role.create"])}`;
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const result = await db.batch([
    ...guards,
    roleTargetGuard(db, i),
    db
      .prepare(
        `INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'reserved') ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...values(i),
        i.providerProjectId,
        i.databaseId,
        i.roleName,
        `role.create:${i.roleName}`,
        key,
      ),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_role_operations WHERE project_id=?1 AND provider_project_id=?2 AND database_id=?3 AND role_name=?4 AND idempotency_key=?5 AND step=?6)`,
      [...roleIdentity(i), key, `role.create:${i.roleName}`],
    ),
    db
      .prepare(
        `SELECT organization_id,environment_id,operation_id,claim_id,idempotency_key,provider_operation_id,state FROM native_auth_role_operations WHERE project_id=?1 AND provider_project_id=?2 AND database_id=?3 AND role_name=?4`,
      )
      .bind(...roleIdentity(i)),
  ]);
  const row = result.at(-1)?.results[0];
  if (!row) throw fail();
  return {
    organizationId: String(row["organization_id"]),
    projectId: i.projectId,
    environmentId: String(row["environment_id"]),
    operationId: String(row["operation_id"]),
    claimId: String(row["claim_id"]),
    providerProjectId: i.providerProjectId,
    databaseId: i.databaseId,
    roleName: i.roleName,
    idempotencyKey: String(row["idempotency_key"]),
    providerOperationId: row["provider_operation_id"] as string | null,
    state: String(row["state"]),
  };
}

/** Reauthorize the current claim even when reconciling an older role reservation. */
export async function beginNativeAuthRoleOperation(context: CatalogContext, raw: unknown) {
  const i = roleInput.parse(raw);
  validateRole(i);
  const { db } = await routeOrganization(context, i.organizationId);
  assertNativeAuthLaunchAllowed(context, i.organizationId, i.projectId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const result = await db.batch([
    ...guards,
    roleTargetGuard(db, i),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_role_operations WHERE project_id=?1 AND provider_project_id=?2 AND database_id=?3 AND role_name=?4 AND state IN('reserved','dispatched','succeeded'))`,
      roleIdentity(i),
    ),
    db
      .prepare(
        `UPDATE native_auth_role_operations SET state='dispatched' WHERE project_id=?1 AND provider_project_id=?2 AND database_id=?3 AND role_name=?4 AND state='reserved'`,
      )
      .bind(...roleIdentity(i)),
  ]);
  return result.at(-1)?.meta.changes === 1 ? ("dispatch" as const) : ("observe" as const);
}

/** Observe only the exact durable original request, even after current authority has changed. */
export async function recordNativeAuthRoleObservation(context: CatalogContext, raw: unknown) {
  const i = roleObservationInput.parse(raw);
  validateRole(i);
  const { db } = await routeOrganization(context, i.organizationId);
  await db.batch([
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_role_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND provider_project_id=?6 AND database_id=?7 AND role_name=?8 AND idempotency_key=?9 AND (state='dispatched' OR (state=?10 AND provider_operation_id IS ?11)) AND (provider_operation_id IS NULL OR provider_operation_id IS ?11))`,
      [
        ...values(i),
        i.providerProjectId,
        i.databaseId,
        i.roleName,
        i.idempotencyKey,
        i.state,
        i.providerOperationId,
      ],
    ),
    db
      .prepare(
        `UPDATE native_auth_role_operations SET state=?10,provider_operation_id=?11 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND provider_project_id=?6 AND database_id=?7 AND role_name=?8 AND idempotency_key=?9 AND state='dispatched'`,
      )
      .bind(
        ...values(i),
        i.providerProjectId,
        i.databaseId,
        i.roleName,
        i.idempotencyKey,
        i.state,
        i.providerOperationId,
      ),
  ]);
  return { status: "recorded" as const };
}

/** Called only by the private database manager after pinned migration and real SQL privilege readback. */
export async function recordNativeAuthPreparation(context: CatalogContext, raw: unknown) {
  const i = preparationInput.parse(raw);
  const env = i.environmentId.toLowerCase(),
    project = i.projectId.toLowerCase();
  if (
    i.schema !== `omh_auth_${env}` ||
    i.runtimeRole !== `omh_ar_${env}` ||
    i.migratorRole !== `omh_am_${env}` ||
    i.backupRole !== `omh_ab_${project}`
  )
    throw fail();
  const { db } = await routeOrganization(context, i.organizationId);
  const guards = await nativeAuthEffectGuards(context, db, i);
  const args = [
    ...values(i),
    i.providerProjectId,
    i.databaseId,
    i.targetVersion,
    i.schema,
    i.runtimeRole,
    i.migratorRole,
    i.backupRole,
    i.migrationDigest,
    i.migrationVersion,
  ];
  await db.batch([
    ...guards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.project_id=?2 AND t.provider_project_id=?6 AND t.database_id=?7 AND t.target_version=?8 AND t.ended_at IS NULL) OR EXISTS(SELECT 1 FROM json_each(json_array(?10,?11,?12)) role WHERE NOT EXISTS(SELECT 1 FROM native_auth_role_operations r WHERE r.project_id=?2 AND r.provider_project_id=?6 AND r.database_id=?7 AND r.role_name=role.value AND r.state='succeeded'))`,
      args.slice(0, 12),
    ),
    db
      .prepare(
        `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT DO NOTHING`,
      )
      .bind(...args),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_preparation_receipts WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND claim_id=?5 AND provider_project_id=?6 AND database_id=?7 AND target_version=?8 AND schema_name=?9 AND runtime_role=?10 AND migrator_role=?11 AND backup_role=?12 AND migration_digest=?13 AND migration_version=?14)`,
      args,
    ),
  ]);
  return { status: "recorded" as const };
}
