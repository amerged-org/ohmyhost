import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type { D1Database } from "../../control-store/src/d1-types.js";
import {
  activateTestCore,
  migrate,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
    banner: {
      js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire("/fixture.js");',
    },
    plugins: [
      {
        name: "external-builtins-and-trap-gateway-pg",
        setup(b) {
          b.onResolve({ filter: /^pg$/ }, (args) =>
            args.importer.endsWith("/control-api/src/gateway-routing.ts")
              ? { path: "gateway-pg-trap", namespace: "gateway-pg-trap" }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "gateway-pg-trap" }, () => ({
            contents:
              'export class Pool { constructor(){globalThis.__gatewayPoolCalls=(globalThis.__gatewayPoolCalls??0)+1;throw new Error("PG_POOL_CONSTRUCTION_FORBIDDEN");} }',
            loader: "js",
          }));
          b.onResolve({ filter: /^[a-z_][a-z0-9_/-]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error("Missing Worker bundle");
  return output.text;
}

it("runs actual WFP activation/observation/compensation through actual Gateway and probe Workers into real Core without constructing a PG pool", async () => {
  const require = createRequire(new URL("../../control-store/package.json", import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    require.resolve("wrangler/package.json"),
  )("miniflare") as {
    convertV4MiniflareOptions(options: unknown): unknown;
    Miniflare: new (options: unknown) => {
      getD1Database(name: string, worker: string): Promise<unknown>;
      getWorker(
        name: string,
      ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
      dispose(): Promise<void>;
    };
  };
  const [coreScript, apiScript, wfpScript] = await Promise.all([
    bundle(
      'export {GatewayLookupRuntime,GatewayManagementRuntime,RuntimeProbeRuntime,GatewayCreditRuntime,RuntimeSecretAuthorityRuntime} from "./apps/control-store/src/worker-main.ts"; export default {fetch(){return new Response("private");}};',
    ),
    bundle(`export {GatewayRoutingService,GatewayRoutingManagementService} from "./apps/control-api/src/gateway-routing-worker.ts";
      import {RuntimeCreditService} from "./apps/control-api/src/worker-main.ts";
      import {WorkerEntrypoint} from "cloudflare:workers";
      export class Probe extends RuntimeCreditService {constructor(ctx,env){super(ctx,{...env,CONTROL_API_RATE_LIMITER:{async limit(){return {success:true};}}});}}
      export class Diagnostics extends WorkerEntrypoint {read(){return {gateway:globalThis.__gatewayPoolCalls??0};}}
      export default {fetch(){return new Response("private");}};`),
    bundle(`import {WfpManagementService,createWfpManagementRuntime} from "./apps/wfp-management/src/worker-main.ts";
      // Only Cloudflare's external HTTP and private-dispatch transports are substituted. No action runner,
      // Gateway, probe, persistence, receipt or secret-delivery implementation is replaced.
      let deleted=false,deleteCalls=0;
      async function provider(request,init){const url=new URL(typeof request==="string"?request:request.url);const script=url.pathname.split("/").at(-1);const deployment=script.slice(-26).toUpperCase();
        if(!["GET","DELETE"].includes(init?.method??"GET")||url.hostname!=="api.cloudflare.com"||!url.pathname.includes("/dispatch/namespaces/ohmyho-production/scripts/"))throw new Error("Unexpected provider call");
        if(init?.method==="DELETE"){deleted=true;deleteCalls++;return Response.json({success:true,errors:[],messages:[],result:null});}
        if(deleted)return Response.json({success:false,errors:[{code:10007}],messages:[],result:null},{status:404});
        const scope=await globalThis.__inputScope();return Response.json({success:true,errors:[],messages:[],result:{modified_on:new Date().toISOString(),script:{id:script,tag:"b".repeat(32),deployment_id:"b".repeat(32),tags:["project:"+scope.projectId,"environment:"+scope.environmentId,"deployment:"+deployment,"artifact:sha256:"+"03".repeat(32),"layout:gateway-scopes-v1"]}}});}
      export class Wfp extends WfpManagementService {
        runtime(input){globalThis.__inputScope=async()=>input.scope; return createWfpManagementRuntime({...this.env,WFP_DISPATCH:{get(script){return {async fetch(request){if(!script.startsWith("p-")||!request.url.includes("/health"))throw new Error("Unexpected private probe");return new Response("healthy");}};} }},{fetch:provider});}
        activateCandidate(input){return this.runtime(input).activateCandidate(input);}
        observeActivation(input){return this.runtime(input).observeActivation(input);}
        compensateGatewayActivation(input){return this.runtime(input).compensateGatewayActivation(input);}
        removeCandidate(input){return this.runtime(input).removeCandidate(input);}
        deleteCalls(){return deleteCalls;}
      } export default {fetch(){return new Response("private");}};`),
  ]);
  const common = {
    modules: true,
    compatibilityDate: "2026-08-24",
    compatibilityFlags: ["nodejs_compat"],
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...common,
          name: "core",
          script: coreScript,
          d1Databases: { CONTROL_CORE: "gateway-core" },
        },
        {
          ...common,
          name: "api",
          script: apiScript,
          bindings: {
            DEV_ACCESS_SESSION_PUBLIC_JWK: "unused-for-prod",
          },
          serviceBindings: {
            GATEWAY_LOOKUP_RUNTIME: { name: "core", entrypoint: "GatewayLookupRuntime" },
            GATEWAY_MANAGEMENT_RUNTIME: { name: "core", entrypoint: "GatewayManagementRuntime" },
            RUNTIME_PROBE_RUNTIME: { name: "core", entrypoint: "RuntimeProbeRuntime" },
            GATEWAY_CREDIT_RUNTIME: { name: "core", entrypoint: "GatewayCreditRuntime" },
          },
        },
        {
          ...common,
          name: "wfp",
          script: wfpScript,
          bindings: {
            WFP_ACCOUNT_ID: "a".repeat(32),
            WFP_API_TOKEN: "fixture-token",
            WFP_DISPATCH_NAMESPACE: "ohmyho-production",
            WFP_WORKERS_DEV_SUBDOMAIN: "fixture",
            DATABASE_SERVICE_US: "ohmyho-project-database-production-us",
            DATABASE_SERVICE_EU: "ohmyho-project-database-production-eu",
            BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-production",
            BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-production-eu",
          },
          r2Buckets: { BUILD_OBJECTS_US: "build-us", BUILD_OBJECTS_EU: "build-eu" },
          serviceBindings: {
            GATEWAY_REGISTRY: { name: "api", entrypoint: "GatewayRoutingManagementService" },
            RUNTIME_PROBES: { name: "api", entrypoint: "Probe" },
            RUNTIME_SECRET_AUTHORITY: { name: "core", entrypoint: "RuntimeSecretAuthorityRuntime" },
          },
        },
        {
          ...common,
          name: "caller",
          script: `export default {async fetch(request,env){const {target,action,input}=await request.json();try {const value=await env[target][action](input);return Response.json({ok:true,value});}catch(e){return Response.json({ok:false,message:String(e.message)});}}};`,
          serviceBindings: {
            WFP: { name: "wfp", entrypoint: "Wfp" },
            GATEWAY: { name: "api", entrypoint: "GatewayRoutingManagementService" },
            LOOKUP: { name: "api", entrypoint: "GatewayRoutingService" },
            PROBE: { name: "api", entrypoint: "Probe" },
            DIAG: { name: "api", entrypoint: "Diagnostics" },
            CORE_LOOKUP: { name: "core", entrypoint: "GatewayLookupRuntime" },
          },
        },
      ],
    }),
  );
  try {
    const core = (await mf.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(core, "core");
    await activateTestCore(core);
    const control: TestControl = {
      core,
      bindings: { CONTROL_CORE: core },
      directory: core,
      shards: { CONTROL_SHARD_0000: core },
      dispose: async () => undefined,
    };
    const r = await gatewayFixture(control),
      caller = await mf.getWorker("caller");
    const call = async (target: string, action: string, input: unknown = {}) =>
      (
        await caller.fetch("https://fixture/", {
          method: "POST",
          body: JSON.stringify({ target, action, input }),
        })
      ).json() as Promise<{ ok: boolean; value?: unknown; message?: string }>;
    const previous = await r.store.gateway.management.observe(r.scope);
    const candidate = {
      provider: "cloudflare-wfp",
      namespace: "ohmyho-production",
      scriptName: r.script,
      projectId: r.project.projectId,
      environmentId: r.project.prodEnvironmentId,
      productDeploymentId: r.deploymentId,
      providerTag: r.providerTag,
      artifactDigest: `sha256:${"03".repeat(32)}`,
      buildReused: true,
      deployedAt: new Date("2026-10-28T10:00:00.000Z"),
    };
    const base = {
      organizationId: r.project.organizationId,
      scope: {
        projectId: r.project.projectId,
        environmentId: r.project.prodEnvironmentId,
        environmentName: "prod",
        handle: r.project.handle,
      },
      candidate,
      runtimePolicy: { healthCheckPath: "/health", egressAllowedOrigins: [] },
    };
    const activated = await call("WFP", "activateCandidate", {
      ...base,
      operationId: r.accepted.operationId,
      claimId: r.accepted.claimId,
      candidateReceiptId: r.candidateReceiptId,
      previousGateway: previous,
    });
    expect(activated).toMatchObject({
      ok: true,
      value: {
        status: "activated",
        gateway: { revision: 2, candidateReceiptId: r.candidateReceiptId },
      },
    });
    const gateway = (activated.value as { gateway: unknown }).gateway;
    expect(
      await call("WFP", "observeActivation", { ...base, expectedGateway: gateway }),
    ).toMatchObject({ ok: true, value: { status: "activated", gateway: { revision: 2 } } });
    expect(await call("LOOKUP", "resolve", { hostname: r.hostname })).toMatchObject({
      ok: true,
      value: { targetDeploymentId: r.published.deploymentId, devAccess: null },
    });
    expect(await call("CORE_LOOKUP", "activate", r.activation)).toMatchObject({ ok: false });
    expect(
      await call("PROBE", "beginProbe", {
        ...r.scope,
        deploymentId: r.deploymentId,
        now: "2099-01-01",
      }),
    ).toMatchObject({ ok: false, message: "Runtime probe accounting is unavailable" });
    const serving = await call("PROBE", "read", { ...r.scope, includePaidPlan: true });
    expect(serving).toMatchObject({
      ok: true,
      value: { ...r.scope, allowed: true, paidAllowed: false, reason: null },
    });
    const readAt = serving.value as { checkedAt: string; expiresAt: string };
    expect(Date.parse(readAt.expiresAt) - Date.parse(readAt.checkedAt)).toBe(900_000);
    expect(await call("PROBE", "read", { ...r.scope, includePaidPlan: false })).toMatchObject({
      ok: false,
      message: "Runtime credit admission is unavailable",
    });
    const windows = (
      await core
        .prepare("SELECT starts_at,expires_at FROM runtime_probe_windows")
        .all<{ starts_at: string; expires_at: string }>()
    ).results;
    expect(windows).toHaveLength(2);
    for (const w of windows)
      expect(Date.parse(w.expires_at) - Date.parse(w.starts_at)).toBe(210000);
    expect(
      await call("WFP", "compensateGatewayActivation", {
        organizationId: base.organizationId,
        scope: base.scope,
        candidate,
        operationId: r.accepted.operationId,
        claimId: r.accepted.claimId,
        expectedGateway: gateway,
        previousGateway: previous,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        status: "compensated",
        gateway: { revision: 3, candidateReceiptId: r.published.candidateReceiptId },
        candidateRetained: true,
      },
    });
    const removal = {
      organizationId: base.organizationId,
      operationId: r.accepted.operationId,
      claimId: r.accepted.claimId,
      candidateReceiptId: r.candidateReceiptId,
      scope: base.scope,
      candidate,
    };
    expect(await call("WFP", "removeCandidate", removal)).toMatchObject({ ok: false });
    expect(await call("WFP", "deleteCalls")).toEqual({ ok: true, value: 0 });
    await core.batch([
      core
        .prepare(
          "INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at) VALUES(?1,?2,?3,?4,?5,'failed','2026-10-28T10:00:00.000000Z')",
        )
        .bind(
          r.accepted.claimId,
          r.candidateReceiptId,
          r.scope.organizationId,
          r.scope.projectId,
          r.accepted.operationId,
        ),
      core
        .prepare(
          "INSERT INTO wfp_candidate_cleanup_claims(candidate_receipt_id,organization_id,project_id,claim_id,attempt_number,claimed_at,lease_expires_at) VALUES(?1,?2,?3,?4,1,'2026-10-28T10:00:00.000000Z','2099-01-01T00:00:00.000000Z')",
        )
        .bind(r.candidateReceiptId, r.scope.organizationId, r.scope.projectId, r.accepted.claimId),
    ]);
    expect(await call("WFP", "removeCandidate", removal)).toMatchObject({
      ok: true,
      value: {
        status: "removed",
        outcome: "removed",
        receipt: {
          state: "metadata_absent",
          scriptName: r.script,
          expectedProviderTag: r.providerTag,
        },
      },
    });
    expect(await call("WFP", "removeCandidate", removal)).toMatchObject({
      ok: true,
      value: { status: "removed", outcome: "not_found" },
    });
    expect(await call("WFP", "deleteCalls")).toEqual({ ok: true, value: 1 });
    await core
      .prepare(
        "UPDATE wfp_candidate_cleanup_claims SET lease_expires_at='2026-10-28T11:00:00.000000Z'",
      )
      .run();
    expect(await call("WFP", "removeCandidate", removal)).toMatchObject({ ok: false });
    expect(await call("WFP", "deleteCalls")).toEqual({ ok: true, value: 1 });
    // The real provider absence travels back to the caller. Only the still-unported workflow finalizer may
    // append an immutable cleanup receipt; a legacy opaque outcome or authority read never fabricates one.
    expect(
      await core.prepare("SELECT count(*) n FROM wfp_candidate_cleanup_receipts").first(),
    ).toEqual({ n: 0 });
    await core
      .prepare("UPDATE projects SET owner_state='transfer_pending_frozen' WHERE project_id=?")
      .bind(r.project.projectId)
      .run();
    expect(await call("GATEWAY", "activate", r.activation)).toMatchObject({
      ok: false,
      message: "Gateway routing is unavailable",
    });
    expect(await call("DIAG", "read")).toEqual({ ok: true, value: { gateway: 0 } });
    expect((await core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 120000);
