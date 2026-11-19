import { afterAll, beforeAll, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createHash } from "node:crypto";
import type {
  PgcfEntitlementAction,
  PgcfEntitlementObservation,
} from "../../../../packages/database/src/pgcf-database-entitlements.js";
import {
  readProductEntitlementTargets,
  claimProductEntitlement,
  beginProductEntitlement,
  recordProductEntitlement,
  recordProductEntitlementCheckFailure,
  type ProductEntitlementScope,
} from "../../src/catalog/database/product-entitlements.js";
import { setPaid } from "../../src/catalog/credit/index.js";
import { createD1PgcfEntitlementPersistence } from "../../../neon-management/src/d1-pgcf-entitlements.js";
import { createPgcfEntitlementReconciler } from "../../../neon-management/src/pgcf-entitlements.js";
import {
  PgcfProviderError,
  PgcfProjectProvider,
  type PgcfDatabase,
  type PgcfOperation,
} from "../../../../packages/provider-pgcf/src/pgcf-provider.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import { exhaust, makePaid } from "../support/credit-fixtures.js";
import {
  seedProject,
  NOW,
  STORED_NOW,
  ulidOf,
  beforeFirstWrite,
} from "../support/platform-fixtures.js";
import type { D1Database } from "../../src/d1-types.js";
import type { CatalogContext } from "../../src/catalog/common.js";

let control: TestControl,
  seq = 8000;
const next = () => parseUlid(ulidOf("entitlement-test", seq++));
const providerProjectId = "prj_abcdefghijklmnopqrst",
  operationId = "op_abcdefghijklmnopqrst";
beforeAll(async () => {
  control = await createTestControl();
}, 240_000);
afterAll(async () => {
  await control?.dispose();
});
const context = (db: D1Database = control.core): CatalogContext => ({
  directory: db,
  router: coreRouter(control, { CONTROL_SHARD_0000: db }),
});
const query = (sql: string, ...args: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...args)
    .run();
async function fixture(free = false) {
  const p = await seedProject(control, { handle: `calm-otter-entitlement-${seq++}` }),
    s = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      physicalEnvironmentId: p.devEnvironmentId,
      providerProjectId,
      databaseId: "a" + String(seq++).padStart(19, "0"),
    };
  await query(
    "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
    s.organizationId,
    s.projectId,
    s.physicalEnvironmentId,
    STORED_NOW,
  );
  await query(
    "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev',?6,?7,?8,?9)",
    s.organizationId,
    s.projectId,
    s.physicalEnvironmentId,
    providerProjectId,
    s.databaseId,
    free ? "r256-s500m" : "r512-s1g",
    "ohmyho_rw_" + s.physicalEnvironmentId.toLowerCase(),
    "registry:" + s.physicalEnvironmentId,
    STORED_NOW,
  );
  await query(
    "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active',?4,?4)",
    s.organizationId,
    s.projectId,
    s.physicalEnvironmentId,
    STORED_NOW,
  );
  const observation: PgcfEntitlementObservation = {
    id: s.databaseId,
    projectId: providerProjectId,
    sizeClassId: free ? "r256-s500m" : "r512-s1g",
    resources: { memoryMiB: free ? 256 : 512, storageMiB: free ? 500 : 1024 },
    desiredState: "running",
    suspensionReason: null,
    generation: 1,
    observedGeneration: 1,
    observedState: "ready",
  };
  return {
    p,
    s,
    observation,
    async paid(enabled: boolean) {
      if (enabled) await makePaid(control.core, s.organizationId);
      else
        await control.core.batch(
          setPaid(control.core, {
            organizationId: s.organizationId,
            paidUntil: null,
            source: null,
            now: NOW,
          }).statements,
        );
    },
  };
}
async function claim(f: Awaited<ReturnType<typeof fixture>>, o = f.observation, now = NOW) {
  const input = { now, actionId: next(), claimId: next() };
  return claimProductEntitlement(context(), { scope: f.s, observation: o, input });
}
async function begin(j: PgcfEntitlementAction, o: PgcfEntitlementObservation, now = NOW) {
  return beginProductEntitlement(context(), { job: j, now, observation: o });
}
async function record(
  j: PgcfEntitlementAction,
  state: "pending" | "succeeded" | "failed" | "superseded",
  now = NOW,
  op: string | null = operationId,
  gen: number | null = 2,
) {
  const input = { now, providerOperationId: op, providerGeneration: gen, state };
  await recordProductEntitlement(context(), { job: j, input });
}
const action = (r: Awaited<ReturnType<typeof claim>>) => {
  if (r.status !== "action") throw new Error("expected action");
  return r.job;
};
type Decision = [
  action: string,
  state: string,
  expectedGeneration: number,
  providerOperationId: string | null,
  providerGeneration: number | null,
];
/** What the Core's entitlement policy and actions of one organization hold after the decisions so far. */
async function expectDecisions(
  f: Awaited<ReturnType<typeof fixture>>,
  policy: { suspended: boolean; generation: number | null; checkedAt: string } | null,
  actions: Decision[],
) {
  const query = (sql: string) => control.core.prepare(sql).bind(f.s.organizationId).all();
  expect(
    (
      await query(
        "SELECT suspended_by_entitlement,suspension_generation,last_checked_at FROM pgcf_database_entitlement_policies WHERE organization_id=?1",
      )
    ).results,
  ).toEqual(
    policy === null
      ? []
      : [
          {
            suspended_by_entitlement: policy.suspended ? 1 : 0,
            suspension_generation: policy.generation,
            last_checked_at: policy.checkedAt,
          },
        ],
  );
  const rows = (
    await query(
      "SELECT action,state,expected_generation,provider_operation_id,provider_generation,claim_id IS NOT NULL AS claimed FROM pgcf_database_entitlement_actions WHERE organization_id=?1 ORDER BY action_id",
    )
  ).results;
  expect(rows).toEqual(
    actions.map(([action, state, expectedGeneration, operation, generation]) => ({
      action,
      state,
      expected_generation: expectedGeneration,
      provider_operation_id: operation,
      provider_generation: generation,
      claimed: 1,
    })),
  );
}
const LATER = "2026-10-28T10:02:00.000000Z";

it("decides policy and action from the observation: provider identity, current claims and generation ownership", async () => {
  const f = await fixture();
  expect(await readProductEntitlementTargets(context(), { providerProjectId })).toEqual([f.s]);
  const suspend = action(await claim(f));
  expect(suspend.action).toBe("suspend");
  expect(await claim(f)).toEqual({ status: "waiting" });
  expect(await begin(suspend, f.observation)).toBe(true);
  await record(suspend, "pending");
  await expectDecisions(f, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "pending", 1, operationId, 2],
  ]);
  const later = "2026-10-28T10:02:00.000Z",
    pending = action(await claim(f, f.observation, later));
  expect(pending.actionId).toBe(suspend.actionId);
  expect(pending.idempotencyKey).toBe(suspend.idempotencyKey);
  expect(pending.providerOperationId).toBe(operationId);
  await expect(
    recordProductEntitlement(context(), {
      job: suspend,
      input: {
        now: later,
        providerOperationId: operationId,
        providerGeneration: 2,
        state: "succeeded",
      },
    }),
  ).rejects.toThrow("scope or action");
  expect(await begin(pending, f.observation, later)).toBe(true);
  await record(pending, "succeeded", later);
  await expectDecisions(f, { suspended: true, generation: 2, checkedAt: LATER }, [
    ["suspend", "succeeded", 1, operationId, 2],
  ]);
  await f.paid(true);
  const stopped = {
    ...f.observation,
    generation: 2,
    observedGeneration: 2,
    desiredState: "suspended" as const,
    suspensionReason: "manual" as const,
    observedState: "hibernated",
  };
  const resume = action(await claim(f, stopped, later));
  expect(resume.action).toBe("resume");
  const newer = { ...stopped, generation: 3, observedGeneration: 3 };
  expect(await begin(resume, newer, later)).toBe(false);
  await expectDecisions(f, { suspended: false, generation: null, checkedAt: LATER }, [
    ["suspend", "succeeded", 1, operationId, 2],
    ["resume", "cancelled", 2, null, null],
  ]);
  expect(await claim(f, newer, later)).toEqual({ status: "idle" });
  const micro = await fixture(),
    microInput = { now: "2026-10-28T10:00:00.123456Z", actionId: next(), claimId: next() };
  await expect(
    claimProductEntitlement(context(), {
      scope: micro.s,
      observation: micro.observation,
      input: microInput,
    }),
  ).rejects.toThrow("Invalid input");
  await expectDecisions(micro, null, []);
  const deleted = await fixture();
  await query(
    "UPDATE organizations SET state='deleted' WHERE organization_id=?1",
    deleted.s.organizationId,
  );
  expect(await claim(deleted)).toMatchObject({ status: "action" });
  await expectDecisions(deleted, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "reserved", 1, null, null],
  ]);
  const fresh = await fixture();
  const reserved = action(await claim(fresh));
  await fresh.paid(true);
  expect(await begin(reserved, fresh.observation)).toBe(false);
  await expectDecisions(fresh, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "cancelled", 1, null, null],
  ]);
  await fresh.paid(false);
  const second = action(await claim(fresh));
  await begin(second, fresh.observation);
  await record(second, "failed", NOW, null, null);
  await expectDecisions(fresh, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "cancelled", 1, null, null],
    ["suspend", "failed", 1, null, null],
  ]);
  const third = action(await claim(fresh));
  await begin(third, fresh.observation);
  await record(third, "superseded", NOW, null, null);
  await expectDecisions(fresh, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "cancelled", 1, null, null],
    ["suspend", "failed", 1, null, null],
    ["suspend", "superseded", 1, null, null],
  ]);
  const resumed = await fixture();
  const stopJob = action(await claim(resumed));
  await begin(stopJob, resumed.observation);
  await record(stopJob, "succeeded");
  await resumed.paid(true);
  const resumeJob = action(await claim(resumed, { ...stopped, id: resumed.s.databaseId }));
  await begin(resumeJob, { ...stopped, id: resumed.s.databaseId });
  await record(resumeJob, "succeeded", NOW, "op_aaaaaaaaaaaaaaaaaaaa", 3);
  await expectDecisions(resumed, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "succeeded", 1, operationId, 2],
    ["resume", "succeeded", 2, "op_aaaaaaaaaaaaaaaaaaaa", 3],
  ]);
}, 240_000);

/**
 * A queued export of the fixture's database: its recovery operation and job in the database's environment. The job's
 * sealed input expires one hour after the request, as the store writes it; the export holds the database awake until then.
 */
async function queueExport(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const exportOperation = next();
  await query(
    "INSERT INTO environment_data_assignments(organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at) VALUES(?1,?2,1,?3,?4,?5)",
    f.s.organizationId,
    f.s.physicalEnvironmentId,
    f.s.projectId,
    f.s.physicalEnvironmentId,
    STORED_NOW,
  );
  await query(
    "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?5,?5)",
    f.s.organizationId,
    exportOperation,
    f.s.projectId,
    f.p.billingEpochId,
    STORED_NOW,
  );
  await query(
    "INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket) VALUES(?1,?2,?3,?4,'2026-10-28T11:00:00.000000Z',?5,'ohmyho-development-backups')",
    f.s.organizationId,
    exportOperation,
    f.s.projectId,
    f.s.physicalEnvironmentId,
    STORED_NOW,
  );
  return exportOperation;
}
const finishExport = (exportOperation: string, state: "succeeded" | "failed") =>
  query(
    "UPDATE operations SET state=?2,updated_at=?3 WHERE operation_id=?1",
    exportOperation,
    state,
    LATER,
  );
/** The management clock form of a stored instant: claims and begins take milliseconds. */
const CLOCK_LATER = "2026-10-28T10:02:00.000Z";

it("holds a lapsed database awake while a queued export runs, resumes its entitlement suspension for it and suspends it again afterwards", async () => {
  const f = await fixture();
  // Paid has lapsed: the database is suspended by entitlement at generation 2.
  const suspend = action(await claim(f));
  expect(await begin(suspend, f.observation)).toBe(true);
  await record(suspend, "pending");
  const pending = action(await claim(f, f.observation, CLOCK_LATER));
  expect(await begin(pending, f.observation, CLOCK_LATER)).toBe(true);
  await record(pending, "succeeded", LATER);
  const stopped = {
    ...f.observation,
    generation: 2,
    observedGeneration: 2,
    desiredState: "suspended" as const,
    suspensionReason: "manual" as const,
    observedState: "hibernated",
  };
  const exportOperation = await queueExport(f);
  // The queued export is a reason to be awake: the owned suspension is resumed and nothing is suspended.
  const resume = action(await claim(f, stopped, CLOCK_LATER));
  expect(resume.action).toBe("resume");
  expect(await begin(resume, stopped, CLOCK_LATER)).toBe(true);
  await record(resume, "succeeded", LATER, "op_aaaaaaaaaaaaaaaaaaaa", 3);
  const running = {
    ...f.observation,
    generation: 3,
    observedGeneration: 3,
    desiredState: "running" as const,
    suspensionReason: null,
    observedState: "ready",
  };
  expect(await claim(f, running, CLOCK_LATER)).toEqual({ status: "idle" });
  await expectDecisions(f, { suspended: false, generation: null, checkedAt: LATER }, [
    ["suspend", "succeeded", 1, operationId, 2],
    ["resume", "succeeded", 2, "op_aaaaaaaaaaaaaaaaaaaa", 3],
  ]);
  // The export ends: the lapsed database is suspended again at the generation it was observed at.
  await finishExport(exportOperation, "succeeded");
  const again = action(await claim(f, running, "2026-10-28T10:04:00.000Z"));
  expect(again).toMatchObject({ action: "suspend", expectedGeneration: 3 });
}, 240_000);

it("cancels a suspension still waiting for dispatch while an export holds the database, and holds nothing once the export input expired", async () => {
  const f = await fixture();
  const reserved = action(await claim(f));
  expect(reserved.action).toBe("suspend");
  await queueExport(f);
  expect(await claim(f, f.observation, CLOCK_LATER)).toEqual({ status: "idle" });
  await expectDecisions(f, { suspended: false, generation: null, checkedAt: LATER }, [
    ["suspend", "cancelled", 1, null, null],
  ]);
  // The sealed input of the export expired at 11:00, so the same job can no longer run and holds nothing.
  expect(action(await claim(f, f.observation, "2026-10-28T11:30:00.000Z"))).toMatchObject({
    action: "suspend",
    expectedGeneration: 1,
  });
}, 240_000);

it("holds Free physical capacity, Paid exhaustion grace, scope fences and rolls back under races", async () => {
  const f = await fixture(true);
  expect(await claim(f)).toEqual({ status: "idle" });
  expect(
    await claim(f, { ...f.observation, resources: { memoryMiB: 256, storageMiB: 1024 } }),
  ).toMatchObject({ status: "action" });
  await expectDecisions(f, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "reserved", 1, null, null],
  ]);
  const paid = await fixture();
  await paid.paid(true);
  for (const exhaustedAt of ["2026-10-27T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]) {
    await exhaust(control.core, paid.s.organizationId, exhaustedAt.replace(".000Z", ".000000Z"));
    const r = await claim(paid);
    expect(r.status).toBe(exhaustedAt.includes("27") ? "idle" : "action");
  }
  await expectDecisions(paid, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "reserved", 1, null, null],
  ]);
  await expect(
    claimProductEntitlement(context(), {
      scope: { ...paid.s, organizationId: next() },
      observation: paid.observation,
      input: { now: NOW, actionId: next(), claimId: next() },
    }),
  ).rejects.toThrow("scope or action");
  const raced = await fixture();
  const wrapped = beforeFirstWrite(control.core, async () => {
    await query(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
      raced.s.organizationId,
      raced.s.projectId,
    );
  });
  await expect(
    claimProductEntitlement(context(wrapped), {
      scope: raced.s,
      observation: raced.observation,
      input: { now: NOW, actionId: next(), claimId: next() },
    }),
  ).rejects.toThrow("scope or action");
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM pgcf_database_entitlement_actions WHERE organization_id=?1")
      .bind(raced.s.organizationId)
      .first(),
  ).toEqual({ n: 0 });
  const inactive = await fixture();
  await query(
    "UPDATE database_provider_target_heads SET activated_at=NULL WHERE organization_id=?1 AND project_id=?2",
    inactive.s.organizationId,
    inactive.s.projectId,
  );
  expect(
    (await readProductEntitlementTargets(context(), { providerProjectId })).some(
      (s) => s.projectId === inactive.s.projectId,
    ),
  ).toBe(false);
  // A Free cancellation also fences pending-compute state: a concurrent resize must re-decide before returning.
  const computing = await fixture(),
    computeAction = action(await claim(computing)),
    computeId = next();
  await query(
    "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) SELECT organization_id,project_id,physical_environment_id,2,provider,provider_project_id,database_id,region_id,'r256-s500m',runtime_role,credential_reference,created_at FROM database_provider_target_revisions WHERE organization_id=?1 AND target_version=1",
    computing.s.organizationId,
  );
  await query(
    "UPDATE database_provider_target_heads SET target_version=2 WHERE organization_id=?1",
    computing.s.organizationId,
  );
  const freeObservation = {
    ...computing.observation,
    sizeClassId: "r256-s500m",
    resources: { memoryMiB: 256, storageMiB: 500 },
  };
  const operationValues = [
    computeId,
    computing.s.organizationId,
    computing.s.projectId,
    computing.p.billingEpochId,
    STORED_NOW,
  ];
  await query(
    "INSERT INTO operations(operation_id,organization_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
    ...operationValues,
  );
  const computeValues = [
    computeId,
    computing.s.organizationId,
    computing.s.projectId,
    computing.s.physicalEnvironmentId,
    computing.p.billingEpochId,
    providerProjectId,
    computing.s.databaseId,
    STORED_NOW,
  ];
  const computeSql =
    "INSERT INTO pgcf_database_compute_changes(operation_id,organization_id,project_id,environment_id,data_environment_id,billing_epoch_id,provider_project_id,database_id,target_version,memory_mib,size_class_id,accepted_lifecycle_version,requested_at) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,2,256,'r256-s500m',1,?8)";
  const computeRace = beforeFirstWrite(control.core, async () => {
    await query(computeSql, ...computeValues);
  });
  expect(
    await beginProductEntitlement(context(computeRace), {
      job: computeAction,
      now: NOW,
      observation: freeObservation,
    }),
  ).toBe(true);
  await expectDecisions(computing, { suspended: false, generation: null, checkedAt: STORED_NOW }, [
    ["suspend", "dispatched", 1, null, null],
  ]);
  const originalControl = control,
    missing = await createTestControl(2, { activated: false });
  try {
    control = missing;
    await expect(readProductEntitlementTargets(context(), { providerProjectId })).rejects.toThrow(
      "qualified immutable activation",
    );
  } finally {
    control = originalControl;
    await missing.dispose();
  }
  await providerLoop();
  const reserved = action(await claim(paid, paid.observation, "2026-10-28T10:02:00.000Z"));
  await expect(
    beginProductEntitlement(context(), {
      job: reserved,
      now: "2026-10-28T10:05:00.000Z",
      observation: paid.observation,
    }),
  ).rejects.toThrow("scope or action");
}, 240_000);

it("records the check time of a target whose provider read failed, so the targets behind it are reached next", async () => {
  const f = await fixture(true);
  const tick = Date.parse(NOW);
  const runtime = {
    readProductEntitlementTargets: (i: unknown) => readProductEntitlementTargets(context(), i),
    claimProductEntitlement: (i: unknown) => claimProductEntitlement(context(), i),
    beginProductEntitlement: (i: unknown) => beginProductEntitlement(context(), i),
    recordProductEntitlement: (i: unknown) => recordProductEntitlement(context(), i),
    recordProductEntitlementCheckFailure: (i: unknown) =>
      recordProductEntitlementCheckFailure(context(), i),
  };
  const persistence = createD1PgcfEntitlementPersistence(runtime),
    native = persistence.listTargets;
  persistence.listTargets = async (p) =>
    (await native(p)).filter((s) => s.projectId === f.s.projectId);
  const provider = {
    projectId: providerProjectId,
    readDatabase: async () => {
      throw new PgcfProviderError("transport", 503, true);
    },
  } as unknown as PgcfProjectProvider;
  const service = createPgcfEntitlementReconciler({
    persistence,
    provider,
    clock: { now: () => new Date(tick) },
    ids: { next },
  });
  expect(await service.reconcile()).toMatchObject({ failed: 1 });
  expect(
    await control.core
      .prepare(
        "SELECT last_checked_at FROM pgcf_database_entitlement_policies WHERE database_id = ?1",
      )
      .bind(f.s.databaseId)
      .first<{ last_checked_at: string }>(),
  ).toEqual({ last_checked_at: "2026-10-28T10:00:00.000000Z" });
});

const checkedAt = async (databaseId: string) =>
  (
    await control.core
      .prepare(
        "SELECT last_checked_at FROM pgcf_database_entitlement_policies WHERE database_id = ?1",
      )
      .bind(databaseId)
      .first<{ last_checked_at: string }>()
  )?.last_checked_at ?? null;
const recordFailure = (scope: ProductEntitlementScope, now: string) =>
  recordProductEntitlementCheckFailure(context(), { scope, now });

it("records no check time for a database or provider project that is not the active PGCF target of the scope", async () => {
  const f = await fixture(true);
  const unknownDatabase = "z".padEnd(20, "0");
  await expect(recordFailure({ ...f.s, databaseId: unknownDatabase }, NOW)).rejects.toThrow(
    "scope or action",
  );
  await expect(
    recordFailure({ ...f.s, providerProjectId: "prj_zzzzzzzzzzzzzzzzzzzz" }, NOW),
  ).rejects.toThrow("scope or action");
  expect(await checkedAt(unknownDatabase)).toBeNull();
  expect(await checkedAt(f.s.databaseId)).toBeNull();
});

it("never moves a recorded check time backwards", async () => {
  const f = await fixture(true);
  await recordFailure(f.s, NOW);
  await recordFailure(f.s, "2026-10-28T09:00:00.000Z");
  expect(await checkedAt(f.s.databaseId)).toBe(STORED_NOW);
  await recordFailure(f.s, "2026-10-28T11:00:00.000Z");
  expect(await checkedAt(f.s.databaseId)).toBe("2026-10-28T11:00:00.000000Z");
});

it("writes no check time for an organization whose bucket is fenced", async () => {
  const f = await fixture(true);
  await recordFailure(f.s, NOW);
  const bucket = (
    await control.core
      .prepare("SELECT bucket FROM organizations WHERE organization_id = ?1")
      .bind(f.s.organizationId)
      .first<{ bucket: number }>()
  )?.bucket;
  await query(
    "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?1,'moving',?2,'2026-10-28T12:00:00.000000Z')",
    bucket,
    next(),
  );
  try {
    await expect(recordFailure(f.s, "2026-10-28T11:00:00.000Z")).rejects.toThrow("fenced");
    expect(await checkedAt(f.s.databaseId)).toBe(STORED_NOW);
  } finally {
    await query("DELETE FROM bucket_fences WHERE bucket = ?1", bucket);
  }
});

it("reconciles cold resume activation under immutable Core generations and preserves a later manual pause", async () => {
  async function exercise(
    mode: "restore" | "archive-parent" | "operator-pause" | "failed-replaced",
  ) {
    const f = await fixture();
    const suspended = action(await claim(f));
    await begin(suspended, f.observation);
    await record(suspended, "succeeded");
    await f.paid(true);
    const runtime = {
      readProductEntitlementTargets: (i: unknown) => readProductEntitlementTargets(context(), i),
      claimProductEntitlement: (i: unknown) => claimProductEntitlement(context(), i),
      beginProductEntitlement: (i: unknown) => beginProductEntitlement(context(), i),
      recordProductEntitlement: (i: unknown) => recordProductEntitlement(context(), i),
      recordProductEntitlementCheckFailure: (i: unknown) =>
        recordProductEntitlementCheckFailure(context(), i),
    };
    const persistence = createD1PgcfEntitlementPersistence(runtime),
      list = persistence.listTargets;
    persistence.listTargets = async (id) =>
      (await list(id)).filter((target) => target.projectId === f.s.projectId);
    const providerOperation =
      mode === "archive-parent" ? "op_bbbbbbbbbbbbbbbbbbbb" : "op_aaaaaaaaaaaaaaaaaaaa";
    let tick = Date.parse(NOW),
      posts = 0;
    let database = {
      id: f.s.databaseId,
      project_id: providerProjectId,
      region_id: "us-dev",
      name: "cold-entitlement",
      size_class_id: "r512-s1g",
      resources: { memory_mib: 512, cpu_millicores: 250, storage_gib: 1 },
      desired_state: "suspended",
      suspension_reason: "manual" as string | null,
      observed_state: "hibernated",
      generation: 2,
      observed_generation: 2,
      effective_sleep_after_seconds: 300,
      storage_residency: "archived",
      storage_operation_id: "op_zzzzzzzzzzzzzzzzzzzz",
    };
    let observedOperation = {
      id: providerOperation,
      project_id: providerProjectId,
      database_id: f.s.databaseId,
      kind: mode === "archive-parent" ? "database.archive" : "database.rehydrate",
      status: "running",
      generation: mode === "archive-parent" ? 2 : 3,
      error: null as null | { code: string },
    };
    const provider = new PgcfProjectProvider({
      baseUrl: "https://pgcf.example.com",
      projectId: providerProjectId,
      apiKey: "test-integrator-secret-not-live",
      fetch: (async (url, init) => {
        if (init?.method === "POST") {
          posts++;
          expect(JSON.parse(String(init.body))).toEqual({ expected_generation: 2 });
          database = {
            ...database,
            desired_state: mode === "archive-parent" ? "suspended" : "running",
            suspension_reason: mode === "archive-parent" ? "manual" : null,
            storage_residency: mode === "archive-parent" ? "archiving" : "restoring",
            storage_operation_id: providerOperation,
          };
          return Response.json({ database, operation: observedOperation }, { status: 202 });
        }
        return Response.json(String(url).includes("/operations/") ? observedOperation : database);
      }) as typeof fetch,
    });
    const service = createPgcfEntitlementReconciler({
      persistence,
      provider,
      clock: { now: () => new Date(tick) },
      ids: { next },
    });
    expect(await service.reconcile()).toMatchObject({ waiting: 1, failed: 0 });
    const providerGeneration = mode === "archive-parent" ? 2 : 3;
    const readAction = () =>
      control.core
        .prepare(
          "SELECT state,provider_generation FROM pgcf_database_entitlement_actions WHERE organization_id=?1 AND action='resume'",
        )
        .bind(f.s.organizationId)
        .first<{ state: string; provider_generation: number }>();
    expect(await readAction()).toEqual({
      state: "pending",
      provider_generation: providerGeneration,
    });
    tick += 91_000;
    if (mode === "failed-replaced") {
      database = { ...database, storage_operation_id: "op_cccccccccccccccccccc" };
      observedOperation = {
        ...observedOperation,
        status: "failed",
        error: { code: "build_failed" },
      };
      expect(await service.reconcile()).toMatchObject({ failed: 1 });
      expect(await readAction()).toEqual({ state: "failed", provider_generation: 3 });
      tick += 91_000;
      expect(await service.reconcile()).toMatchObject({ unchanged: 1, failed: 0 });
      expect(posts).toBe(1);
      return;
    }
    if (mode !== "archive-parent") {
      database = { ...database, generation: 4, storage_residency: "restoring" };
      observedOperation = { ...observedOperation, generation: 4 };
      expect(await service.reconcile()).toMatchObject({ waiting: 1, failed: 0 });
      expect(await readAction()).toEqual({ state: "pending", provider_generation: 3 });
      tick += 91_000;
    }
    database = {
      ...database,
      generation: mode === "operator-pause" ? 5 : 4,
      observed_generation: mode === "operator-pause" ? 5 : 4,
      desired_state: mode === "operator-pause" ? "suspended" : "running",
      suspension_reason: mode === "operator-pause" ? "manual" : null,
      observed_state: mode === "operator-pause" ? "hibernated" : "ready",
      storage_residency: "local",
      storage_operation_id:
        mode === "archive-parent" ? "op_cccccccccccccccccccc" : providerOperation,
    };
    observedOperation = { ...observedOperation, status: "succeeded" };
    expect(await service.reconcile()).toMatchObject(
      mode === "operator-pause" ? { unchanged: 1, failed: 0 } : { accepted: 1, failed: 0 },
    );
    expect(await readAction()).toEqual({
      state: mode === "operator-pause" ? "superseded" : "succeeded",
      provider_generation: providerGeneration,
    });
    tick += 91_000;
    database = {
      ...database,
      generation: 5,
      observed_generation: 5,
      desired_state: "suspended",
      suspension_reason: "manual",
      observed_state: "hibernated",
    };
    expect(await service.reconcile()).toMatchObject({ unchanged: 1, failed: 0 });
    expect(posts).toBe(1);
  }
  await exercise("restore");
  await exercise("archive-parent");
  await exercise("operator-pause");
  await exercise("failed-replaced");
}, 240_000);

async function providerLoop() {
  const f = await fixture(),
    runtime = {
      readProductEntitlementTargets: (i: unknown) => readProductEntitlementTargets(context(), i),
      claimProductEntitlement: (i: unknown) => claimProductEntitlement(context(), i),
      beginProductEntitlement: (i: unknown) => beginProductEntitlement(context(), i),
      recordProductEntitlement: (i: unknown) => recordProductEntitlement(context(), i),
      recordProductEntitlementCheckFailure: (i: unknown) =>
        recordProductEntitlementCheckFailure(context(), i),
    };
  const persistence = createD1PgcfEntitlementPersistence(runtime),
    native = persistence.listTargets;
  persistence.listTargets = async (p) =>
    (await native(p)).filter((s) => s.projectId === f.s.projectId);
  let tick = Date.parse(NOW),
    drop = true,
    effects = 0;
  const keys: string[] = [],
    database = {
      ...f.observation,
      regionId: "us-dev",
      name: "entitlement",
      sleepAfterSeconds: 300,
      resources: { ...f.observation.resources, cpuMillicores: 250 },
    } as PgcfDatabase;
  const operation: PgcfOperation = {
    id: operationId,
    projectId: providerProjectId,
    databaseId: f.s.databaseId,
    kind: "database.suspend",
    generation: 2,
    status: "succeeded",
    errorCode: null,
  };
  const provider = {
    projectId: providerProjectId,
    readDatabase: async () => structuredClone(database),
    readOperation: async () => operation,
    changeDatabase: async (
      id: string,
      action: string,
      key: string,
      sizeClass: undefined,
      expectedGeneration: number,
    ) => {
      expect(id).toBe(f.s.databaseId);
      expect(action).toBe("suspend");
      expect(sizeClass).toBeUndefined();
      expect(expectedGeneration).toBe(1);
      keys.push(key);
      if (effects === 0) {
        effects++;
        Object.assign(database, {
          generation: 2,
          observedGeneration: 2,
          desiredState: "suspended",
          suspensionReason: "manual",
          observedState: "hibernated",
        });
      }
      if (drop) {
        drop = false;
        throw new PgcfProviderError("transport", 503, true);
      }
      return { database, operation };
    },
  } as unknown as PgcfProjectProvider;
  const service = createPgcfEntitlementReconciler({
    persistence,
    provider,
    clock: { now: () => new Date(tick) },
    ids: { next },
  });
  expect(await service.reconcile()).toMatchObject({ failed: 1 });
  expect(await service.reconcile()).toMatchObject({ waiting: 1 });
  tick += 91_000;
  expect(await service.reconcile()).toMatchObject({ accepted: 1 });
  expect(effects).toBe(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toBe(
    "omh-entitlement-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            ...Object.values(f.s),
            JSON.parse(
              JSON.stringify(
                await control.core
                  .prepare(
                    "SELECT action_id FROM pgcf_database_entitlement_actions WHERE organization_id=?1",
                  )
                  .bind(f.s.organizationId)
                  .first<{ action_id: string }>(),
              ),
            ).action_id,
            "suspend",
          ]),
        )
        .digest("hex"),
  );
}
