import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedProject } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const stored = (iso: string) => `${iso.slice(0, 23)}000Z`;

describe("customerReads", () => {
  it("lists the newest scheduled runs of one environment and pages a deployment's diagnostics inside the seven-day window", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      project = await seedProject(control),
      scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
      },
      operationId = newUlid(),
      deploymentId = newUlid(),
      at = stored("2026-10-28T11:00:00.000Z");
    // Runs: no foreign keys, so the rows are the scheduler's own shape.
    const run = (cron: string, scheduledAt: string, state: string) =>
      db
        .prepare(
          "INSERT INTO function_runs(organization_id,run_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,status_code,finished_at,egress_allowed_origins,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'p-script',?6,?7,?8,1,204,?7,'[]',?7,?7)",
        )
        .bind(
          scope.organizationId,
          newUlid(),
          scope.projectId,
          scope.environmentId,
          deploymentId,
          cron,
          stored(scheduledAt),
          state,
        );
    await db.batch([
      run("0 4 * * *", "2026-10-29T04:00:00.000Z", "succeeded"),
      run("*/5 * * * *", "2026-10-29T04:00:00.000Z", "failed"),
      run("0 4 * * *", "2026-10-28T04:00:00.000Z", "succeeded"),
    ]);
    const runs = (await store.customerReads.readEnvironmentFunctionRuns({
      ...scope,
      limit: 2,
    })) as { cron: string; scheduledAt: string; state: string }[];
    expect(runs.map((r) => [r.cron, r.scheduledAt, r.state])).toEqual([
      ["*/5 * * * *", "2026-10-29T04:00:00.000Z", "failed"],
      ["0 4 * * *", "2026-10-29T04:00:00.000Z", "succeeded"],
    ]);
    expect(
      await store.customerReads.readEnvironmentFunctionRuns({
        ...scope,
        environmentId: project.prodEnvironmentId,
        limit: 2,
      }),
    ).toEqual([]);

    await db.batch([
      db
        .prepare(
          "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
        )
        .bind(
          project.organizationId,
          project.projectId,
          operationId,
          project.billingEpochId,
          at,
          at,
        ),
      db
        .prepare(
          "INSERT INTO deployments(organization_id,project_id,environment_id,deployment_id,operation_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'deploy','queued',?,?)",
        )
        .bind(
          project.organizationId,
          project.projectId,
          project.devEnvironmentId,
          deploymentId,
          operationId,
          at,
          at,
        ),
    ]);
    const diagnostic = (id: string, occurredAt: string) =>
      db
        .prepare(
          "INSERT INTO deployment_diagnostics(diagnostic_event_id,organization_id,project_id,environment_id,deployment_id,source,code,catalog_message,occurred_at,recorded_at) VALUES(?,?,?,?,?,'control','DEPLOYMENT_FAILED','DEPLOYMENT_FAILED_SEE_OPERATION_ERROR',?,?)",
        )
        .bind(
          id,
          project.organizationId,
          project.projectId,
          project.devEnvironmentId,
          deploymentId,
          occurredAt,
          at,
        );
    const [a, b, c] = [newUlid(), newUlid(), newUlid()].sort();
    await db.batch([
      // a and b share one public millisecond, c is older; the id breaks the tie descending.
      diagnostic(a as string, "2026-10-28T10:59:00.123100Z"),
      diagnostic(b as string, "2026-10-28T10:59:00.123900Z"),
      diagnostic(c as string, "2026-10-28T10:00:00.000000Z"),
    ]);
    const request = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      deploymentId,
    };
    const first = (await store.customerReads.readDeploymentDiagnostics({
      ...request,
      now: "2026-10-29T00:00:00.000Z",
      limit: 1,
    })) as {
      items: { id: string; occurredAt: string }[];
      nextBefore: { occurredAt: string; id: string } | null;
    };
    expect(first.items.map((i) => [i.id, i.occurredAt])).toEqual([[b, "2026-10-28T10:59:00.123Z"]]);
    expect(first.nextBefore).toEqual({ occurredAt: "2026-10-28T10:59:00.123Z", id: b });
    const second = (await store.customerReads.readDeploymentDiagnostics({
      ...request,
      now: "2026-10-29T00:00:00.000Z",
      limit: 5,
      before: first.nextBefore,
    })) as { items: { id: string }[]; nextBefore: unknown };
    expect(second.items.map((i) => i.id)).toEqual([a, c]);
    expect(second.nextBefore).toBeNull();
    // Eight days later every row is outside the retention window.
    expect(
      await store.customerReads.readDeploymentDiagnostics({
        ...request,
        now: "2026-11-06T00:00:00.000Z",
        limit: 5,
      }),
    ).toEqual({ items: [], nextBefore: null });
  });
});
