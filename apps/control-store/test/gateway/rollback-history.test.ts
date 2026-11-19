import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { gatewayFixture } from "./gateway-fixture.js";
import { newUlid } from "../../src/catalog/common.js";

it("admits exact attested legacy rollback bytes only while unserved, retaining static/append-only rules and permanent activation lockout", async () => {
  const control = await createTestControl(2, { activated: false });
  try {
    const r = await gatewayFixture(control),
      db = r.db,
      at = "2026-10-28T10:00:00.123456Z",
      id = newUlid();
    await db
      .prepare(
        "UPDATE deployments SET kind='rollback',rollback_target_deployment_id=?,rollback_target_revision_id=? WHERE deployment_id=?",
      )
      .bind(r.published.deploymentId, r.published.revisionId, r.deploymentId)
      .run();
    const values = [
      id,
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
      r.accepted.operationId,
      r.deploymentId,
      r.published.deploymentId,
      r.published.revisionId,
      r.published.candidateReceiptId,
      r.published.wfpReceiptId,
      "retained-version",
      "retained-provider-deployment",
      at,
    ];
    const sql =
      "INSERT INTO wfp_rollback_activation_receipts(rollback_activation_receipt_id,organization_id,project_id,environment_id,operation_id,rollback_deployment_id,target_deployment_id,target_revision_id,candidate_receipt_id,wfp_receipt_id,gateway_version_id,gateway_deployment_id,activated_at) VALUES(" +
      values.map(() => "?").join(",") +
      ")";
    await expect(
      db
        .prepare(sql)
        .bind(...values)
        .run(),
    ).rejects.toThrow("exact target");
    const importId = "10000000-0000-4000-8000-000000000001";
    const open = (tables: unknown) =>
      db
        .prepare(
          "INSERT INTO core_historical_import(singleton,import_id,manifest_sha256,source_fingerprint_sha256,expected_runtime_schema_sha256,temporal_tables,started_at) VALUES(1,?,zeroblob(32),zeroblob(32),zeroblob(32),?,'2026-10-28T00:00:00.000000Z')",
        )
        .bind(importId, JSON.stringify(tables))
        .run();
    for (const tables of [
      ["shared_gateway_address_receipts"],
      ["wfp_rollback_activation_receipts", "wfp_rollback_activation_receipts"],
      ["wfp_rollback_activation_receipts_suffix"],
      [false],
    ])
      await expect(open(tables)).rejects.toThrow("closed exact table allowlist");
    await open([
      "wfp_candidate_receipts",
      "wfp_publish_receipts",
      "wfp_candidate_cleanup_receipts",
      "wfp_rollback_activation_receipts",
    ]);
    const corrupt = [...values];
    corrupt[7] = newUlid();
    await expect(
      db
        .prepare(sql)
        .bind(...corrupt)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
    const malformed = [...values];
    malformed[0] = "not-a-ulid";
    await expect(
      db
        .prepare(sql)
        .bind(...malformed)
        .run(),
    ).rejects.toThrow("CHECK");
    await db
      .prepare(sql)
      .bind(...values)
      .run();
    const before = await db
      .prepare(
        "SELECT * FROM wfp_rollback_activation_receipts WHERE rollback_activation_receipt_id=?",
      )
      .bind(id)
      .first();
    expect(before).toMatchObject({
      rollback_activation_receipt_id: id,
      activated_at: at,
      gateway_version_id: "retained-version",
      gateway_deployment_id: "retained-provider-deployment",
      activated_head_version: null,
      shared_gateway_revision: null,
      gateway_provider_tag: null,
      gateway_dev_access_public_key_sha256: null,
    });
    // A separate pre-v8 activation retains the complete original v7 gateway body and every digest byte.
    const fullId = newUlid(),
      fullOperation = newUlid();
    await db
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'succeeded',?4,?5,?5)",
      )
      .bind(r.scope.organizationId, fullOperation, r.scope.projectId, r.project.billingEpochId, at)
      .run();
    const script = `g-p-${r.scope.projectId.toLowerCase()}-prod`;
    const full = {
      rollback_activation_receipt_id: fullId,
      organization_id: r.scope.organizationId,
      project_id: r.scope.projectId,
      environment_id: r.scope.environmentId,
      operation_id: fullOperation,
      rollback_deployment_id: r.deploymentId,
      target_deployment_id: r.published.deploymentId,
      target_revision_id: r.published.revisionId,
      candidate_receipt_id: r.published.candidateReceiptId,
      wfp_receipt_id: r.published.wfpReceiptId,
      gateway_version_id: "retained-full-version",
      gateway_deployment_id: "retained-full-deployment",
      activated_at: at,
      activated_head_version: 7,
      gateway_contract_version: "ohmyhost.project-gateway/v7",
      gateway_script_name: script,
      gateway_workers_dev_subdomain: "fixture",
      gateway_internal_origin: `https://${script}.fixture.workers.dev`,
      gateway_public_origin: "https://" + r.hostname,
      gateway_provider_tag: new Uint8Array(32).fill(1),
      gateway_egress_policy_sha256: new Uint8Array(32).fill(2),
      gateway_dev_access_service: "ohmyho-dev-access-production",
      gateway_dev_access_entrypoint: "DevAccessService",
      gateway_dev_access_key_id: new Uint8Array(32).fill(3),
      gateway_dev_access_public_key_sha256: new Uint8Array(32).fill(3),
      gateway_module_sha256: new Uint8Array(32).fill(4),
      gateway_compatibility_date: "2026-10-12",
      gateway_observed_at: at,
      shared_gateway_revision: null,
    };
    await db
      .prepare(
        `INSERT INTO wfp_rollback_activation_receipts(${Object.keys(full).join(",")}) VALUES(${Object.keys(
          full,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .bind(...Object.values(full))
      .run();
    expect(
      await db
        .prepare(
          "SELECT lower(hex(gateway_provider_tag)) provider,lower(hex(gateway_egress_policy_sha256)) egress,lower(hex(gateway_dev_access_key_id)) key,lower(hex(gateway_dev_access_public_key_sha256)) public_key,lower(hex(gateway_module_sha256)) module,gateway_observed_at FROM wfp_rollback_activation_receipts WHERE rollback_activation_receipt_id=?",
        )
        .bind(fullId)
        .first(),
    ).toEqual({
      provider: "01".repeat(32),
      egress: "02".repeat(32),
      key: "03".repeat(32),
      public_key: "03".repeat(32),
      module: "04".repeat(32),
      gateway_observed_at: at,
    });
    await expect(
      db.prepare("UPDATE wfp_rollback_activation_receipts SET activated_at=activated_at").run(),
    ).rejects.toThrow("append-only");
    await expect(db.prepare("DELETE FROM wfp_rollback_activation_receipts").run()).rejects.toThrow(
      "append-only",
    );
    await db
      .prepare(
        "UPDATE core_historical_import SET closed_at='2026-10-29T00:00:00.000000Z',comparison_sha256=zeroblob(32),restored_runtime_schema_sha256=zeroblob(32)",
      )
      .run();
    const replay = [...values];
    replay[0] = newUlid();
    await expect(
      db
        .prepare(sql)
        .bind(...replay)
        .run(),
    ).rejects.toThrow("exact target");
    await db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256) VALUES(1,'20000000-0000-4000-8000-000000000001','2026-10-29T00:00:00.000000Z',?,zeroblob(32),zeroblob(32))",
      )
      .bind(importId)
      .run();
    await expect(open([])).rejects.toThrow("ever-activated");
    expect(
      await db
        .prepare(
          "SELECT * FROM wfp_rollback_activation_receipts WHERE rollback_activation_receipt_id=?",
        )
        .bind(id)
        .first(),
    ).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 120000);
