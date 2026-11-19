import type { ProjectDataChangeKind } from "@ohmyhost/database";
import { expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { runtimeRoleOf } from "../../src/catalog/database/contracts.js";
import {
  parseProjectDataChangeSnapshot,
  planProjectDataChangeTransition,
} from "../../src/catalog/provisioning/context-snapshots.js";
import {
  dataChangeAcceptanceStatements,
  dataChangeInventoryRecord,
  dataChangeInventoryStatements,
  readCurrentDataAssignments,
  readDataChangeInventoryPlan,
} from "../../src/catalog/provisioning/project-data-change.js";
import { createControlStore } from "../../src/store.js";
import { seedAcceptedOperation, seedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  STORED_NOW,
  beforeFirstWrite,
  losingWriteResponses,
  seedProject,
} from "../support/platform-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

const NOW = "2026-10-28T10:30:00.000Z";

/** A project with its dev and prod data assignments at version 1, shared (one data environment) or isolated. */
async function dataProject(control: TestControl, mode: "shared" | "isolated") {
  const project = await seedProject(control);
  const dev = newUlid();
  const prod = mode === "shared" ? dev : newUlid();
  const db = control.core;
  const environment = (id: string) =>
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(project.organizationId, project.projectId, id, STORED_NOW);
  const assignment = (environmentId: string, dataEnvironmentId: string) =>
    db
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,1,?5)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        environmentId,
        dataEnvironmentId,
        STORED_NOW,
      );
  await db.batch([
    ...[...new Set([dev, prod])].map(environment),
    assignment(project.devEnvironmentId, dev),
    assignment(project.prodEnvironmentId, prod),
    ...(mode === "isolated"
      ? [
          db
            .prepare("UPDATE projects SET data_mode='isolated' WHERE organization_id=?1")
            .bind(project.organizationId),
        ]
      : []),
  ]);
  const scope = { organizationId: project.organizationId, projectId: project.projectId };
  return { control, project, scope, dev, prod };
}
type Data = Awaited<ReturnType<typeof dataProject>>;

/** The frozen plan the acceptance stores: the transition over the current assignments, heads and registrations. */
async function snapshotOf(d: Data, change: ProjectDataChangeKind) {
  const before = await readCurrentDataAssignments(d.control.core, d.scope);
  if (before === null) throw new Error("fixture has no assignments");
  const heads = await d.control.core
    .prepare("SELECT environment_id,head_version FROM environments WHERE project_id=?1")
    .bind(d.project.projectId)
    .all<{ environment_id: string; head_version: number }>();
  return parseProjectDataChangeSnapshot({
    transition: planProjectDataChangeTransition({
      change,
      assignments: before,
      newDataEnvironmentId: newUlid(),
      prodDatabaseReady: true,
    }),
    environmentHeads: heads.results.map((row) => ({
      environmentId: row.environment_id,
      expectedHeadVersion: row.head_version,
    })),
    registrationGenerations: [...new Set([d.dev, d.prod])].map((dataEnvironmentId) => ({
      dataEnvironmentId,
      registrationVersion: 0,
    })),
  });
}
type Snapshot = Awaited<ReturnType<typeof snapshotOf>>;

/** The accepted data-change operation: its intent pins the snapshot, its cleanup run is still pending. */
async function accept(d: Data, change: ProjectDataChangeKind, snapshot: Snapshot) {
  const accepted = await seedAcceptedOperation(d.project, d.project.devEnvironmentId, {
    eventType: "ProjectDataChangeRequestedV1",
    intent: async (operationId) => {
      const cleanupRunId = newUlid();
      await d.control.core
        .prepare(
          "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'pending',1,?5,?5)",
        )
        .bind(d.project.organizationId, cleanupRunId, d.project.projectId, operationId, STORED_NOW)
        .run();
      return {
        expected_etag: `"${"a".repeat(64)}"`,
        cleanup_run_id: cleanupRunId,
        data_change: change,
        data_change_snapshot: JSON.stringify(snapshot),
      };
    },
  });
  return {
    ...d.scope,
    operationId: accepted.operationId,
    claimId: accepted.claimId,
    snapshot,
    now: NOW,
  };
}
type Accepted = Awaited<ReturnType<typeof accept>>;

const rows = async <T>(d: Data, sql: string, ...values: unknown[]) =>
  (
    await d.control.core
      .prepare(sql)
      .bind(...values)
      .all<T>()
  ).results;
const assignmentsOf = (d: Data) =>
  rows<{ environment_id: string; assignment_version: number; data_environment_id: string }>(
    d,
    "SELECT environment_id,assignment_version,data_environment_id FROM environment_data_assignments WHERE project_id=?1 ORDER BY environment_id,assignment_version",
    d.project.projectId,
  );
const cleanupOf = async (d: Data, a: Accepted) =>
  (
    await rows<{ state: string; revision: number }>(
      d,
      "SELECT state,revision FROM cleanup_runs WHERE operation_id=?1",
      a.operationId,
    )
  )[0];
const modeOf = async (d: Data) =>
  (
    await rows<{ data_mode: string }>(
      d,
      "SELECT data_mode FROM projects WHERE project_id=?1",
      d.project.projectId,
    )
  )[0]?.data_mode;

it("starts the cleanup run, switches the losing environment to a new data environment with one audit, and replays both", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const d = await dataProject(control, "shared");
    expect(await readCurrentDataAssignments(control.core, d.scope)).toEqual({
      dataMode: "shared",
      dev: {
        environmentId: d.project.devEnvironmentId,
        environment: "dev",
        dataEnvironmentId: d.dev,
        assignmentVersion: 1,
        assignedAt: "2026-10-28T10:00:00.000Z",
      },
      prod: {
        environmentId: d.project.prodEnvironmentId,
        environment: "prod",
        dataEnvironmentId: d.dev,
        assignmentVersion: 1,
        assignedAt: "2026-10-28T10:00:00.000Z",
      },
    });
    // isolate_dev_keeps_data: prod loses the shared data environment and gets a new one.
    const snapshot = await snapshotOf(d, "isolate_dev_keeps_data");
    const a = await accept(d, "isolate_dev_keeps_data", snapshot);
    const fresh = snapshot.transition.after.prod.dataEnvironmentId;

    expect(await store.provisioning.startDataChange(a)).toBe("created");
    expect(await cleanupOf(d, a)).toEqual({ state: "running", revision: 2 });
    expect(await store.provisioning.startDataChange(a)).toBe("existing");
    expect(await cleanupOf(d, a)).toEqual({ state: "running", revision: 2 });

    expect(await store.provisioning.switchDataAssignments(a)).toBe("created");
    expect(await assignmentsOf(d)).toEqual(
      [
        {
          environment_id: d.project.devEnvironmentId,
          assignment_version: 1,
          data_environment_id: d.dev,
        },
        {
          environment_id: d.project.prodEnvironmentId,
          assignment_version: 1,
          data_environment_id: d.dev,
        },
        {
          environment_id: d.project.prodEnvironmentId,
          assignment_version: 2,
          data_environment_id: fresh,
        },
      ].sort(
        (x, y) =>
          x.environment_id.localeCompare(y.environment_id) ||
          x.assignment_version - y.assignment_version,
      ),
    );
    expect(await modeOf(d)).toBe("isolated");
    expect(
      await rows(
        d,
        "SELECT data_environment_id FROM project_data_environments WHERE project_id=?1 ORDER BY data_environment_id",
        d.project.projectId,
      ),
    ).toEqual([d.dev, fresh].sort().map((id) => ({ data_environment_id: id })));
    const audit = await rows<{ actor_id: string; payload: string; occurred_at: string }>(
      d,
      "SELECT actor_id,payload,occurred_at FROM audit_events WHERE operation_id=?1 AND event_type='ProjectDataChanged'",
      a.operationId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: "deployment-workflow",
      occurred_at: "2026-10-28T10:30:00.000000Z",
    });
    expect(JSON.parse(audit[0]?.payload ?? "")).toEqual({
      change: "isolate_dev_keeps_data",
      from: snapshot.transition.before,
      to: snapshot.transition.after,
    });

    // The same switch again appends nothing.
    expect(await store.provisioning.switchDataAssignments(a)).toBe("existing");
    expect(await assignmentsOf(d)).toHaveLength(3);
    expect(
      await rows(
        d,
        "SELECT 1 FROM audit_events WHERE operation_id=?1 AND event_type='ProjectDataChanged'",
        a.operationId,
      ),
    ).toHaveLength(1);
  } finally {
    await control.dispose();
  }
}, 60_000);

it("shares prod's data environment without creating one, and answers a lost response to start and switch from the committed state", async () => {
  const control = await createTestControl();
  try {
    const d = await dataProject(control, "isolated");
    const snapshot = await snapshotOf(d, "share_prod_keeps_data");
    const a = await accept(d, "share_prod_keeps_data", snapshot);
    const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    const store = createControlStore(control.bindings);

    // The write commits, its response is lost: the caller learns "unknown" and re-sends the same command.
    await expect(lossy.provisioning.startDataChange(a)).rejects.toMatchObject({
      code: "store_outcome_unknown",
    });
    expect(await cleanupOf(d, a)).toEqual({ state: "running", revision: 2 });
    expect(await store.provisioning.startDataChange(a)).toBe("existing");

    const lossySwitch = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    await expect(lossySwitch.provisioning.switchDataAssignments(a)).rejects.toMatchObject({
      code: "store_outcome_unknown",
    });
    expect(await store.provisioning.switchDataAssignments(a)).toBe("existing");

    expect(await assignmentsOf(d)).toContainEqual({
      environment_id: d.project.devEnvironmentId,
      assignment_version: 2,
      data_environment_id: d.prod,
    });
    expect(await assignmentsOf(d)).toHaveLength(3);
    expect(await modeOf(d)).toBe("shared");
    expect(
      await rows(
        d,
        "SELECT 1 FROM project_data_environments WHERE project_id=?1",
        d.project.projectId,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        d,
        "SELECT 1 FROM audit_events WHERE operation_id=?1 AND event_type='ProjectDataChanged'",
        a.operationId,
      ),
    ).toHaveLength(1);
  } finally {
    await control.dispose();
  }
}, 60_000);

it("refuses a start or switch whose claim, assignments or audit no longer match the accepted snapshot", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const d = await dataProject(control, "isolated");
    const snapshot = await snapshotOf(d, "reset_dev");
    const a = await accept(d, "reset_dev", snapshot);
    const conflict = { code: "deployment_persistence_conflict" };

    await expect(
      store.provisioning.startDataChange({ ...a, claimId: newUlid() }),
    ).rejects.toMatchObject(conflict);
    await expect(
      store.provisioning.switchDataAssignments({ ...a, claimId: newUlid() }),
    ).rejects.toMatchObject(conflict);
    await expect(store.provisioning.startDataChange({ ...a, snapshot: {} })).rejects.toThrow();

    // A writer appends a newer dev assignment between the switch's read and its commit: the guard retires the
    // plan, the re-read sees assignments the snapshot never described, and nothing is appended.
    const racing = createControlStore({
      CONTROL_CORE: beforeFirstWrite(control.core, async () => {
        const other = newUlid();
        await control.core.batch([
          control.core
            .prepare(
              "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
            )
            .bind(d.project.organizationId, d.project.projectId, other, STORED_NOW),
          control.core
            .prepare(
              "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,2,?5)",
            )
            .bind(
              d.project.organizationId,
              d.project.projectId,
              d.project.devEnvironmentId,
              other,
              STORED_NOW,
            ),
        ]);
      }),
    });
    await expect(racing.provisioning.switchDataAssignments(a)).rejects.toMatchObject({
      ...conflict,
      message: "Project data assignments changed",
    });
    expect(await assignmentsOf(d)).toHaveLength(3);
    expect(
      await rows(
        d,
        "SELECT 1 FROM audit_events WHERE operation_id=?1 AND event_type='ProjectDataChanged'",
        a.operationId,
      ),
    ).toEqual([]);

    // An assignment already at the target without its audit is not a replay: it is refused.
    const lone = await dataProject(control, "isolated");
    const loneSnapshot = await snapshotOf(lone, "reset_dev");
    const loneAccepted = await accept(lone, "reset_dev", loneSnapshot);
    const target = loneSnapshot.transition.after.dev;
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
        )
        .bind(
          lone.project.organizationId,
          lone.project.projectId,
          target.dataEnvironmentId,
          STORED_NOW,
        ),
      control.core
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at,operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        )
        .bind(
          lone.project.organizationId,
          lone.project.projectId,
          target.environmentId,
          target.dataEnvironmentId,
          target.assignmentVersion,
          STORED_NOW,
          loneAccepted.operationId,
        ),
    ]);
    await expect(store.provisioning.switchDataAssignments(loneAccepted)).rejects.toMatchObject({
      ...conflict,
      message: "Data assignment replay or audit changed",
    });
  } finally {
    await control.dispose();
  }
}, 60_000);

it("guards the acceptance on the frozen assignments, heads and operations, and inventories exactly the targets a dev reset retires", async () => {
  const control = await createTestControl();
  try {
    // Acceptance guards: no claim and no other running operation exists yet.
    const g = await dataProject(control, "isolated");
    const plan = await snapshotOf(g, "reset_dev");
    const acceptance = (snapshot: Snapshot, operationId = newUlid()) =>
      dataChangeAcceptanceStatements(control.core, {
        ...g.scope,
        environmentId: g.project.devEnvironmentId,
        operationId,
        expectedProjectVersion: 1,
        snapshot,
      });
    await control.core.batch(acceptance(plan));
    await control.core
      .prepare("UPDATE environments SET head_version=head_version+1 WHERE environment_id=?1")
      .bind(g.project.prodEnvironmentId)
      .run();
    await expect(control.core.batch(acceptance(plan))).rejects.toThrow(
      /guard_precondition_changed/u,
    );
    // The acceptance is anchored on the dev environment the snapshot describes.
    expect(() =>
      dataChangeAcceptanceStatements(control.core, {
        ...g.scope,
        environmentId: g.project.prodEnvironmentId,
        operationId: newUlid(),
        expectedProjectVersion: 1,
        snapshot: plan,
      }),
    ).toThrow(/Lifecycle inventory or scope changed/u);
    const busy = await dataProject(control, "isolated");
    await seedOperation(busy.project);
    await expect(
      control.core.batch(
        dataChangeAcceptanceStatements(control.core, {
          ...busy.scope,
          environmentId: busy.project.devEnvironmentId,
          operationId: newUlid(),
          expectedProjectVersion: 1,
          snapshot: await snapshotOf(busy, "reset_dev"),
        }),
      ),
    ).rejects.toThrow(/guard_precondition_changed/u);

    // Inventory: the dev deployment's script and the database target of the retired dev data environment.
    const d = await dataProject(control, "isolated");
    const snapshot = await snapshotOf(d, "reset_dev");
    const published = await seedWfpPublication(d.project, {
      operationId: await seedOperation(d.project, { state: "queued" }),
      environmentId: d.project.devEnvironmentId,
    });
    const databaseId = `d${"b".repeat(19)}`;
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'eu-dev','standard',?6,'sealed:fixture',?7)",
        )
        .bind(
          d.project.organizationId,
          d.project.projectId,
          d.dev,
          `prj_${"a".repeat(20)}`,
          databaseId,
          runtimeRoleOf(d.dev),
          STORED_NOW,
        ),
      control.core
        .prepare(
          "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active',?4,?4)",
        )
        .bind(d.project.organizationId, d.project.projectId, d.dev, STORED_NOW),
    ]);
    const a = await accept(d, "reset_dev", snapshot);
    const inventory = await readDataChangeInventoryPlan(control.core, {
      ...d.scope,
      operationId: a.operationId,
      snapshot,
      now: NOW,
    });
    expect(
      inventory.targets.map((t) => `${t.provider}/${t.resource_kind}/${t.locator}`).sort(),
    ).toEqual(
      [
        `cloudflare/wfp-script/ohmyho-production/p-${d.project.projectId.toLowerCase()}-dev-${published.deploymentId.toLowerCase()}`,
        `pgcf/database/${databaseId}`,
      ].sort(),
    );
    expect(inventory.records).toEqual(
      inventory.targets.map((t) => dataChangeInventoryRecord(a.operationId, t)),
    );

    await control.core.batch(dataChangeInventoryStatements(control.core, inventory));
    const recorded = await rows<{
      resource_record_id: string;
      provider: string;
      cleanup_locator: string;
    }>(
      d,
      "SELECT resource_record_id,provider,cleanup_locator FROM run_resource_inventory WHERE operation_id=?1 ORDER BY resource_record_id",
      a.operationId,
    );
    expect(recorded).toEqual(
      inventory.records
        .map((r) => ({
          resource_record_id: r.resourceRecordId,
          provider: r.provider,
          cleanup_locator: r.cleanupLocator,
        }))
        .sort((x, y) => x.resource_record_id.localeCompare(y.resource_record_id)),
    );
    // Recording the same inventory again adds nothing.
    await control.core.batch(dataChangeInventoryStatements(control.core, inventory));
    expect(
      await rows(d, "SELECT 1 FROM run_resource_inventory WHERE operation_id=?1", a.operationId),
    ).toHaveLength(2);

    // The intent must be the accepted one: another data change cannot record under this operation.
    const other = await snapshotOf(d, "share_prod_keeps_data");
    await expect(
      control.core.batch(
        dataChangeInventoryStatements(control.core, {
          ...inventory,
          input: { ...inventory.input, snapshot: other },
        }),
      ),
    ).rejects.toThrow(/guard_precondition_changed/u);
    // A target that changed after the plan was read is a stale plan, not a silent omission.
    await control.core
      .prepare(
        "UPDATE database_provider_target_heads SET state='retired' WHERE organization_id=?1 AND physical_environment_id=?2",
      )
      .bind(d.project.organizationId, d.dev)
      .run();
    await expect(
      control.core.batch(dataChangeInventoryStatements(control.core, inventory)),
    ).rejects.toThrow(/guard_precondition_changed/u);
  } finally {
    await control.dispose();
  }
}, 60_000);
