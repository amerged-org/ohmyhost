import { builtinModules } from "node:module";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { splitSql } from "../scripts/control-d1-target.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
async function bundle(contents, nodeFixture = false) {
  return (
    await build({
      stdin: { contents, loader: "ts", resolveDir: root },
      bundle: true,
      format: "esm",
      platform: nodeFixture ? "node" : "neutral",
      target: "es2024",
      mainFields: ["module", "main"],
      conditions: nodeFixture ? ["source"] : ["source", "workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*", ...(nodeFixture ? ["miniflare"] : [])],
      ...(nodeFixture
        ? {
            banner: {
              js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);',
            },
          }
        : {}),
      plugins: nodeFixture
        ? []
        : [
            {
              name: "native-node-builtins",
              setup(builder) {
                builder.onResolve({ filter: /^(?:node:)?[a-z][a-z0-9_/-]*$/ }, (args) => {
                  const name = args.path.replace(/^node:/u, "");
                  if (!builtinModules.includes(name) && !builtinModules.includes(`node:${name}`))
                    return;
                  return args.kind === "require-call"
                    ? { path: name, namespace: "native-node-builtins" }
                    : { path: `node:${name}`, external: true };
                });
                builder.onLoad({ filter: /.*/, namespace: "native-node-builtins" }, (args) => ({
                  contents: `import value from ${JSON.stringify(`node:${args.path}`)}; module.exports = value;`,
                  loader: "js",
                }));
              },
            },
          ],
      write: false,
    })
  ).outputFiles[0].text;
}
const modules = (name, contents) => [
  { type: "ESModule", path: `${root}tests/${name}.mjs`, contents },
];

test("actual DiagnosticIngestion Worker records signed diagnostics through the fixed Core RPC, acknowledges a retired usage notification, preserving signature/ACK/retry/unknown and mixed-authority refusal", async () => {
  const authority = await bundle(
    `export {DiagnosticConsumerRuntime} from './apps/control-store/src/worker-main.ts';export default {fetch(){return new Response(null,{status:404})}}`,
  );
  const caller =
    await bundle(`import worker from './apps/diagnostic-ingestion/src/consumer-main.ts';
    export default { async fetch(request, env) {
      const url = new URL(request.url), path=url.pathname; let acked=0,retried=0;
      const cfg={RUNTIME_CONFIGURATION_STATE:'configured',DIAGNOSTIC_CONSUMER_RUNTIME:env.DIAGNOSTIC_CONSUMER_RUNTIME,DIAGNOSTIC_PRODUCER_ID:'fixture-producer',DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64:Buffer.alloc(32,7).toString('base64')};
      try {
        if(path==='/direct'){Object.defineProperty(cfg,'CONTROL_SHARD_0000',{enumerable:false,get(){throw new Error('POISON raw binding getter')}});await worker.scheduled({},cfg);}
        else if(path==='/scheduled')return Response.json(await worker.scheduled({},cfg));
        else {
          const body=await request.json();
          await worker.queue({messages:[{body,ack(){acked++},retry(){retried++}}]},cfg);
        }
        return Response.json({acked,retried});
      }catch(error){return Response.json({name:error.name,message:error.message},{status:409})}
    }};`);
  const temporary = await mkdtemp(`${root}node_modules/.diagnostic-authority-`),
    fixturePath = `${temporary}/fixture.mjs`;
  let mf;
  try {
    await writeFile(
      fixturePath,
      await bundle(
        `export {workflowFixture} from './apps/control-store/test/provisioning/workflow-fixture.ts';export {signEnvelope} from './apps/diagnostic-ingestion/src/runtime.ts';export {newUlid} from './apps/control-store/src/catalog/common.ts';`,
        true,
      ),
    );
    const { workflowFixture, signEnvelope, newUlid } = await import(pathToFileURL(fixturePath));
    const options = (name, contents) => ({
      name,
      compatibilityDate: "2026-08-19",
      compatibilityFlags: ["nodejs_compat"],
      modules: modules(`diagnostic-${name}`, contents),
    });
    mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            ...options("caller", caller),
            serviceBindings: {
              DIAGNOSTIC_CONSUMER_RUNTIME: {
                name: "core",
                entrypoint: "DiagnosticConsumerRuntime",
              },
            },
          },
          {
            ...options("core", authority),
            d1Databases: { CONTROL_CORE: "native-diagnostic-core" },
          },
        ],
      }),
    );
    const db = await mf.getD1Database("CONTROL_CORE", "core"),
      migrations = new URL("../apps/control-store/migrations/core/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((n) => n.endsWith(".sql")).sort())
      await db.batch(
        splitSql(await readFile(new URL(name, migrations), "utf8")).map((sql) => db.prepare(sql)),
      );
    const call = async (path, body, binary = false) => {
      const response = await mf.dispatchFetch(`http://localhost${path}`, {
        method: "POST",
        body: binary ? body : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const activation = db.prepare(
      "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00.000000Z',unhex(?),unhex(?))",
    );
    const retired = {
      account: "00000000000000000000000000000001",
      action: "PutObject",
      bucket: "ohmyho-usage-development",
      object: { key: "usage/20261029/object.log.gz", size: 1 },
      eventTime: "2026-10-29T12:00:00.000Z",
    };
    await activation.bind("00".repeat(32), "11".repeat(32)).run();
    // The notification of the retired usage bucket rule is acknowledged and ignored, never retried and never stored.
    assert.deepEqual(await call("/diagnostic", retired), {
      status: 200,
      body: { acked: 1, retried: 0 },
    });
    assert.equal((await db.prepare("SELECT count(*) n FROM deployment_diagnostics").first()).n, 0);
    const control = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
        dispose: async () => {},
      },
      r = await workflowFixture(control);
    const payload = {
        schemaVersion: "ohmyhost.diagnostic/v1",
        diagnosticId: newUlid(),
        organizationId: r.p.organizationId,
        projectId: r.p.projectId,
        environmentId: r.input.environmentId,
        deploymentId: r.deployment,
        source: "runtime",
        code: "RUNTIME_FAILED",
        catalogMessage: "CUSTOMER_RUNTIME_FAILED",
        occurredAt: new Date().toISOString(),
      },
      key = Buffer.alloc(32, 7).toString("base64");
    const envelope = await signEnvelope(payload, "fixture-producer", key);
    assert.deepEqual(await call("/diagnostic", envelope), {
      status: 200,
      body: { acked: 1, retried: 0 },
    });
    assert.deepEqual(await call("/diagnostic", envelope), {
      status: 200,
      body: { acked: 1, retried: 0 },
    });
    assert.equal((await db.prepare("SELECT count(*) n FROM deployment_diagnostics").first()).n, 1);
    assert.deepEqual(await call("/diagnostic", { ...envelope, signature: "invalid" }), {
      status: 200,
      body: { acked: 1, retried: 0 },
    });
    const conflict = await signEnvelope(
      { ...payload, code: "RUNTIME_EXCEPTION" },
      "fixture-producer",
      key,
    );
    assert.deepEqual(await call("/diagnostic", conflict), {
      status: 200,
      body: { acked: 0, retried: 1 },
    });
    const foreign = await signEnvelope(
      { ...payload, diagnosticId: newUlid(), projectId: newUlid() },
      "fixture-producer",
      key,
    );
    assert.deepEqual(await call("/diagnostic", foreign), {
      status: 200,
      body: { acked: 0, retried: 1 },
    });
    assert.deepEqual(await call("/scheduled", {}), { status: 200, body: { removed: 0 } });
    const direct = await call("/direct", {});
    assert.equal(direct.status, 409);
    assert.match(direct.body.message, /mixed Control authority/u);
    assert.doesNotMatch(direct.body.message, /POISON/u);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
