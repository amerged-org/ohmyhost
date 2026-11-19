import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid, ownershipInvariantGuard } from "../src/catalog/common.js";
import type { D1PreparedStatement } from "../src/d1-types.js";
import { createControlStore } from "../src/store.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { acceptInput, projectInput, seedOrganization, type Store } from "./support/seed.js";

/**
 * The ownership-transfer import: the former owner's operation and data history stays exactly where it was
 * recorded (no relabelled row, no fake current project) while ONE scope of the project is current. Every statement runs on
 * a real local D1 with foreign keys enforced, the way a PostgreSQL import writes them.
 */
let control: TestControl;
let store: Store;
const TRANSFER = "2026-12-10T00:00:00.000000Z";
const RETURN = "2026-12-18T00:00:00.000000Z";

let oldOrg: string;
let newOrg: string;
let project: ReturnType<typeof projectInput>;
const newEpoch = newUlid();
const returnEpoch = newUlid();

const run = async (sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .run();
const all = async <Row>(sql: string, ...values: unknown[]) =>
  (
    await control.core
      .prepare(sql)
      .bind(...values)
      .all<Row>()
  ).results;

beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  oldOrg = await seedOrganization(store, 2, 0);
  newOrg = await seedOrganization(store, 2, 1);
  project = projectInput(oldOrg, "transferred-app");
  await store.projects.createInitialProject(project);
});
afterAll(async () => control.dispose());

/** What the import writes when the project moves: close the old epoch, retire the old scope, open the new one. */
async function transfer() {
  const T = TRANSFER;
  const keep = (table: string) =>
    control.core
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE organization_id = ?`)
      .bind(oldOrg);
  void keep;
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE billing_epochs SET ended_at = ?3 WHERE organization_id = ?1 AND billing_epoch_id = ?2",
      )
      .bind(oldOrg, project.billingEpochId, T),
    control.core
      .prepare(
        "UPDATE projects SET owner_state = 'transferred', updated_at = ?3 WHERE organization_id = ?1 AND project_id = ?2",
      )
      .bind(oldOrg, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version,
           handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode,
           region, dev_access_mode, created_at, updated_at)
         SELECT ?1, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt,
           lifecycle_state, lifecycle_version, 'active', 1, ?3, data_mode, region, dev_access_mode, created_at, ?4
         FROM projects WHERE organization_id = ?2 AND project_id = ?5`,
      )
      .bind(newOrg, oldOrg, newEpoch, T, project.projectId),
    control.core
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:import')",
      )
      .bind(newOrg, newEpoch, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at)
         SELECT ?1, environment_id, project_id, name, desired_state, 0, dev_access_epoch, created_at, ?4
         FROM environments WHERE organization_id = ?2 AND project_id = ?3`,
      )
      .bind(newOrg, oldOrg, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at)
         SELECT ?1, project_id, data_environment_id, ?4 FROM project_data_environments WHERE organization_id = ?2 AND project_id = ?3`,
      )
      .bind(newOrg, oldOrg, project.projectId, T),
    control.core
      .prepare(
        `INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at, operation_id)
         SELECT ?1, environment_id, 1, project_id, data_environment_id, ?4, NULL FROM environment_data_assignments
          WHERE organization_id = ?2 AND project_id = ?3 AND assignment_version = 1`,
      )
      .bind(newOrg, oldOrg, project.projectId, T),
    control.core
      .prepare("UPDATE project_directory SET organization_id = ?1 WHERE project_id = ?2")
      .bind(newOrg, project.projectId),
    // the same final guard as the creation batch: one current owner, one GLOBAL open epoch, and the owner's epoch is it
    ownershipInvariantGuard(control.core, project.projectId),
  ]);
}

/** The return of the project to its former owner: the third epoch of the project, a fresh global id (A -> B -> A). */
async function returnToFormerOwner(extra: D1PreparedStatement[] = []) {
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE billing_epochs SET ended_at = ?3 WHERE organization_id = ?1 AND billing_epoch_id = ?2",
      )
      .bind(newOrg, newEpoch, RETURN),
    control.core
      .prepare(
        "UPDATE projects SET owner_state = 'transferred', updated_at = ?3 WHERE organization_id = ?1 AND project_id = ?2",
      )
      .bind(newOrg, project.projectId, RETURN),
    control.core
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:import')",
      )
      .bind(oldOrg, returnEpoch, project.projectId, RETURN),
    control.core
      .prepare(
        "UPDATE projects SET owner_state = 'active', ownership_version = 3, active_billing_epoch_id = ?3, updated_at = ?4 WHERE organization_id = ?1 AND project_id = ?2",
      )
      .bind(oldOrg, project.projectId, returnEpoch, RETURN),
    control.core
      .prepare("UPDATE project_directory SET organization_id = ?1 WHERE project_id = ?2")
      .bind(oldOrg, project.projectId),
    ...extra,
    ownershipInvariantGuard(control.core, project.projectId),
  ]);
}

describe("an ownership transfer keeps the former owner's history and one current owner", () => {
  it("imports with foreign keys on, keeps every former row byte for byte and opens the new scope", async () => {
    const snapshot = async () => ({
      operations: await all("SELECT * FROM operations WHERE organization_id = ?", oldOrg),
      assignments: await all(
        "SELECT * FROM environment_data_assignments WHERE organization_id = ?",
        oldOrg,
      ),
      environments: await all("SELECT * FROM environments WHERE organization_id = ?", oldOrg),
      data: await all("SELECT * FROM project_data_environments WHERE organization_id = ?", oldOrg),
    });
    const before = await snapshot();
    expect(before.operations.length).toBeGreaterThan(0);
    expect((await all<{ foreign_keys: number }>("PRAGMA foreign_keys"))[0]?.foreign_keys).toBe(1);

    await transfer();

    expect(await snapshot()).toEqual(before);
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
    const scopes = await all<Record<string, unknown>>(
      "SELECT organization_id, owner_state, active_billing_epoch_id FROM projects WHERE project_id = ? ORDER BY owner_state DESC",
      project.projectId,
    );
    expect(scopes).toEqual([
      {
        organization_id: oldOrg,
        owner_state: "transferred",
        active_billing_epoch_id: project.billingEpochId,
      },
      { organization_id: newOrg, owner_state: "active", active_billing_epoch_id: newEpoch },
    ]);
    expect(await all("SELECT project_id, created_organization_id FROM project_identities")).toEqual(
      [{ project_id: project.projectId, created_organization_id: oldOrg }],
    );
    expect(
      await all(
        "SELECT organization_id FROM billing_epochs WHERE project_id = ? AND ended_at IS NULL",
        project.projectId,
      ),
    ).toEqual([{ organization_id: newOrg }]);
    expect(
      await all(
        "SELECT organization_id FROM project_directory WHERE project_id = ?",
        project.projectId,
      ),
    ).toEqual([{ organization_id: newOrg }]);
    // the physical data environment stays with its origin; the new owner holds an alias of the same identity
    expect(
      await all<{ physical_organization_id: string }>(
        "SELECT DISTINCT physical_organization_id FROM data_environment_identities",
      ),
    ).toEqual([{ physical_organization_id: oldOrg }]);
  });

  it("refuses a second open epoch, a second current scope, a cloned identity and an unclosed transfer", async () => {
    await expect(
      run(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:import')",
        newOrg,
        newUlid(),
        project.projectId,
        TRANSFER,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed: billing_epochs\.project_id/u);
    await expect(
      run(
        "UPDATE projects SET owner_state = 'active' WHERE organization_id = ?1 AND project_id = ?2",
        oldOrg,
        project.projectId,
      ),
    ).rejects.toThrow(/transferred project scope is history/u);

    const third = await seedOrganization(store, 2, 0);
    const scopeRow = (organization: string, projectId: string, eventId: string) =>
      run(
        `INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version,
           handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode,
           region, dev_access_mode, created_at, updated_at)
         SELECT ?1, ?2, created_organization_id, name, ?3, handle, handle_version, handle_attempt, lifecycle_state, lifecycle_version,
           'active', 1, ?4, data_mode, region, dev_access_mode, created_at, updated_at
         FROM projects WHERE organization_id = ?5 AND project_id = ?6`,
        organization,
        projectId,
        eventId,
        newUlid(),
        newOrg,
        project.projectId,
      );
    const identity = (
      await all<{ created_event_id: string }>(
        "SELECT created_event_id FROM project_identities WHERE project_id = ?",
        project.projectId,
      )
    )[0]?.created_event_id as string;
    // a third current scope of the same project
    await expect(scopeRow(third, project.projectId, identity)).rejects.toThrow(
      /UNIQUE constraint failed: projects\.project_id/u,
    );
    // a scope row that disagrees with the project's global identity
    await expect(scopeRow(third, project.projectId, newUlid())).rejects.toThrow(
      /carries the global identity|UNIQUE constraint failed/u,
    );
    // a second project that clones the creation event of the first
    await expect(scopeRow(third, newUlid(), identity)).rejects.toThrow(
      /UNIQUE constraint failed: project_identities\.created_event_id/u,
    );
    // a current scope may not be retired while its epoch is open
    const other = projectInput(third, "open-epoch-app");
    await store.projects.createInitialProject(other);
    await expect(
      run(
        "UPDATE projects SET owner_state = 'transferred' WHERE organization_id = ?1 AND project_id = ?2",
        third,
        other.projectId,
      ),
    ).rejects.toThrow(/only after its billing epoch is closed/u);
    // an environment or data alias of another project is not an alias
    await expect(
      run(
        "INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at) VALUES (?1, ?2, ?3, 'dev', '{}', 0, 0, ?4, ?4)",
        third,
        project.developmentEnvironmentId,
        other.projectId,
        TRANSFER,
      ),
    ).rejects.toThrow(/environment/u);
    await expect(
      run(
        "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        third,
        other.projectId,
        project.developmentDataEnvironmentId,
        TRANSFER,
      ),
    ).rejects.toThrow(/data environment alias/u);
  });

  it("refuses new mutations of the former owner and admits the new owner", async () => {
    await expect(
      store.operations.acceptApiOperation(acceptInput(project, { idempotencyKey: "old-after" })),
    ).rejects.toMatchObject({ code: expect.stringMatching(/scope_inactive|owner_changed/u) });
    const admitted = await store.operations.acceptApiOperation(
      acceptInput(
        { ...project, organizationId: newOrg, billingEpochId: newEpoch },
        {
          idempotencyKey: "new-owner",
        },
      ),
    );
    expect(admitted).toBeDefined();
    expect(
      await all(
        "SELECT organization_id FROM operations WHERE project_id = ? AND billing_epoch_id = ?",
        project.projectId,
        newEpoch,
      ),
    ).toEqual([{ organization_id: newOrg }]);
  });

  it("returns the project to its former owner under a fresh third epoch and keeps every earlier epoch's history", async () => {
    const history = async (organization: string) => ({
      operations: await all("SELECT * FROM operations WHERE organization_id = ?", organization),
      assignments: await all(
        "SELECT * FROM environment_data_assignments WHERE organization_id = ?",
        organization,
      ),
      environments: await all("SELECT * FROM environments WHERE organization_id = ?", organization),
    });
    const epochs = () =>
      all<Record<string, unknown>>(
        "SELECT organization_id, billing_epoch_id, started_at, ended_at FROM billing_epochs WHERE project_id = ? ORDER BY started_at",
        project.projectId,
      );
    const scopes = () =>
      all<Record<string, unknown>>(
        "SELECT organization_id, owner_state, ownership_version, active_billing_epoch_id FROM projects WHERE project_id = ? ORDER BY organization_id",
        project.projectId,
      );
    const before = { old: await history(oldOrg), new: await history(newOrg) };
    const epochsBefore = await epochs();
    const scopesBefore = await scopes();
    const closeTheCurrentOwner = [
      control.core
        .prepare(
          "UPDATE billing_epochs SET ended_at = ?3 WHERE organization_id = ?1 AND billing_epoch_id = ?2",
        )
        .bind(newOrg, newEpoch, RETURN),
      control.core
        .prepare(
          "UPDATE projects SET owner_state = 'transferred', updated_at = ?3 WHERE organization_id = ?1 AND project_id = ?2",
        )
        .bind(newOrg, project.projectId, RETURN),
    ];
    const openEpoch = (epochId: string, startedAt: string) =>
      control.core
        .prepare(
          "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:import')",
        )
        .bind(oldOrg, epochId, project.projectId, startedAt);
    const reactivate = (version: number, epochId: string) =>
      control.core
        .prepare(
          "UPDATE projects SET owner_state = 'active', ownership_version = ?3, active_billing_epoch_id = ?4, updated_at = ?5 WHERE organization_id = ?1 AND project_id = ?2",
        )
        .bind(oldOrg, project.projectId, version, epochId, RETURN);
    const refused: [string, D1PreparedStatement[], RegExp][] = [
      [
        "the former epoch cannot be reopened",
        [...closeTheCurrentOwner, reactivate(3, project.billingEpochId)],
        /changes only by a return to a fresh billing epoch/u,
      ],
      [
        "an epoch id another scope retains is not fresh, whichever organization asks",
        [...closeTheCurrentOwner, openEpoch(newEpoch, RETURN)],
        /UNIQUE constraint failed: billing_epochs\.billing_epoch_id/u,
      ],
      [
        "the fresh epoch opens after every earlier epoch ended",
        [...closeTheCurrentOwner, openEpoch(returnEpoch, TRANSFER)],
        /opens after every earlier epoch of its project has ended/u,
      ],
      [
        "the ownership version rises above every scope row",
        [...closeTheCurrentOwner, openEpoch(returnEpoch, RETURN), reactivate(1, returnEpoch)],
        /changes only by a return to a fresh billing epoch/u,
      ],
      [
        "a project without a current owner never commits",
        [
          ...closeTheCurrentOwner,
          openEpoch(returnEpoch, RETURN),
          ownershipInvariantGuard(control.core, project.projectId),
        ],
        /guard_owner_changed/u,
      ],
    ];
    for (const [name, statements, failure] of refused) {
      await expect(control.core.batch(statements), name).rejects.toThrow(failure);
      expect(await epochs(), name).toEqual(epochsBefore);
      expect(await scopes(), name).toEqual(scopesBefore);
    }

    await returnToFormerOwner();

    expect({ old: await history(oldOrg), new: await history(newOrg) }).toEqual(before);
    expect(await epochs()).toEqual([
      epochsBefore[0],
      { ...(epochsBefore[1] as object), ended_at: RETURN },
      {
        organization_id: oldOrg,
        billing_epoch_id: returnEpoch,
        started_at: RETURN,
        ended_at: null,
      },
    ]);
    expect(await scopes()).toEqual(
      [
        {
          organization_id: oldOrg,
          owner_state: "active",
          ownership_version: 3,
          active_billing_epoch_id: returnEpoch,
        },
        {
          organization_id: newOrg,
          owner_state: "transferred",
          ownership_version: 1,
          active_billing_epoch_id: newEpoch,
        },
      ].sort((a, b) => (a.organization_id < b.organization_id ? -1 : 1)),
    );
    expect(
      await all(
        "SELECT organization_id, ownership_version, active_billing_epoch_id, returned_to_billing_epoch_id FROM project_scope_history WHERE project_id = ?",
        project.projectId,
      ),
    ).toEqual([
      {
        organization_id: oldOrg,
        ownership_version: 1,
        active_billing_epoch_id: project.billingEpochId,
        returned_to_billing_epoch_id: returnEpoch,
      },
    ]);
    expect(
      await all(
        "SELECT organization_id FROM project_directory WHERE project_id = ?",
        project.projectId,
      ),
    ).toEqual([{ organization_id: oldOrg }]);
    expect(await all("SELECT project_id FROM project_identities")).toContainEqual({
      project_id: project.projectId,
    });
    await expect(run("UPDATE project_scope_history SET ownership_version = 9")).rejects.toThrow(
      /never changes/u,
    );
    await expect(
      run("DELETE FROM project_scope_history WHERE organization_id = ?", oldOrg),
    ).rejects.toThrow(/never deleted/u);
    await expect(
      run("DELETE FROM billing_epochs WHERE billing_epoch_id = ?", project.billingEpochId),
    ).rejects.toThrow(/never deleted/u);
    await expect(
      run(
        "UPDATE billing_epochs SET ended_at = ?2 WHERE billing_epoch_id = ?1",
        project.billingEpochId,
        RETURN,
      ),
    ).rejects.toThrow(/only ends, once/u);

    // new mutations belong to the returned owner's fresh epoch only
    const accepted = await store.operations.acceptApiOperation(
      acceptInput(
        { ...project, billingEpochId: returnEpoch },
        { idempotencyKey: "returned-owner" },
      ),
    );
    expect(accepted).toBeDefined();
    for (const stale of [
      { ...project, billingEpochId: project.billingEpochId },
      { ...project, organizationId: newOrg, billingEpochId: newEpoch },
    ]) {
      await expect(
        store.operations.acceptApiOperation(
          acceptInput(stale, { idempotencyKey: `stale-${stale.organizationId}` }),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/scope_inactive|owner_changed/u) });
    }
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("binds a transfer copy and a return to the lifecycle the project last had, never the stale scope", async () => {
    const [x, y] = [await seedOrganization(store, 2, 0), await seedOrganization(store, 2, 1)];
    const p = projectInput(x, "lifecycle-app");
    await store.projects.createInitialProject(p);
    const [epochY, epochX] = [newUlid(), newUlid()];
    const [T1, T2, T3] = [
      "2026-12-20T00:00:00.000000Z",
      "2026-12-21T00:00:00.000000Z",
      "2026-12-22T00:00:00.000000Z",
    ];
    const scopes = () =>
      all<Record<string, unknown>>(
        "SELECT organization_id, owner_state, ownership_version, lifecycle_state, lifecycle_version, active_billing_epoch_id FROM projects WHERE project_id = ? ORDER BY organization_id",
        p.projectId,
      );
    const epochs = () =>
      all(
        "SELECT organization_id, billing_epoch_id, ended_at FROM billing_epochs WHERE project_id = ? ORDER BY started_at",
        p.projectId,
      );
    const close = (organization: string, epoch: string, at: string) =>
      control.core
        .prepare(
          "UPDATE billing_epochs SET ended_at = ?3 WHERE organization_id = ?1 AND billing_epoch_id = ?2",
        )
        .bind(organization, epoch, at);
    const retire = (organization: string, state: string, version: number, at: string) =>
      control.core
        .prepare(
          "UPDATE projects SET owner_state = 'transferred', lifecycle_state = ?3, lifecycle_version = ?4, updated_at = ?5 WHERE organization_id = ?1 AND project_id = ?2",
        )
        .bind(organization, p.projectId, state, version, at);
    const copyTo = (state: string, version: number) =>
      control.core
        .prepare(
          `INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version,
             handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode,
             region, dev_access_mode, created_at, updated_at)
           SELECT ?1, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt,
             ?3, ?4, 'active', 1, ?5, data_mode, region, dev_access_mode, created_at, ?6
           FROM projects WHERE organization_id = ?2 AND project_id = ?7`,
        )
        .bind(y, x, state, version, epochY, T1, p.projectId);
    const openEpoch = (organization: string, epoch: string, at: string) =>
      control.core
        .prepare(
          "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:import')",
        )
        .bind(organization, epoch, p.projectId, at);
    const reactivate = (state: string, version: number) =>
      control.core
        .prepare(
          "UPDATE projects SET owner_state = 'active', ownership_version = 3, lifecycle_state = ?3, lifecycle_version = ?4, active_billing_epoch_id = ?5, updated_at = ?6 WHERE organization_id = ?1 AND project_id = ?2",
        )
        .bind(x, p.projectId, state, version, epochX, T3);
    const guard = ownershipInvariantGuard(control.core, p.projectId);

    // the first copy must carry the lifecycle of the project it copies
    const start = await scopes();
    await expect(
      control.core.batch([
        close(x, p.billingEpochId, T1),
        retire(x, "active", 1, T1),
        copyTo("deleting", 2),
      ]),
    ).rejects.toThrow(/carries the latest lifecycle of the project/u);
    expect(await scopes()).toEqual(start);
    await control.core.batch([
      close(x, p.billingEpochId, T1),
      retire(x, "active", 1, T1),
      copyTo("active", 1),
      openEpoch(y, epochY, T1),
      guard,
    ]);

    // the new owner progresses the ONE project lifecycle to deleting/v2 and then deleted/v3 while it hands the project on
    await control.core
      .prepare(
        "UPDATE projects SET lifecycle_state = 'deleting', lifecycle_version = 2, updated_at = ?2 WHERE organization_id = ?1 AND project_id = ?3",
      )
      .bind(y, T2, p.projectId)
      .run();
    const deleted = [close(y, epochY, T3), retire(y, "deleted", 3, T3), openEpoch(x, epochX, T3)];
    const before = { scopes: await scopes(), epochs: await epochs() };
    // the stale scope of A (active/1), a backwards lifecycle and a resurrection are all refused and leave everything as it was
    for (const [state, version] of [
      ["active", 1],
      ["deleting", 2],
      ["active", 3],
      ["deleted", 2],
    ] as const) {
      await expect(
        control.core.batch([...deleted, reactivate(state, version), guard]),
        `${state}/${String(version)}`,
      ).rejects.toThrow(/changes only by a return to a fresh billing epoch/u);
      expect(await scopes()).toEqual(before.scopes);
      expect(await epochs()).toEqual(before.epochs);
    }
    // only the lifecycle the project really has returns with it (the original never refuses the transfer of a deleted project)
    await control.core.batch([...deleted, reactivate("deleted", 3), guard]);
    expect(await scopes()).toEqual(
      [
        {
          organization_id: x,
          owner_state: "active",
          ownership_version: 3,
          lifecycle_state: "deleted",
          lifecycle_version: 3,
          active_billing_epoch_id: epochX,
        },
        {
          organization_id: y,
          owner_state: "transferred",
          ownership_version: 1,
          lifecycle_state: "deleted",
          lifecycle_version: 3,
          active_billing_epoch_id: epochY,
        },
      ].sort((a, b) => (a.organization_id < b.organization_id ? -1 : 1)),
    );
    expect(
      await all(
        "SELECT ownership_version, lifecycle_state, lifecycle_version, active_billing_epoch_id FROM project_scope_history WHERE project_id = ?",
        p.projectId,
      ),
    ).toEqual([
      {
        ownership_version: 1,
        lifecycle_state: "active",
        lifecycle_version: 1,
        active_billing_epoch_id: p.billingEpochId,
      },
    ]);
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
