import { afterAll, beforeAll, expect, it } from "vitest";
import {
  issueProductDatabaseAccess,
  readProductDatabaseAccess,
  readProductDatabaseAccessSweep,
  readProductAccessCreditAdmission,
  readDataChangeProductAccess,
} from "../../src/catalog/database/product-access.js";
import {
  acceptProductDatabaseWrite,
  finishProductDatabaseWrite,
  readExpiredProductDatabaseWrites,
  expireProductDatabaseWrites,
} from "../../src/catalog/database/product-writes.js";
import { createControlStore } from "../../src/store.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import {
  ulidOf,
  STORED_NOW,
  NOW,
  beforeFirstWrite,
  losingWriteResponses,
} from "../support/platform-fixtures.js";
import { makePaid } from "../support/credit-fixtures.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120000);
afterAll(async () => {
  await control?.dispose();
});
const fixture = () => seedProductRuntimeFixture(control);
function access(f: Awaited<ReturnType<typeof fixture>>, index = 0) {
  return {
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev" as const,
    mode: "read" as const,
    ttlSeconds: 3600,
    label: "access fixture",
    principalId: "user:fixture",
    now: NOW,
    roleSuffix: String(index).padStart(8, "0"),
    accessId: ulidOf("access-runtime", f.n * 10 + index),
    auditEventId: ulidOf("access-audit", f.n * 10 + index),
  };
}
function write(f: Awaited<ReturnType<typeof fixture>>) {
  const id = (label: string) => ulidOf(label, f.n);
  return {
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev" as const,
    principalId: "user:fixture",
    requestId: "req",
    idempotencyKey: "write" + f.n,
    canonicalRequestDigest: "cc".repeat(32),
    operationId: id("write-runtime"),
    queuedEventId: id("write-queued"),
    startedEventId: id("write-started"),
    startedAuditEventId: id("write-start-audit"),
    writeAuditEventId: id("write-audit"),
    now: NOW,
    operationEventId: id("write-completed"),
    auditEventId: id("write-complete-audit"),
    completionAuditEventId: id("write-done-audit"),
  };
}

it("admits database access with its financial grant and exact target, then closes it by revocation", async () => {
  const f = await fixture(),
    input = access(f),
    accepted = await issueProductDatabaseAccess(f.context, input);
  expect(accepted).toEqual({
    status: "accepted",
    access: {
      accessId: input.accessId,
      provider: "pgcf",
      databaseId: f.database,
      roleName: `ohmyho_da_${f.physical.toLowerCase()}_00000000`,
      memberRole: `ohmyho_ro_${f.physical.toLowerCase()}`,
      mode: "read",
      environment: "dev",
      environmentId: f.devEnvironmentId,
      dataEnvironmentId: f.physical,
      providerProjectId: f.provider,
      originHost: "fixture.pgcf.example",
      issuedAt: NOW,
      expiresAt: "2026-10-28T11:00:00.000Z",
      label: "access fixture",
    },
  });
  expect(
    (await readProductDatabaseAccessSweep(f.context, { now: NOW, limit: 50 })).active.some(
      (row) => row.accessId === input.accessId,
    ),
  ).toBe(true);
  expect(
    (
      await readProductAccessCreditAdmission(f.context, {
        organizationId: f.organizationId,
        projectId: f.projectId,
        environmentId: f.devEnvironmentId,
        now: NOW,
      })
    ).allowed,
  ).toBe(true);
  await expect(
    readDataChangeProductAccess(f.context, {
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.devEnvironmentId,
      operationId: ulidOf("missing-op", f.n),
      claimId: ulidOf("missing-claim", f.n),
      losingEnvironmentId: f.prodEnvironmentId,
    }),
  ).rejects.toThrow("scope");
  // Admission reads the credit account of the organization and writes none of it.
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM credit_log WHERE organization_id=?")
      .bind(f.organizationId)
      .first(),
  ).toEqual({ n: 0 });
  // The issuance read and the closed revocation are the store's own commands, as the product Worker calls them.
  const store = createControlStore(control.bindings).productDatabase;
  expect(
    await store.readAccessForIssuance({
      organizationId: f.organizationId,
      projectId: f.projectId,
      accessId: input.accessId,
      now: NOW,
    }),
  ).toBeTruthy();
  await store.recordAccessOperation({
    organizationId: f.organizationId,
    projectId: f.projectId,
    accessId: input.accessId,
    kind: "delete",
    operationId: "op_" + "a".repeat(20),
    revocation: {
      revokedAt: NOW,
      revokedBy: "user:fixture",
      reason: "principal",
      roleDropped: false,
      auditEventId: ulidOf("revoke", f.n),
    },
  });
  expect(
    (
      await readProductDatabaseAccess(f.context, {
        organizationId: f.organizationId,
        projectId: f.projectId,
        accessId: input.accessId,
        now: NOW,
      })
    )?.revocationReason,
  ).toBe("principal");
  expect(
    await store.readAccessForIssuance({
      organizationId: f.organizationId,
      projectId: f.projectId,
      accessId: input.accessId,
      now: NOW,
    }),
  ).toBeNull();
});

it("admits a database write and ends it with a terminal unknown receipt, replaying before any new execution", async () => {
  const f = await fixture(),
    input = write(f),
    accepted = await acceptProductDatabaseWrite(f.context, input);
  expect(accepted).toEqual({
    status: "accepted",
    result: {
      mode: "execute",
      receipt: {
        operation_id: input.operationId,
        environment: "dev",
        state: "running",
        command: null,
        affected_rows: null,
        error: null,
      },
      target: {
        provider: "pgcf",
        providerProjectId: f.provider,
        databaseId: f.database,
        dataEnvironmentId: f.physical,
        originHost: "fixture.pgcf.example",
        roleName: `ohmyho_rw_${f.physical.toLowerCase()}`,
        deadlineAt: "2026-10-28T10:01:00.000Z",
      },
    },
  });
  const end = {
    organizationId: f.organizationId,
    projectId: f.projectId,
    operationId: input.operationId,
    now: "2026-10-28T10:00:10.000Z",
    operationEventId: input.operationEventId,
    auditEventId: input.auditEventId,
    completionAuditEventId: input.completionAuditEventId,
    failureCode: "DATABASE_WRITE_OUTCOME_UNKNOWN" as const,
  };
  const source = {
    operation_id: input.operationId,
    environment: "dev",
    state: "failed",
    command: null,
    affected_rows: null,
    error: {
      code: "database_write_outcome_unknown",
      message: "The database write outcome could not be confirmed.",
      retryable: false,
      suggested_action:
        "Do not repeat the write with a new key. Inspect the target data with a read query and retain this operation ID. The same key only reads this receipt.",
    },
  };
  expect(await finishProductDatabaseWrite(f.context, end)).toEqual(source);
  expect(await acceptProductDatabaseWrite(f.context, input)).toEqual({
    status: "accepted",
    result: { mode: "observe", receipt: source },
  });
  expect(
    await acceptProductDatabaseWrite(f.context, {
      ...input,
      canonicalRequestDigest: "dd".repeat(32),
    }),
  ).toEqual({ status: "rejected", code: "idempotency" });
  expect(
    await finishProductDatabaseWrite(f.context, {
      ...end,
      command: "INSERT",
      affectedRows: 1,
      failureCode: undefined,
    }),
  ).toEqual(source);
  const stale = await fixture(),
    staleInput = write(stale);
  await acceptProductDatabaseWrite(stale.context, staleInput);
  expect(
    await acceptProductDatabaseWrite(stale.context, {
      ...staleInput,
      now: "2026-10-28T10:01:00.000Z",
    }),
  ).toMatchObject({
    status: "accepted",
    result: {
      mode: "observe",
      receipt: { state: "failed", error: { code: "database_write_outcome_unknown" } },
    },
  });
  const first = await fixture(),
    second = await fixture(),
    w1 = write(first),
    w2 = write(second);
  await acceptProductDatabaseWrite(first.context, w1);
  await acceptProductDatabaseWrite(second.context, w2);
  const sweep = { now: "2026-10-28T10:01:00.000Z", passId: ulidOf("expiry-pass", first.n) };
  // Older neon-management Workers still require the bounded deadline reader on their binding.
  expect(await readExpiredProductDatabaseWrites(first.context, { now: sweep.now })).toEqual(
    expect.arrayContaining([
      {
        organizationId: first.organizationId,
        projectId: first.projectId,
        operationId: w1.operationId,
      },
      {
        organizationId: second.organizationId,
        projectId: second.projectId,
        operationId: w2.operationId,
      },
    ]),
  );
  const late = {
    prepare: (sql: string) => control.core.prepare(sql),
    batch: (statements: import("../../src/d1-types.js").D1PreparedStatement[]) =>
      control.core.batch([
        ...statements,
        control.core.prepare("INSERT INTO guard_fail(code) VALUES('unregistered_expiry_test')"),
      ]),
  };
  await expect(
    expireProductDatabaseWrites(
      { directory: control.core, router: coreRouter(control, { CONTROL_SHARD_0000: late }) },
      sweep,
    ),
  ).rejects.toThrow();
  expect(
    (
      await control.core
        .prepare(
          "SELECT completed_at FROM project_database_writes WHERE operation_id IN(?1,?2) ORDER BY operation_id",
        )
        .bind(w1.operationId, w2.operationId)
        .all()
    ).results,
  ).toEqual([{ completed_at: null }, { completed_at: null }]);
  expect(await expireProductDatabaseWrites(first.context, sweep)).toBe(2);
  expect(await expireProductDatabaseWrites(first.context, sweep)).toBe(2);
  expect(
    await expireProductDatabaseWrites(first.context, {
      ...sweep,
      passId: ulidOf("expiry-empty-pass", first.n),
    }),
  ).toBe(0);
  expect(
    (
      await control.core
        .prepare(
          "SELECT DISTINCT completed_at,failure_code FROM project_database_writes WHERE operation_id IN(?1,?2)",
        )
        .bind(w1.operationId, w2.operationId)
        .all()
    ).results,
  ).toEqual([
    { completed_at: "2026-10-28T10:01:00.000000Z", failure_code: "DATABASE_WRITE_OUTCOME_UNKNOWN" },
  ]);
});

it("guards limit and current scope races and rolls all financial/operation writes back after a late audit collision", async () => {
  const f = await fixture();
  for (let n = 0; n < 3; n++)
    expect((await issueProductDatabaseAccess(f.context, access(f, n))).status).toBe("accepted");
  expect(await issueProductDatabaseAccess(f.context, access(f, 3))).toEqual({
    status: "rejected",
    code: "limit",
  });
  const next = await fixture(),
    input = write(next),
    db = control.core;
  await db
    .prepare(
      "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?1,?2,?3,NULL,?4,'Collision','service','test','{}',?5)",
    )
    .bind(
      next.organizationId,
      input.writeAuditEventId,
      next.projectId,
      next.billingEpochId,
      STORED_NOW,
    )
    .run();
  await expect(acceptProductDatabaseWrite(next.context, input)).rejects.toThrow();
  expect(
    await db
      .prepare("SELECT operation_id FROM project_database_writes WHERE organization_id=?")
      .bind(next.organizationId)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT organization_id FROM credit_log WHERE organization_id=?")
      .bind(next.organizationId)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT operation_id FROM operations WHERE operation_id=?")
      .bind(input.operationId)
      .first(),
  ).toBeNull();
  const race = await fixture(),
    raceDb = beforeFirstWrite(db, async () => {
      await db
        .prepare("UPDATE projects SET owner_state='security_frozen' WHERE project_id=?")
        .bind(race.projectId)
        .run();
    });
  const context = { directory: db, router: coreRouter(control, { CONTROL_SHARD_0000: raceDb }) };
  expect(await issueProductDatabaseAccess(context, access(race))).toEqual({
    status: "rejected",
    code: "scope",
  });
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("refuses a credential for an entitlement-suspended database without Paid coverage, before any access row", async () => {
  const f = await fixture(),
    input = access(f, 4);
  // The entitlement reconciler suspended this above-Free database for lack of Paid coverage.
  await control.core
    .prepare(
      "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at,suspended_by_entitlement,suspension_operation_id,suspension_generation) VALUES(?1,?2,?3,?4,?5,1,?6,1)",
    )
    .bind(f.organizationId, f.projectId, f.physical, f.database, STORED_NOW, "op_" + "a".repeat(20))
    .run();
  expect(await issueProductDatabaseAccess(f.context, input)).toEqual({
    status: "rejected",
    code: "paid_plan_required",
  });
  expect(
    await control.core
      .prepare(
        "SELECT count(*) n FROM project_database_access WHERE organization_id=?1 AND access_id=?2",
      )
      .bind(f.organizationId, input.accessId)
      .first(),
  ).toEqual({ n: 0 });
});

it("refuses a database write to an entitlement-suspended database without Paid coverage, before its operation is queued", async () => {
  const f = await fixture(),
    input = write(f);
  await control.core
    .prepare(
      "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at,suspended_by_entitlement,suspension_operation_id,suspension_generation) VALUES(?1,?2,?3,?4,?5,1,?6,1)",
    )
    .bind(f.organizationId, f.projectId, f.physical, f.database, STORED_NOW, "op_" + "b".repeat(20))
    .run();
  expect(await acceptProductDatabaseWrite(f.context, input)).toEqual({
    status: "rejected",
    code: "paid_plan_required",
  });
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM operations WHERE organization_id=?1 AND operation_id=?2")
      .bind(f.organizationId, input.operationId)
      .first(),
  ).toEqual({ n: 0 });
});

it("admits a Paid organization's suspended database, and refuses a lapsed one whose suspension is already dispatched, before any row", async () => {
  // Paid coverage is back: the reconciler resumes this database, so a credential is still issued for it.
  const paid = await fixture(),
    paidAccess = access(paid, 6);
  await makePaid(control.core, paid.organizationId);
  await control.core
    .prepare(
      "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at,suspended_by_entitlement,suspension_operation_id,suspension_generation) VALUES(?1,?2,?3,?4,?5,1,?6,1)",
    )
    .bind(
      paid.organizationId,
      paid.projectId,
      paid.physical,
      paid.database,
      STORED_NOW,
      "op_" + "e".repeat(20),
    )
    .run();
  expect((await issueProductDatabaseAccess(paid.context, paidAccess)).status).toBe("accepted");

  // The lapsed database holds an access, then the reconciler dispatches its suspension: the suspension is not yet
  // recorded in the policy, but the open action already keeps the database out of the roles and the credentials.
  const lapsed = await fixture(),
    lapsedAccess = access(lapsed, 7),
    refusedAccess = access(lapsed, 8),
    refusedWrite = write(lapsed);
  expect((await issueProductDatabaseAccess(lapsed.context, lapsedAccess)).status).toBe("accepted");
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at,suspended_by_entitlement,suspension_operation_id,suspension_generation) VALUES(?1,?2,?3,?4,?5,0,NULL,NULL)",
      )
      .bind(lapsed.organizationId, lapsed.projectId, lapsed.physical, lapsed.database, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO pgcf_database_entitlement_actions(action_id,organization_id,project_id,physical_environment_id,billing_epoch_id,target_version,provider_project_id,database_id,action,expected_generation,idempotency_key,state,claim_id,claim_expires_at,created_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,'suspend',1,?8,'dispatched',?9,?10,?10)",
      )
      .bind(
        ulidOf("entitlement-action", lapsed.n),
        lapsed.organizationId,
        lapsed.projectId,
        lapsed.physical,
        lapsed.billingEpochId,
        lapsed.provider,
        lapsed.database,
        "omh-entitlement-" + "d".repeat(64),
        ulidOf("entitlement-claim", lapsed.n),
        STORED_NOW,
      ),
  ]);
  expect(await issueProductDatabaseAccess(lapsed.context, refusedAccess)).toEqual({
    status: "rejected",
    code: "paid_plan_required",
  });
  expect(await acceptProductDatabaseWrite(lapsed.context, refusedWrite)).toEqual({
    status: "rejected",
    code: "paid_plan_required",
  });
  expect(
    (await readProductDatabaseAccessSweep(lapsed.context, { now: NOW, limit: 50 })).active.some(
      (row) => row.accessId === lapsedAccess.accessId,
    ),
  ).toBe(false);
});

it("leaves the roles of an entitlement-suspended database to the sweep that runs after its resume", async () => {
  const f = await fixture(),
    input = access(f, 5);
  expect((await issueProductDatabaseAccess(f.context, input)).status).toBe("accepted");
  const swept = async () =>
    (await readProductDatabaseAccessSweep(f.context, { now: NOW, limit: 50 })).active.some(
      (row) => row.accessId === input.accessId,
    );
  expect(await swept()).toBe(true);
  // The reconciler suspends the database: a role drop there would raise its generation and end the automatic resume.
  await control.core
    .prepare(
      "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at,suspended_by_entitlement,suspension_operation_id,suspension_generation) VALUES(?1,?2,?3,?4,?5,1,?6,1)",
    )
    .bind(f.organizationId, f.projectId, f.physical, f.database, STORED_NOW, "op_" + "c".repeat(20))
    .run();
  expect(await swept()).toBe(false);
  // Paid coverage returned and the reconciler resumed the database: the sweep takes the role again.
  await control.core
    .prepare(
      "UPDATE pgcf_database_entitlement_policies SET suspended_by_entitlement=0,suspension_operation_id=NULL,suspension_generation=NULL WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND database_id=?4",
    )
    .bind(f.organizationId, f.projectId, f.physical, f.database)
    .run();
  expect(await swept()).toBe(true);
});

it("answers the caller whose admission committed but lost its reply with the execute answer, once", async () => {
  const f = await fixture(),
    input = write(f),
    lossy = {
      directory: f.context.directory,
      router: coreRouter(control, { CONTROL_SHARD_0000: losingWriteResponses(control.core, 1) }),
    };
  // The admission batch commits, then its reply is lost: the caller must still run its own write.
  expect(await acceptProductDatabaseWrite(lossy, input)).toMatchObject({
    status: "accepted",
    result: {
      mode: "execute",
      receipt: { operation_id: input.operationId, state: "running" },
      target: {
        roleName: `ohmyho_rw_${f.physical.toLowerCase()}`,
        deadlineAt: "2026-10-28T10:01:00.000Z",
      },
    },
  });
  // A different operation with the same key observes the running write and never executes it again.
  expect(
    await acceptProductDatabaseWrite(f.context, {
      ...input,
      operationId: ulidOf("write-retry", f.n),
    }),
  ).toMatchObject({
    status: "accepted",
    result: { mode: "observe", receipt: { operation_id: input.operationId, state: "running" } },
  });
});
