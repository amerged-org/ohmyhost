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

import { sourceLinkFixture } from "../../control-store/test/provisioning/source-link.fixture.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { runCoreWorkflow } from "./support/chain-workflows.js";

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await c.dispose();
});

/** The GitHub answer of the repository the consent names (the private source fetcher's validateRepositoryLink). */
const repositoryLink = (externalRepositoryId: string) => () => ({
  permission: "contents:read",
  externalRepositoryId,
});

const first = async <T>(sql: string, ...values: unknown[]) =>
  (await c.core
    .prepare(sql)
    .bind(...values)
    .first<T>()) as T;

it("links a GitHub repository end to end on the real D1 Core", async () => {
  const r = await sourceLinkFixture(c);
  const outcome = await runCoreWorkflow(
    c,
    { command: r.command, workflowId: r.workflowId },
    { SOURCE_FETCHER: { validateRepositoryLink: repositoryLink("42") } },
  );
  expect(outcome.failures).toEqual([]);
  expect(outcome.steps).toEqual(
    expect.arrayContaining([
      "claim-pending-wfp-candidate-cleanup",
      "observe-source-link",
      "persist-product-command-completion",
    ]),
  );
  expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });
  expect(
    await first(
      "SELECT state,lease_expires_at FROM operations WHERE operation_id=?1",
      r.operationId,
    ),
  ).toEqual({ state: "succeeded", lease_expires_at: null });
  expect(
    await first<{ state: string }>(
      "SELECT state FROM product_workflow_runs WHERE workflow_id=?1",
      r.workflowId,
    ),
  ).toEqual({ state: "completed" });
  expect(
    await first(
      "SELECT external_repository_id FROM github_source_connections WHERE source_connection_id=?1",
      r.operationId,
    ),
  ).toEqual({ external_repository_id: "42" });
  expect(
    await first(
      "SELECT external_repository_id FROM repository_grants WHERE source_connection_id=?1",
      r.operationId,
    ),
  ).toEqual({ external_repository_id: "42" });
  expect(
    await first(
      "SELECT source_connection_id,provider,generation FROM project_source_bindings WHERE project_id=?1",
      r.base.p.projectId,
    ),
  ).toEqual({ source_connection_id: r.operationId, provider: "github", generation: 2 });
  expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 60_000);

it("keeps a source link whose repository differs from the consent non-terminal, its lease intact", async () => {
  const r = await sourceLinkFixture(c);
  const outcome = await runCoreWorkflow(
    c,
    { command: r.command, workflowId: r.workflowId },
    { SOURCE_FETCHER: { validateRepositoryLink: repositoryLink("43") } },
  );
  // The changed repository is refused at observation: the step fails, nothing is linked and the operation stays queued.
  expect(outcome.failures).toEqual([
    {
      step: "observe-source-link",
      name: "Error",
      message: "GitHub repository identity changed after customer consent",
    },
  ]);
  expect(
    await first(
      "SELECT state,lease_expires_at IS NOT NULL AS leased FROM operations WHERE operation_id=?1",
      r.operationId,
    ),
  ).toEqual({ state: "queued", leased: 1 });
  expect(
    await first(
      "SELECT count(*) AS n FROM github_source_connections WHERE organization_id=?1",
      r.base.p.organizationId,
    ),
  ).toEqual({ n: 0 });
}, 60_000);
