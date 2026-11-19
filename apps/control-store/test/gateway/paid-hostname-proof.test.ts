import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { bytes, STORED_NOW } from "../support/platform-fixtures.js";
import { gatewayFixture } from "./gateway-fixture.js";

/** A Paid hostname that points at the shared gateway is answered only once its project proof is recorded. */
it("answers a Paid hostname on the shared gateway only while its ownership proof is recorded", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    await r.store.gateway.management.activate(r.activation);
    const hostname = "shop.gateway-proof.example";
    await control.core
      .prepare(
        `INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,
          apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,created_at,updated_at,provisioning_started_at)
         VALUES(?1,?2,?3,'ohmyho-gateway-production','active','user:owner',?4,?5,'{}','{}',?6,?6,?6)`,
      )
      .bind(
        r.scope.organizationId,
        r.scope.projectId,
        hostname,
        bytes(32, 7),
        bytes(32, 8),
        STORED_NOW,
      )
      .run();

    expect(await r.store.gateway.lookup.resolve({ hostname })).toBeNull();

    await control.core
      .prepare("UPDATE paid_project_domains SET hostname_proven_at=?1 WHERE hostname=?2")
      .bind(STORED_NOW, hostname)
      .run();
    expect(await r.store.gateway.lookup.resolve({ hostname })).toMatchObject({
      targetDeploymentId: r.published.deploymentId,
      hostname,
    });
  } finally {
    await control.dispose();
  }
}, 120_000);
