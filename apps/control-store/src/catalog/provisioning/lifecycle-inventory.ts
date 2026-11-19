import { createHash } from "node:crypto";
import {
  parseUlid,
  type Ulid,
  type SharedGatewayReceipt,
  parseNewProductionFrameworkPlan,
} from "@ohmyhost/platform";
import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import {
  type CatalogContext,
  routeOrganization,
  ulid,
  publicTimestamp,
  hexBytes,
} from "../common.js";
import { storedTimestamp } from "../../timestamps.js";
import { LEGACY_MAIL_RESOURCES_SQL } from "../mail/legacy-resources.js";
import { observeGatewayRoute } from "../gateway/reads.js";
import { LifecycleInventoryConflictError } from "./lifecycle-conflict.js";

export interface LifecycleScope {
  readonly organizationId: string;
  readonly projectId: string;
}
export interface InventoryScope extends LifecycleScope {
  readonly operationId: string;
  readonly recordedAt: string;
}
export interface InventoryTarget {
  readonly provider: string;
  readonly resource_kind: string;
  readonly locator: string;
}
export interface LifecycleInventoryRecord {
  readonly resourceRecordId: Ulid;
  readonly provider: string;
  readonly resourceKind: string;
  readonly externalRefHash: Uint8Array;
  readonly cleanupLocator: string;
}
export interface DeletionInventoryPlan {
  readonly input: InventoryScope;
  readonly targets: readonly InventoryTarget[];
  readonly records: readonly LifecycleInventoryRecord[];
}
export const lifecycleTime = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);
const scoped = z.strictObject({ organizationId: ulid, projectId: ulid });
export function lifecycleConflict(message = "Lifecycle inventory or scope changed"): never {
  throw new LifecycleInventoryConflictError(message);
}
export function lifecyclePages<T>(values: readonly T[], size = 128): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < values.length; i += size) pages.push(values.slice(i, i + size));
  return pages;
}
function awsBucket(alias: string) {
  return ["ohmyho-poc-private-fullstack-build-", "ohmyho-production-build-"]
    .map(
      (prefix) =>
        `(substr(${alias},1,${prefix.length})='${prefix}' AND length(${alias})>=${prefix.length + 14} AND substr(${alias},${prefix.length + 1},12) NOT GLOB '*[^0-9]*' AND substr(${alias},${prefix.length + 13},1)='-' AND substr(${alias},${prefix.length + 14}) NOT GLOB '*[^a-z0-9-]*')`,
    )
    .join(" OR ");
}

/**
 * Exact original target set. Legacy receipts stay explicit and do not become provider/absence guesses.
 * D1 rejects a compound SELECT of more than 5 terms, so the terms form nested groups of at most 4.
 */
export const DELETION_INVENTORY_TARGETS = `SELECT DISTINCT provider,resource_kind,locator FROM(
 SELECT * FROM(SELECT 'control' provider,'project' resource_kind,p.project_id locator FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2
 UNION ALL SELECT 'cloudflare','wfp-script',r.dispatch_namespace||'/'||r.script_name FROM wfp_publish_receipts r WHERE r.organization_id=?1 AND r.project_id=?2
 UNION ALL SELECT 'cloudflare','wfp-script',c.dispatch_namespace||'/'||c.immutable_script_name FROM wfp_candidate_receipts c LEFT JOIN wfp_publish_receipts p ON p.candidate_receipt_id=c.candidate_receipt_id LEFT JOIN wfp_candidate_cleanup_receipts d ON d.candidate_receipt_id=c.candidate_receipt_id WHERE c.organization_id=?1 AND c.project_id=?2 AND(p.candidate_receipt_id IS NOT NULL OR d.candidate_receipt_id IS NULL)
 UNION ALL SELECT 'ohmyhost','gateway-route',r.environment_id FROM shared_gateway_route_revisions r WHERE r.organization_id=?1 AND r.project_id=?2)
 UNION ALL SELECT * FROM(SELECT CASE WHEN ${awsBucket("s.bucket_name")} THEN 'aws' ELSE 'cloudflare' END,'source-object',s.bucket_name||'/'||s.object_key||'/'||s.object_version_id FROM product_source_archive_objects s WHERE s.organization_id=?1 AND s.project_id=?2
 UNION ALL SELECT 'cloudflare','managed-source-repository','artifacts:'||r.namespace||'/'||r.repository_name FROM managed_source_repositories r WHERE r.organization_id=?1 AND r.project_id=?2
 UNION ALL SELECT 'cloudflare','managed-source-blob',b.bucket||'/'||b.object_key||'/'||b.version_id FROM managed_source_blobs b JOIN managed_source_publications p USING(operation_id) WHERE p.organization_id=?1 AND p.project_id=?2
 UNION ALL SELECT CASE WHEN a.object_version_ref LIKE 's3-version:%' THEN 'aws' ELSE 'cloudflare' END,'build-artifact',a.object_version_ref FROM build_artifacts a JOIN build_executions b ON b.organization_id=a.organization_id AND b.project_id=a.project_id AND b.build_execution_id=a.build_execution_id JOIN product_command_intents i ON i.organization_id=b.organization_id AND i.project_id=b.project_id AND i.operation_id=b.operation_id AND i.event_type='DeploymentRequestedV1' WHERE a.organization_id=?1 AND a.project_id=?2)
 UNION ALL SELECT * FROM(SELECT 'cloudflare','sql-export',j.archive_bucket||'/'||j.archive_key FROM project_recovery_jobs j WHERE j.project_id=?2 AND j.archive_bytes IS NOT NULL AND j.native_manifest IS NULL
 UNION ALL SELECT 'cloudflare','sql-export',e.bucket||'/'||e.object_key FROM native_export_effects e WHERE e.project_id=?2 AND e.state NOT IN('tombstoned','absent')
 UNION ALL SELECT 'cloudflare','r2-bucket',r.bucket_name FROM project_r2_bucket_receipts r WHERE r.organization_id=?1 AND r.project_id=?2
 UNION ALL SELECT t.provider,CASE WHEN t.provider='neon' THEN 'project' ELSE 'database' END,CASE WHEN t.provider='neon' THEN t.provider_project_id ELSE t.database_id END FROM database_provider_target_heads h JOIN database_provider_target_revisions t USING(organization_id,project_id,physical_environment_id,target_version) WHERE h.organization_id=?1 AND h.project_id=?2 AND h.state='active'
 UNION ALL SELECT 'ohmyhost','database-registration',r.physical_environment_id FROM(SELECT physical_environment_id FROM project_database_registration_receipts WHERE organization_id=?1 AND project_id=?2 UNION SELECT physical_environment_id FROM project_database_registration_reservations WHERE organization_id=?1 AND project_id=?2)r WHERE NOT EXISTS(SELECT 1 FROM database_provider_target_heads h JOIN database_provider_target_revisions t USING(organization_id,project_id,physical_environment_id,target_version) WHERE h.organization_id=?1 AND h.project_id=?2 AND h.physical_environment_id=r.physical_environment_id AND h.state='retired' AND t.provider='neon'))
 UNION ALL SELECT * FROM(SELECT 'resend','mail-domain',d.provider_domain_id FROM resend_mail_domains d WHERE d.organization_id=?1 AND d.project_id=?2 AND d.provider_domain_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id)
 UNION ALL SELECT 'resend','mail-api-key',d.sending_key_id FROM resend_mail_domains d WHERE d.organization_id=?1 AND d.project_id=?2 AND d.sending_key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id)
 UNION ALL SELECT 'cloudflare','mail-dns-record',d.domain_id||'/'||json_extract(r.value,'$.id') FROM resend_mail_domains d,json_each(COALESCE(json_extract(d.dns_receipts,'$.records'),'[]'))r WHERE d.organization_id=?1 AND d.project_id=?2 AND NOT EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id)
 UNION ALL SELECT 'aws',resource_kind,locator FROM(${LEGACY_MAIL_RESOURCES_SQL}))
 UNION ALL SELECT * FROM(SELECT 'cloudflare','domain-receipt',r.receipt_id FROM cloudflare_project_domain_receipts r WHERE r.organization_id=?1 AND r.project_id=?2
 UNION ALL SELECT 'pgcf','native-auth-database',t.database_id FROM native_auth_database_targets t WHERE t.organization_id=?1 AND t.project_id=?2 AND t.ended_at IS NULL
 UNION ALL SELECT 'ohmyhost','native-auth-registry',r.registry_reference FROM native_auth_registrations r WHERE r.organization_id=?1 AND r.project_id=?2 AND NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms f JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN native_auth_database_targets t ON t.organization_id=d.organization_id AND t.project_id=d.project_id AND t.target_version=d.target_version WHERE f.organization_id=r.organization_id AND f.project_id=r.project_id AND f.environment_id=r.environment_id AND f.registry_version>=r.registry_version AND f.purged_at IS NOT NULL AND d.state='absent' AND t.ended_at IS NOT NULL)
 UNION ALL SELECT 'cloudflare','native-auth-restore-pin',p.bucket||'/'||p.object_key FROM native_auth_restore_pins p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.state IN('reserved','verified'))
) ORDER BY provider,resource_kind,locator`;
const DNS_INVALID = `EXISTS(SELECT 1 FROM resend_mail_domains d WHERE d.organization_id=?1 AND d.project_id=?2 AND NOT EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id) AND json_type(d.dns_receipts,'$.records') IS NOT NULL AND json_type(d.dns_receipts,'$.records')<>'array')`;

export function inventoryDigest(provider: string, kind: string, locator: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`${provider}\0${kind}\0${locator}`).digest());
}
export function lifecycleEncodedUlid(bytes: Uint8Array): Ulid {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex")),
    value = "";
  for (let i = 0; i < 26; i++) {
    value = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(n & 31n)] + value;
    n >>= 5n;
  }
  return parseUlid(value);
}
/** Original delete identity differs from data-change identity: preserve the first-byte mask here only. */
export function deletionInventoryRecord(
  operationId: string,
  target: InventoryTarget,
): LifecycleInventoryRecord {
  const digest = inventoryDigest(target.provider, target.resource_kind, target.locator),
    id = new Uint8Array(
      createHash("sha256").update(operationId).update(digest).digest().subarray(0, 16),
    );
  id[0] = (id[0] ?? 0) & 127;
  const encoded = `encoded/${Buffer.from(target.locator).toString("base64url")}`;
  return Object.freeze({
    resourceRecordId: lifecycleEncodedUlid(id),
    provider: target.provider,
    resourceKind: target.resource_kind,
    externalRefHash: digest,
    cleanupLocator:
      encoded.length <= 1024 ? encoded : `hash/${Buffer.from(digest).toString("hex")}`,
  });
}
export async function readDeletionInventoryPlan(
  db: D1Database,
  input: InventoryScope,
): Promise<DeletionInventoryPlan> {
  scoped.parse({ organizationId: input.organizationId, projectId: input.projectId });
  parseUlid(input.operationId);
  lifecycleTime.parse(input.recordedAt);
  const result = await db.batch([
    db.prepare(`SELECT 1 WHERE ${DNS_INVALID}`).bind(input.organizationId, input.projectId),
    db.prepare(DELETION_INVENTORY_TARGETS).bind(input.organizationId, input.projectId),
  ]);
  if (result[0]?.results.length) lifecycleConflict("Deletion DNS receipt shape changed");
  const targets = (result[1]?.results ?? []) as unknown as InventoryTarget[];
  if (
    !targets.length ||
    targets.some(
      (t) =>
        typeof t.provider !== "string" ||
        typeof t.resource_kind !== "string" ||
        typeof t.locator !== "string",
    )
  )
    lifecycleConflict("Deletion inventory cannot be empty or ambiguous");
  return Object.freeze({
    input: Object.freeze({ ...input }),
    targets: Object.freeze(targets.map((t) => Object.freeze({ ...t }))),
    records: Object.freeze(targets.map((t) => deletionInventoryRecord(input.operationId, t))),
  });
}
/** Count plus every immutable tuple, in bounded pages, catches both additions and removals at acceptance commit. */
export function inventoryTargetGuards(
  db: D1Database,
  sql: string,
  params: readonly unknown[],
  targets: readonly InventoryTarget[],
): D1PreparedStatement[] {
  const statements = [
    guard(db, "precondition_changed", `(SELECT COUNT(*) FROM(${sql}))<>?${params.length + 1}`, [
      ...params,
      targets.length,
    ]),
  ];
  for (const page of lifecyclePages(targets))
    statements.push(
      guard(
        db,
        "precondition_changed",
        `EXISTS(SELECT 1 FROM json_each(?${params.length + 1}) expected WHERE NOT EXISTS(SELECT 1 FROM(${sql}) current WHERE current.provider=json_extract(expected.value,'$.provider') AND current.resource_kind=json_extract(expected.value,'$.resource_kind') AND current.locator=json_extract(expected.value,'$.locator')))`,
        [...params, JSON.stringify(page)],
      ),
    );
  return statements;
}
export function inventoryInsertStatements(
  db: D1Database,
  input: InventoryScope,
  records: readonly LifecycleInventoryRecord[],
): D1PreparedStatement[] {
  return lifecyclePages(
    records.map((r) => ({
      id: r.resourceRecordId,
      provider: r.provider,
      kind: r.resourceKind,
      hash: Buffer.from(r.externalRefHash).toString("hex"),
      locator: r.cleanupLocator,
    })),
  ).map((page) =>
    db
      .prepare(
        `INSERT INTO run_resource_inventory(resource_record_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,cleanup_locator,recorded_at) SELECT json_extract(value,'$.id'),?1,?2,?3,json_extract(value,'$.provider'),json_extract(value,'$.kind'),unhex(json_extract(value,'$.hash')),json_extract(value,'$.locator'),?4 FROM json_each(?5) WHERE 1 ON CONFLICT(organization_id,operation_id,provider,resource_kind,external_ref_hash) DO NOTHING`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.operationId,
        lifecycleTime.parse(input.recordedAt),
        JSON.stringify(page),
      ),
  );
}
/** Compose AFTER lifecycle/intent acceptance, in that SAME audit/outbox transaction; never an independent RPC. */
export function deletionInventoryStatements(
  db: D1Database,
  plan: DeletionInventoryPlan,
): D1PreparedStatement[] {
  const { input } = plan;
  return [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM product_command_intents i JOIN projects p ON p.organization_id=i.organization_id AND p.project_id=i.project_id AND p.lifecycle_state='deleting' AND p.owner_state='active' WHERE i.organization_id=?1 AND i.project_id=?2 AND i.operation_id=?3 AND i.event_type='ProjectDeletionRequestedV1')`,
      [input.organizationId, input.projectId, input.operationId],
    ),
    guard(db, "precondition_changed", DNS_INVALID, [input.organizationId, input.projectId]),
    // A reserved copy may still materialize after an absence check. Keep deletion
    // unaccepted until the original copy outcome and any active restore are reconciled.
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM native_auth_restore_pins p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.state='reserved') OR EXISTS(SELECT 1 FROM native_auth_restore_jobs j WHERE j.organization_id=?1 AND j.project_id=?2 AND j.state IN('queued','claimed','consumed')) OR EXISTS(SELECT 1 FROM native_auth_restores r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.state='restoring')`,
      [input.organizationId, input.projectId],
    ),
    ...inventoryTargetGuards(
      db,
      DELETION_INVENTORY_TARGETS,
      [input.organizationId, input.projectId],
      plan.targets,
    ),
    ...inventoryInsertStatements(db, input, plan.records),
  ];
}

/** Original readWfpProjectDeletionEvidence: historical candidates plus each latest active gateway. */
export async function readLifecycleDeletionEvidence(context: CatalogContext, raw: unknown) {
  const input = scoped.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    result = await db.batch([
      db
        .prepare(
          `SELECT c.*,lower(hex(c.artifact_sha256)) digest,CASE WHEN c.binding_set_digest IS NULL THEN NULL ELSE lower(hex(c.binding_set_digest)) END binding_digest FROM wfp_candidate_receipts c LEFT JOIN wfp_publish_receipts p ON p.candidate_receipt_id=c.candidate_receipt_id LEFT JOIN wfp_candidate_cleanup_receipts d ON d.candidate_receipt_id=c.candidate_receipt_id WHERE c.organization_id=?1 AND c.project_id=?2 AND(p.candidate_receipt_id IS NOT NULL OR d.candidate_receipt_id IS NULL) ORDER BY c.staged_at,c.candidate_receipt_id`,
        )
        .bind(input.organizationId, input.projectId),
      db
        .prepare(
          "SELECT environment_id FROM environments WHERE organization_id=? AND project_id=? ORDER BY name",
        )
        .bind(input.organizationId, input.projectId),
    ]),
    activeGateways: SharedGatewayReceipt[] = [];
  for (const env of result[1]?.results ?? []) {
    const route = await observeGatewayRoute(context, {
      ...input,
      environmentId: env["environment_id"],
    });
    if (route?.active) activeGateways.push(route);
  }
  return {
    candidates: (result[0]?.results ?? []).map((r) => ({
      candidateReceiptId: parseUlid(String(r["candidate_receipt_id"])),
      organizationId: parseUlid(String(r["organization_id"])),
      projectId: parseUlid(String(r["project_id"])),
      environmentId: parseUlid(String(r["environment_id"])),
      operationId: parseUlid(String(r["operation_id"])),
      productDeploymentId: parseUlid(String(r["product_deployment_id"])),
      artifactId: parseUlid(String(r["artifact_id"])),
      namespace: String(r["dispatch_namespace"]),
      immutableScriptName: String(r["immutable_script_name"]),
      artifactDigest: hexBytes(String(r["digest"])),
      ...(r["binding_digest"] == null
        ? {}
        : { bindingSetDigest: hexBytes(String(r["binding_digest"])) }),
      providerTag: String(r["provider_tag"]),
      buildReused: r["build_reused"] === 1,
      stagedAt: publicTimestamp(String(r["staged_at"])),
    })),
    activeGateways,
  };
}
/** Exact source-operation filter without live-parent or current-build aliases. */
export async function readLifecycleCleanupResources(context: CatalogContext, raw: unknown) {
  const input = scoped.extend({ environmentId: ulid, operationId: ulid }).parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    result = await db.batch([
      db
        .prepare(
          "SELECT bucket_name,object_key,object_version_id,object_etag,CAST(byte_length AS TEXT) byte_length,operation_id,lower(hex(source_sha256)) digest FROM product_source_archive_objects WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 ORDER BY operation_id",
        )
        .bind(input.organizationId, input.projectId, input.environmentId, input.operationId),
      db
        .prepare(
          `SELECT DISTINCT b.provider_build_id,b.build_project_name,b.operation_id,i.deployment_id,p.commit_sha,lower(hex(p.source_sha256)) source_digest,lower(hex(p.build_plan_sha256)) plan_digest,p.framework_plan,a.object_version_ref FROM build_executions b JOIN build_artifacts a ON a.organization_id=b.organization_id AND a.project_id=b.project_id AND a.build_execution_id=b.build_execution_id JOIN product_command_intents i ON i.organization_id=b.organization_id AND i.project_id=b.project_id AND i.operation_id=b.operation_id AND i.environment_id=?3 AND i.event_type='DeploymentRequestedV1' AND i.deployment_id IS NOT NULL AND i.plan_id IS NOT NULL JOIN deployment_plans p ON p.organization_id=i.organization_id AND p.project_id=i.project_id AND p.plan_id=i.plan_id WHERE b.organization_id=?1 AND b.project_id=?2 AND b.operation_id=?4 ORDER BY i.deployment_id,b.provider_build_id`,
        )
        .bind(input.organizationId, input.projectId, input.environmentId, input.operationId),
    ]);
  const scope = (operation: string) => ({
    projectId: parseUlid(input.projectId),
    environmentId: parseUlid(input.environmentId),
    operationId: parseUlid(operation),
  });
  return {
    sourceArchives: (result[0]?.results ?? []).map((r) => {
      const byteLength = Number(r["byte_length"]);
      if (!Number.isSafeInteger(byteLength) || byteLength < 1)
        throw new TypeError("Persisted source archive byte length is invalid");
      return {
        bucket: String(r["bucket_name"]),
        key: String(r["object_key"]),
        versionId: String(r["object_version_id"]),
        eTag: String(r["object_etag"]),
        byteLength,
        scope: scope(String(r["operation_id"])),
        sourceSha256: String(r["digest"]),
      };
    }),
    artifactExpectations: (result[1]?.results ?? []).map((r) => {
      const providerScope = scope(String(r["operation_id"])),
        frameworkPlan = parseNewProductionFrameworkPlan(JSON.parse(String(r["framework_plan"]))),
        match =
          /^r2-version:(ohmyho-builds-(?:development|production)(?:-eu)?)\/([^#]{1,512})#([0-9a-f]{32})$/u.exec(
            String(r["object_version_ref"]),
          );
      if (
        !match ||
        match[2] !==
          `runs/${providerScope.projectId}/${providerScope.environmentId}/${providerScope.operationId}/output/bundle.tar.gz`
      )
        throw new TypeError("Persisted build artifact object reference is invalid");
      return {
        receipt: {
          buildId: String(r["provider_build_id"]),
          projectName: String(r["build_project_name"]),
          scope: providerScope,
        },
        deploymentId: parseUlid(String(r["deployment_id"])),
        commitSha: String(r["commit_sha"]),
        sourceSha256: String(r["source_digest"]),
        buildPlanSha256: String(r["plan_digest"]),
        frameworkPlan,
        output: {
          bucket: match[1] as string,
          key: match[2],
          versionId: match[3] as string,
          scope: providerScope,
        },
      };
    }),
  };
}
export async function recordLifecycleCleanupAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = scoped
    .extend({
      operationId: ulid,
      cleanupAttemptId: ulid,
      provider: z.string(),
      resourceKind: z.string(),
      externalRefHash: z.instanceof(Uint8Array),
      outcome: z.enum(["removed", "not_found", "failed"]),
      errorCode: z.string().optional(),
      attemptedAt: lifecycleTime,
    })
    .parse(raw);
  if (
    input.provider.trim() !== input.provider ||
    !input.provider ||
    input.resourceKind.trim() !== input.resourceKind ||
    !input.resourceKind ||
    input.externalRefHash.byteLength !== 32 ||
    (input.outcome === "failed") !== (input.errorCode !== undefined)
  )
    throw new TypeError("Cleanup resource identity is invalid");
  const { db } = await routeOrganization(context, input.organizationId),
    name = "workflow.recordCleanupAttempt",
    hash = Buffer.from(input.externalRefHash).toString("hex");
  return runCommand<Record<string, unknown> | null, "created" | "existing">(db, {
    name,
    input,
    lookup: async () => {
      throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
    },
    naturalKeyTables: ["run_cleanup_attempts"],
    read: (r) =>
      r
        .prepare(
          "SELECT organization_id,project_id,operation_id,provider,resource_kind,lower(hex(external_ref_hash)) hash,outcome,error_code,attempted_at FROM run_cleanup_attempts WHERE cleanup_attempt_id=?",
        )
        .bind(input.cleanupAttemptId)
        .first(),
    decide: (old) => {
      if (old) {
        const repeated = old["outcome"] === "removed" && input.outcome === "not_found";
        if (
          old["organization_id"] !== input.organizationId ||
          old["project_id"] !== input.projectId ||
          old["operation_id"] !== input.operationId ||
          old["provider"] !== input.provider ||
          old["resource_kind"] !== input.resourceKind ||
          old["hash"] !== hash ||
          (old["outcome"] !== input.outcome && !repeated) ||
          old["error_code"] !== (input.errorCode ?? null) ||
          publicTimestamp(String(old["attempted_at"])) !== publicTimestamp(input.attemptedAt)
        )
          lifecycleConflict("Cleanup attempt conflicts with append-only evidence");
        return { replay: "existing" };
      }
      return {
        statements: [
          db
            .prepare(
              "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,error_code,attempted_at)VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              input.cleanupAttemptId,
              input.organizationId,
              input.projectId,
              input.operationId,
              input.provider,
              input.resourceKind,
              input.externalRefHash,
              input.outcome,
              input.errorCode ?? null,
              input.attemptedAt,
            ),
        ],
        result: () => "created",
      };
    },
  });
}
export async function deleteLifecycleSchedules(
  context: CatalogContext,
  raw: unknown,
): Promise<number> {
  const input = scoped.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    name = "workflow.deleteSchedules";
  return runCommand<number, number>(db, {
    name,
    input,
    lookup: async () => {
      throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
    },
    retryOn: ["precondition_changed"],
    read: async (r) =>
      Number(
        (
          await r
            .prepare(
              "SELECT COUNT(*) n FROM environment_function_schedules WHERE organization_id=? AND project_id=?",
            )
            .bind(input.organizationId, input.projectId)
            .first<{ n: number }>()
        )?.n ?? 0,
      ),
    decide: (count) => ({
      statements: [
        guard(
          db,
          "precondition_changed",
          "(SELECT COUNT(*) FROM environment_function_schedules WHERE organization_id=?1 AND project_id=?2)<>?3",
          [input.organizationId, input.projectId, count],
        ),
        db
          .prepare(
            "DELETE FROM environment_function_schedules WHERE organization_id=? AND project_id=?",
          )
          .bind(input.organizationId, input.projectId),
      ],
      result: () => count,
    }),
  });
}

/** Original deleting/current-owner/current-epoch/running-cleanup authority and one consistent managed read. */
export async function readLifecycleManagedSourceInventory(context: CatalogContext, raw: unknown) {
  const input = scoped.extend({ operationId: ulid }).parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    result = await db.batch([
      db
        .prepare(
          `SELECT 1 FROM product_command_intents i JOIN operations o USING(organization_id,project_id,operation_id) JOIN projects p ON p.organization_id=i.organization_id AND p.project_id=i.project_id JOIN cleanup_runs c ON c.organization_id=i.organization_id AND c.cleanup_run_id=i.cleanup_run_id AND c.operation_id=i.operation_id AND c.project_id=i.project_id WHERE i.organization_id=?1 AND i.project_id=?2 AND i.operation_id=?3 AND i.event_type='ProjectDeletionRequestedV1' AND o.state IN('queued','running') AND p.lifecycle_state='deleting' AND p.owner_state='active' AND i.billing_epoch_id=p.active_billing_epoch_id AND c.state='running'`,
        )
        .bind(input.organizationId, input.projectId, input.operationId),
      db
        .prepare(
          "SELECT source_connection_id,namespace,repository_name FROM managed_source_repositories WHERE organization_id=? AND project_id=? ORDER BY source_connection_id",
        )
        .bind(input.organizationId, input.projectId),
      db
        .prepare(
          "SELECT p.operation_id,b.path,b.sha256,CAST(b.byte_length AS TEXT) byte_length,b.executable,b.bucket,b.object_key,b.version_id,b.etag FROM managed_source_publications p JOIN managed_source_blobs b USING(operation_id) WHERE p.organization_id=? AND p.project_id=? ORDER BY p.operation_id,b.path COLLATE BINARY",
        )
        .bind(input.organizationId, input.projectId),
    ]);
  if (result[0]?.results.length !== 1)
    throw Object.assign(new Error("Managed source scope conflict"), {
      name: "ManagedSourceConflictError",
      kind: "scope",
    });
  type Blob = {
    path: string;
    sha256: string;
    byteLength: number;
    executable: boolean;
    bucket: string;
    key: string;
    versionId: string;
    eTag: string;
  };
  const groups = new Map<string, Blob[]>();
  for (const r of result[2]?.results ?? []) {
    const id = String(r["operation_id"]),
      blobs = groups.get(id) ?? [];
    blobs.push({
      path: String(r["path"]),
      sha256: String(r["sha256"]),
      byteLength: Number(r["byte_length"]),
      executable: r["executable"] === 1,
      bucket: String(r["bucket"]),
      key: String(r["object_key"]),
      versionId: String(r["version_id"]),
      eTag: String(r["etag"]),
    });
    groups.set(id, blobs);
  }
  return {
    repos: (result[1]?.results ?? []).map((r) => ({
      sourceConnectionId: String(r["source_connection_id"]),
      namespace: String(r["namespace"]),
      repositoryName: String(r["repository_name"]),
    })),
    blobOperations: [...groups].map(([operationId, blobs]) => ({ operationId, blobs })),
  };
}
