import { test } from "node:test";
import { startTestPostgres } from "../apps/control-api/test/postgres.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { splitSql } from "../scripts/control-d1-target.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
async function bundle(contents, external = ["cloudflare:workers", "node:*"], nodeFixture = false) {
  return (
    await build({
      stdin: { contents, loader: "ts", resolveDir: root },
      bundle: true,
      format: "esm",
      platform: nodeFixture ? "node" : "browser",
      conditions: ["source"],
      external,
      ...(nodeFixture
        ? {
            banner: {
              js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);',
            },
          }
        : {}),
      write: false,
    })
  ).outputFiles[0].text;
}
const modules = (name, contents) => [
  { type: "ESModule", path: `${root}tests/${name}.mjs`, contents },
];
test("the actual deployment authority and parent reader port preserve accepted identity and digest bytes across native Worker RPC", async () => {
  const authority = await bundle(
      `export {DeploymentWorkflowRuntime,ProductProviderAuthorizationRuntime} from './apps/control-store/src/worker-main.ts';export default {fetch(){return new Response(null,{status:404})}}`,
    ),
    caller =
      await bundle(`import {createCoreDeploymentReaderPort} from './apps/project-provisioning-worker/src/core-deployment-reader.ts';import {createCoreDeploymentTerminalPort} from './apps/project-provisioning-worker/src/core-deployment-terminal.ts';import {createCoreDeploymentSourcePort} from './apps/project-provisioning-worker/src/core-deployment-source.ts';import {createCoreSourceCompletionPort} from './apps/project-provisioning-worker/src/core-source-completion.ts';
      export default {async fetch(request,env){try{const input=await request.json(),port=createCoreDeploymentReaderPort(env.DEPLOYMENT_WORKFLOW_RUNTIME);if(new URL(request.url).pathname==='/authorize'){await env.PRODUCT_PROVIDER_AUTHORIZATION_RUNTIME.authorizeProductProviderMutation(input);return Response.json({authorized:true});}
      if(new URL(request.url).pathname==='/source-complete'){const port=createCoreSourceCompletionPort(env.DEPLOYMENT_WORKFLOW_RUNTIME,()=>new Date('2026-10-28T11:02:00.000Z'));return Response.json({result:await port.complete(input)});}const source=createCoreDeploymentSourcePort(env.DEPLOYMENT_WORKFLOW_RUNTIME);if(new URL(request.url).pathname==='/source-record')return Response.json({result:await source.recordArchive(input)});if(new URL(request.url).pathname==='/source-observe'){const value=await source.observeArchive(input);return Response.json(value===null?null:{...value,sha256:Array.from(value.sha256)});}const terminals=createCoreDeploymentTerminalPort(env.DEPLOYMENT_WORKFLOW_RUNTIME,()=>new Date('2026-10-28T11:00:10.000Z'));if(new URL(request.url).pathname==='/fail')return Response.json({result:await terminals.fail(input)});if(new URL(request.url).pathname==='/health')return Response.json({result:await terminals.recordHealthFailure(input)});if(new URL(request.url).pathname==='/claim')return Response.json({result:await port.claimProviderMutation(input)});
      const value=await port.readContext(input);return Response.json({operation:value?.intent.operationId,source:Buffer.isBuffer(value?.intent.sourceDigest),build:Buffer.isBuffer(value?.intent.buildPlanDigest),artifact:value?.intent.sourceArtifactDigest});
      }catch(error){return Response.json({name:error.name,message:error.message},{status:409})}}}`),
    temporary = await mkdtemp(`${root}apps/control-api/node_modules/.workflow-authority-`);
  const fixturePath = `${temporary}/fixture.mjs`;
  await writeFile(
    fixturePath,
    await bundle(
      `export {workflowFixture} from './apps/control-store/test/provisioning/workflow-fixture.ts';export {sourceLinkFixture} from './apps/control-store/test/provisioning/source-link.fixture.ts'`,
      ["miniflare", "pg", "cloudflare:workers", "node:*"],
      true,
    ),
  );
  const { workflowFixture, sourceLinkFixture } = await import(pathToFileURL(fixturePath));
  let pg;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "caller",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: modules("deployment-authority-caller", caller),
          serviceBindings: {
            DEPLOYMENT_WORKFLOW_RUNTIME: { name: "core", entrypoint: "DeploymentWorkflowRuntime" },
            PRODUCT_PROVIDER_AUTHORIZATION_RUNTIME: {
              name: "core",
              entrypoint: "ProductProviderAuthorizationRuntime",
            },
          },
        },
        {
          name: "core",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: modules("deployment-authority-server", authority),
          d1Databases: { CONTROL_CORE: "native-deployment-authority" },
        },
      ],
    }),
  );
  try {
    const db = await mf.getD1Database("CONTROL_CORE", "core"),
      migrations = new URL("../apps/control-store/migrations/core/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((n) => n.endsWith(".sql")).sort())
      await db.batch(
        splitSql(await readFile(new URL(name, migrations), "utf8")).map((sql) => db.prepare(sql)),
      );
    await db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00.000000Z',unhex(?),unhex(?))",
      )
      .bind("00".repeat(32), "11".repeat(32))
      .run();
    const r = await workflowFixture({ core: db, bindings: { CONTROL_CORE: db } }),
      call = async (path, input) => {
        const response = await mf.dispatchFetch(`http://localhost${path}`, {
          method: "POST",
          body: JSON.stringify(input),
        });
        return { status: response.status, body: await response.json() };
      };
    assert.deepEqual(await call("/claim", r.input), { status: 200, body: { result: "created" } });
    assert.deepEqual(await call("/claim", r.input), { status: 200, body: { result: "existing" } });
    const authorization = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      acceptedLifecycleVersion: 1,
    };
    assert.deepEqual(await call("/authorize", authorization), {
      status: 200,
      body: { authorized: true },
    });
    const extraAuthorization = await call("/authorize", {
      ...authorization,
      claimId: r.input.claimId,
    });
    assert.equal(extraAuthorization.status, 409);
    assert.equal(extraAuthorization.body.message, "ZodError");
    const missingAuthorization = await call("/authorize", {
      ...authorization,
      acceptedLifecycleVersion: 2,
    });
    assert.equal(missingAuthorization.status, 409);
    assert.equal(missingAuthorization.body.name, "DeploymentPersistenceConflictError");
    assert.deepEqual(await call("/context", r.input), {
      status: 200,
      body: { operation: r.input.operationId, source: true, build: true, artifact: null },
    });
    pg = await startTestPostgres();
    const linked = await sourceLinkFixture({ core: db, bindings: { CONTROL_CORE: db } }, pg),
      link = {
        workflowId: linked.workflowId,
        executionId: linked.workflowId,
        command: linked.command,
        evidence: { externalRepositoryId: "42" },
      };
    assert.deepEqual(await call("/source-complete", link), {
      status: 200,
      body: { result: "applied" },
    });
    assert.deepEqual(await call("/source-complete", link), {
      status: 200,
      body: { result: "duplicate" },
    });
    const badLink = await call("/source-complete", {
      ...link,
      evidence: { externalRepositoryId: "43" },
    });
    assert.equal(badLink.status, 409);
    assert.equal(badLink.body.name, "DeploymentPersistenceConflictError");
    for (const [table, key] of [
      ["github_source_connections", "source_connection_id"],
      ["source_connections", "source_connection_id"],
      ["repository_grants", "grant_id"],
      ["project_sources", "source_id"],
    ])
      assert.equal(
        (
          await db
            .prepare(`SELECT count(*) n FROM ${table} WHERE ${key}=?`)
            .bind(linked.operationId)
            .first()
        ).n,
        1,
      );
    const foreign = await workflowFixture({ core: db, bindings: { CONTROL_CORE: db } });
    const refused = await call("/claim", { ...foreign.input, claimId: r.input.claimId });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.name, "DeploymentPersistenceConflictError");
    const source = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      billingEpochId: r.p.billingEpochId,
      sourceConnectionId: r.source,
      externalRepositoryId: "42",
      commitSha: "a".repeat(40),
      sourceSha256: "03".repeat(32),
      archive: {
        bucket: "synthetic-source",
        key: "source.tar.gz",
        versionId: "retained-version",
        archiveId: `archive_${r.input.operationId}_${r.input.claimId}`,
        eTag: "retained-etag",
        byteLength: 123,
      },
      recordedAt: "2026-10-28T11:00:05.000Z",
    };
    assert.deepEqual(await call("/source-record", source), {
      status: 200,
      body: { result: "created" },
    });
    assert.deepEqual(await call("/source-record", source), {
      status: 200,
      body: { result: "existing" },
    });
    const sourceRead = await call("/source-observe", {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      operationId: r.input.operationId,
    });
    assert.equal(sourceRead.status, 200);
    assert.deepEqual(sourceRead.body.sha256, Array(32).fill(3));
    assert.equal(sourceRead.body.objectRef, source.archive.archiveId);
    const terminal = {
      workflowId: r.input.logicalWorkflowId,
      executionId: r.input.logicalWorkflowId,
      command: {
        version: 1,
        eventType: r.input.eventType,
        eventId: r.input.eventId,
        organizationId: r.input.organizationId,
        projectId: r.input.projectId,
        environmentId: r.input.environmentId,
        operationId: r.input.operationId,
        billingEpochId: r.p.billingEpochId,
        planId: r.plan,
      },
    };
    assert.deepEqual(
      await call("/health", {
        ...terminal,
        health: { status: 503, path: "/health", excerpt: "Unavailable", truncated: false },
      }),
      { status: 200, body: { result: "applied" } },
    );
    assert.deepEqual(
      await call("/health", {
        ...terminal,
        health: { status: 503, path: "/health", excerpt: "Unavailable", truncated: false },
      }),
      { status: 200, body: { result: "duplicate" } },
    );
    assert.deepEqual(await call("/fail", { ...terminal, errorCode: "RUNTIME_CANDIDATE_FAILED" }), {
      status: 200,
      body: { result: "applied" },
    });
    assert.deepEqual(await call("/fail", { ...terminal, errorCode: "RUNTIME_CANDIDATE_FAILED" }), {
      status: 200,
      body: { result: "duplicate" },
    });
    const refusedHealth = await call("/health", {
      ...terminal,
      health: { status: 503, path: "/health", excerpt: null, truncated: false },
    });
    assert.equal(refusedHealth.status, 409);
    assert.equal(
      refusedHealth.body.name,
      "DeploymentPersistenceConflictError",
      JSON.stringify(refusedHealth),
    );
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    try {
      await pg?.stop();
    } finally {
      await mf.dispose();
      await rm(temporary, { recursive: true });
    }
  }
});
