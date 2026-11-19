import { createRequire, builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

import type { D1Database } from "../../control-store/src/d1-types.js";
import {
  activateTestCore,
  migrate,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { buildRig, cid, fundBuild } from "../../control-store/test/support/build-fixtures.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bundle = async (contents: string) => {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    banner: {
      js: 'import {createRequire as __fixtureCreateRequire} from "node:module"; const require=__fixtureCreateRequire("/fixture.js");',
    },
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve(
            {
              filter: /^[a-z_][a-z0-9_/-]*$/,
            },
            (args) =>
              builtinModules.includes(args.path)
                ? { path: `node:${args.path}`, external: true }
                : undefined,
          );
        },
      },
    ],
    write: false,
    logLevel: "error",
  });
  if (result.outputFiles[0] === undefined) throw new Error("empty test bundle");
  return result.outputFiles[0].text;
};

const USAGE = {
  runner: "cloudflare-build-sandbox",
  instanceType: "standard-3",
  status: "SUCCEEDED",
  startedAt: "2026-10-28T12:00:00.000Z",
  provisioningStartedAt: "2026-10-28T12:00:00.800Z",
  completedAt: "2026-10-28T12:01:57.286Z",
};

it("runs the actual BuildRunner reader through the actual receipt service and ControlRuntime binding", async () => {
  // The only substituted boundary is the external build sandbox's measured provider result. All three application
  // classes, binding calls, receipt commands, guarded batches and the engine are the real production code.
  const require = createRequire(new URL("../../control-store/package.json", import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    require.resolve("wrangler/package.json"),
  )("miniflare") as {
    convertV4MiniflareOptions(options: unknown): unknown;
    Miniflare: new (options: unknown) => {
      getD1Database(name: string, worker?: string): Promise<unknown>;
      getWorker(
        name: string,
      ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
      dispose(): Promise<void>;
    };
  };
  const [controlScript, receiptScript, runnerScript] = await Promise.all([
    bundle(
      'export { ControlRuntime } from "./apps/control-store/src/worker-main.ts"; export default { fetch() { return new Response("private"); } };',
    ),
    bundle(`import { BuildReceiptPersistenceService } from "./apps/control-api/src/worker-main.ts";
      export class ReceiptService extends BuildReceiptPersistenceService {}
      export class MissingReceiptService extends BuildReceiptPersistenceService { constructor(ctx,env){super(ctx,{...env,CONTROL_RUNTIME:undefined});} }
      export default { fetch(){return new Response("private");} };`),
    bundle(`import { BuildRunnerService } from "./apps/build-runner/src/worker-main.ts";
      const usage=${JSON.stringify(USAGE)};
      export class RunnerService extends BuildRunnerService {
        constructor(ctx,env){
          const namespace={idFromName(name){return name;},get(id){return {
            async startBuild(){throw new Error("provider start not part of this read qualification");},
            async stopBuild(){throw new Error("provider stop not part of this read qualification");},
            async readBuild(){return {buildId:"test-builds:"+id,projectName:"test-builds",status:"SUCCEEDED",startTime:new Date(usage.startedAt),operationId:id,inputFingerprint:"sha256:${"ab".repeat(32)}",usage};}
          };}};
          super(ctx,{...env,BUILD_SANDBOX:namespace,BUILD_SANDBOX_EU:namespace});
        }
      } export default {fetch(){return new Response("private");}};`),
  ]);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "control",
          modules: true,
          script: controlScript,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { CONTROL_CORE: "build-core" },
        },
        {
          name: "receipt",
          modules: true,
          script: receiptScript,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: { CONTROL_RUNTIME: { name: "control", entrypoint: "ControlRuntime" } },
        },
        {
          name: "runner",
          modules: true,
          script: runnerScript,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            BUILD_PROJECT: "test-builds",
            BUILD_OBJECTS_BUCKET_US: "omh-builds-test-us",
            BUILD_OBJECTS_BUCKET_EU: "omh-builds-test-eu",
          },
          r2Buckets: { BUILD_OBJECTS_US: "builds-us", BUILD_OBJECTS_EU: "builds-eu" },
          serviceBindings: { BUILD_RECEIPTS: { name: "receipt", entrypoint: "ReceiptService" } },
        },
        {
          name: "caller",
          modules: true,
          script: `export default {async fetch(request,env){const {action,input,target}=await request.json();
        try{let value;const binding=target==="missing"?env.MISSING:env.RECEIPTS;
          if(action==="readBuild")value=await env.RUNNER.readBuild(input);
          else if(action==="authorizeBuildStart")value=await binding.authorizeBuildStart(input.scope,input.claimId);
          else value=await binding[action](input);
          return Response.json({ok:true,value:value??null});
        }catch(error){return Response.json({ok:false,message:String(error.message)});}}};`,
          compatibilityDate: "2026-08-24",
          serviceBindings: {
            RECEIPTS: { name: "receipt", entrypoint: "ReceiptService" },
            MISSING: { name: "receipt", entrypoint: "MissingReceiptService" },
            RUNNER: { name: "runner", entrypoint: "RunnerService" },
          },
        },
      ],
    }),
  );
  try {
    const core = (await mf.getD1Database("CONTROL_CORE", "control")) as D1Database;
    await migrate(core, "core");
    await activateTestCore(core);
    const control: TestControl = {
      core,
      bindings: { CONTROL_CORE: core },
      directory: core,
      shards: { CONTROL_SHARD_0000: core, CONTROL_SHARD_0001: core },
      dispose: async () => undefined,
    };
    const r = await buildRig(control);
    await fundBuild(r);
    const caller = await mf.getWorker("caller");
    const call = async (action: string, input: unknown = {}, target?: string) =>
      (
        await caller.fetch("https://fixture/", {
          method: "POST",
          body: JSON.stringify({ action, input, target }),
        })
      ).json() as Promise<{ ok: boolean; value?: unknown; message?: string }>;
    const claimed = await call("claimBuildInput", r.claim);
    expect(claimed).toMatchObject({
      ok: true,
      value: { status: "claimed", mode: "start", attemptNumber: 1 },
    });
    expect(await call("authorizeBuildStart", { scope: r.scope, claimId: r.claim.claimId })).toEqual(
      { ok: true, value: true },
    );
    const receipt = { ...r.receipt, buildId: `test-builds:${r.scope.operationId}` };
    const envelope = { ...r.envelope, receipt };
    expect(await call("putBuildReceipt", envelope)).toEqual({ ok: true, value: null });
    expect(await call("claimBuildInput", { ...r.claim, claimId: cid() })).toMatchObject({
      ok: true,
      value: { status: "completed", envelope },
    });
    const read = await call("readBuild", { receipt, bucket: "omh-builds-test-us" });
    expect(read).toMatchObject({ ok: true, value: { status: "succeeded", usage: USAGE } });
    expect(await call("putBuildUsage", { receipt, usage: USAGE })).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await core
        .prepare("SELECT kind,delta_micros FROM credit_log WHERE key=?")
        .bind(`settle:${r.scope.operationId}`)
        .first(),
    ).toEqual({ kind: "settle", delta_micros: -2_349_628 });
    expect(
      await call("claimBuildInput", { ...r.claim, inputFingerprint: `sha256:${"cd".repeat(32)}` }),
    ).toMatchObject({
      ok: false,
      message: "Build input conflicts with the reserved operation scope",
    });
    for (const [action, input] of [
      ["claimBuildInput", r.claim],
      ["authorizeBuildStart", { scope: r.scope, claimId: r.claim.claimId }],
      ["putBuildReceipt", envelope],
      ["putBuildUsage", { receipt, usage: USAGE }],
    ] as const) {
      expect(await call(action, input, "missing")).toMatchObject({ ok: false });
    }
  } finally {
    await mf.dispose();
  }
}, 60_000);
