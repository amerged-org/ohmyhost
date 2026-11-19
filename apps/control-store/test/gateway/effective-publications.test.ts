import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { newUlid } from "../../src/catalog/common.js";
import { gatewayFixture } from "./gateway-fixture.js";

it("enforces the next-head rollback guards and resolves the effective rollback/address lookup, with immutable exact evidence", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    // What the lookup resolves for the rolled-back head: the published deployment, not the candidate.
    const resolved = (hostname: string, handle: string) => ({
      ...r.scope,
      environmentName: "prod",
      handle,
      hostname,
      publicOrigin: `https://${hostname}`,
      targetDeploymentId: r.published.deploymentId,
      targetScriptName: `p-${r.scope.projectId.toLowerCase()}-prod-${r.published.deploymentId.toLowerCase()}`,
      egressAllowedOrigins: [],
      poweredBy: false,
    });
    const op = newUlid(),
      deployment = newUlid(),
      receipt = newUlid(),
      at = "2026-10-29T00:00:00.000000Z";
    const insert = async (sql: string, args: unknown[]) => {
      await r.db
        .prepare(sql.replaceAll(/\$[0-9]+/g, "?"))
        .bind(...args)
        .run();
    };
    await insert(
      "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES($1,$2,$3,'running',$4,$5,$6)",
      [r.scope.organizationId, op, r.scope.projectId, r.project.billingEpochId, at, at],
    );
    await insert(
      "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,created_at,updated_at,rollback_target_deployment_id,rollback_target_revision_id) VALUES($1,$2,$3,$4,$5,'rollback','running',$6,$7,$8,$9)",
      [
        r.scope.organizationId,
        deployment,
        r.scope.projectId,
        r.scope.environmentId,
        op,
        at,
        at,
        r.published.deploymentId,
        r.published.revisionId,
      ],
    );
    const routeSql =
      "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) VALUES($1,$2,$3,2,1,$4,$5,'activate',true,$6,$7,'[]',$8)";
    await insert(routeSql, [
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
      op,
      r.published.candidateReceiptId,
      r.project.handle,
      "https://" + r.hostname,
      at,
    ]);
    const values = [
      receipt,
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
      op,
      deployment,
      r.published.deploymentId,
      r.published.revisionId,
      r.published.candidateReceiptId,
      r.published.wfpReceiptId,
      at,
      2,
      2,
    ];
    const sql =
      "INSERT INTO wfp_rollback_activation_receipts(rollback_activation_receipt_id,organization_id,project_id,environment_id,operation_id,rollback_deployment_id,target_deployment_id,target_revision_id,candidate_receipt_id,wfp_receipt_id,activated_at,activated_head_version,shared_gateway_revision) VALUES(" +
      values.map((_, i) => `$${i + 1}`).join(",") +
      ")";
    for (const [index, value] of [
      [11, 3],
      [12, 1],
      [8, r.candidateReceiptId],
      [10, "not-a-timestamp"],
    ] as const) {
      const args = [...values];
      args[index] = value;
      await expect(
        r.db
          .prepare(sql.replaceAll(/\$[0-9]+/g, "?"))
          .bind(...args)
          .run(),
      ).rejects.toThrow();
    }
    await insert(sql, values);
    await insert(
      "UPDATE environments SET head_version=2 WHERE organization_id=$1 AND environment_id=$2",
      [r.scope.organizationId, r.scope.environmentId],
    );
    expect(
      await r.db
        .prepare(
          "SELECT shared_gateway_revision FROM effective_wfp_publish_receipts WHERE wfp_receipt_id=?",
        )
        .bind(r.published.wfpReceiptId)
        .first(),
    ).toEqual({ shared_gateway_revision: 2 });
    // The rolled-back head keeps serving the published deployment under the original hostname.
    expect(await r.store.gateway.lookup.resolve({ hostname: r.hostname })).toEqual(
      resolved(r.hostname, r.project.handle),
    );
    const newHandle = "renamed-amber-studio",
      newHost = newHandle + ".check.omh.st";
    const addressOp = newUlid();
    await insert(
      "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES($1,$2,$3,'running',$4,$5,$6)",
      [r.scope.organizationId, addressOp, r.scope.projectId, r.project.billingEpochId, at, at],
    );
    await insert(
      "UPDATE operations SET state='succeeded' WHERE organization_id=$1 AND operation_id=$2",
      [r.scope.organizationId, r.accepted.operationId],
    );
    await insert(
      "DELETE FROM product_provider_mutation_claims WHERE organization_id=$1 AND project_id=$2",
      [r.scope.organizationId, r.scope.projectId],
    );
    const event = newUlid(),
      workflow = newUlid(),
      claim = newUlid();
    await insert(
      "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,expected_etag,requested_handle,created_at) VALUES($1,$2,$3,$4,$5,'ProjectHandleChangeRequestedV1','retained-etag',$6,$7)",
      [
        r.scope.organizationId,
        r.scope.projectId,
        r.scope.environmentId,
        addressOp,
        r.project.billingEpochId,
        newHandle,
        at,
      ],
    );
    await insert(
      "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,billing_epoch_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts) VALUES($1,$2,$3,$4,$5,'ProjectHandleChangeRequestedV1','{}',$6,$7,$8,3)",
      [
        r.scope.organizationId,
        event,
        r.scope.projectId,
        addressOp,
        r.project.billingEpochId,
        at,
        at,
        at,
      ],
    );
    await insert(
      "INSERT INTO product_workflow_runs(organization_id,operation_id,event_type,workflow_id,event_id,project_id,environment_id,billing_epoch_id,state,created_at,updated_at) VALUES($1,$2,'ProjectHandleChangeRequestedV1',$3,$4,$5,$6,$7,'queued',$8,$9)",
      [
        r.scope.organizationId,
        addressOp,
        workflow,
        event,
        r.scope.projectId,
        r.scope.environmentId,
        r.project.billingEpochId,
        at,
        at,
      ],
    );
    await insert(
      "INSERT INTO product_provider_mutation_claims(organization_id,project_id,claim_id,environment_id,operation_id,billing_epoch_id,event_id,logical_workflow_id,event_type,accepted_lifecycle_version,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ProjectHandleChangeRequestedV1',1,$9)",
      [
        r.scope.organizationId,
        r.scope.projectId,
        claim,
        r.scope.environmentId,
        addressOp,
        r.project.billingEpochId,
        event,
        workflow,
        at,
      ],
    );
    await insert(routeSql.replace("2,1", "3,2"), [
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
      addressOp,
      r.published.candidateReceiptId,
      newHandle,
      "https://" + newHost,
      at,
    ]);
    await insert(
      "UPDATE projects SET handle=$1,handle_version='customer-chosen-v1',handle_attempt=0 WHERE project_id=$2",
      [newHandle, r.scope.projectId],
    );
    await insert(
      "UPDATE cloudflare_project_domains SET handle=$1,production_domain=$2,development_domain=$3 WHERE project_id=$4",
      [newHandle, newHost, "dev-" + newHost, r.scope.projectId],
    );
    await insert(
      "INSERT INTO shared_gateway_address_receipts(organization_id,project_id,environment_id,operation_id,wfp_receipt_id,shared_gateway_revision,head_version,handle,public_origin,observed_at) VALUES($1,$2,$3,$4,$5,3,2,$6,$7,$8)",
      [
        r.scope.organizationId,
        r.scope.projectId,
        r.scope.environmentId,
        addressOp,
        r.published.wfpReceiptId,
        newHandle,
        "https://" + newHost,
        at,
      ],
    );
    expect(await r.store.gateway.lookup.resolve({ hostname: newHost })).toEqual(
      resolved(newHost, newHandle),
    );
    expect(
      await r.db
        .prepare(
          "SELECT shared_gateway_revision FROM effective_wfp_publish_receipts WHERE wfp_receipt_id=?",
        )
        .bind(r.published.wfpReceiptId)
        .first(),
    ).toEqual({ shared_gateway_revision: 3 });
    expect(await r.store.gateway.lookup.resolve({ hostname: r.hostname })).toBeNull();
    for (const table of ["wfp_rollback_activation_receipts", "shared_gateway_address_receipts"]) {
      await expect(r.db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow("append-only");
    }
  } finally {
    await control.dispose();
  }
}, 120000);
