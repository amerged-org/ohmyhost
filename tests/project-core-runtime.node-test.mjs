import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { splitSql } from "../scripts/control-d1-target.mjs";
import { createControlStore } from "../apps/control-store/dist/store.js";
const root = fileURLToPath(new URL("../", import.meta.url));
// The Core bundle pulls the yaml parser through the contracts package: only the browser platform leaves its `process`
// reference to the Worker global (the node platform turns it into a require that workerd refuses).
const bundle = async (contents, platform = "node") =>
  (
    await build({
      stdin: { contents, loader: "ts", resolveDir: root },
      bundle: true,
      format: "esm",
      platform,
      conditions: ["source"],
      external: ["cloudflare:workers", "node:*"],
      write: false,
    })
  ).outputFiles[0].text;
const module = (name, contents) => [
  { type: "ESModule", path: `${root}tests/${name}.mjs`, contents },
];
const id = (n) => String(n).padStart(26, "0");
test("actual Project publisher/Queue/provisioning handlers cross native Worker RPC to one guarded Core", async () => {
  const core = await bundle(
    `export {ProjectDispatchRuntime,ProjectWorkflowRuntime} from './apps/control-store/src/worker-main.ts'; export default {fetch(){return new Response(null,{status:404})}};`,
    "browser",
  );
  const client =
    await bundle(`import {runScheduledPublisher} from './apps/project-provisioning-worker/src/worker-runtime.ts';
 import consumer from './apps/project-provisioning-worker/dist/consumer-bundle/consumer-main.js';
 import {ProjectProvisioningWorkflow} from './apps/project-provisioning-worker/dist/workflow-bundle/workflow-main.js';
 export default {async fetch(request,env,ctx){try{const body=await request.json();const path=new URL(request.url).pathname;
 if(path==='/publish'){await env.OPERATION_PUBLISHER.wake();return Response.json(await env.PROJECT_PROVISIONING_QUEUE.read());}
 if(path==='/consume'){let acked=0,retried=0;await consumer.queue({messages:[{body:JSON.stringify(body),ack(){acked++},retry(){retried++}}]},env);return Response.json({acked,retried});}
 if(path==='/workflow'){return Response.json(await new ProjectProvisioningWorkflow(ctx,env).run({payload:body,instanceId:'project-provisioning-v1-'+body.eventId+'-'+body.operationId},{do:async(name,config,run)=>run()}));}
 if(path==='/malformed'){await runScheduledPublisher({...env,PROJECT_DISPATCH_RUNTIME:{}},1);}
 return Response.json({error:'unknown'}, {status:404});}catch(error){return Response.json({error:error.message},{status:500});}}};`);
  const publisher = await readFile(
    new URL(
      "../apps/project-provisioning-worker/dist/publisher-bundle/publisher-main.js",
      import.meta.url,
    ),
    "utf8",
  );
  const boundary = `import {WorkerEntrypoint,RpcTarget} from 'cloudflare:workers';let messages=[];class Instance extends RpcTarget{async status(){return {status:'complete'}}};export class QueueBoundary extends WorkerEntrypoint{send(message){messages.push(message)}read(){return messages}}export class WorkflowBoundary extends WorkerEntrypoint{create(){throw new Error('lost create reply')}get(){return new Instance()}}export default {fetch(){return new Response(null,{status:404})}};`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "client",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: module("project-core-client", client),
          bindings: { RUNTIME_CONFIGURATION_STATE: "configured" },
          serviceBindings: {
            OPERATION_PUBLISHER: { name: "publisher", entrypoint: "OperationPublisherService" },
            PROJECT_DISPATCH_RUNTIME: { name: "core", entrypoint: "ProjectDispatchRuntime" },
            PROJECT_WORKFLOW_RUNTIME: { name: "core", entrypoint: "ProjectWorkflowRuntime" },
            PROJECT_PROVISIONING_QUEUE: { name: "boundary", entrypoint: "QueueBoundary" },
            PROJECT_PROVISIONING_WORKFLOW: { name: "boundary", entrypoint: "WorkflowBoundary" },
            DEPLOYMENT_WORKFLOW: { name: "boundary", entrypoint: "WorkflowBoundary" },
          },
        },
        {
          name: "publisher",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: module("project-core-actual-publisher", publisher),
          bindings: { RUNTIME_CONFIGURATION_STATE: "configured" },
          serviceBindings: {
            PROJECT_DISPATCH_RUNTIME: { name: "core", entrypoint: "ProjectDispatchRuntime" },
            PROJECT_PROVISIONING_QUEUE: { name: "boundary", entrypoint: "QueueBoundary" },
          },
        },
        {
          name: "core",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: module("project-core-authority", core),
          d1Databases: { CONTROL_CORE: "native-project-core" },
        },
        {
          name: "boundary",
          compatibilityDate: "2026-08-19",
          modules: module("project-core-boundary", boundary),
        },
      ],
    }),
  );
  try {
    const db = await mf.getD1Database("CONTROL_CORE", "core");
    const migrations = new URL("../apps/control-store/migrations/core/", import.meta.url);
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
    const store = createControlStore({ CONTROL_CORE: db }),
      org = id(7001),
      project = id(7002),
      op = id(7003),
      epoch = id(7004),
      event = id(7014),
      at = "2026-10-28T10:00:00.000Z";
    await store.identity.applyOrganizationSnapshot({
      organizationId: org,
      workosOrganizationId: "org_nativeproject",
      state: "active",
      snapshotDigest: "33".repeat(32),
      snapshotFetchedAt: at,
      synchronizedAt: at,
      triggerEventId: "evt_nativeproject",
      memberships: [],
      auditEventId: id(7005),
    });
    await store.projects.createInitialProject({
      organizationId: org,
      projectId: project,
      billingEpochId: epoch,
      principalId: "user:user_native",
      projectName: "Native Project",
      projectHandle: "native-project",
      projectHandleVersion: "customer-chosen-v1",
      projectHandleAttempt: 0,
      dataMode: "shared",
      region: "eu",
      createdEventId: id(7006),
      createdAt: at,
      developmentEnvironmentId: id(7007),
      productionEnvironmentId: id(7008),
      developmentDataEnvironmentId: id(7009),
      productionDataEnvironmentId: id(7009),
      operation: { operationId: op, eventId: id(7010) },
      audit: {
        auditEventId: id(7011),
        projectId: project,
        operationId: op,
        eventType: "ProjectCreated",
        actorType: "principal",
        actorId: "user:user_native",
        payload: {},
        occurredAt: at,
      },
      outbox: {
        eventId: event,
        eventType: "ProjectProvisioningRequested",
        payload: { projectId: project, operationId: op },
        createdAt: at,
        maxAttempts: 5,
      },
    });
    const call = async (path, body = {}) => {
      const response = await mf.dispatchFetch("http://localhost" + path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const messages = await call("/publish");
    assert.equal(messages.length, 1);
    const message = JSON.parse(messages[0]);
    assert.equal(message.operationId, op);
    assert.deepEqual(await call("/workflow", message), {
      status: "completed",
      persistence: "applied",
    });
    assert.deepEqual(await call("/consume", message), { acked: 1, retried: 0 });
    assert.deepEqual(await call("/consume", message), { acked: 1, retried: 0 });
    assert.equal(
      (await store.operations.loadOperation({ organizationId: org, operationId: op })).events
        .length,
      3,
    );
    const rejected = await mf.dispatchFetch("http://localhost/malformed", {
      method: "POST",
      body: "{}",
    });
    assert.equal(rejected.status, 500);
    assert.match((await rejected.json()).error, /Project Core capability is unavailable/);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await mf.dispose();
  }
});
