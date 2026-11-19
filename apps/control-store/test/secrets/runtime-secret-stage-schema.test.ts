import { expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { createTestControl } from "../support/control-d1.js";
import { newUlid } from "../../src/catalog/common.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";

it("guards stage target/lease/cardinality and live activation identity/terminal rules with all parents enabled", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    await r.store.gateway.management.activate(r.activation);
    const row = {
      stage_receipt_id: newUlid(),
      organization_id: r.scope.organizationId,
      project_id: r.scope.projectId,
      environment_id: r.scope.environmentId,
      operation_id: r.accepted.operationId,
      product_deployment_id: r.deploymentId,
      candidate_receipt_id: r.candidateReceiptId,
      lease_id: newUlid(),
      generation: 0,
      release_sequence: 1,
      trigger: "deploy",
      provider_tag: r.providerTag,
      applied_secret_names: [] as unknown[],
      manifest_sha256: Buffer.alloc(32, 3),
      manifest_secret_count: 0,
      staged_at: "2026-10-28T10:00:00.123456Z",
    };
    const insert = async (table: string, value: Record<string, unknown>) => {
      const keys = Object.keys(value),
        values = Object.values(value).map((v) => (Array.isArray(v) ? JSON.stringify(v) : v));
      return r.db
        .prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
        .bind(...values)
        .run();
    };
    for (const change of [
      { generation: -1 },
      { release_sequence: 0 },
      { trigger: "unknown" },
      { manifest_secret_count: 1 },
      { product_deployment_id: newUlid() },
      { environment_id: r.project.devEnvironmentId },
    ]) {
      await expect(
        insert("runtime_secret_delivery_stages", { ...row, ...change }),
      ).rejects.toThrow();
    }
    await insert("runtime_secret_delivery_stages", row);
    await expect(
      insert("runtime_secret_delivery_stages", { ...row, stage_receipt_id: newUlid() }),
    ).rejects.toThrow();
    const activation = {
      activation_receipt_id: newUlid(),
      stage_receipt_id: row.stage_receipt_id,
      organization_id: r.scope.organizationId,
      project_id: r.scope.projectId,
      environment_id: r.scope.environmentId,
      shared_gateway_revision: 2,
      activated_at: row.staged_at,
    };
    for (const change of [
      { shared_gateway_revision: 1 },
      { organization_id: newUlid() },
      { gateway_version_id: "legacy" },
    ])
      await expect(
        insert("runtime_secret_delivery_stage_activations", { ...activation, ...change }),
      ).rejects.toThrow();
    await insert("runtime_secret_delivery_stage_activations", activation);
    const compensation = {
      compensation_receipt_id: newUlid(),
      stage_receipt_id: row.stage_receipt_id,
      failure_code: "CANDIDATE_REMOVED",
      compensated_at: row.staged_at,
    };
    await expect(
      insert("runtime_secret_delivery_stage_compensations", compensation),
    ).rejects.toThrow();
    const another = {
      ...row,
      stage_receipt_id: newUlid(),
      lease_id: newUlid(),
      trigger: "rollback",
      operation_id: r.previous.operationId,
      applied_secret_names: ["A", "B"],
      manifest_secret_count: 2,
    };
    // The target FK permits rollback's operation to differ from its candidate's original operation.
    await insert("runtime_secret_delivery_stages", another);
    await insert("runtime_secret_delivery_stage_compensations", {
      ...compensation,
      compensation_receipt_id: newUlid(),
      stage_receipt_id: another.stage_receipt_id,
    });
    await expect(
      insert("runtime_secret_delivery_stage_activations", {
        ...activation,
        activation_receipt_id: newUlid(),
        stage_receipt_id: another.stage_receipt_id,
      }),
    ).rejects.toThrow();
    for (const table of [
      "runtime_secret_delivery_stages",
      "runtime_secret_delivery_stage_activations",
      "runtime_secret_delivery_stage_compensations",
    ])
      await expect(r.db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow("append-only");
    expect((await r.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 240000);

it("loads exact old nullable activation bytes only under the attested family while static FK/terminal guards never relax", async () => {
  const control = await createTestControl(2, { activated: false });
  try {
    const r = await gatewayFixture(control),
      db = r.db,
      stage = newUlid(),
      lease = newUlid(),
      activation = newUlid();
    await db
      .prepare(
        "INSERT INTO runtime_secret_delivery_stages(stage_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,candidate_receipt_id,lease_id,generation,release_sequence,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,1,'rollback','retained-tag','[]',zeroblob(32),0,'2026-10-28T10:00:00.123456Z')",
      )
      .bind(
        stage,
        r.scope.organizationId,
        r.scope.projectId,
        r.scope.environmentId,
        r.accepted.operationId,
        r.published.deploymentId,
        r.published.candidateReceiptId,
        lease,
      )
      .run();
    const sql =
      "INSERT INTO runtime_secret_delivery_stage_activations(activation_receipt_id,stage_receipt_id,gateway_version_id,gateway_deployment_id,activated_at) VALUES(?1,?2,'retained-original-version','retained-original-deployment','2026-10-28T10:00:00.123456Z')";
    await expect(db.prepare(sql).bind(activation, stage).run()).rejects.toThrow("exact current");
    const open = (tables: unknown) =>
      db
        .prepare(
          "INSERT INTO core_historical_import(singleton,import_id,manifest_sha256,source_fingerprint_sha256,expected_runtime_schema_sha256,temporal_tables,started_at) VALUES(1,'10000000-0000-4000-8000-000000000001',zeroblob(32),zeroblob(32),zeroblob(32),?,'2026-10-28T00:00:00.000000Z')",
        )
        .bind(JSON.stringify(tables))
        .run();
    await expect(
      open([
        "runtime_secret_delivery_stage_activations",
        "runtime_secret_delivery_stage_activations",
      ]),
    ).rejects.toThrow("closed exact");
    await expect(open(["runtime_secret_delivery_stages"])).rejects.toThrow("closed exact");
    await open([
      "wfp_candidate_receipts",
      "wfp_candidate_cleanup_receipts",
      "wfp_publish_receipts",
      "wfp_rollback_activation_receipts",
      "runtime_secret_delivery_stage_activations",
    ]);
    await expect(db.prepare(sql).bind(newUlid(), newUlid()).run()).rejects.toThrow("FOREIGN KEY");
    await db.prepare(sql).bind(activation, stage).run();
    const bytes = await db
      .prepare("SELECT * FROM runtime_secret_delivery_stage_activations")
      .first();
    expect(bytes).toMatchObject({
      activation_receipt_id: activation,
      stage_receipt_id: stage,
      gateway_version_id: "retained-original-version",
      gateway_deployment_id: "retained-original-deployment",
      activated_at: "2026-10-28T10:00:00.123456Z",
      organization_id: null,
      project_id: null,
      environment_id: null,
      shared_gateway_revision: null,
    });
    await expect(
      db
        .prepare(
          "INSERT INTO runtime_secret_delivery_stage_compensations VALUES(?1,?2,'CANDIDATE_REMOVED','2026-10-28T11:00:00.000000Z')",
        )
        .bind(newUlid(), stage)
        .run(),
    ).rejects.toThrow("cannot compensate");
    await db
      .prepare(
        "UPDATE core_historical_import SET closed_at='2026-10-29T00:00:00.000000Z',comparison_sha256=zeroblob(32),restored_runtime_schema_sha256=zeroblob(32)",
      )
      .run();
    expect(
      await db.prepare("SELECT * FROM runtime_secret_delivery_stage_activations").first(),
    ).toEqual(bytes);
  } finally {
    await control.dispose();
  }
}, 120000);
