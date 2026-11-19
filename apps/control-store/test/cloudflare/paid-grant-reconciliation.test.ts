import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { seedDeletionIntent, seedPublishedClaim } from "../support/accepted-operation.js";
import { connectGrant, scope, secret, sha, time } from "../support/cloudflare-fixtures.js";
import { cfFixture } from "../support/cf-mail-fixture.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";
import {
  losingWriteResponses,
  seedProject,
  STORED_NOW,
  type SeededProject,
} from "../support/platform-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control.dispose());

const apply = (p: SeededProject, overrides: Record<string, unknown> = {}) => ({
  ...scope(p),
  hostname: `${p.handle}.example.com`,
  gatewayScriptName: "ohmyho-gateway-production",
  principalId: "user:user_consent",
  idempotencyKeySha256: sha(0x71),
  requestSha256: sha(0x72),
  now: time(0),
  auditEventId: newUlid(),
  ...overrides,
});
const deleting = async (p: SeededProject) => {
  const operationId = newUlid();
  await p.shard.batch([
    p.shard
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId),
    p.shard
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(p.organizationId, operationId, p.projectId, p.billingEpochId, STORED_NOW),
  ]);
  await seedDeletionIntent(p, p.prodEnvironmentId, operationId);
  return operationId;
};

describe("paid domain", () => {
  it("connects a hostname once, activates it with the provider receipts, deletes it with a fenced key and keeps its name away from other projects", async () => {
    const owner = await cfFixture(control),
      p = owner.project,
      other = await seedProject(control),
      input = apply(p, { principalId: owner.principalId });
    expect(await store.cloudflareDomain.readPaidDomainRecord(scope(p))).toBeNull();

    // A reply lost after the commit is answered from the committed row.
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    expect(await flaky.cloudflareDomain.claimPaidDomainApply(input)).toMatchObject({
      hostname: input.hostname,
      state: "pending",
      gatewayRetarget: false,
    });
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(p, { requestSha256: sha(0x73) })),
    ).rejects.toMatchObject({ name: "PaidDomainKeyConflictError" });
    await expect(
      store.cloudflareDomain.claimPaidDomainApply(apply(other, { hostname: input.hostname })),
    ).rejects.toMatchObject({ name: "PaidDomainHostnameTakenError" });

    const active = {
      ...scope(p),
      hostname: input.hostname,
      gatewayScriptName: "ohmyho-gateway-production",
      idempotencyKeySha256: input.idempotencyKeySha256,
      requestSha256: input.requestSha256,
      customHostnameReceipt: { id: "custom" },
      workerRouteReceipt: { id: "route" },
      now: time(1),
    };
    await expect(
      store.cloudflareDomain.putPaidDomainActive({ ...active, hostname: `x.${input.hostname}` }),
    ).rejects.toThrow();
    expect(await store.cloudflareDomain.putPaidDomainActive(active)).toMatchObject({
      state: "active",
      customHostnameReceipt: { id: "custom" },
      workerRouteReceipt: { id: "route" },
    });

    const remove = {
      ...scope(p),
      hostname: input.hostname,
      principalId: owner.principalId,
      idempotencyKeySha256: sha(0x74),
      requestSha256: sha(0x75),
      now: time(2),
    };
    expect(await store.cloudflareDomain.claimPaidDomainDelete(remove)).toMatchObject({
      state: "deleting",
    });
    expect(await store.cloudflareDomain.claimPaidDomainDelete(remove)).toMatchObject({
      state: "deleting",
    });
    await expect(
      store.cloudflareDomain.claimPaidDomainDelete({ ...remove, requestSha256: sha(0x76) }),
    ).rejects.toMatchObject({ name: "PaidDomainKeyConflictError" });
    await store.cloudflareDomain.markPaidDomainDeleted({
      ...scope(p),
      hostname: input.hostname,
      idempotencyKeySha256: remove.idempotencyKeySha256,
      now: time(3),
    });
    expect(await store.cloudflareDomain.readPaidDomainRecord(scope(p))).toMatchObject({
      state: "deleted",
    });
  });

  it("closes the paid domain of a deleting project, and answers the production gateway only for a published deployment", async () => {
    const p = await seedProject(control);
    expect(await store.cloudflareDomain.readPaidDomainTarget(scope(p))).toBe(
      "production_deployment_required",
    );
    await seedPublishedClaim(p, p.prodEnvironmentId, (operationId) =>
      seedWfpPublication(p, { operationId }),
    );
    expect(await store.cloudflareDomain.readPaidDomainTarget(scope(p))).toEqual({
      gatewayScriptName: "ohmyho-gateway-production",
    });

    const doomed = await seedProject(control);
    await store.cloudflareDomain.claimPaidDomainApply(apply(doomed, { gatewayScriptName: null }));
    const operationId = await deleting(doomed);
    expect(
      await store.cloudflareDomain.claimPaidProjectDeletion({
        ...scope(doomed),
        operationId,
        now: time(4),
      }),
    ).toMatchObject({ state: "deleting" });
    await expect(
      store.cloudflareDomain.claimPaidProjectDeletion({
        ...scope(doomed),
        operationId: newUlid(),
        now: time(4),
      }),
    ).rejects.toThrow();
  });
});

describe("grant use and reconciliation", () => {
  it("excludes a second use of the grant until the first is released, and rotates the grant only from the version it read", async () => {
    const p = await seedProject(control),
      { authorizationId } = await connectGrant(control, store, p),
      first = { ...scope(p), useId: newUlid(), now: time(10) };
    expect(await store.cloudflareDomain.claimGrantUse(first)).toMatchObject({ status: "claimed" });
    await expect(
      store.cloudflareDomain.claimGrantUse({ ...first, useId: newUlid() }),
    ).rejects.toMatchObject({ code: "store_busy" });
    await store.cloudflareDomain.releaseGrantUse(first);
    expect(
      await store.cloudflareDomain.claimGrantUse({ ...first, useId: newUlid() }),
    ).toMatchObject({ status: "claimed" });

    const grant = await store.cloudflareDomain.readGrant(scope(p));
    const rotation = {
      ...scope(p),
      authorizationId,
      expectedUpdatedAt: grant && "updatedAt" in grant ? grant.updatedAt : undefined,
      ...secret(9),
      accessExpiresAt: time(58),
      rotatedAt: time(11),
    };
    expect(await store.cloudflareDomain.rotateGrant(rotation)).toMatchObject({
      authorizationId,
      updatedAt: `${time(11).slice(0, 23)}000Z`,
    });
    expect(await store.cloudflareDomain.rotateGrant(rotation)).toBeNull();
  });

  it("reads the domains for an accepted candidate deployment and nothing for anything else", async () => {
    const p = await seedProject(control),
      { claim, published } = await seedPublishedClaim(p, p.prodEnvironmentId, (operationId) =>
        seedWfpPublication(p, { operationId }),
      );
    await p.shard
      .prepare("UPDATE deployments SET status='running' WHERE deployment_id=?1")
      .bind(published.deploymentId)
      .run();
    const reconcile = {
      ...scope(p),
      environmentId: p.prodEnvironmentId,
      operationId: claim.operationId,
      deploymentId: published.deploymentId,
      environmentName: "prod",
      gatewayScriptName: "ohmyho-gateway-production",
      healthCheckPath: "/",
    };
    expect(await store.cloudflareDomain.readReconciliation(reconcile)).toMatchObject({
      domains: { handle: p.handle },
    });
    expect(
      await store.cloudflareDomain.readReconciliation({
        ...reconcile,
        healthCheckPath: "/other",
      }),
    ).toBeNull();
  });
});
