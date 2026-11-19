import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import {
  createTestControl,
  losingNthResponse,
  shardOf,
  type TestControl,
} from "./support/control-d1.js";
import { projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const count = async (db: TestControl["directory"], table: string, where = "1 = 1") =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())?.n;
const claim = (projectId: string) =>
  control.directory
    .prepare("SELECT state, reserved_until FROM project_directory WHERE project_id = ?")
    .bind(projectId)
    .first<{ state: string; reserved_until: string | null }>();

describe("projects.createInitialProject", () => {
  it("creates project, epoch, environments, assignments, operation, audit and outbox in one shard batch and replays", async () => {
    const organizationId = await seedOrganization(store, 2, 1);
    const input = projectInput(organizationId, "first-handle", false);
    expect(await store.projects.createInitialProject(input)).toMatchObject({ outcome: "created" });
    expect(await claim(input.projectId)).toEqual({ state: "active", reserved_until: null });
    const shard = shardOf(control, 1);
    for (const [table, expected] of [
      ["projects", 1],
      ["billing_epochs", 1],
      ["environments", 2],
      ["project_data_environments", 2],
      ["environment_data_assignments", 2],
      ["operation_events", 1],
      ["audit_events", 1],
      ["outbox_events", 1],
    ] as const) {
      // the seeded organization's own snapshot audit event is not part of the project batch
      const scope =
        table === "audit_events"
          ? `organization_id = '${organizationId}' AND event_type = 'ProjectCreated'`
          : `organization_id = '${organizationId}'`;
      expect(await count(shard, table, scope), table).toBe(expected);
    }
    expect(
      await control.directory
        .prepare("SELECT kind, shard_id FROM work_due WHERE kind = 'outbox'")
        .first(),
    ).toEqual({ kind: "outbox", shard_id: 0 });
    // The same request is answered, not repeated; a different request under the same id is refused.
    expect(await store.projects.createInitialProject(input)).toMatchObject({ outcome: "existing" });
    await expect(
      store.projects.createInitialProject({ ...input, projectName: "Another name" }),
    ).rejects.toMatchObject({ code: "project_identity_conflict" });
    expect(await count(shard, "projects", `organization_id = '${organizationId}'`)).toBe(1);
    // A handle is global: another organization, another shard, same handle.
    const other = await seedOrganization(store, 2, 0);
    await expect(
      store.projects.createInitialProject(projectInput(other, "first-handle")),
    ).rejects.toMatchObject({ code: "project_handle_taken" });
    expect(await count(shardOf(control, 0), "projects", `organization_id = '${other}'`)).toBe(0);
  });

  it("lets exactly one of two racing creators claim a handle and leaves nothing of the loser", async () => {
    const [a, b] = [await seedOrganization(store, 2, 0), await seedOrganization(store, 2, 1)];
    const inputs = [projectInput(a, "race-handle"), projectInput(b, "race-handle")] as const;
    const settled = await Promise.allSettled(
      inputs.map((input) => store.projects.createInitialProject(input)),
    );
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = settled.findIndex((result) => result.status === "rejected");
    expect((settled[loser] as PromiseRejectedResult).reason).toMatchObject({
      code: "project_handle_taken",
    });
    const winner = inputs[1 - loser] as (typeof inputs)[number];
    const loserInput = inputs[loser] as (typeof inputs)[number];
    expect(await count(control.directory, "project_directory", "handle = 'race-handle'")).toBe(1);
    expect(await claim(winner.projectId)).toMatchObject({ state: "active" });
    for (const db of Object.values(control.shards)) {
      expect(await count(db, "projects", `project_id = '${loserInput.projectId}'`)).toBe(0);
      expect(await count(db, "operations", `project_id = '${loserInput.projectId}'`)).toBe(0);
    }
  });

  it("resumes after a lost response and resolves abandoned reservations without allowing a late commit", async () => {
    // Lost response: the shard batch commits, the caller sees an error; the retry finds the project.
    const lossy = createControlStore({ CONTROL_CORE: losingNthResponse(shardOf(control, 0), 2) });
    const organizationId = await seedOrganization(store, 2, 0);
    const lost = projectInput(organizationId, "lost-response");
    expect(await lossy.projects.createInitialProject(lost)).toMatchObject({
      projectId: lost.projectId,
    });
    expect(await count(shardOf(control, 0), "projects", `project_id = '${lost.projectId}'`)).toBe(
      1,
    );
    expect(await claim(lost.projectId)).toMatchObject({ state: "active" });

    // Crash after the shard batch, before activation: the reservation expires into `active`.
    const committed = projectInput(organizationId, "crash-after");
    await store.projects.createInitialProject(committed);
    await control.directory
      .prepare(
        "UPDATE project_directory SET state = 'reserved', reserved_until = '2026-10-28T10:15:00.000000Z' WHERE project_id = ?",
      )
      .bind(committed.projectId)
      .run();
    // Crash before the shard batch: only the reservation exists.
    const abandoned = projectInput(organizationId, "crash-before");
    await control.directory
      .prepare(
        "INSERT INTO project_directory(project_id, organization_id, handle, state, reserved_until, created_at) VALUES (?, ?, ?, 'reserved', '2026-10-28T10:15:00.000000Z', '2026-10-28T10:00:00.000000Z')",
      )
      .bind(abandoned.projectId, organizationId, abandoned.projectHandle)
      .run();
    // Not yet due: untouched.
    expect(
      await store.maintenance.resolveProjectReservations({
        now: "2026-10-28T10:14:59.000Z",
        limit: 10,
      }),
    ).toEqual({
      activated: 0,
      released: 0,
    });
    const now = "2026-10-28T10:16:00.000Z";
    expect(await store.maintenance.resolveProjectReservations({ now, limit: 10 })).toEqual({
      activated: 1,
      released: 1,
    });
    expect(await claim(committed.projectId)).toMatchObject({ state: "active" });
    expect(await claim(abandoned.projectId)).toBeNull();
    // The delayed creator of the closed reservation can no longer commit, and the handle is free again.
    await expect(store.projects.createInitialProject(abandoned)).rejects.toMatchObject({
      code: "project_reservation_expired",
    });
    expect(
      await count(shardOf(control, 0), "projects", `project_id = '${abandoned.projectId}'`),
    ).toBe(0);
    const retaken = projectInput(organizationId, "crash-before");
    expect(await store.projects.createInitialProject(retaken)).toMatchObject({
      outcome: "created",
    });
  });

  it("leaves no claim, project, epoch or operation behind when the LAST statement of the batch fails", async () => {
    const organizationId = await seedOrganization(store, 2, 1);
    const input = projectInput(organizationId, "late-failure-handle", false);
    await control.core
      .prepare(
        "CREATE TRIGGER late_project_outbox BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT, 'late failure'); END",
      )
      .run();
    await expect(store.projects.createInitialProject(input)).rejects.toThrow();
    // the former phases (Directory claim, project batch, activation) were separate commits: now none survives
    expect(
      await count(control.directory, "project_directory", `project_id = '${input.projectId}'`),
    ).toBe(0);
    expect(
      await count(control.directory, "project_directory", "handle = 'late-failure-handle'"),
    ).toBe(0);
    for (const table of [
      "projects",
      "billing_epochs",
      "environments",
      "environment_data_assignments",
      "operations",
      "outbox_events",
    ]) {
      expect(
        await count(control.directory, table, `organization_id = '${organizationId}'`),
        table,
      ).toBe(0);
    }
    expect(
      await count(control.directory, "project_identities", `project_id = '${input.projectId}'`),
    ).toBe(0);
    await control.core.prepare("DROP TRIGGER late_project_outbox").run();
    // nothing blocked the handle or the id: the same request now commits whole
    expect(await store.projects.createInitialProject(input)).toMatchObject({ outcome: "created" });
    expect(await claim(input.projectId)).toEqual({ state: "active", reserved_until: null });
  });
});
