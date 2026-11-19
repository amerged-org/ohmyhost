import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  activateTestCore,
  migrationFiles,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  bootstrapCore,
  coreBootstrapWorker,
} from "../../control-store/test/support/core-bootstrap.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import {
  releaseProviderClaim,
  seedAcceptedOperation,
} from "../../control-store/test/support/accepted-operation.js";

it("retries a partially completed cache deletion through real Core, Worker RPC and SQLite Durable Objects", async () => {
  const bundle = async (entry: string) => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      banner: {
        js: 'import {createRequire as __testCreateRequire} from "node:module";const require=__testCreateRequire("/fixture.js");',
      },
      conditions: ["source", "workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*"],
      write: false,
    });
    const code = result.outputFiles[0]?.text;
    if (code === undefined) throw new Error("missing bundle");
    return code;
  };
  const [coreCode, cacheCode, helperCode] = await Promise.all([
    bundle("../../control-store/src/worker-main.ts"),
    bundle("../../next-cache/src/worker-main.ts"),
    build({
      stdin: {
        resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
        contents: `
      import { retireNextCacheScopes } from './next-cache-retirement.ts';
      import { createCoreDeploymentInventory } from './core-deployment-inventory.ts';
      export default { async fetch(request, env) {
        const { authority, failSecond } = await request.json(); let calls = 0;
        const retirement = { retire(input) { if (failSecond && calls++ === 1) throw new Error('injected transport failure'); return env.RETIRE.retire(input); } };
        const completed = await retireNextCacheScopes(retirement, createCoreDeploymentInventory(env.CORE), authority);
        return Response.json({ completed });
      } };`,
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      banner: {
        js: 'import {createRequire as __testCreateRequire} from "node:module";const require=__testCreateRequire("/fixture.js");',
      },
      conditions: ["source", "workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*"],
      write: false,
    }).then((result) => result.outputFiles[0]?.text ?? ""),
  ]);
  // Local workerd cannot emulate geographic subnamespaces; production uses the exact same scoped name with jurisdiction.
  const localCacheCode = cacheCode.replace(".jurisdiction(region).getByName(", ".getByName(");
  if (localCacheCode === cacheCode || helperCode === "") throw new Error("invalid test bundle");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "bootstrap",
          compatibilityDate: "2026-09-14",
          modules: [{ type: "ESModule", path: "bootstrap.mjs", contents: coreBootstrapWorker }],
          d1Databases: { CONTROL_CORE: "shared-core" },
        },
        {
          name: "core",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: "core.mjs", contents: coreCode }],
          d1Databases: { CONTROL_CORE: "shared-core" },
        },
        {
          name: "cache",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: "cache.mjs", contents: localCacheCode }],
          durableObjects: { NEXT_CACHE_OBJECT: { className: "NextCacheObject", useSQLite: true } },
          serviceBindings: {
            NEXT_CACHE_RETIREMENT_AUTHORITY: {
              name: "core",
              entrypoint: "NextCacheRetirementAuthorityRuntime",
            },
          },
        },
        {
          name: "driver",
          compatibilityDate: "2026-09-14",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: "driver.mjs", contents: helperCode }],
          serviceBindings: {
            CORE: { name: "core", entrypoint: "DeploymentWorkflowRuntime" },
            RETIRE: { name: "cache", entrypoint: "NextCacheRetirementRuntime" },
          },
        },
      ],
    }),
  );
  try {
    await bootstrapCore(
      mf as unknown as Parameters<typeof bootstrapCore>[0],
      migrationFiles("core"),
    );
    const core = await mf.getD1Database("CONTROL_CORE", "bootstrap");
    const db = core as unknown as TestControl["core"];
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      bindings: {
        CONTROL_CORE: db,
        CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
      },
      dispose: () => mf.dispose(),
    };
    const store = createControlStore(control.bindings),
      project = await seedProject(control);
    for (const environmentId of [project.devEnvironmentId, project.prodEnvironmentId]) {
      const accepted = await seedAcceptedOperation(project, environmentId);
      const deploymentId = accepted.intent.deployment_id;
      if (!deploymentId) throw new Error("missing deployment");
      expect(
        await store.runtimeSecrets.registerNextCacheScope({
          organizationId: project.organizationId,
          projectId: project.projectId,
          environmentId,
          deploymentId,
        }),
      ).toEqual({ region: "eu" });
      await releaseProviderClaim(project);
    }
    const deletion = await seedAcceptedOperation(project, project.prodEnvironmentId, {
      eventType: "ProjectDeletionRequestedV1",
      claim: false,
    });
    const cleanupRunId = deletion.intent.cleanup_run_id;
    if (!cleanupRunId) throw new Error("missing cleanup run");
    await db
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=? AND project_id=?",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    const authority = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: deletion.operationId,
      cleanupRunId,
    };
    const driver = await mf.getWorker("driver");
    const run = async (failSecond: boolean) =>
      (
        await driver.fetch("https://driver.invalid", {
          method: "POST",
          body: JSON.stringify({ authority, failSecond }),
        })
      ).json();
    expect(await run(false)).toEqual({ completed: false });
    await store.provisioning.retainDeletionTombstone({
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: deletion.operationId,
      environmentId: project.prodEnvironmentId,
      workflowId: deletion.workflowId,
      outboxEventId: deletion.eventId,
      startedOperationEventId: newUlid(),
      recordedAt: "2026-10-28T10:01:00.000Z",
      tombstoneReceiptId: "wfp:tombstone",
    });
    expect(await run(true)).toEqual({ completed: false });
    expect(
      (
        await db
          .prepare("SELECT count(*) n FROM next_cache_retirements WHERE project_id=?")
          .bind(project.projectId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(await run(false)).toEqual({ completed: true });
    expect(
      (
        await db
          .prepare("SELECT count(*) n FROM next_cache_retirements WHERE project_id=?")
          .bind(project.projectId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    expect(
      await store.runtimeSecrets.listNextCacheRetirementScopes({ ...authority, limit: 100 }),
    ).toEqual({ scopes: [], nextCursor: null });
  } finally {
    await mf.dispose();
  }
}, 120_000);
