import { expect, it } from "vitest";
import { migrationsThrough, startTestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl } from "../support/control-d1.js";
import { newUlid } from "../../src/catalog/common.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { seedOriginalGateway } from "../gateway/pg-gateway.fixture.js";

it("preserves the actual original144 backfill representation when a rollback stage operation differs from candidate/route1", async () => {
  const [control, pg] = await Promise.all([
    createTestControl(2, { activated: false }),
    startTestPostgres(),
  ]);
  try {
    await pg.migrate("down", await migrationsThrough("144_shared_gateway_receipts"));
    const r = await gatewayFixture(control),
      p = r.project,
      at = "2026-10-28T10:00:00.123456Z";
    await seedOriginalGateway(pg, r, { legacyGateway: true });
    // Original144 requires a completed source run for the exact published candidate: the accepted deployment that
    // published it (copied to PostgreSQL with the rest of the accepted facts) is completed, not replaced by a fake parent.
    await pg.pool.query(
      "UPDATE product_workflow_runs SET state='completed',terminal_evidence=$1,updated_at=$2,completed_at=$2 WHERE organization_id=$3 AND operation_id=$4",
      [
        '{"runtimePolicy":{"egressAllowedOrigins":[]}}',
        at,
        p.organizationId,
        r.previous.operationId,
      ],
    );
    const stage = newUlid(),
      activation = newUlid(),
      lease = newUlid();
    const stageValues = [
      stage,
      p.organizationId,
      p.projectId,
      p.prodEnvironmentId,
      r.accepted.operationId,
      r.published.deploymentId,
      r.published.candidateReceiptId,
      lease,
      at,
    ];
    const stageSql =
      "INSERT INTO runtime_secret_delivery_stages(stage_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,candidate_receipt_id,lease_id,generation,release_sequence,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,staged_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,1,'rollback','retained-v7-tag','{}',decode(repeat('03',32),'hex'),0,$9)";
    await pg.pool.query(stageSql, stageValues);
    await pg.pool.query(
      "INSERT INTO runtime_secret_delivery_stage_activations(activation_receipt_id,stage_receipt_id,gateway_version_id,gateway_deployment_id,activated_at) VALUES($1,$2,'retained-v7-version','retained-v7-deployment',$3)",
      [activation, stage, at],
    );
    await pg.migrate("up", "144_shared_gateway_receipts");
    const sourceRow = (
      await pg.pool.query(
        "SELECT activation.*,to_char(activation.activated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') activated_at,stage.operation_id stage_operation,route.operation_id route_operation FROM runtime_secret_delivery_stage_activations activation JOIN runtime_secret_delivery_stages stage USING(stage_receipt_id) JOIN shared_gateway_route_revisions route ON route.organization_id=activation.organization_id AND route.project_id=activation.project_id AND route.environment_id=activation.environment_id AND route.revision=activation.shared_gateway_revision WHERE activation.activation_receipt_id=$1",
        [activation],
      )
    ).rows[0];
    expect(sourceRow).toMatchObject({
      shared_gateway_revision: "1",
      gateway_version_id: "retained-v7-version",
      gateway_deployment_id: "retained-v7-deployment",
      stage_operation: r.accepted.operationId,
      route_operation: r.previous.operationId,
    });
    // This is the migration's own historical representation; no source trigger/constraint was manually disabled.
    const db = control.core;
    await db
      .prepare(
        "INSERT INTO runtime_secret_delivery_stages(stage_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,candidate_receipt_id,lease_id,generation,release_sequence,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,1,'rollback','retained-v7-tag','[]',unhex(?9),0,?10)",
      )
      .bind(...stageValues.slice(0, 8), "03".repeat(32), at)
      .run();
    await db
      .prepare(
        "INSERT INTO core_historical_import(singleton,import_id,manifest_sha256,source_fingerprint_sha256,expected_runtime_schema_sha256,temporal_tables,started_at) VALUES(1,'10000000-0000-4000-8000-000000000001',zeroblob(32),zeroblob(32),zeroblob(32),'[\"runtime_secret_delivery_stage_activations\"]','2026-10-28T00:00:00.000000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO runtime_secret_delivery_stage_activations(activation_receipt_id,stage_receipt_id,gateway_version_id,gateway_deployment_id,activated_at,organization_id,project_id,environment_id,shared_gateway_revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1)",
      )
      .bind(
        activation,
        stage,
        sourceRow.gateway_version_id,
        sourceRow.gateway_deployment_id,
        sourceRow.activated_at,
        p.organizationId,
        p.projectId,
        p.prodEnvironmentId,
      )
      .run();
    const target = await db
      .prepare(
        "SELECT * FROM runtime_secret_delivery_stage_activations WHERE activation_receipt_id=?",
      )
      .bind(activation)
      .first();
    expect(target).toEqual({
      activation_receipt_id: activation,
      stage_receipt_id: stage,
      gateway_version_id: sourceRow.gateway_version_id,
      gateway_deployment_id: sourceRow.gateway_deployment_id,
      activated_at: at,
      organization_id: p.organizationId,
      project_id: p.projectId,
      environment_id: p.prodEnvironmentId,
      shared_gateway_revision: 1,
    });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await Promise.all([control.dispose(), pg.stop()]);
  }
}, 240000);
