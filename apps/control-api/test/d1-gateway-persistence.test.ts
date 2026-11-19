import { expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createGatewayRoutingHandlers } from "../src/gateway-routing.js";
import {
  beginD1RuntimeProbe,
  createD1GatewayPersistence,
  selectD1GatewayBindings,
} from "../src/d1-gateway-routing.js";

it("carries real Core Native routes through Control and rejects malformed Native authority", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control, {
      frameworkPlan: {
        ...sourceFrameworkPlan(false),
        auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
      },
    });
    const bindings = {
      DEV_ACCESS_SESSION_PUBLIC_JWK: "unused-for-prod",
      GATEWAY_LOOKUP_RUNTIME: r.store.gateway.lookup,
    };
    const handlers = createGatewayRoutingHandlers(bindings);
    const hostname = r.hostname;
    expect(await handlers.resolve({ hostname })).toMatchObject({
      nativeAuth: { region: "eu", realmGeneration: null, configurationRevision: null },
    });
    await control.core
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
      )
      .bind(r.scope.organizationId, r.scope.projectId, r.scope.environmentId, `https://${hostname}`)
      .run();
    const route = await r.store.gateway.lookup.resolve({ hostname });
    expect(await handlers.resolve({ hostname })).toMatchObject({
      nativeAuth: { region: "eu", realmGeneration: 1, configurationRevision: 1 },
    });
    for (const nativeAuth of [
      { region: "us", realmGeneration: 2147483647, configurationRevision: 2147483647 },
      { region: "eu", realmGeneration: null, configurationRevision: null },
    ]) {
      const persistence = createD1GatewayPersistence({
        GATEWAY_LOOKUP_RUNTIME: { resolve: async () => ({ ...route, nativeAuth }) },
      });
      expect(await persistence.resolve({ hostname })).toMatchObject({ nativeAuth });
    }
    for (const nativeAuth of [
      { region: "eu", realmGeneration: null, configurationRevision: 1 },
      { region: "eu", realmGeneration: 1, configurationRevision: null },
      { region: "eu", realmGeneration: 0, configurationRevision: 1 },
      { region: "eu", realmGeneration: 1, configurationRevision: 2147483648 },
      { region: "eu", realmGeneration: 1.5, configurationRevision: 1 },
      { region: "other", realmGeneration: 1, configurationRevision: 1 },
      { region: "eu", realmGeneration: 1, configurationRevision: 1, extra: true },
      null,
    ]) {
      const persistence = createD1GatewayPersistence({
        GATEWAY_LOOKUP_RUNTIME: { resolve: async () => ({ ...route, nativeAuth }) },
      });
      await expect(persistence.resolve({ hostname })).rejects.toThrow(
        "Gateway routing is unavailable",
      );
    }
  } finally {
    await control.dispose();
  }
}, 120000);

it("uses actual Core commands under actual API handlers for every Gateway capability; malformed remote replies cannot cross scope", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const bindings = {
      DEV_ACCESS_SESSION_PUBLIC_JWK: "unused-for-prod",
      GATEWAY_LOOKUP_RUNTIME: r.store.gateway.lookup,
      GATEWAY_MANAGEMENT_RUNTIME: r.store.gateway.management,
      RUNTIME_PROBE_RUNTIME: r.store.gateway.probe,
    };
    const handlers = createGatewayRoutingHandlers(bindings);
    expect(await handlers.resolve({ hostname: r.hostname })).toMatchObject({
      targetDeploymentId: r.published.deploymentId,
      devAccess: null,
    });
    expect(await handlers.resolve({ hostname: "absent.example.test" })).toBeNull();
    const a = await handlers.activate({
      ...r.activation,
      egressAllowedOrigins: ["https://a.example.test", "https://z.example.test"],
    });
    expect(a).toMatchObject({ revision: 2 });
    expect(await handlers.observe(r.scope)).toEqual(a);
    expect(await handlers.compensate({ ...r.mutation, expectedRevision: 2 })).toMatchObject({
      revision: 3,
    });
    expect(await handlers.remove({ ...r.mutation, expectedRevision: 3 })).toMatchObject({
      revision: 4,
    });
    const removal = {
      ...r.scope,
      operationId: r.accepted.operationId,
      claimId: r.accepted.claimId,
      candidateReceiptId: r.candidateReceiptId,
      productDeploymentId: r.deploymentId,
      scriptName: r.script,
      providerTag: r.providerTag,
    };
    await r.db.batch([
      r.db
        .prepare(
          "INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at) VALUES(?1,?2,?3,?4,?5,'failed','2026-10-28T10:00:00.000000Z')",
        )
        .bind(
          r.accepted.claimId,
          r.candidateReceiptId,
          r.scope.organizationId,
          r.scope.projectId,
          r.accepted.operationId,
        ),
      r.db
        .prepare(
          "INSERT INTO wfp_candidate_cleanup_claims(candidate_receipt_id,organization_id,project_id,claim_id,attempt_number,claimed_at,lease_expires_at) VALUES(?1,?2,?3,?4,1,'2026-10-28T10:00:00.000000Z','2099-01-01T00:00:00.000000Z')",
        )
        .bind(r.candidateReceiptId, r.scope.organizationId, r.scope.projectId, r.accepted.claimId),
    ]);
    expect(await handlers.authorizeCandidateRemoval(removal)).toEqual({ authorized: true });
    expect(
      await beginD1RuntimeProbe(bindings, {
        ...r.scope,
        deploymentId: r.deploymentId,
        windowId: newUlid(),
      }),
    ).toHaveProperty("expiresAt");
    const real = r.store.gateway.management;
    const wrongScope = {
      ...bindings,
      GATEWAY_MANAGEMENT_RUNTIME: {
        ...real,
        observe: async () => ({ ...a, projectId: newUlid() }),
      },
    };
    await expect(createD1GatewayPersistence(wrongScope).observe(r.scope)).rejects.toThrow(
      "Gateway routing is unavailable",
    );
    for (const value of [undefined, null, { observe: true }])
      await expect(
        createD1GatewayPersistence({ ...bindings, GATEWAY_MANAGEMENT_RUNTIME: value }).observe(
          r.scope,
        ),
      ).rejects.toThrow("unavailable");
    await expect(
      createD1GatewayPersistence({
        ...bindings,
        GATEWAY_LOOKUP_RUNTIME: { resolve: async () => ({ hostname: "bad" }) },
      }).resolve({ hostname: r.hostname }),
    ).rejects.toThrow("unavailable");
    await expect(
      beginD1RuntimeProbe(
        {
          ...bindings,
          RUNTIME_PROBE_RUNTIME: { beginProbe: async () => ({ expiresAt: "not-a-time" }) },
        },
        { ...r.scope, deploymentId: r.deploymentId, windowId: newUlid() },
      ),
    ).rejects.toThrow("unavailable");
    for (const raw of [null, "d1", { CONTROL_CORE: control.core }])
      expect(() => selectD1GatewayBindings(raw)).toThrow("unavailable");
  } finally {
    await control.dispose();
  }
}, 120000);

it("refuses a direct Core binding without reading it", () => {
  const credential = vi.fn(() => {
    throw new Error("Core binding getter must not be read");
  });
  for (const value of [
    { CONTROL_DIRECTORY: {} },
    Object.defineProperty({}, "CONTROL_CORE", { enumerable: true, get: credential }),
  ])
    expect(() => selectD1GatewayBindings(value)).toThrow("Gateway routing is unavailable");
  expect(credential).not.toHaveBeenCalled();
  const selected = { GATEWAY_CREDIT_RUNTIME: { read() {} } };
  expect(selectD1GatewayBindings(selected)).toBe(selected);
});
