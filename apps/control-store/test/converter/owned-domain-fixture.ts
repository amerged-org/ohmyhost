import { Buffer } from "node:buffer";
import type { TestPostgres } from "../../../control-api/test/postgres.js";
import type { D1Database } from "../../src/d1-types.js";
import { newUlid } from "../../src/catalog/common.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { seedOriginalGateway } from "../gateway/pg-gateway.fixture.js";
import { createTestControl } from "../support/control-d1.js";

/** Real original PG18 facts. Parents are accepted real Core fixtures, never fake schema or production adapters. */
export async function seedOwnedSource(pool: TestPostgres["pool"]) {
  const source = await createTestControl();
  try {
    const r = await gatewayFixture(source);
    await seedOriginalGateway({ pool }, r);
    const { organizationId: org, projectId: project, environmentId: env } = r.scope,
      at = "2026-10-29T00:00:00.123456Z",
      rollbackOp = newUlid(),
      rollbackDeployment = newUlid(),
      addressOp = newUlid();
    const insert = async (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      await pool.query(
        `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        Object.values(row),
      );
    };
    for (const op of [rollbackOp, addressOp])
      await insert("operations", {
        organization_id: org,
        operation_id: op,
        project_id: project,
        state: "running",
        billing_epoch_id: r.project.billingEpochId,
        created_at: at,
        updated_at: at,
      });
    await insert("deployments", {
      organization_id: org,
      deployment_id: rollbackDeployment,
      project_id: project,
      environment_id: env,
      operation_id: rollbackOp,
      kind: "rollback",
      status: "running",
      created_at: at,
      updated_at: at,
      rollback_target_deployment_id: r.published.deploymentId,
      rollback_target_revision_id: r.published.revisionId,
    });
    const route = (revision: number, operation: string) => ({
      organization_id: org,
      project_id: project,
      environment_id: env,
      revision,
      predecessor_revision: revision - 1,
      operation_id: operation,
      candidate_receipt_id: r.published.candidateReceiptId,
      action: "activate",
      active: true,
      handle: r.project.handle,
      public_origin: `https://${r.hostname}`,
      egress_allowed_origins: "[]",
      observed_at: at,
    });
    await insert("shared_gateway_route_revisions", route(2, rollbackOp));
    await insert("wfp_rollback_activation_receipts", {
      rollback_activation_receipt_id: newUlid(),
      organization_id: org,
      project_id: project,
      environment_id: env,
      operation_id: rollbackOp,
      rollback_deployment_id: rollbackDeployment,
      target_deployment_id: r.published.deploymentId,
      target_revision_id: r.published.revisionId,
      candidate_receipt_id: r.published.candidateReceiptId,
      wfp_receipt_id: r.published.wfpReceiptId,
      activated_at: at,
      activated_head_version: "2",
      shared_gateway_revision: "2",
    });
    await pool.query(
      "UPDATE environments SET head_version=2 WHERE organization_id=$1 AND environment_id=$2",
      [org, env],
    );
    const stage = {
      stage_receipt_id: newUlid(),
      organization_id: org,
      project_id: project,
      environment_id: env,
      operation_id: rollbackOp,
      product_deployment_id: r.published.deploymentId,
      candidate_receipt_id: r.published.candidateReceiptId,
      lease_id: newUlid(),
      generation: "9007199254740993",
      release_sequence: "9007199254740994",
      trigger: "rollback",
      provider_tag: "retained/tag",
      applied_secret_names: ["A", "A", null, "comma,name", 'quote"name'],
      manifest_sha256: Buffer.alloc(32, 4),
      manifest_secret_count: 5,
      staged_at: at,
    };
    await insert("runtime_secret_delivery_stages", stage);
    await insert("runtime_secret_delivery_stage_activations", {
      activation_receipt_id: newUlid(),
      stage_receipt_id: stage.stage_receipt_id,
      activated_at: at,
      organization_id: org,
      project_id: project,
      environment_id: env,
      shared_gateway_revision: "2",
    });
    const otherStage = { ...stage, stage_receipt_id: newUlid(), lease_id: newUlid() };
    await insert("runtime_secret_delivery_stages", otherStage);
    await insert("runtime_secret_delivery_stage_compensations", {
      compensation_receipt_id: newUlid(),
      stage_receipt_id: otherStage.stage_receipt_id,
      failure_code: "CANDIDATE_REMOVED",
      compensated_at: at,
    });
    await insert("runtime_secret_delivery_receipts", {
      receipt_id: newUlid(),
      organization_id: newUlid(),
      project_id: project,
      environment_id: env,
      lease_id: stage.lease_id,
      generation: stage.generation,
      release_sequence: stage.release_sequence,
      trigger: stage.trigger,
      provider_tag: stage.provider_tag,
      applied_secret_names: stage.applied_secret_names,
      manifest_sha256: stage.manifest_sha256,
      manifest_secret_count: stage.manifest_secret_count,
      completed_at: at,
    });
    await insert("shared_gateway_route_revisions", route(3, addressOp));
    await insert("shared_gateway_address_receipts", {
      organization_id: org,
      project_id: project,
      environment_id: env,
      operation_id: addressOp,
      wfp_receipt_id: r.published.wfpReceiptId,
      shared_gateway_revision: "3",
      head_version: 2,
      handle: r.project.handle,
      public_origin: `https://${r.hostname}`,
      observed_at: at,
    });
    const cleanup = newUlid();
    await insert("wfp_candidate_cleanup_requests", {
      cleanup_request_id: cleanup,
      candidate_receipt_id: r.candidateReceiptId,
      organization_id: org,
      project_id: project,
      operation_id: r.accepted.operationId,
      reason: "compensate",
      requested_at: at,
    });
    await insert("wfp_candidate_cleanup_claims", {
      candidate_receipt_id: r.candidateReceiptId,
      organization_id: org,
      project_id: project,
      claim_id: newUlid(),
      attempt_number: 7,
      claimed_at: at,
      lease_expires_at: "2026-10-29T01:00:00.123456Z",
    });
    await insert("wfp_candidate_cleanup_resource_expectations", {
      cleanup_request_id: cleanup,
      candidate_receipt_id: r.candidateReceiptId,
      organization_id: org,
      project_id: project,
      operation_id: r.accepted.operationId,
      provider: "cloudflare",
      resource_kind: "build-artifact",
      resource_identity_sha256: Buffer.alloc(32, 9),
    });
    const originalScript = (
      await pool.query<{ immutable_script_name: string }>(
        "SELECT immutable_script_name FROM wfp_candidate_receipts WHERE candidate_receipt_id=$1",
        [r.published.candidateReceiptId],
      )
    ).rows[0]?.immutable_script_name;
    if (!originalScript) throw new Error("Missing native retained target");
    await insert("wfp_candidate_cleanup_receipts", {
      cleanup_receipt_id: newUlid(),
      candidate_receipt_id: r.candidateReceiptId,
      organization_id: org,
      project_id: project,
      outcome: "removed",
      compensated_target_script_name: originalScript,
      observed_provider_tag: r.providerTag,
      observed_at: at,
      environment_id: env,
      shared_gateway_revision: "3",
    });
    await insert("environment_secrets", {
      organization_id: org,
      project_id: project,
      environment_id: env,
      name: "ORIGINAL",
      ciphertext: Buffer.alloc(25, 5),
      nonce: Buffer.alloc(12, 6),
      value_sha256: Buffer.alloc(32, 7),
      key_version: 1,
      revision: "9007199254740993",
      created_at: at,
      updated_at: at,
    });
    for (const pending of [true, false])
      await insert("environment_secret_requests", {
        organization_id: pending ? newUlid() : org,
        project_id: project,
        environment_id: env,
        action: "set",
        name: "ORIGINAL",
        idempotency_key: pending ? "pending" : "completed",
        request_sha256: Buffer.alloc(32, 8),
        response: pending ? null : '{"z": 9007199254740993, "status": "set"}',
        requested_at: at,
        completed_at: pending ? null : at,
      });
    await pool.query(
      "UPDATE runtime_secret_delivery_states SET next_release_sequence=9007199254740995,applied_release_sequence=9007199254740993,updated_at=$3 WHERE organization_id=$1 AND environment_id=$2",
      [org, env, at],
    );
    const bucket = {
      organization_id: org,
      project_id: project,
      environment_id: env,
      operation_id: r.accepted.operationId,
      claim_id: r.accepted.claimId,
      bucket_name: `ohmyho-${project.toLowerCase()}-${env.toLowerCase()}`,
      provider_bucket_id: "f".repeat(32),
      jurisdiction: "us",
      storage_class: "Standard",
      public_access: false,
      observed_at: at,
      created_at: at,
    };
    await insert("project_r2_bucket_receipts", bucket);
    await insert("storage_gateway_keys", {
      organization_id: org,
      project_id: project,
      environment_id: env,
      key_version: 1,
      key_sha256: Buffer.alloc(32, 10),
      created_at: at,
    });
    return { source, r, bucket, insert };
  } catch (error) {
    await source.dispose();
    throw error;
  }
}

/** Parent fixture transfer ONLY. These real rows are outside the owned domain-mapper qualification. */
export async function seedTargetParents(
  source: D1Database,
  target: D1Database,
  operationRecords: { row: Record<string, string | null> }[],
  bucket: Record<string, unknown>,
  environmentRows: Record<string, string | null>[],
) {
  for (const table of [
    "org_directory",
    "project_directory",
    "organizations",
    "projects",
    "billing_epochs",
    "environments",
    "source_connections",
    "repository_grants",
    "deployment_plans",
    "build_source_uploads",
    "build_executions",
    "build_artifacts",
    "cloudflare_project_domains",
  ]) {
    const rows = (await source.prepare(`SELECT * FROM ${table}`).all()).results;
    // Operations precede all source/build/deployment parent facts. The source capture is already native-valid.
    if (table === "source_connections")
      for (const { row } of operationRecords) await put(target, "operations", row, true);
    for (const row of table === "environments" ? environmentRows : rows)
      await put(target, table, row, table === "environments");
  }
  await put(target, "project_r2_bucket_receipts", bucket);
}
async function put(db: D1Database, table: string, row: Record<string, unknown>, captured = false) {
  const columns = (await db.prepare(`PRAGMA table_info(${table})`).all()).results,
    names = Object.keys(row);
  await db
    .prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .bind(
      ...names.map((name) => {
        const v = row[name],
          type = columns.find((c) => c["name"] === name)?.["type"];
        return captured && type === "BLOB" && typeof v === "string"
          ? Uint8Array.from(Buffer.from(v, "hex"))
          : typeof v === "boolean"
            ? v
              ? 1
              : 0
            : v;
      }),
    )
    .run();
}
