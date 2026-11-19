import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { splitSql } from "../scripts/control-d1-target.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
async function bundle(contents, fixture = false) {
  return (
    await build({
      stdin: { contents, loader: "ts", resolveDir: root },
      bundle: true,
      format: "esm",
      platform: fixture ? "node" : "browser",
      conditions: ["source"],
      external: fixture
        ? ["miniflare", "node:*", "cloudflare:workers"]
        : ["node:*", "cloudflare:workers"],
      write: false,
      ...(fixture
        ? {
            banner: {
              js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);',
            },
          }
        : {}),
    })
  ).outputFiles[0].text;
}
const modules = (name, contents) => [
  { type: "ESModule", path: `${root}tests/${name}.mjs`, contents },
];

test("actual Functions Worker invokes only its fixed Core scheduler capability across native RPC and refuses a direct Core database binding", async () => {
  // The occurrence is the start of the current hour: a run more than an hour late is recorded as skipped, so a fixed date would age out.
  const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const authority = await bundle(
      `export {FunctionsSchedulerRuntime} from './apps/control-store/src/worker-main.ts';export default {fetch(){return new Response(null,{status:404})}}`,
    ),
    caller = `import scheduler from '../apps/functions-scheduler/dist/worker-bundle/worker-main.js';
      export default {async fetch(request,env){const executions=[];
        const bindings={RUNTIME_CONFIGURATION_STATE:'configured',CONTROL_FUNCTIONS_RUNTIME:env.CONTROL_FUNCTIONS_RUNTIME,CUSTOMER_DISPATCH:{get(script,args,options){return {async fetch(request){executions.push({script,args,options,body:await request.json()});return new Response(null,{status:204});}}}}};
        const kind=new URL(request.url).pathname.slice(1);
        if(kind==='direct')bindings.CONTROL_CORE={};
        if(kind==='hidden')Object.defineProperty(bindings,'CONTROL_DIRECTORY',{enumerable:false,value:{}});
        try{await scheduler.scheduled({scheduledTime:${hourStart}},bindings);return Response.json({executions});}
        catch(error){return Response.json({message:error.message,executions},{status:409});}
      }};`,
    shippedCaller = await readFile(
      new URL("../apps/functions-scheduler/dist/worker-bundle/worker-main.js", import.meta.url),
      "utf8",
    ),
    temporary = await mkdtemp(`${root}node_modules/.functions-core-`),
    fixturePath = `${temporary}/fixture.mjs`;
  await writeFile(
    fixturePath,
    await bundle(
      `export {gatewayFixture} from './apps/control-store/test/gateway/gateway-fixture.ts';export {functionScheduleStatements} from './apps/control-store/src/catalog/gateway/function-schedules.ts'`,
      true,
    ),
  );
  const { gatewayFixture, functionScheduleStatements } = await import(pathToFileURL(fixturePath));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "caller",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            ...modules("functions-core-caller", caller),
            {
              type: "ESModule",
              path: `${root}apps/functions-scheduler/dist/worker-bundle/worker-main.js`,
              contents: shippedCaller,
            },
          ],
          serviceBindings: {
            CONTROL_FUNCTIONS_RUNTIME: { name: "core", entrypoint: "FunctionsSchedulerRuntime" },
          },
        },
        {
          name: "core",
          compatibilityDate: "2026-08-19",
          compatibilityFlags: ["nodejs_compat"],
          modules: modules("functions-core-server", authority),
          d1Databases: { CONTROL_CORE: "functions-core" },
        },
      ],
    }),
  );
  try {
    const db = await mf.getD1Database("CONTROL_CORE", "core"),
      migrations = new URL("../apps/control-store/migrations/core/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
      await db.batch(
        splitSql(await readFile(new URL(name, migrations), "utf8")).map((sql) => db.prepare(sql)),
      );
    await db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00.000000Z',unhex(?),unhex(?))",
      )
      .bind("00".repeat(32), "11".repeat(32))
      .run();
    // Legacy fixture aliases refer to this same single authority; none is a Worker binding.
    const r = await gatewayFixture({
      core: db,
      directory: db,
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      bindings: { CONTROL_CORE: db },
    });
    await db.batch(
      functionScheduleStatements(db, {
        ...r.scope,
        deploymentId: r.deploymentId,
        candidateReceiptId: r.candidateReceiptId,
        crons: ["0 * * * *"],
        egressAllowedOrigins: ["https://api.example.test"],
        now: new Date(hourStart - 60_000).toISOString(),
      }),
    );
    const response = await mf.dispatchFetch("http://local/run"),
      result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.executions.length, 1);
    assert.deepEqual(result.executions[0], {
      script: r.script,
      args: {},
      options: {
        limits: { cpuMs: 50, subRequests: 10 },
        outbound: {
          EGRESS_CONTEXT: {
            version: 1,
            projectId: r.project.projectId,
            allowedOrigins: ["https://api.example.test"],
          },
        },
      },
      body: {
        cron: "0 * * * *",
        scheduledTime: hourStart,
        immutableScriptName: r.script,
      },
    });
    assert.deepEqual(
      (await db.prepare("SELECT state,attempt,status_code FROM function_runs").all()).results,
      [{ state: "succeeded", attempt: 1, status_code: 204 }],
    );
    const replay = await (await mf.dispatchFetch("http://local/run")).json();
    assert.deepEqual(replay.executions, []);
    for (const kind of ["direct", "hidden"]) {
      const refused = await mf.dispatchFetch(`http://local/${kind}`),
        body = await refused.json();
      assert.equal(refused.status, 409);
      assert.deepEqual(body.executions, []);
      assert.match(body.message, /ambiguous/u);
    }
  } finally {
    await mf.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
