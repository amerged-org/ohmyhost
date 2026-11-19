import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../src/catalog/common.js";
import { CommandConflictError, StoreBusyError, runCommand } from "../src/run-command.js";
import { createControlStore } from "../src/store.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { acceptInput, projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
let orgA: string;
let orgB: string;
let projectA: ReturnType<typeof projectInput>;
let projectB: ReturnType<typeof projectInput>;

const count = async (sql: string, ...values: unknown[]) =>
  (
    await control.core
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;

beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  orgA = await seedOrganization(store, 2, 0);
  orgB = await seedOrganization(store, 2, 1);
  projectA = projectInput(orgA, "global-a");
  projectB = projectInput(orgB, "global-b");
  await store.projects.createInitialProject(projectA);
  await store.projects.createInitialProject(projectB);
});
afterAll(async () => control.dispose());

describe("global epoch and operation identity across organizations", () => {
  const T = "2026-12-01T00:00:00.000000Z";
  const quick = { baseDelayMs: 0, sleep: async () => undefined };

  it("refuses an epoch and an operation another organization retains, before any write", async () => {
    // A's project ends its epoch (the ownership moved away): the epoch id stays retained and is never reusable
    const closed = projectInput(orgA, "global-closed");
    await store.projects.createInitialProject(closed);
    await control.core
      .prepare(
        "UPDATE billing_epochs SET ended_at = '2026-12-02T00:00:00.000000Z' WHERE organization_id = ? AND billing_epoch_id = ?",
      )
      .bind(orgA, closed.billingEpochId)
      .run();
    const intruder = projectInput(orgB, "global-intruder");
    const stolen = { ...intruder, billingEpochId: closed.billingEpochId };
    const refusedEpoch = await store.projects.createInitialProject(stolen).catch((error) => error);
    expect(refusedEpoch).toBeInstanceOf(CommandConflictError);
    expect(refusedEpoch).not.toBeInstanceOf(StoreBusyError);
    expect(refusedEpoch).toMatchObject({ code: "global_identity_conflict" });
    expect(
      await count("SELECT count(*) AS n FROM projects WHERE project_id = ?", intruder.projectId),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM project_directory WHERE project_id = ?",
        intruder.projectId,
      ),
    ).toBe(0);
    // the same organization-scoped project then commits with its own epoch
    await expect(store.projects.createInitialProject(intruder)).resolves.toMatchObject({
      outcome: "created",
    });

    // a distinct operation of B that proposes the operation id A retains
    const reuse = acceptInput(projectB, {
      operationId: projectA.operation.operationId,
      idempotencyKey: "global-operation-reuse",
    });
    const refusedOperation = await store.operations.acceptApiOperation(reuse).catch((e) => e);
    expect(refusedOperation).toBeInstanceOf(CommandConflictError);
    expect(refusedOperation).not.toBeInstanceOf(StoreBusyError);
    expect(refusedOperation).toMatchObject({ code: "global_identity_conflict" });
    expect(
      await count(
        "SELECT count(*) AS n FROM operations WHERE operation_id = ?",
        projectA.operation.operationId,
      ),
    ).toBe(1);
  });

  it("classifies a collision the decision cannot see by its global table, never as store_busy", async () => {
    const operationId = newUlid();
    const blindOperation = (organizationId: string, project: typeof projectA) =>
      runCommand(
        control.core,
        {
          name: "test.blindOperation",
          input: { organizationId },
          read: async () => null,
          decide: () => ({
            statements: [
              control.core
                .prepare(
                  "INSERT INTO operations(organization_id, operation_id, project_id, state, billing_epoch_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?5)",
                )
                .bind(organizationId, operationId, project.projectId, project.billingEpochId, T),
            ],
            result: () => "queued",
          }),
        },
        quick,
      );
    expect(await blindOperation(orgA, projectA)).toBe("queued");
    const refused = await blindOperation(orgB, projectB).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CommandConflictError);
    expect(refused).not.toBeInstanceOf(StoreBusyError);
    expect(refused).toMatchObject({ code: "global_identity_conflict" });
  });
});
