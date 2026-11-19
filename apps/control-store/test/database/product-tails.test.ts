import { afterAll, beforeAll, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  issueProductDatabaseAccess,
  mutateProductDatabaseAccess,
  readDataChangeProductAccess,
  readProductAccessCreditAdmission,
  readProductDatabaseAccessSweep,
  readProductDatabaseAdmission,
  readProductDiagnosticTarget,
} from "../../src/catalog/database/product-access.js";
import { acceptProductDatabaseWrite } from "../../src/catalog/database/product-writes.js";
import {
  acceptProductCompute,
  claimProductCompute,
  completeProductCompute,
  readDueProductCompute,
} from "../../src/catalog/database/product-compute.js";
import { seedAcceptedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { runReserve, setProjectBudget } from "../../src/catalog/credit/index.js";
import { exhaust, grantOneTime, makePaid } from "../support/credit-fixtures.js";
import { NOW, seedProject, ulidOf } from "../support/platform-fixtures.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});

it("replays an issued access from its command log, sweeps expired and undropped roles and keeps the read-only target through a pending data change", async () => {
  const f = await seedProductRuntimeFixture(control);
  const issue = (index: number) => ({
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev" as const,
    mode: "read" as const,
    ttlSeconds: 3600,
    label: "tails",
    principalId: "user:fixture",
    now: NOW,
    roleSuffix: String(index).padStart(8, "0"),
    accessId: ulidOf("tail-access", f.n * 10 + index),
    auditEventId: ulidOf("tail-audit", f.n * 10 + index),
  });
  const [kept, revoked] = [issue(0), issue(1)];
  const accepted = await issueProductDatabaseAccess(f.context, kept);
  expect(accepted.status).toBe("accepted");
  // the committed command answers its own repetition without admitting a second access
  expect(await issueProductDatabaseAccess(f.context, kept)).toEqual(accepted);
  expect((await issueProductDatabaseAccess(f.context, revoked)).status).toBe("accepted");
  await mutateProductDatabaseAccess(f.context, {
    organizationId: f.organizationId,
    projectId: f.projectId,
    accessId: revoked.accessId,
    revokedAt: NOW,
    revokedBy: "user:fixture",
    reason: "principal",
    roleDropped: false,
    auditEventId: ulidOf("tail-revoke", f.n),
  });
  const sweep = await readProductDatabaseAccessSweep(f.context, {
    now: "2026-10-28T12:00:00.000Z",
    limit: 50,
  });
  expect(sweep.expired.map((row) => row.accessId)).toEqual([kept.accessId]);
  expect(sweep.undropped.map((row) => row.accessId)).toEqual([revoked.accessId]);
  expect(sweep.active).toEqual([]);

  // an accepted data change closes direct SQL admission and names the access it will revoke
  const change = await seedAcceptedOperation(f, f.devEnvironmentId, {
    eventType: "ProjectDataChangeRequestedV1",
  });
  expect(
    await readDataChangeProductAccess(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.devEnvironmentId,
      operationId: change.operationId,
      claimId: change.claimId,
      losingEnvironmentId: f.devEnvironmentId,
    }),
  ).toEqual([kept.accessId]);
  expect(await issueProductDatabaseAccess(f.context, issue(2))).toEqual({
    status: "rejected",
    code: "scope",
  });
  expect(
    await readProductDiagnosticTarget(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environment: "dev",
    }),
  ).toEqual({
    provider: "pgcf",
    providerProjectId: f.provider,
    databaseId: f.database,
    dataEnvironmentId: f.physical,
    originHost: "fixture.pgcf.example",
    roleName: `ohmyho_ro_${f.physical.toLowerCase()}`,
  });
  const bare = await seedProject(control);
  expect(
    await readProductDiagnosticTarget(f.context, {
      organizationId: bare.organizationId,
      projectId: bare.projectId,
      environment: "dev",
    }),
  ).toBeNull();
});

it("lists a due compute change and settles a claimed one as failed", async () => {
  const f = await seedProductRuntimeFixture(control);
  await makePaid(control.core, f.organizationId);
  const operationId = ulidOf("tail-compute", f.n);
  expect(
    await acceptProductCompute(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.devEnvironmentId,
      billingEpochId: f.billingEpochId,
      operationId,
      operationEventId: ulidOf("tail-compute-queued", f.n),
      auditEventId: ulidOf("tail-compute-audit", f.n),
      outboxEventId: ulidOf("tail-compute-outbox", f.n),
      principalId: "user:fixture",
      requestId: "tails",
      idempotencyKey: `tails-${f.n}`,
      canonicalRequestDigest: "cc".repeat(32),
      httpMethod: "POST" as const,
      routeTemplate: "/v1/projects/{project_id}/database/compute",
      occurredAt: NOW,
      memoryMiB: 512,
      currentStorageMiB: 1024,
      expectedDatabaseId: f.database,
      expectedTargetVersion: 1,
      eventType: "ProjectDatabaseComputeChangeRequestedV1",
    }),
  ).toEqual({ outcome: "created", operationId });
  const job = { organizationId: f.organizationId, projectId: f.projectId, operationId };
  expect(await readDueProductCompute(f.context, { now: NOW })).toContainEqual(job);

  const claim = {
    ...job,
    claimId: ulidOf("tail-compute-claim", f.n),
    occurredAt: "2026-10-28T10:00:05.000Z",
    operationEventId: ulidOf("tail-compute-start", f.n),
    auditEventId: ulidOf("tail-compute-start-audit", f.n),
  };
  await claimProductCompute(f.context, claim);
  expect(await readDueProductCompute(f.context, { now: NOW })).not.toContainEqual(job);
  expect(
    await completeProductCompute(f.context, {
      ...claim,
      occurredAt: "2026-10-28T10:00:10.000Z",
      physicalEnvironmentId: f.physical,
      success: false,
      failureCode: "DATABASE_COMPUTE_PLAN_CHANGED",
      operationEventId: ulidOf("tail-compute-done", f.n),
      auditEventId: ulidOf("tail-compute-done-audit", f.n),
    }),
  ).toBeUndefined();
  expect(
    await control.core
      .prepare(
        "SELECT j.completed_at,j.failure_code,j.claim_id,op.state FROM pgcf_database_compute_changes j JOIN operations op ON op.organization_id=j.organization_id AND op.operation_id=j.operation_id WHERE j.operation_id=?",
      )
      .bind(operationId)
      .first(),
  ).toEqual({
    completed_at: "2026-10-28T10:00:10.000000Z",
    failure_code: "DATABASE_COMPUTE_PLAN_CHANGED",
    claim_id: null,
    state: "failed",
  });
});

it("refuses database access and SQL writes when the credit ran out past its grace or a stop budget is reached", async () => {
  const f = await seedProductRuntimeFixture(control);
  const access = (index: number) => ({
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev" as const,
    mode: "read" as const,
    ttlSeconds: 3600,
    label: "refusal",
    principalId: "user:fixture",
    now: NOW,
    roleSuffix: String(index).padStart(8, "0"),
    accessId: ulidOf("refusal-access", f.n * 10 + index),
    auditEventId: ulidOf("refusal-audit", f.n * 10 + index),
  });
  const write = (index: number) => {
    const id = (label: string) => ulidOf(label, f.n * 10 + index);
    return {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environment: "dev" as const,
      principalId: "user:fixture",
      requestId: "refusal",
      idempotencyKey: `refusal-${f.n}-${index}`,
      canonicalRequestDigest: "cc".repeat(32),
      operationId: id("refusal-write"),
      queuedEventId: id("refusal-queued"),
      startedEventId: id("refusal-started"),
      startedAuditEventId: id("refusal-start-audit"),
      writeAuditEventId: id("refusal-write-audit"),
      now: NOW,
      operationEventId: id("refusal-completed"),
      auditEventId: id("refusal-complete-audit"),
      completionAuditEventId: id("refusal-done-audit"),
    };
  };
  const admitted = (environmentId = f.devEnvironmentId) =>
    readProductAccessCreditAdmission(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId,
      now: NOW,
    });
  expect(await admitted()).toMatchObject({ allowed: true, reason: null });
  const admission = (scope: { organizationId: string; projectId: string } = f) =>
    readProductDatabaseAdmission(f.context, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environment: "dev",
      now: NOW,
    });
  expect(await admission()).toEqual({ status: "admitted" });

  // The 7-day grace of an exhausted credit keeps the database serving; once it lapsed, access and writes are refused.
  await exhaust(control.core, f.organizationId, "2026-10-27T10:00:00.000000Z");
  expect((await issueProductDatabaseAccess(f.context, access(0))).status).toBe("accepted");
  await exhaust(control.core, f.organizationId, "2026-10-01T10:00:00.000000Z");
  expect(await admitted()).toMatchObject({
    allowed: false,
    reason: "insufficient_organization_credits",
  });
  expect(await admission()).toEqual({
    status: "rejected",
    code: "insufficient_organization_credits",
  });
  expect(await issueProductDatabaseAccess(f.context, access(1))).toEqual({
    status: "rejected",
    code: "insufficient_organization_credits",
  });
  expect(await acceptProductDatabaseWrite(f.context, write(1))).toEqual({
    status: "rejected",
    code: "insufficient_organization_credits",
  });
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM project_database_writes WHERE organization_id=?")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 0 });

  // New credit admits them again, a reached stop budget refuses them with its own reason.
  await grantOneTime(control.core, f.organizationId, 50_000_000, `topup:refusal-${f.n}`);
  expect(await admission()).toEqual({ status: "admitted" });
  expect((await issueProductDatabaseAccess(f.context, access(2))).status).toBe("accepted");
  expect((await acceptProductDatabaseWrite(f.context, write(2))).status).toBe("accepted");
  await control.core.batch(
    setProjectBudget(control.core, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      budgetMicros: 1_000_000,
      mode: "stop",
      now: NOW,
    }).statements,
  );
  await runReserve(control.core, {
    organizationId: f.organizationId,
    reservationId: ulidOf("refusal-hold", f.n),
    projectId: f.projectId,
    amountMicros: 2_000_000,
    now: NOW,
  });
  expect(await admitted()).toMatchObject({ allowed: false, reason: "project_budget_exceeded" });
  expect(await admission()).toEqual({ status: "rejected", code: "project_budget_exceeded" });
  // A scope that is not this organization's project answers as an absent scope, never with a budget code.
  const foreign = await seedProject(control);
  expect(
    await admission({ organizationId: f.organizationId, projectId: foreign.projectId }),
  ).toEqual({
    status: "rejected",
    code: "organization_credit_scope_missing",
  });
  expect(
    await admission({ organizationId: foreign.organizationId, projectId: f.projectId }),
  ).toEqual({
    status: "rejected",
    code: "organization_credit_scope_missing",
  });
  await expect(
    readProductDatabaseAdmission(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environment: "dev",
      now: NOW,
      extra: true,
    }),
  ).rejects.toThrow(ZodError);
  await expect(
    readProductDatabaseAdmission(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environment: "dev",
    }),
  ).rejects.toThrow(ZodError);
  expect(await issueProductDatabaseAccess(f.context, access(3))).toEqual({
    status: "rejected",
    code: "project_budget_exceeded",
  });
  expect(await acceptProductDatabaseWrite(f.context, write(3))).toEqual({
    status: "rejected",
    code: "project_budget_exceeded",
  });
});

it("gives every tenant its own share of the access sweep, so one tenant's undropped roles cannot push another tenant out of a pass", async () => {
  const noisy = await seedProductRuntimeFixture(control);
  const quiet = await seedProductRuntimeFixture(control);
  const revokedAccess = async (
    f: Awaited<ReturnType<typeof seedProductRuntimeFixture>>,
    index: number,
    revokedAt: string,
  ) => {
    const accessId = ulidOf("share-access", f.n * 100 + index);
    const accepted = await issueProductDatabaseAccess(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environment: "dev" as const,
      mode: "read" as const,
      ttlSeconds: 3600,
      label: "share",
      principalId: "user:fixture",
      now: NOW,
      roleSuffix: String(index).padStart(8, "0"),
      accessId,
      auditEventId: ulidOf("share-audit", f.n * 100 + index),
    });
    expect(accepted.status).toBe("accepted");
    await mutateProductDatabaseAccess(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      accessId,
      revokedAt,
      revokedBy: "user:fixture",
      reason: "principal",
      roleDropped: false,
      auditEventId: ulidOf("share-revoke", f.n * 100 + index),
    });
    return accessId;
  };
  // Eight undropped roles of one tenant were revoked before the other tenant's single role.
  for (let index = 0; index < 8; index += 1) await revokedAccess(noisy, index, NOW);
  const quietAccess = await revokedAccess(
    quiet,
    0,
    new Date(Date.parse(NOW) + 1_000).toISOString(),
  );

  const sweep = await readProductDatabaseAccessSweep(noisy.context, {
    now: "2026-10-28T12:00:00.000Z",
    limit: 5,
  });
  expect(sweep.undropped.map((row) => row.accessId)).toContain(quietAccess);
  // Earlier tests in this file leave their own undropped rows, so the pass is judged by this test's two tenants only.
  const ofThisTest = sweep.undropped.filter((row) =>
    [noisy.organizationId, quiet.organizationId].includes(row.organizationId),
  );
  expect(ofThisTest.map((row) => row.accessId)).toContain(quietAccess);
  expect(
    ofThisTest.filter((row) => row.organizationId === noisy.organizationId).length,
  ).toBeLessThan(8);
}, 120_000);
