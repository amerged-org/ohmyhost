import { afterAll, beforeAll, expect, it } from "vitest";
import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import {
  acceptProductCompute,
  readProductComputeScope,
  replayProductCompute,
  readProductComputeJob,
  claimProductCompute,
  completeProductCompute,
  recordProductCompute,
  readProductComputeContext,
  readDueProductCompute,
  acknowledgeProductComputeOutbox,
  releaseProductComputeUse,
} from "../../src/catalog/database/product-compute.js";
import {
  reserveDatabaseProviderOperation as reserveCore,
  beginDatabaseProviderOperation as beginCore,
} from "../../src/catalog/database/provider-targets.js";
import { revokeMcpConsent } from "../../src/catalog/identity/mcp-delegations.js";
import { readProductDatabaseOperation } from "../../src/catalog/database/product-writes.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";
import { createTestControl, coreRouter, type TestControl } from "../support/control-d1.js";
import { exhaust, grantOneTime, makePaid } from "../support/credit-fixtures.js";
import { OVERRUN_CEILING_MICROS } from "../../src/catalog/credit/index.js";
import {
  NOW,
  ulidOf,
  losingWriteResponses,
  beforeFirstWrite,
} from "../support/platform-fixtures.js";
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120000);
afterAll(async () => {
  await control?.dispose();
});
async function fixture(paid = true) {
  const f = await seedProductRuntimeFixture(control);
  if (paid) {
    await makePaid(control.core, f.organizationId);
  }
  return f;
}
function accept(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    organizationId: f.organizationId,
    projectId: f.projectId,
    environmentId: f.devEnvironmentId,
    billingEpochId: f.billingEpochId,
    operationId: ulidOf("compute", f.n),
    operationEventId: ulidOf("compute-queued", f.n),
    auditEventId: ulidOf("compute-audit", f.n),
    outboxEventId: ulidOf("compute-outbox", f.n),
    principalId: "user:fixture",
    requestId: "compute",
    idempotencyKey: "compute-" + f.n,
    canonicalRequestDigest: "cc".repeat(32),
    httpMethod: "POST" as const,
    routeTemplate: "/v1/projects/{project_id}/database/compute",
    occurredAt: NOW,
    memoryMiB: 512,
    currentStorageMiB: 1024,
    expectedDatabaseId: f.database,
    expectedTargetVersion: 1,
    eventType: "ProjectDatabaseComputeChangeRequestedV1",
  };
}
function mutation(f: Awaited<ReturnType<typeof fixture>>, at = new Date().toISOString()) {
  return {
    organizationId: f.organizationId,
    projectId: f.projectId,
    operationId: ulidOf("compute", f.n),
    claimId: ulidOf("compute-claim", f.n),
    occurredAt: at,
    operationEventId: ulidOf("compute-start", f.n),
    auditEventId: ulidOf("compute-start-audit", f.n),
  };
}

it("accepts, claims and reserves a compute change and completes it with a confirmed provider operation on the real graph", async () => {
  const f = await fixture(),
    input = accept(f),
    scope = {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environment: "dev" as const,
    };
  expect(await readProductComputeScope(f.context, scope)).toMatchObject({
    physicalEnvironmentId: f.physical,
    target: { databaseId: f.database, targetVersion: 1 },
  });
  expect(await acceptProductCompute(f.context, input)).toEqual({
    outcome: "created",
    operationId: input.operationId,
  });
  expect(
    await replayProductCompute(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      canonicalRequestDigest: input.canonicalRequestDigest,
    }),
  ).toBe(input.operationId);
  const claim = mutation(f),
    claimed = await claimProductCompute(f.context, claim);
  expect(claimed).toEqual({
    operationId: input.operationId,
    organizationId: f.organizationId,
    projectId: f.projectId,
    environmentId: f.physical,
    physicalEnvironmentId: f.physical,
    billingEpochId: f.billingEpochId,
    providerProjectId: f.provider,
    databaseId: f.database,
    targetVersion: 1,
    memoryMiB: 512,
    sizeClassId: "r512-s1g",
    completedAt: null,
    claimId: claim.claimId,
    claimExpiresAt: new Date(Date.parse(claim.occurredAt) + 60_000).toISOString(),
    state: "running",
    mutationPermitted: true,
    providerDispatchStarted: false,
  });
  const reservation = {
      organizationId: claim.organizationId,
      projectId: claim.projectId,
      operationId: claim.operationId,
      claimId: claim.claimId,
      physicalEnvironmentId: f.physical,
      step: "database.resize",
      providerProjectId: f.provider,
      requestBody: { database_id: f.database, size_class_id: "r512-s1g" },
    },
    operation = await reserveCore(f.context, reservation);
  expect(operation).toEqual({
    ...reservation,
    idempotencyKey: expect.stringMatching(/^omh-[0-9a-f]{64}$/u),
    providerOperationId: null,
    databaseId: null,
    state: "reserved",
  });
  await beginCore(f.context, { operation, now: claim.occurredAt });
  const observation = {
      databaseId: f.database,
      providerOperationId: "op_" + "a".repeat(20),
      state: "succeeded" as const,
    },
    completion = {
      ...claim,
      physicalEnvironmentId: f.physical,
      success: true,
      operationEventId: ulidOf("compute-done", f.n),
      auditEventId: ulidOf("compute-done-audit", f.n),
    };
  await recordProductCompute(f.context, {
    record: { operation, observation, now: claim.occurredAt },
    completion,
  });
  expect(
    await readProductComputeJob(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      operationId: input.operationId,
    }),
  ).toMatchObject({
    state: "succeeded",
    completedAt: completion.occurredAt,
    claimId: null,
  });
  expect(
    await readProductComputeContext(f.context, { ...scope, now: new Date().toISOString() }),
  ).toMatchObject({
    effective: { memoryMiB: 512, sizeClassId: "r512-s1g" },
    selected: { operationId: input.operationId },
    pendingChange: null,
  });
  expect(
    await readProductDatabaseOperation(f.context, {
      organizationId: f.organizationId,
      operationId: input.operationId,
    }),
  ).toMatchObject({
    outcome: "ready",
    operation: { operationId: input.operationId, state: "succeeded" },
  });
  expect(await readDueProductCompute(f.context, { now: claim.occurredAt })).not.toContainEqual({
    organizationId: f.organizationId,
    projectId: f.projectId,
    operationId: input.operationId,
  });
  expect(
    await acknowledgeProductComputeOutbox(f.context, {
      now: claim.occurredAt,
      attemptId: ulidOf("compute-delivery", f.n),
    }),
  ).toBe(true);
});

it("refuses a Paid compute size at the month's overrun ceiling even inside the grace, and accepts it just below", async () => {
  const f = await fixture(true),
    input = accept(f);
  // Paid and inside the 7-day grace, with no balance; the month's overrun is at the ceiling.
  await exhaust(control.core, f.organizationId, "2026-10-27T10:00:00.000Z");
  const overrun = (overrunMicros: number) =>
    control.core
      .prepare(
        "UPDATE credit_account SET overrun_micros = ?2, overrun_base_micros = 0 WHERE organization_id = ?1",
      )
      .bind(f.organizationId, overrunMicros)
      .run();
  await overrun(OVERRUN_CEILING_MICROS);
  await expect(acceptProductCompute(f.context, input)).rejects.toThrow("compute_paid_required");
  await overrun(OVERRUN_CEILING_MICROS - 1);
  await acceptProductCompute(f.context, input);
});

it("preserves Paid/grace refusal, pending exclusion, changed idempotency and original current-owner lifecycle scope", async () => {
  const f = await fixture(false),
    input = accept(f);
  await expect(acceptProductCompute(f.context, input)).rejects.toThrow("compute_paid_required");
  await makePaid(control.core, f.organizationId);
  // Paid, but the credit ran out three weeks ago: the 7-day grace has lapsed.
  await exhaust(control.core, f.organizationId, "2026-10-01T00:00:00.000000Z");
  await expect(acceptProductCompute(f.context, input)).rejects.toThrow("compute_paid_required");
  await grantOneTime(control.core, f.organizationId, 50_000_000, `topup:refill-${f.n}`);
  await acceptProductCompute(f.context, input);
  await expect(
    acceptProductCompute(f.context, {
      ...input,
      operationId: ulidOf("parallel", f.n),
      idempotencyKey: "another",
    }),
  ).rejects.toThrow("compute_change_pending");
  await expect(
    replayProductCompute(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      canonicalRequestDigest: "dd".repeat(32),
    }),
  ).rejects.toThrow("idempotency_key_reused");
  await control.core
    .prepare("UPDATE projects SET owner_state='security_frozen' WHERE project_id=?")
    .bind(f.projectId)
    .run();
  expect(
    await readProductComputeJob(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      operationId: input.operationId,
    }),
  ).toBeNull();
});

it("retains resize identity across an expired claim and proves exact terminal replay after a lost Core completion response", async () => {
  const f = await fixture(),
    input = accept(f);
  await acceptProductCompute(f.context, input);
  const first = mutation(f);
  await claimProductCompute(f.context, first);
  const original = await reserveCore(f.context, {
    organizationId: first.organizationId,
    projectId: first.projectId,
    operationId: first.operationId,
    claimId: first.claimId,
    physicalEnvironmentId: f.physical,
    step: "database.resize",
    providerProjectId: f.provider,
    requestBody: { database_id: f.database, size_class_id: "r512-s1g" },
  });
  await control.core
    .prepare("UPDATE pgcf_database_compute_changes SET claim_expires_at=? WHERE operation_id=?")
    .bind(new Date(Date.now() - 61000).toISOString().replace("Z", "000Z"), input.operationId)
    .run();
  const next = { ...mutation(f), claimId: ulidOf("new-compute-claim", f.n) };
  await claimProductCompute(f.context, next);
  const operation = await reserveCore(f.context, {
    organizationId: next.organizationId,
    projectId: next.projectId,
    operationId: next.operationId,
    claimId: next.claimId,
    physicalEnvironmentId: f.physical,
    step: "database.resize",
    providerProjectId: f.provider,
    requestBody: { database_id: f.database, size_class_id: "r512-s1g" },
  });
  expect(operation.idempotencyKey).toBe(original.idempotencyKey);
  expect(operation.claimId).toBe(next.claimId);
  expect(
    await control.core
      .prepare("SELECT claim_id FROM database_provider_operations WHERE operation_id=?")
      .bind(input.operationId)
      .first(),
  ).toEqual({ claim_id: first.claimId });
  await beginCore(f.context, { operation, now: next.occurredAt });
  const completion = {
    ...next,
    physicalEnvironmentId: f.physical,
    success: false,
    failureCode: "DATABASE_COMPUTE_PLAN_CHANGED",
    operationEventId: ulidOf("failed-compute", f.n),
    auditEventId: ulidOf("failed-compute-audit", f.n),
  };
  const lossy = {
    directory: control.core,
    router: coreRouter(control, { CONTROL_SHARD_0000: losingWriteResponses(control.core, 1) }),
  };
  await completeProductCompute(lossy, completion);
  expect(
    await readProductComputeJob(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      operationId: input.operationId,
    }),
  ).toMatchObject({
    state: "failed",
    claimId: null,
  });
  expect(
    JSON.parse(
      (
        await control.core
          .prepare("SELECT failure FROM operations WHERE operation_id=?")
          .bind(input.operationId)
          .first<{ failure: string }>()
      )?.failure ?? "null",
    ),
  ).toEqual({
    code: "DATABASE_COMPUTE_PLAN_CHANGED",
    message: publicOperationFailure("DATABASE_COMPUTE_PLAN_CHANGED").message,
  });
  await expect(
    completeProductCompute(f.context, { ...completion, success: true }),
  ).rejects.toThrow();
  expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("refuses a resize of an entitlement-suspended database, and holds the dispatch of one accepted before the suspension", async () => {
  // The entitlement reconciler suspended the database: a resize would move PGCF's generation past the one its resume matches.
  const suspend = (f: Awaited<ReturnType<typeof fixture>>) =>
    control.core
      .prepare(
        "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,suspended_by_entitlement,suspension_operation_id,suspension_generation,last_checked_at) VALUES(?1,?2,?3,?4,1,'op_aaaaaaaaaaaaaaaaaaaa',1,'2026-10-28T10:00:00.000000Z')",
      )
      .bind(f.organizationId, f.projectId, f.physical, f.database)
      .run();
  const suspended = await fixture(true);
  await suspend(suspended);
  await expect(acceptProductCompute(suspended.context, accept(suspended))).rejects.toThrow(
    "compute_change_pending",
  );

  const accepted = await fixture(true);
  await acceptProductCompute(accepted.context, accept(accepted));
  await suspend(accepted);
  expect(await claimProductCompute(accepted.context, mutation(accepted))).toMatchObject({
    state: "running",
    mutationPermitted: false,
    providerDispatchStarted: false,
  });
});

it("pins delegated compute rights and refuses a provider dispatch after role loss", async () => {
  const f = await fixture();
  const grantId = crypto.randomUUID();
  const consentHash = "ab".repeat(32);
  const at = "2026-10-28T10:00:00.000000Z";
  await control.core.batch([
    control.core
      .prepare("UPDATE organizations SET beta_admitted_at=? WHERE organization_id=?")
      .bind(at, f.organizationId),
    control.core
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_compute','admin','active',1,?2,?3,'evt')",
      )
      .bind(f.organizationId, new Uint8Array(32), at),
    control.core
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_compute','owner',?3)",
      )
      .bind(f.organizationId, ulidOf("compute-owner", f.n), at),
    control.core
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at) VALUES(?1,?2,'user_compute','compute-client',?3,?4,1,?5,0,1,?6)",
      )
      .bind(f.organizationId, grantId, consentHash, f.projectId, f.billingEpochId, at),
  ]);
  const delegation = {
    grantId,
    clientId: "compute-client",
    consentHash,
    action: "projects:write" as const,
    authorizationRestriction: { projectIds: [f.projectId] },
  };
  const input = { ...accept(f), principalId: "user:user_compute", delegation };
  await expect(
    acceptProductCompute(f.context, {
      ...input,
      delegation: { ...delegation, authorizationRestriction: { actions: [] } },
    }),
  ).rejects.toMatchObject({ code: "operation_authorization_changed" });
  await acceptProductCompute(f.context, input);
  const claim = mutation(f);
  await claimProductCompute(f.context, claim);
  const operation = await reserveCore(f.context, {
    organizationId: claim.organizationId,
    projectId: claim.projectId,
    operationId: claim.operationId,
    claimId: claim.claimId,
    physicalEnvironmentId: f.physical,
    step: "database.resize",
    providerProjectId: f.provider,
    requestBody: { database_id: f.database, size_class_id: "r512-s1g" },
  });
  await control.core
    .prepare(
      "UPDATE organization_memberships SET role='reader' WHERE organization_id=? AND workos_user_id='user_compute'",
    )
    .bind(f.organizationId)
    .run();
  await expect(beginCore(f.context, { operation, now: claim.occurredAt })).rejects.toThrow();
  expect(
    await control.core
      .prepare("SELECT state FROM database_provider_operations WHERE operation_id=?")
      .bind(input.operationId)
      .first(),
  ).toEqual({ state: "reserved" });
  await control.core
    .prepare(
      "UPDATE organization_memberships SET role='admin' WHERE organization_id=? AND workos_user_id='user_compute'",
    )
    .bind(f.organizationId)
    .run();
  const racedDb = beforeFirstWrite(control.core, async () => {
    await control.core
      .prepare(
        "INSERT INTO mcp_connection_revocations(user_id,client_id,consent_hash,revoked_at) VALUES(?,?,?,?)",
      )
      .bind("user_compute", delegation.clientId, consentHash, "2026-10-28T10:00:00.000000Z")
      .run();
  });
  const racedContext = {
    directory: control.core,
    router: coreRouter(control, { CONTROL_SHARD_0000: racedDb }),
  };
  await expect(beginCore(racedContext, { operation, now: claim.occurredAt })).rejects.toThrow();
  expect(
    await control.core
      .prepare("SELECT 1 FROM compute_connection_provider_uses WHERE operation_id=?")
      .bind(input.operationId)
      .first(),
  ).toBeNull();
  // Reset this isolated fixture to exercise the separate admitted-before-disconnect ordering below.
  await control.core
    .prepare(
      "DELETE FROM mcp_connection_revocations WHERE user_id=? AND client_id=? AND consent_hash=?",
    )
    .bind("user_compute", delegation.clientId, consentHash)
    .run();
  await beginCore(f.context, { operation, now: claim.occurredAt });
  const revoke = {
    userId: "user_compute",
    clientId: delegation.clientId,
    consentHash,
    now: new Date().toISOString(),
  };
  expect(await revokeMcpConsent(f.context, revoke)).toEqual({ state: "pending" });
  await expect(beginCore(f.context, { operation, now: claim.occurredAt })).rejects.toThrow();
  expect(
    await releaseProductComputeUse(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      operationId: input.operationId,
      claimId: claim.claimId,
    }),
  ).toBe(true);
  expect(await revokeMcpConsent(f.context, revoke)).toEqual({ state: "revoked" });
});
