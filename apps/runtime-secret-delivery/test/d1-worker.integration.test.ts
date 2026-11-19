import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import {
  createRuntimeSecretManifest,
  type RuntimeSecretBinding,
} from "@ohmyhost/provider-cloudflare";
import {
  AI_KEY_PATTERN,
  createAiKey,
  createEnvironmentSecretCipherKeyring,
  parseUlid,
} from "@ohmyhost/platform";
import { createBrowserKey } from "@ohmyhost/platform/shared";
import { createD1RuntimeSecretPersistence } from "../src/d1-persistence.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import {
  migrate,
  activateTestCore,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import { newUlid } from "../../control-store/src/catalog/common.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function bundle(contents: string) {
  const output = await build({
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
      js: 'import {createRequire as __secretFixtureCreateRequire} from "node:module";const require=__secretFixtureCreateRequire("/fixture.js");',
    },
    plugins: [
      {
        name: "native-builtins-and-direct-pool-trap",
        setup(b) {
          b.onResolve({ filter: /^pg$/ }, (args) =>
            args.importer.endsWith("/control-api/src/gateway-routing.ts")
              ? { path: "pool-trap", namespace: "pool-trap" }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "pool-trap" }, () => ({
            loader: "js",
            contents:
              'export class Pool {constructor(){globalThis.__poolCalls=(globalThis.__poolCalls??0)+1;throw new Error("PG_POOL_CONSTRUCTION_FORBIDDEN");}}',
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
  const file = output.outputFiles[0];
  if (file === undefined) throw new Error("Missing Worker bundle");
  return file.text;
}

it("runs actual Secret/WFP/Gateway/probe/Core Workers with real encryption and accepted empty/nonempty stages", async () => {
  const require = createRequire(new URL("../../control-store/package.json", import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    require.resolve("wrangler/package.json"),
  )("miniflare") as {
    convertV4MiniflareOptions(value: unknown): unknown;
    Miniflare: new (value: unknown) => {
      getD1Database(name: string, worker: string): Promise<unknown>;
      getWorker(
        name: string,
      ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
      dispose(): Promise<void>;
    };
  };
  const [coreScript, apiScript, secretScript, wfpScript] = await Promise.all([
    bundle(
      'export {RuntimeSecretDeliveryRuntime,RuntimeSecretAuthorityRuntime,GatewayManagementRuntime,GatewayLookupRuntime,RuntimeProbeRuntime} from "./apps/control-store/src/worker-main.ts";export default {fetch(){return new Response("private");}};',
    ),
    bundle(
      `export {GatewayRoutingManagementService} from "./apps/control-api/src/gateway-routing-worker.ts";import {RuntimeCreditService} from "./apps/control-api/src/worker-main.ts";export class Probe extends RuntimeCreditService {constructor(ctx,env){super(ctx,{...env,CONTROL_API_RATE_LIMITER:{async limit(){return {success:true};}}});}}export default {fetch(){return new Response("private");}};`,
    ),
    bundle(`import {WorkerEntrypoint} from "cloudflare:workers";import {RuntimeSecretDeliveryService,default as RuntimeSecretDeliveryWorker} from "./apps/runtime-secret-delivery/src/worker-main.ts";export {RuntimeSecretDeliveryService,RuntimeSecretDeliveryWorker};
 let getters=0;export class Diagnostics extends WorkerEntrypoint {read(){return {getters};}}
 export class Missing extends RuntimeSecretDeliveryService {constructor(ctx,env){super(ctx,{...env,RUNTIME_SECRET_RUNTIME:undefined});}}
 export class Mixed extends RuntimeSecretDeliveryService {constructor(ctx,env){const invalid={...env};Object.defineProperty(invalid,"CONTROL_DIRECTORY",{enumerable:true,get(){getters++;throw new Error("DIRECT_CORE_GETTER_FORBIDDEN");}});super(ctx,invalid);}}
 export default {fetch(){return new Response("private");}};`),
    bundle(`import {WfpManagementService,createWfpManagementRuntime} from "./apps/wfp-management/src/worker-main.ts";
 let scope,stages=0;async function provider(request,init){const url=new URL(typeof request==="string"?request:request.url),script=url.pathname.split("/").at(-1);if((init?.method??"GET")!=="GET"||url.hostname!=="api.cloudflare.com"||!url.pathname.includes("/dispatch/namespaces/ohmyho-production/scripts/"))throw new Error("Unexpected external provider call");return Response.json({success:true,errors:[],messages:[],result:{modified_on:new Date().toISOString(),script:{id:script,tag:"b".repeat(32),deployment_id:"b".repeat(32),tags:["project:"+scope.projectId,"environment:"+scope.environmentId,"deployment:"+script.slice(-26).toUpperCase(),"artifact:sha256:"+"03".repeat(32),"layout:gateway-scopes-v1"]}}});}
 export class Wfp extends WfpManagementService {
 runtime(input){scope=input.scope;return createWfpManagementRuntime({...this.env,WFP_DISPATCH:{get(script){return {async fetch(request){if(!script.startsWith("p-")||!request.url.includes("/health"))throw new Error("Unexpected private probe");return new Response("healthy");}};}}},{fetch:provider});}
 activateCandidate(input){return this.runtime(input).activateCandidate(input);}observeActivation(input){return this.runtime(input).observeActivation(input);}compensateGatewayActivation(input){return this.runtime(input).compensateGatewayActivation(input);}
 stageVerifiedArtifact(input){stages++;return this.runtime(input).stageVerifiedArtifact(input);}stageCalls(){return stages;}}
 export default {fetch(){return new Response("private");}};`),
  ]);
  const common = {
      modules: true,
      compatibilityDate: "2026-08-24",
      compatibilityFlags: ["nodejs_compat"],
    },
    key = Buffer.alloc(32, 7).toString("base64");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...common,
          name: "core",
          script: coreScript,
          d1Databases: { CONTROL_CORE: "secret-core" },
        },
        {
          ...common,
          name: "api",
          script: apiScript,
          bindings: {
            DEV_ACCESS_SESSION_PUBLIC_JWK: "unused-prod",
          },
          serviceBindings: {
            GATEWAY_MANAGEMENT_RUNTIME: { name: "core", entrypoint: "GatewayManagementRuntime" },
            RUNTIME_PROBE_RUNTIME: { name: "core", entrypoint: "RuntimeProbeRuntime" },
          },
        },
        {
          ...common,
          name: "secrets",
          script: secretScript,
          bindings: {
            RUNTIME_CONFIGURATION_STATE: "configured",
            ENVIRONMENT_SECRET_KEY_BASE64: key,
            ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: "{}",
            ENVIRONMENT_SECRET_KEY_VERSION: "1",
          },
          serviceBindings: {
            RUNTIME_SECRET_RUNTIME: { name: "core", entrypoint: "RuntimeSecretDeliveryRuntime" },
            WFP_MANAGEMENT: { name: "wfp", entrypoint: "Wfp" },
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
          script: `export default {async fetch(request,env){const {target,action,input}=await request.json();try{const value=await env[target][action](input);return new Response(JSON.stringify({ok:true,value},(_,v)=>v instanceof Uint8Array?Array.from(v):v),{headers:{"content-type":"application/json"}});}catch(e){return Response.json({ok:false,message:String(e.message)});}}};`,
          serviceBindings: {
            SECRET: { name: "secrets", entrypoint: "RuntimeSecretDeliveryService" },
            SCHEDULE: { name: "secrets", entrypoint: "RuntimeSecretDeliveryWorker" },
            DIAG: { name: "secrets", entrypoint: "Diagnostics" },
            MISSING: { name: "secrets", entrypoint: "Missing" },
            MIXED: { name: "secrets", entrypoint: "Mixed" },
            CORE: { name: "core", entrypoint: "RuntimeSecretDeliveryRuntime" },
            GATEWAY: { name: "api", entrypoint: "GatewayRoutingManagementService" },
            WFP: { name: "wfp", entrypoint: "Wfp" },
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
      },
      caller = await mf.getWorker("caller");
    const call = async (target: string, action: string, input: unknown = {}) =>
      (
        await caller.fetch("https://fixture/", {
          method: "POST",
          body: JSON.stringify({ target, action, input }),
        })
      ).json() as Promise<{ ok: boolean; value?: unknown; message?: string }>;
    const cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: key,
      additionalKeysJson: "{}",
      currentKeyVersion: 1,
      crypto: globalThis.crypto,
    });
    for (const nonempty of [false, true]) {
      const r = await gatewayFixture(control),
        plain = "postgresql://fixture.invalid/private-value";
      if (nonempty)
        expect(
          await call("SECRET", "installPlatformSecret", {
            ...r.scope,
            operationId: r.accepted.operationId,
            claimId: r.accepted.claimId,
            name: "DATABASE_URL",
            value: plain,
          }),
        ).toMatchObject({ ok: true, value: { name: "DATABASE_URL", revision: 1 } });
      const leaseId = newUlid(),
        claimed = await call("CORE", "claim", {
          ...r.scope,
          operationId: r.accepted.operationId,
          trigger: "deploy",
          runtimeProvider: "wfp",
          leaseId,
          claimedAt: new Date().toISOString(),
          leaseMilliseconds: 120000,
        });
      expect(claimed).toMatchObject({
        ok: true,
        value: {
          outcome: "claimed",
          generation: nonempty ? 1 : 0,
          secrets: nonempty ? [{ name: "DATABASE_URL" }] : [],
        },
      });
      const claim = claimed.value as {
        generation: number;
        releaseSequence: number;
        secrets: {
          name: string;
          ciphertext: number[];
          nonce: number[];
          valueSha256: number[];
          keyVersion: number;
          revision: number;
        }[];
      };
      const entries: RuntimeSecretBinding[] = [];
      for (const secret of claim.secrets) {
        const decoded = await cipher.openEnvironmentSecret({
          ...r.scope,
          organizationId: parseUlid(r.scope.organizationId),
          projectId: parseUlid(r.scope.projectId),
          environmentId: parseUlid(r.scope.environmentId),
          name: secret.name,
          ciphertext: Uint8Array.from(secret.ciphertext),
          nonce: Uint8Array.from(secret.nonce),
          valueSha256: Uint8Array.from(secret.valueSha256),
          keyVersion: secret.keyVersion,
        });
        expect(decoded).toBe(plain);
        entries.push({
          name: secret.name,
          value: decoded,
          revision: secret.revision,
          valueSha256: `sha256:${createHash("sha256").update(decoded).digest("hex")}`,
        });
      }
      const manifest = await createRuntimeSecretManifest(entries);
      const scope = {
          ...r.scope,
          environmentName: "prod",
          handle: r.project.handle,
          operationId: r.accepted.operationId,
        },
        candidate = {
          provider: "cloudflare-wfp",
          namespace: "ohmyho-production",
          scriptName: r.script,
          projectId: r.scope.projectId,
          environmentId: r.scope.environmentId,
          productDeploymentId: r.deploymentId,
          providerTag: r.providerTag,
          artifactDigest: `sha256:${"03".repeat(32)}`,
          buildReused: true,
          deployedAt: "2026-10-28T10:00:00.000Z",
        };
      // Accepted upstream candidate facts; artifact upload/build admission is independently qualified, not faked here.
      const pending = {
        stageReceiptId: newUlid(),
        operationId: r.accepted.operationId,
        productDeploymentId: r.deploymentId,
        leaseId,
        generation: claim.generation,
        releaseSequence: claim.releaseSequence,
        trigger: "deploy",
        providerTag: r.providerTag,
        appliedSecretNames: manifest.secrets.map((s) => s.name),
        manifestDigest: manifest.digest,
        manifestSecretCount: manifest.secrets.length,
        stagedAt: new Date().toISOString(),
      };
      const recorded = await call("SECRET", "recordStagedCandidate", {
        scope,
        candidate,
        candidateReceiptId: r.candidateReceiptId,
        runtimeSecretDeliveryStage: pending,
      });
      expect(recorded).toMatchObject({
        ok: true,
        value: {
          status: "recorded",
          runtimeSecretDeliveryStage: { candidateReceiptId: r.candidateReceiptId },
        },
      });
      const stage = (recorded.value as { runtimeSecretDeliveryStage: unknown })
          .runtimeSecretDeliveryStage,
        previous = (await call("GATEWAY", "observe", r.scope)).value;
      const activated = await call("SECRET", "activateCandidate", {
        scope,
        candidate,
        claimId: r.accepted.claimId,
        previousGateway: previous,
        runtimePolicy: { healthCheckPath: "/health", egressAllowedOrigins: [] },
        runtimeSecretDeliveryStage: stage,
      });
      expect(activated).toMatchObject({
        ok: true,
        value: { status: "activated", gateway: { revision: 2 } },
      });
      const gateway = (activated.value as { gateway: unknown }).gateway;
      expect(
        await call("SECRET", "recordActivatedCandidate", {
          scope,
          candidate,
          gateway,
          runtimeSecretDeliveryStage: stage,
        }),
      ).toMatchObject({ ok: true, value: { status: "activated" } });
      expect(
        await call("SECRET", "observeActivation", {
          scope,
          candidate,
          runtimePolicy: { healthCheckPath: "/health", egressAllowedOrigins: [] },
          runtimeSecretDeliveryStage: stage,
        }),
      ).toMatchObject({ ok: true, value: { status: "activated", health: { status: 200 } } });
      expect(JSON.stringify([recorded, activated])).not.toContain(plain);
      expect(await call("CORE", "readState", r.scope)).toMatchObject({
        ok: true,
        value: {
          appliedGeneration: claim.generation,
          appliedReleaseSequence: claim.releaseSequence,
        },
      });
    }
    expect(await call("SCHEDULE", "scheduled")).toMatchObject({ ok: true });
    const invalid = await gatewayFixture(control),
      value = "fixture-secret-decrypt-path";
    expect(
      await call("SECRET", "installPlatformSecret", {
        ...invalid.scope,
        operationId: invalid.accepted.operationId,
        claimId: invalid.accepted.claimId,
        name: "DATABASE_URL",
        value,
      }),
    ).toMatchObject({ ok: true });
    const before = await call("WFP", "stageCalls");
    const badArtifact = {
      scope: {
        ...invalid.scope,
        environmentName: "prod",
        handle: invalid.project.handle,
        operationId: invalid.accepted.operationId,
      },
      deploymentId: invalid.deploymentId,
      artifact: {},
      knownDeployments: [],
    };
    expect(await call("SECRET", "stageCandidate", badArtifact)).toMatchObject({ ok: false });
    expect(await call("WFP", "stageCalls")).toEqual({ ok: true, value: Number(before.value) + 1 }); // Actual runtime decrypted before the actual WFP input refusal.
    const generatedScope = {
      ...invalid.scope,
      operationId: invalid.accepted.operationId,
      claimId: invalid.accepted.claimId,
    };
    expect(await call("SECRET", "ensureCustomerAuthSecret", generatedScope)).toMatchObject({
      ok: true,
      value: { name: "BETTER_AUTH_SECRET", revision: 1 },
    });
    expect(await call("SECRET", "ensureStorageGatewayKey", generatedScope)).toMatchObject({
      ok: false,
    });
    expect(await call("SECRET", "ensureMailGatewayKey", generatedScope)).toMatchObject({
      ok: false,
    });
    expect(await call("SECRET", "ensureAiGatewayKey", generatedScope)).toMatchObject({
      ok: true,
      value: { name: "OHMYHOST_AI_KEY", revision: 1 },
    });
    expect(await call("SECRET", "ensureBrowserGatewayKey", generatedScope)).toMatchObject({
      ok: true,
      value: { name: "OHMYHOST_BROWSER_KEY", revision: 1 },
    });
    const readAiKey = () =>
      core
        .prepare(
          "SELECT hex(ciphertext) AS ciphertext, hex(nonce) AS nonce, hex(value_sha256) AS valueSha256, key_version AS keyVersion, revision FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='OHMYHOST_AI_KEY'",
        )
        .bind(invalid.scope.organizationId, invalid.scope.projectId, invalid.scope.environmentId)
        .first<{
          ciphertext: string;
          nonce: string;
          valueSha256: string;
          keyVersion: number;
          revision: number;
        }>();
    const installedAiKey = await readAiKey();
    if (installedAiKey === null) throw new Error("Expected an encrypted AI gateway key");
    const aiScope = {
      organizationId: parseUlid(invalid.scope.organizationId),
      projectId: parseUlid(invalid.scope.projectId),
      environmentId: parseUlid(invalid.scope.environmentId),
      name: "OHMYHOST_AI_KEY" as const,
    };
    const originalAiKey = await cipher.decrypt({
      ...aiScope,
      ciphertext: Uint8Array.from(Buffer.from(installedAiKey.ciphertext, "hex")),
      nonce: Uint8Array.from(Buffer.from(installedAiKey.nonce, "hex")),
      valueSha256: Uint8Array.from(Buffer.from(installedAiKey.valueSha256, "hex")),
      keyVersion: installedAiKey.keyVersion,
    });
    expect(AI_KEY_PATTERN.exec(originalAiKey)?.[1]).toBe(invalid.scope.projectId);
    const replacementAiKey = createAiKey(
      aiScope.projectId,
      Buffer.alloc(32, 9).toString("base64url"),
    );
    // The source persistence adapter reaches the same real Core as the native Worker RPC above. Replaying with
    // different, genuinely encrypted key material must preserve the first installed key and its revision.
    const persistence = createD1RuntimeSecretPersistence(invalid.store.runtimeSecrets);
    expect(
      await persistence.ensureAiGateway({
        ...aiScope,
        operationId: parseUlid(invalid.accepted.operationId),
        claimId: parseUlid(invalid.accepted.claimId),
        ...(await cipher.encrypt({ ...aiScope, value: replacementAiKey })),
        writtenAt: new Date().toISOString(),
      }),
    ).toMatchObject({ name: "OHMYHOST_AI_KEY", revision: 1, keyVersion: 1 });
    expect(await readAiKey()).toEqual(installedAiKey);
    expect(originalAiKey).not.toBe(replacementAiKey);
    const browserScope = { ...aiScope, name: "OHMYHOST_BROWSER_KEY" as const };
    const readBrowserKey = () =>
      core
        .prepare(
          "SELECT hex(ciphertext) AS ciphertext, hex(nonce) AS nonce, hex(value_sha256) AS valueSha256, key_version AS keyVersion, revision FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='OHMYHOST_BROWSER_KEY'",
        )
        .bind(invalid.scope.organizationId, invalid.scope.projectId, invalid.scope.environmentId)
        .first<{
          ciphertext: string;
          nonce: string;
          valueSha256: string;
          keyVersion: number;
          revision: number;
        }>();
    const installedBrowserKey = await readBrowserKey();
    if (installedBrowserKey === null) throw new Error("Expected an encrypted Browser gateway key");
    const replacementBrowserKey = createBrowserKey(
      browserScope.projectId,
      Buffer.alloc(32, 10).toString("base64url"),
    );
    const replacementBrowserCiphertext = await cipher.encrypt({
      ...browserScope,
      value: replacementBrowserKey,
    });
    expect(Buffer.from(replacementBrowserCiphertext.valueSha256).toString("hex")).not.toBe(
      installedBrowserKey.valueSha256.toLowerCase(),
    );
    expect(
      await persistence.ensureBrowserGateway({
        ...browserScope,
        operationId: parseUlid(invalid.accepted.operationId),
        claimId: parseUlid(invalid.accepted.claimId),
        ...replacementBrowserCiphertext,
        writtenAt: new Date().toISOString(),
      }),
    ).toMatchObject({ name: "OHMYHOST_BROWSER_KEY", revision: 1, keyVersion: 1 });
    expect(await readBrowserKey()).toEqual(installedBrowserKey);
    // Stamping the scope as tried reaches the same Core through the adapter and is visible to the Core's own reads.
    const attemptScope = {
      organizationId: parseUlid(invalid.scope.organizationId),
      projectId: parseUlid(invalid.scope.projectId),
      environmentId: parseUlid(invalid.scope.environmentId),
    };
    await expect(
      persistence.recordPendingAttempt({ ...attemptScope, now: new Date().toISOString() }),
    ).resolves.toBeUndefined();
    expect(
      await core
        .prepare(
          "SELECT last_attempted_at FROM runtime_secret_delivery_states WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(invalid.scope.organizationId, invalid.scope.projectId, invalid.scope.environmentId)
        .first<{ last_attempted_at: string | null }>(),
    ).toEqual({ last_attempted_at: expect.any(String) });
    expect(await call("SECRET", "ensureAiGatewayKey", generatedScope)).toMatchObject({
      ok: true,
      value: { name: "OHMYHOST_AI_KEY", revision: 1 },
    });
    expect(
      await core
        .prepare(
          "SELECT count(*) n FROM environment_secrets WHERE organization_id=? AND name IN ('OHMYHOST_MAIL_KEY','OHMYHOST_STORAGE_KEY')",
        )
        .bind(invalid.scope.organizationId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await core
        .prepare(
          "SELECT count(*) n FROM environment_secrets WHERE organization_id=? AND name='OHMYHOST_AI_KEY'",
        )
        .bind(invalid.scope.organizationId)
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await call("CORE", "readRecordedWfpStage", {
        organizationId: invalid.scope.organizationId,
        projectId: invalid.scope.projectId,
        environmentName: "prod",
        candidateReceiptId: invalid.candidateReceiptId,
      }),
    ).toEqual({ ok: true, value: null });
    expect(await call("CORE", "readActiveWfpTarget", invalid.scope)).toEqual({ ok: true });
    const releasable = await gatewayFixture(control),
      releaseLease = newUlid();
    expect(
      await call("CORE", "claim", {
        ...releasable.scope,
        operationId: releasable.accepted.operationId,
        trigger: "deploy",
        runtimeProvider: "wfp",
        leaseId: releaseLease,
        claimedAt: new Date().toISOString(),
        leaseMilliseconds: 120000,
      }),
    ).toMatchObject({ ok: true, value: { outcome: "claimed" } });
    expect(
      await call("CORE", "release", {
        ...releasable.scope,
        leaseId: releaseLease,
        generation: 0,
        releaseSequence: 1,
        releasedAt: new Date().toISOString(),
      }),
    ).toEqual({ ok: true, value: "released" });
    const failed = await gatewayFixture(control),
      failedLease = newUlid(),
      stageId = newUlid();
    expect(
      await call("CORE", "claim", {
        ...failed.scope,
        operationId: failed.accepted.operationId,
        trigger: "deploy",
        runtimeProvider: "wfp",
        leaseId: failedLease,
        claimedAt: new Date().toISOString(),
        leaseMilliseconds: 120000,
      }),
    ).toMatchObject({ ok: true, value: { outcome: "claimed" } });
    const empty = await createRuntimeSecretManifest([]),
      failedCandidate = {
        provider: "cloudflare-wfp",
        namespace: "ohmyho-production",
        scriptName: failed.script,
        projectId: failed.scope.projectId,
        environmentId: failed.scope.environmentId,
        productDeploymentId: failed.deploymentId,
        providerTag: failed.providerTag,
        artifactDigest: `sha256:${"03".repeat(32)}`,
        buildReused: true,
        deployedAt: "2026-10-28T10:00:00.000Z",
      };
    expect(
      await call("SECRET", "recordStagedCandidate", {
        scope: {
          ...failed.scope,
          environmentName: "prod",
          handle: failed.project.handle,
          operationId: failed.accepted.operationId,
        },
        candidate: failedCandidate,
        candidateReceiptId: failed.candidateReceiptId,
        runtimeSecretDeliveryStage: {
          stageReceiptId: stageId,
          operationId: failed.accepted.operationId,
          productDeploymentId: failed.deploymentId,
          leaseId: failedLease,
          generation: 0,
          releaseSequence: 1,
          trigger: "deploy",
          providerTag: failed.providerTag,
          appliedSecretNames: [],
          manifestDigest: empty.digest,
          manifestSecretCount: 0,
          stagedAt: new Date().toISOString(),
        },
      }),
    ).toMatchObject({ ok: true, value: { status: "recorded" } });
    expect(
      await call("CORE", "compensateWfp", {
        ...failed.scope,
        compensationReceiptId: newUlid(),
        stageReceiptId: stageId,
        candidateReceiptId: failed.candidateReceiptId,
        failureCode: "CANDIDATE_REMOVED",
        compensatedAt: new Date().toISOString(),
      }),
    ).toMatchObject({ ok: true, value: { outcome: "compensated" } });
    const corrupt = await gatewayFixture(control);
    await core.batch([
      core
        .prepare(
          "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) SELECT ?1,?2,?3,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at FROM environment_secrets WHERE organization_id=?4 AND environment_id=?5 AND name='DATABASE_URL'",
        )
        .bind(
          corrupt.scope.organizationId,
          corrupt.scope.projectId,
          corrupt.scope.environmentId,
          invalid.scope.organizationId,
          invalid.scope.environmentId,
        ),
      core
        .prepare(
          "UPDATE runtime_secret_delivery_states SET desired_generation=desired_generation+1 WHERE organization_id=?1 AND environment_id=?2",
        )
        .bind(corrupt.scope.organizationId, corrupt.scope.environmentId),
    ]);
    const stageCalls = await call("WFP", "stageCalls");
    expect(
      await call("SECRET", "stageCandidate", {
        ...badArtifact,
        scope: {
          ...corrupt.scope,
          environmentName: "prod",
          handle: corrupt.project.handle,
          operationId: corrupt.accepted.operationId,
        },
        deploymentId: corrupt.deploymentId,
      }),
    ).toMatchObject({ ok: false });
    expect(await call("WFP", "stageCalls")).toEqual(stageCalls); // Foreign-scope AAD fails in the actual cipher before WFP.
    for (const target of ["MISSING", "MIXED"])
      expect(await call(target, "installPlatformSecret", {})).toMatchObject({ ok: false });
    expect(await call("DIAG", "read")).toEqual({ ok: true, value: { getters: 0 } });
    expect((await core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 120000);
