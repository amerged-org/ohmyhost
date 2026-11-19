import {
  notFencedOrganization,
  publicTimestamp,
  routeOrganization,
  type CatalogContext,
} from "../common.js";
import { ROUTE_ROW, ROUTE_FROM } from "../gateway/facts.js";
import { receiptOf, type Route } from "../gateway/mutations.js";
import { AI_KEY_NAME, BROWSER_KEY_NAME } from "@ohmyhost/platform/shared";
import {
  scope,
  pendingInput,
  recordedInput,
  manifestAuthorityInput,
  parse,
  integer,
  storedNames,
  DeliveryInputError,
  DeliveryScopeError,
  ManifestAuthorityError,
  type Row,
  type Scope,
} from "./contracts.js";
import { ACTIVE_SCOPE, STATE_DOCUMENT, params, parseState } from "./facts.js";
import { STAGE_COLUMNS } from "./stage.js";

function blob(hex: unknown): Uint8Array {
  if (typeof hex !== "string" || !/^(?:[a-f0-9]{2})*$/u.test(hex)) throw new DeliveryInputError();
  return Uint8Array.from(hex.match(/../gu) ?? [], (v) => parseInt(v, 16));
}
const CANDIDATE_VALUE = `json_object('candidate_receipt_id',candidate.candidate_receipt_id,'organization_id',candidate.organization_id,'project_id',candidate.project_id,'environment_id',candidate.environment_id,'operation_id',candidate.operation_id,'product_deployment_id',candidate.product_deployment_id,'artifact_id',candidate.artifact_id,'dispatch_namespace',candidate.dispatch_namespace,'immutable_script_name',candidate.immutable_script_name,'artifact_sha256',lower(hex(candidate.artifact_sha256)),'binding_set_digest',CASE WHEN candidate.binding_set_digest IS NULL THEN NULL ELSE lower(hex(candidate.binding_set_digest)) END,'provider_tag',candidate.provider_tag,'build_reused',candidate.build_reused,'staged_at',candidate.staged_at,'shared_gateway_revision',CAST(receipt.shared_gateway_revision AS TEXT))`;
const CANDIDATE_FROM = `FROM environments environment
 JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id AND revision.project_id=environment.project_id AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id
 JOIN effective_wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=receipt.organization_id AND candidate.project_id=receipt.project_id AND candidate.candidate_receipt_id=receipt.candidate_receipt_id
 JOIN projects project ON project.project_id=environment.project_id AND project.owner_state<>'transferred' 
 JOIN cloudflare_project_domains domain ON domain.organization_id=environment.organization_id AND domain.project_id=environment.project_id AND domain.deleted_at IS NULL
 WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3
 AND receipt.shared_gateway_revision IS NOT NULL AND receipt.script_name=candidate.immutable_script_name
 AND receipt.deployment_url='https://'||CASE environment.name WHEN 'dev' THEN domain.development_domain ELSE domain.production_domain END AND domain.handle=project.handle`;
const ACTIVE_CANDIDATE = `SELECT ${CANDIDATE_VALUE} ${CANDIDATE_FROM}`;
function candidateOf(row: Row) {
  return {
    candidateReceiptId: String(row["candidate_receipt_id"]),
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    operationId: String(row["operation_id"]),
    productDeploymentId: String(row["product_deployment_id"]),
    artifactId: String(row["artifact_id"]),
    namespace: String(row["dispatch_namespace"]),
    immutableScriptName: String(row["immutable_script_name"]),
    artifactDigest: blob(row["artifact_sha256"]),
    ...(row["binding_set_digest"] == null
      ? {}
      : { bindingSetDigest: blob(row["binding_set_digest"]) }),
    providerTag: String(row["provider_tag"]),
    buildReused: row["build_reused"] === 1,
    stagedAt: publicTimestamp(String(row["staged_at"])),
  };
}
function deliveryState(row: Row) {
  return {
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    desiredGeneration: integer(row["desired_generation"]),
    appliedGeneration: integer(row["applied_generation"]),
    nextReleaseSequence: integer(row["next_release_sequence"], 1),
    appliedReleaseSequence: integer(row["applied_release_sequence"]),
    ...(row["claimed_release_sequence"] === null
      ? {}
      : { activeClaimReleaseSequence: integer(row["claimed_release_sequence"], 1) }),
    ...(row["provider_tag"] === null
      ? {}
      : { runtimeProvider: "wfp" as const, providerTag: String(row["provider_tag"]) }),
    ...(row["lease_expires_at"] === null
      ? {}
      : { activeLeaseExpiresAt: publicTimestamp(String(row["lease_expires_at"])) }),
    ...(row["last_failure_code"] === null
      ? {}
      : { lastFailureCode: String(row["last_failure_code"]) }),
    appliedSecretNames: storedNames(row["applied_secret_names"]),
    ...(row["applied_manifest_sha256"] === null
      ? {}
      : { manifestSha256: blob(row["applied_manifest_sha256"]) }),
    manifestSecretCount: integer(row["applied_secret_count"]),
    updatedAt: publicTimestamp(String(row["updated_at"])),
  };
}
export async function readDeliveryState(context: CatalogContext, raw: unknown) {
  const input = parse(scope, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const row = await db
    .prepare(`${STATE_DOCUMENT} AND EXISTS(${ACTIVE_SCOPE})`)
    .bind(...params(input))
    .first<{ value: string }>();
  const state = parseState(row?.value ?? null);
  return state === null ? undefined : deliveryState(state);
}

const ANOMALY_LIMIT = 10;
/**
 * Pending rows that the batch leaves out because their owner, environment or bucket is inconsistent. They used to fail the
 * whole read; now they are skipped, so this bounded read keeps the corruption visible in the logs with per-reason counts.
 */
async function logPendingAnomalies(context: CatalogContext, now: string): Promise<void> {
  const rows = (
    await context.directory
      .prepare(
        `SELECT project.created_organization_id<>state.organization_id AS owner_mismatch,
 CASE WHEN EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=project.created_organization_id AND environment.project_id=project.project_id AND environment.environment_id=state.environment_id AND environment.name IN('dev','prod')) THEN 0 ELSE 1 END AS environment_name,
 EXISTS(SELECT 1 FROM organizations organization JOIN bucket_fences fence ON fence.bucket=organization.bucket WHERE organization.organization_id=state.organization_id AND fence.state='moved') AS bucket_moved
 FROM runtime_secret_delivery_states state JOIN projects project ON project.organization_id=state.organization_id AND project.project_id=state.project_id AND project.owner_state='active'
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 WHERE (state.active_lease_id IS NULL OR state.lease_expires_at<=?1) AND (state.desired_generation>state.applied_generation OR state.active_lease_id IS NOT NULL)
 AND (project.created_organization_id<>state.organization_id
   OR NOT EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=project.created_organization_id AND environment.project_id=project.project_id AND environment.environment_id=state.environment_id AND environment.name IN('dev','prod'))
   OR EXISTS(SELECT 1 FROM organizations organization JOIN bucket_fences fence ON fence.bucket=organization.bucket WHERE organization.organization_id=state.organization_id AND fence.state='moved'))
 LIMIT ?2`,
      )
      .bind(now, ANOMALY_LIMIT)
      .all<{ owner_mismatch: number; environment_name: number; bucket_moved: number }>()
  ).results;
  if (rows.length === 0) return;
  const count = (flag: "owner_mismatch" | "environment_name" | "bucket_moved") =>
    rows.filter((row) => row[flag] === 1).length;
  console.error(
    "runtime_secret_pending_anomalies",
    JSON.stringify({
      sampled: rows.length,
      limit: ANOMALY_LIMIT,
      bucketMoved: count("bucket_moved"),
      ownerMismatch: count("owner_mismatch"),
      environmentName: count("environment_name"),
    }),
  );
}

// Plan-gated platform keys: the claim leaves them out when the plan does not enable them, so a manifest may omit them.
const PLAN_GATED_SECRETS = new Set(["OHMYHOST_MAIL_KEY", AI_KEY_NAME, BROWSER_KEY_NAME]);

/**
 * Authorizes a WFP runtime-secret manifest against Core: the environment must be active, every secret the manifest
 * names must be stored at exactly that revision, and every stored secret outside the plan gate must be named.
 */
export async function authorizeRuntimeSecretManifest(context: CatalogContext, raw: unknown) {
  const input = parse(manifestAuthorityInput, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const [active, stored] = await db.batch([
    db.prepare(`SELECT CAST(EXISTS(${ACTIVE_SCOPE}) AS INTEGER) active`).bind(...params(input)),
    db
      .prepare(
        "SELECT name,CAST(revision AS TEXT) revision FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(...params(input)),
  ]);
  if (active?.results[0]?.["active"] !== 1) throw new DeliveryScopeError();
  const storedRevisions = new Map(
    stored?.results.map((row) => [String(row["name"]), String(row["revision"])]),
  );
  const supplied = new Map(input.secrets.map((secret) => [secret.name, String(secret.revision)]));
  if (supplied.size !== input.secrets.length) throw new ManifestAuthorityError();
  for (const [name, revision] of supplied) {
    if (storedRevisions.get(name) !== revision) throw new ManifestAuthorityError();
  }
  for (const name of storedRevisions.keys()) {
    if (!supplied.has(name) && !PLAN_GATED_SECRETS.has(name)) throw new ManifestAuthorityError();
  }
  return Object.freeze({ authorized: true as const });
}

export async function readPendingDeliveries(context: CatalogContext, raw: unknown) {
  const input = parse(pendingInput, raw),
    candidate = ACTIVE_CANDIDATE.replaceAll("?1", "state.organization_id")
      .replaceAll("?2", "state.project_id")
      .replaceAll("?3", "state.environment_id");
  // A scope without a provider runtime has nothing to sync here: the sweeper can only defer it, and only a deployment
  // delivers its secrets. Rows the delivery cannot act on are left out of the batch instead of failing the whole read,
  // and the batch starts with the scopes the sweeper has not tried for longest (`last_attempted_at`).
  const rows = (
    await context.directory
      .prepare(
        `SELECT state.organization_id,state.project_id,state.environment_id,CAST(state.desired_generation AS TEXT) desired_generation,CAST(state.applied_generation AS TEXT) applied_generation,state.provider_tag,state.last_failure_code,project.handle,
 (SELECT environment.name FROM environments environment WHERE environment.organization_id=project.created_organization_id AND environment.project_id=project.project_id AND environment.environment_id=state.environment_id) environment_name,
 CASE WHEN state.provider_tag IS NOT NULL THEN (${candidate}) END candidate_value
 FROM runtime_secret_delivery_states state JOIN projects project ON project.organization_id=state.organization_id AND project.project_id=state.project_id AND project.owner_state='active'
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 WHERE (state.active_lease_id IS NULL OR state.lease_expires_at<=?1) AND (state.desired_generation>state.applied_generation OR state.active_lease_id IS NOT NULL)
 AND state.provider_tag IS NOT NULL AND project.lifecycle_state='active' AND project.created_organization_id=state.organization_id
 AND EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=project.created_organization_id AND environment.project_id=project.project_id AND environment.environment_id=state.environment_id AND environment.name IN('dev','prod'))
 AND ${notFencedOrganization("state.organization_id")}
 ORDER BY (state.desired_generation>state.applied_generation) DESC,state.last_attempted_at IS NOT NULL,state.last_attempted_at,state.updated_at,state.organization_id,state.project_id,state.environment_id LIMIT ?2`,
      )
      .bind(input.now, input.limit)
      .all()
  ).results;
  await logPendingAnomalies(context, input.now);
  return rows.map((row) => ({
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    environmentId: String(row["environment_id"]),
    desiredGeneration: integer(row["desired_generation"]),
    appliedGeneration: integer(row["applied_generation"]),
    ...(row["provider_tag"] === null ? {} : { runtimeProvider: "wfp" as const }),
    ...(row["last_failure_code"] === null
      ? {}
      : { lastFailureCode: String(row["last_failure_code"]) }),
    ...(typeof row["candidate_value"] === "string"
      ? { activeCandidate: candidateOf(JSON.parse(row["candidate_value"]) as Row) }
      : {}),
    environmentName: String(row["environment_name"]),
    handle: String(row["handle"]),
  }));
}

const ACTIVE_SECRET_TAG = `SELECT delivered.provider_tag FROM runtime_secret_delivery_stages staged
 JOIN runtime_secret_delivery_stage_activations activated ON activated.stage_receipt_id=staged.stage_receipt_id AND activated.organization_id=staged.organization_id AND activated.project_id=staged.project_id AND activated.environment_id=staged.environment_id
 JOIN runtime_secret_delivery_receipts delivered ON delivered.receipt_id=activated.activation_receipt_id AND delivered.organization_id=staged.organization_id AND delivered.project_id=staged.project_id AND delivered.environment_id=staged.environment_id
 WHERE staged.organization_id=candidate.organization_id AND staged.project_id=candidate.project_id AND staged.environment_id=candidate.environment_id AND staged.candidate_receipt_id=candidate.candidate_receipt_id
 ORDER BY activated.activated_at DESC,staged.generation DESC LIMIT 1`;
export async function readActiveDeliveryTarget(context: CatalogContext, raw: unknown) {
  const input = parse(scope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    p = params(input);
  const row = await db
    .prepare(
      `SELECT ${CANDIDATE_VALUE} candidate_value,(${ACTIVE_SECRET_TAG}) runtime_secret_provider_tag ${CANDIDATE_FROM}
 AND EXISTS(SELECT 1 FROM runtime_secret_delivery_states state WHERE state.organization_id=environment.organization_id AND state.project_id=environment.project_id AND state.environment_id=environment.environment_id)
 AND (${ACTIVE_SECRET_TAG}) IS NOT NULL`,
    )
    .bind(...p)
    .first<{ candidate_value: string; runtime_secret_provider_tag: string }>();
  if (row === null) return undefined;
  const value = JSON.parse(row.candidate_value) as Row,
    candidate = candidateOf(value),
    revision = integer(value["shared_gateway_revision"], 1);
  const route = await db
    .prepare(
      `SELECT ${ROUTE_ROW} value ${ROUTE_FROM} WHERE route.organization_id=?1 AND route.project_id=?2 AND route.environment_id=?3 AND route.revision=?4`,
    )
    .bind(...p, revision)
    .first<{ value: string }>();
  if (route === null) throw new DeliveryInputError();
  return {
    deployment: {
      provider: "cloudflare-wfp" as const,
      namespace: candidate.namespace,
      scriptName: candidate.immutableScriptName,
      projectId: candidate.projectId,
      environmentId: candidate.environmentId,
      productDeploymentId: candidate.productDeploymentId,
      providerTag: row.runtime_secret_provider_tag,
      artifactDigest: `sha256:${String(value["artifact_sha256"])}`,
      ...(candidate.bindingSetDigest === undefined
        ? {}
        : { bindingSetDigest: `sha256:${String(value["binding_set_digest"])}` }),
      buildReused: candidate.buildReused,
      deployedAt: candidate.stagedAt,
    },
    candidateReceiptId: candidate.candidateReceiptId,
    operationId: candidate.operationId,
    gateway: await receiptOf(JSON.parse(route.value) as Route),
  };
}
export async function readRecordedDeliveryStage(context: CatalogContext, raw: unknown) {
  const input = parse(recordedInput, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const row = await db
    .prepare(
      `SELECT ${STAGE_COLUMNS} FROM runtime_secret_delivery_stages stage
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=stage.organization_id AND candidate.project_id=stage.project_id AND candidate.environment_id=stage.environment_id AND candidate.candidate_receipt_id=stage.candidate_receipt_id AND candidate.operation_id=stage.operation_id AND candidate.product_deployment_id=stage.product_deployment_id
 JOIN environments environment ON environment.organization_id=stage.organization_id AND environment.project_id=stage.project_id AND environment.environment_id=stage.environment_id AND environment.name=?3
 WHERE stage.organization_id=?1 AND stage.project_id=?2 AND stage.candidate_receipt_id=?4
 AND stage.stage_receipt_id=(SELECT latest.stage_receipt_id FROM runtime_secret_delivery_stages latest WHERE latest.organization_id=?1 AND latest.project_id=?2 AND latest.candidate_receipt_id=?4 ORDER BY latest.release_sequence DESC LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM runtime_secret_delivery_stage_activations activation WHERE activation.stage_receipt_id=stage.stage_receipt_id)
 AND NOT EXISTS(SELECT 1 FROM runtime_secret_delivery_stage_compensations compensation WHERE compensation.stage_receipt_id=stage.stage_receipt_id)`,
    )
    .bind(input.organizationId, input.projectId, input.environmentName, input.candidateReceiptId)
    .first();
  return row === null
    ? null
    : {
        stageReceiptId: String(row["stage_receipt_id"]),
        candidateReceiptId: String(row["candidate_receipt_id"]),
        operationId: String(row["operation_id"]),
        productDeploymentId: String(row["product_deployment_id"]),
        leaseId: String(row["lease_id"]),
        generation: integer(row["generation"]),
        releaseSequence: integer(row["release_sequence"], 1),
        trigger: String(row["trigger"]),
        providerTag: String(row["provider_tag"]),
        appliedSecretNames: storedNames(row["applied_secret_names"]),
        manifestDigest: `sha256:${String(row["manifest_sha256"])}`,
        manifestSecretCount: integer(row["manifest_secret_count"]),
        stagedAt: publicTimestamp(String(row["staged_at"])),
        outcome: "existing" as const,
      };
}
export type DeliveryTargetScope = Scope;
