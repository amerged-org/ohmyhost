import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";
import {
  migrate,
  activateTestCore,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { claimProductProviderMutation } from "../../control-store/src/catalog/provisioning/provider-claim.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function bundle(contents: string) {
  const output = await build({
    stdin: { contents, loader: "ts", resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    plugins: [
      {
        name: "native-builtins",
        setup(b) {
          b.onResolve({ filter: /^(?:node:)?[a-z][a-z0-9_/-]*$/ }, (args) => {
            const name = args.path.replace(/^node:/u, "");
            if (!builtinModules.includes(name)) return;
            return args.kind === "require-call"
              ? { path: name, namespace: "native-builtins" }
              : { path: `node:${name}`, external: true };
          });
          b.onLoad({ filter: /.*/, namespace: "native-builtins" }, (args) => ({
            contents: `import value from ${JSON.stringify(`node:${args.path}`)};module.exports=value;`,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!output.outputFiles[0]) throw new Error("Missing R2 worker bundle");
  return output.outputFiles[0].text;
}
it("executes actual R2 ensure/read/purge/usage through fixed Core RPC with genuine authorization and no SQL fallback", async () => {
  const core = await bundle(
    `import {R2ManagementRuntime} from './apps/control-store/src/worker-main.ts';import{createControlStore}from'./apps/control-store/src/store.ts';export {R2ManagementRuntime};
    export class LostR2Runtime extends R2ManagementRuntime {async authorizeBucket(input){await super.authorizeBucket(input);throw new Error('Network connection lost after create marker')}};
    export class FreezeR2Runtime extends R2ManagementRuntime {async authorizeBucket(input){
      const raw=this.env.CONTROL_CORE, saved=new WeakMap();
      const db={prepare(sql){const wrap=inner=>{const value={bind:(...v)=>wrap(inner.bind(...v)),first:()=>inner.first(),all:()=>inner.all(),run:()=>inner.run()};saved.set(value,{sql,inner});return value};return wrap(raw.prepare(sql))},async batch(statements){const rows=statements.map(s=>saved.get(s));if(rows.some(r=>r.sql.startsWith('UPDATE project_r2_bucket_reservations SET create_started_at'))){await raw.prepare("UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2").bind(input.organizationId,input.projectId).run()}return raw.batch(rows.map(r=>r.inner))}};
      return createControlStore({CONTROL_CORE:db}).r2Management.authorizeBucket(input);
    }};export default {fetch(){return new Response(null,{status:404})}}`,
  );
  const caller =
    await bundle(`import {R2ManagementService} from './apps/r2-management/src/worker-main.ts';
    export default {async fetch(request,env,ctx){const url=new URL(request.url);const input=await request.json();
      const cfg={RUNTIME_CONFIGURATION_STATE:'configured',R2_MANAGEMENT_RUNTIME:url.searchParams.has('freeze')?env.FREEZE:url.searchParams.has('lost')?env.LOST:env.CORE,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_R2_API_TOKEN:'token-'+ 'a'.repeat(32),CLOUDFLARE_R2_ANALYTICS_TOKEN:'analytics-'+ 'b'.repeat(32)};
      if(url.searchParams.has('raw'))Object.defineProperty(cfg,'CONTROL_DIRECTORY',{get(){throw new Error('POISON raw')}});
      globalThis.fetch=(address,init)=>env.PROVIDER.fetch(new Request(address,init));
      try{const service=new R2ManagementService(ctx,cfg);
        if(url.pathname==='/ensure')return Response.json(await service.ensureBucket(input));
        if(url.pathname==='/read')return Response.json(await service.readRuntimeBinding(input));
        if(url.pathname==='/purge'){input.observedAt=new Date(input.observedAt);return Response.json(await service.purgeAndDeleteBucket(input));}
        if(url.pathname==='/collect')return Response.json(await service.collectUsage(input));
        return Response.json({name:'NotFound',message:'unknown route'},{status:404});
      }catch(error){return Response.json({name:error.name,message:error.message},{status:409})}
    }};`);
  const buckets = new Set<string>();
  let creates = 0,
    reads = 0,
    rateLimited = false;
  const success = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "core",
          compatibilityDate: "2026-08-25",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: `${root}r2-core.mjs`, contents: core }],
          d1Databases: { CONTROL_CORE: "r2-core" },
        },
        {
          name: "management",
          compatibilityDate: "2026-08-25",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: `${root}r2-management.mjs`, contents: caller }],
          serviceBindings: {
            CORE: { name: "core", entrypoint: "R2ManagementRuntime" },
            LOST: { name: "core", entrypoint: "LostR2Runtime" },
            FREEZE: { name: "core", entrypoint: "FreezeR2Runtime" },
            PROVIDER: async (request: Request) => {
              const url = new URL(request.url);
              reads++;
              if (url.pathname.endsWith("/graphql") && rateLimited)
                return Response.json(
                  { errors: [{ message: "rate limited" }] },
                  { status: 429, headers: { "retry-after": "60" } },
                );
              if (url.pathname.endsWith("/graphql"))
                return Response.json({
                  data: { viewer: { accounts: [{ storage: [], operations: [] }] } },
                  errors: [],
                });
              const name = url.pathname.split("/r2/buckets/")[1]?.split("/")[0];
              if (request.method === "POST") {
                const body = (await request.json()) as { name: string };
                buckets.add(body.name);
                creates++;
                return success({ name: body.name, jurisdiction: "eu", storage_class: "Standard" });
              }
              if (!name || !buckets.has(name))
                return Response.json(
                  {
                    success: false,
                    errors: [{ code: 10006, message: "Bucket not found" }],
                    messages: [],
                    result: null,
                  },
                  { status: 404 },
                );
              if (url.pathname.endsWith("/domains/managed"))
                return success({
                  bucketId: "c".repeat(32),
                  domain: `pub-${"c".repeat(32)}.r2.dev`,
                  enabled: false,
                });
              if (url.pathname.endsWith("/domains/custom")) return success({ domains: [] });
              if (url.pathname.endsWith("/objects")) return success([]);
              if (request.method === "DELETE") {
                buckets.delete(name);
                return success({});
              }
              return success({ name, jurisdiction: "eu", storage_class: "Standard" });
            },
          },
        },
      ],
    }),
  );
  try {
    const db = (await mf.getD1Database("CONTROL_CORE", "core")) as unknown as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: async () => {},
    };
    const r = await workflowFixture(control),
      context = { directory: db, router: new SharedCoreRouter(db) };
    await claimProductProviderMutation(context, r.input);
    const input = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      claimId: r.input.claimId,
      jurisdiction: "eu",
    };
    const management = await mf.getWorker("management");
    const call = async (path: string, input: unknown) => {
      const response = await management.fetch(`http://localhost${path}`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const ensured = await call("/ensure", input);
    expect(ensured).toMatchObject({ status: 200, body: { status: "ready", outcome: "created" } });
    expect(creates).toBe(1);
    expect(await call("/ensure", input)).toMatchObject({
      status: 200,
      body: { status: "ready", outcome: "replayed" },
    });
    const readScope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
    };
    expect(await call("/read", readScope)).toMatchObject({
      status: 200,
      body: { status: "ready", jurisdiction: "eu" },
    });
    // The day's confirmed storage comes from the Core's managed-file tables over the fixed RPC.
    const day = "2026-10-01T00:00:00.000Z";
    const usage = {
      day,
      buckets: [
        {
          bucketName: `ohmyho-${input.projectId.toLowerCase()}-${input.environmentId.toLowerCase()}`,
          jurisdiction: "eu",
        },
      ],
    };
    expect(await call("/collect", usage)).toEqual({
      status: 200,
      body: {
        day,
        buckets: [
          {
            ...usage.buckets[0],
            storagePeakBytes: "0",
            classA: "0",
            classB: "0",
            inexactHours: 0,
          },
        ],
      },
    });
    const today = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    const early = { ...usage, day: today };
    expect(await call("/collect", early)).toMatchObject({
      status: 409,
      body: { name: "TypeError", message: "R2 usage day is not finished" },
    });
    const providerBefore = reads;
    expect((await call("/read?raw=1", readScope)).status).toBe(409);
    expect(reads).toBe(providerBefore);
    rateLimited = true;
    expect(await call("/collect", usage)).toMatchObject({
      status: 409,
      body: { message: "R2 usage rate limited" },
    });
    expect(await call("/purge", ensured.body["receipt"])).toMatchObject({
      status: 200,
      body: { status: "absent", outcome: "deleted" },
    });
    const second = await workflowFixture(control);
    await claimProductProviderMutation(context, second.input);
    const lostInput = {
      organizationId: second.p.organizationId,
      projectId: second.p.projectId,
      environmentId: second.input.environmentId,
      operationId: second.input.operationId,
      claimId: second.input.claimId,
      jurisdiction: "eu",
    };
    const before = creates;
    expect((await call("/ensure?lost=1", lostInput)).status).toBe(409);
    expect(creates).toBe(before);
    expect(await call("/ensure", lostInput)).toMatchObject({
      status: 200,
      body: { status: "reconciliation_required", reason: "provider_absent" },
    });
    expect(creates).toBe(before);
    const raced = await workflowFixture(control);
    await claimProductProviderMutation(context, raced.input);
    const racedInput = {
      organizationId: raced.p.organizationId,
      projectId: raced.p.projectId,
      environmentId: raced.input.environmentId,
      operationId: raced.input.operationId,
      claimId: raced.input.claimId,
      jurisdiction: "eu",
    };
    expect((await call("/ensure?freeze=1", racedInput)).status).toBe(409);
    expect(creates).toBe(before);
    expect(
      (
        await db
          .prepare(
            "SELECT create_started_at FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(raced.p.organizationId, raced.p.projectId)
          .first()
      )?.["create_started_at"],
    ).toBeNull();
  } finally {
    await mf.dispose();
  }
}, 120000);
