import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  }
  return { WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});

import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
  type ProductCommandMessageV1,
} from "@ohmyhost/orchestrator";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  deletionInventoryStatements,
  readDeletionInventoryPlan,
} from "../../control-store/src/catalog/provisioning/lifecycle-inventory.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { acceptDeletion } from "../../control-store/test/provisioning/lifecycle.fixture.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { runCoreWorkflow } from "./support/chain-workflows.js";
import { domainDeletion, sesMailDeletion } from "./support/deployment-chain-providers.js";

/** The Workflow steps of a project deletion without deployments, gateways or database placement, in order. */
const DELETION_STEPS = [
  "remove-project-function-schedules",
  "publish-deletion-tombstone",
  "retain-deletion-tombstone",
  "cleanup-run-inventory",
  "observe-sustained-route-404",
  "wait-for-tombstone-propagation",
  "finalize-deletion-tombstone",
  "persist-product-command-completion",
];

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await c.dispose();
});

const first = async <T>(sql: string, ...values: unknown[]) =>
  (await c.core
    .prepare(sql)
    .bind(...values)
    .first<T>()) as T;

it("deletes a project end to end on the real D1 Core", async () => {
  const r = await workflowFixture(c),
    eventId = newUlid(),
    operationId = newUlid(),
    project = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      billingEpochId: r.p.billingEpochId,
      shard: c.core,
      devEnvironmentId: r.p.developmentEnvironmentId,
      prodEnvironmentId: r.p.productionEnvironmentId,
      handle: r.p.projectHandle,
    },
    command: ProductCommandMessageV1 = parseProductCommandMessageV1({
      version: 1,
      eventType: "ProjectDeletionRequestedV1",
      eventId,
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      operationId,
      billingEpochId: project.billingEpochId,
    });
  // A project is only deleted once its earlier operations finished: no other operation may still be in flight.
  await c.core
    .prepare(
      "UPDATE operations SET state='succeeded',lease_expires_at=NULL WHERE project_id=?1 AND state IN('queued','running')",
    )
    .bind(project.projectId)
    .run();
  const deletion = await acceptDeletion(project, {
    operationId,
    eventId,
    workflowId: deterministicProductCommandWorkflowId(command),
  });
  // The frozen inventory the real acceptance writes; the Workflow records its own cleanup attempts against it.
  const plan = await readDeletionInventoryPlan(c.core, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    operationId,
    recordedAt: "2026-10-28T11:00:00.000Z",
  });
  await c.core.batch(deletionInventoryStatements(c.core, plan));

  const outcome = await runCoreWorkflow(
    c,
    { command, workflowId: deterministicProductCommandWorkflowId(command) },
    {
      SES_MANAGEMENT: { deleteMailProject: () => sesMailDeletion(project) },
      CLOUDFLARE_DOMAIN_MANAGEMENT: {
        deleteProject: (input) => domainDeletion(input as { readonly operationId: string }),
      },
    },
  );
  // A failing step is reported first: the Workflow would otherwise turn it into a reconciliation.
  expect(outcome.failures).toEqual([]);
  expect(outcome.steps).toEqual(DELETION_STEPS);
  expect(outcome.calls.map(([name]) => name)).toEqual([
    "SES_MANAGEMENT.deleteMailProject",
    "CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject",
  ]);
  expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });

  expect(
    await first("SELECT lifecycle_state FROM projects WHERE project_id=?1", project.projectId),
  ).toEqual({ lifecycle_state: "deleted" });
  expect(
    await first(
      "SELECT state,lease_expires_at FROM operations WHERE operation_id=?1",
      deletion.operationId,
    ),
  ).toEqual({ state: "succeeded", lease_expires_at: null });
  expect(
    await first("SELECT state FROM cleanup_runs WHERE cleanup_run_id=?1", deletion.cleanupRunId),
  ).toEqual({ state: "succeeded" });
  expect(
    await first<{ state: string }>(
      "SELECT state FROM product_workflow_runs WHERE workflow_id=?1",
      deterministicProductCommandWorkflowId(command),
    ),
  ).toEqual({ state: "completed" });
  expect(await first("SELECT count(*) AS n FROM project_database_writes")).toEqual({ n: 0 });
  expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 60_000);
