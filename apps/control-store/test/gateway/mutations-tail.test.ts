import { expect, it } from "vitest";
import { planGatewayCompensation } from "../../src/catalog/gateway/mutations.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl } from "../support/control-d1.js";
import { gatewayFixture } from "./gateway-fixture.js";

it("plans the compensation of the current route for the caller's transaction and replays it once committed", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control),
      context = { directory: control.core, router: new SharedCoreRouter(control.core) },
      input = { ...r.mutation, expectedRevision: 2 };
    await r.store.gateway.management.activate(r.activation);
    const { db } = await context.router.routeOrganization(r.scope.organizationId);
    const plan = await planGatewayCompensation(context, input, db);
    expect(plan.statements.length).toBeGreaterThan(0);
    // nothing is written by planning; the caller commits the statements inside its own batch
    const latest = () =>
      control.core
        .prepare(
          "SELECT revision,action,public_origin FROM shared_gateway_route_revisions WHERE organization_id=? AND environment_id=? ORDER BY revision DESC LIMIT 1",
        )
        .bind(r.scope.organizationId, r.scope.environmentId)
        .first();
    expect(await latest()).toMatchObject({ revision: 2, action: "activate" });
    await db.batch(plan.statements);
    expect(await latest()).toEqual({
      revision: 3,
      action: "compensate",
      public_origin: plan.publicOrigin,
    });
    expect(await planGatewayCompensation(context, input, db)).toEqual({
      statements: [],
      publicOrigin: plan.publicOrigin,
    });
    await expect(
      planGatewayCompensation(context, { ...input, expectedRevision: 1 }, db),
    ).rejects.toThrow();
  } finally {
    await control.dispose();
  }
}, 120_000);
