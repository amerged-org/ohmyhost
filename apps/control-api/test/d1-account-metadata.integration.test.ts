import { createRequire, builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { migrate, activateTestCore } from "../../control-store/test/support/control-d1.js";
import { applyWorkosSnapshot } from "../../control-store/src/catalog/identity/membership-state.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createD1AccountMetadataPorts } from "../src/d1-account-metadata.js";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
    banner: {
      js: 'import {createRequire as __accountFixtureRequire} from "node:module"; const require=__accountFixtureRequire("file:///fixture.mjs");',
    },
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[^.:/][^:]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  if (!result.outputFiles[0]) throw new Error("Missing native fixture bundle");
  return result.outputFiles[0].text;
}
interface Harness {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
  dispose(): Promise<void>;
}

it("uses a real session JWT and actual API/Core named RPC for account reads/writes, with no legacy URL/Pool or foreign-profile access", async () => {
  const require = createRequire(import.meta.url),
    { Miniflare } = createRequire(require.resolve("../../control-store/package.json"))(
      "miniflare",
    ) as { Miniflare: new (options: unknown) => Harness };
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwks = {
    keys: [
      {
        ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
        kid: "metadata-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
  const scripts = await Promise.all([
    bundle(
      'import {ControlRuntime,AccountMetadataRuntime} from "./apps/control-store/src/worker-main.ts"; export {ControlRuntime,AccountMetadataRuntime}; export class LostAccountMetadataRuntime extends AccountMetadataRuntime {async recordAccountSignupSource(input){await super.recordAccountSignupSource(input);throw new Error("Network connection lost after committed metadata RPC");}}; export default {fetch(){return new Response("private")}};',
    ),
    bundle(`import {createControlApiWorkerEntrypoint} from "./apps/control-api/src/worker-main.ts";
      const stats={rawReads:0};
      export default {async fetch(request,env,ctx){
        if(new URL(request.url).pathname==="/fixture/stats")return Response.json(stats);
        const worker=createControlApiWorkerEntrypoint({fetcher:r=>env.AUTH_STATUS.fetch(r)});
        const bindings={...env,CONTROL_API_PUBLIC_ORIGIN:"https://dev.app.ohmyho.st",CONTROL_API_RATE_LIMITER:{limit:async()=>({success:true})},OPERATION_PUBLISHER:{wake:async()=>{}},WORKOS_JWKS_URL:"https://fixture.authkit.app/jwks",WORKOS_ISSUER:"https://api.workos.com/user_management/client_fixture",WORKOS_CLIENT_ID:"client_fixture",WORKOS_AUDIENCE:"control-api"};
        const mode=request.headers.get("x-fixture-mode");
        if(mode==="missing")delete bindings.ACCOUNT_METADATA_RUNTIME;
        if(mode==="wrong")bindings.ACCOUNT_METADATA_RUNTIME=env.CONTROL_RUNTIME;
        if(mode==="lost")bindings.ACCOUNT_METADATA_RUNTIME=env.ACCOUNT_METADATA_LOST;
        if(mode?.startsWith("raw:"))Object.defineProperty(bindings,mode.slice(4),{get(){stats.rawReads++;throw new Error("RAW_D1_BINDING_FORBIDDEN")}});
        return worker.fetch(request,bindings,ctx);
      }};`),
  ]);
  const authScript = `let providerCalls=0;export default {async fetch(request,env){const path=new URL(request.url).pathname;
    if(path==="/fixture/stats")return Response.json({providerCalls});
    if(path==="/jwks")return Response.json(JSON.parse(env.JWKS));
    providerCalls++;
    const body=await request.json();
    if(path==="/session-status")return Response.json({active:body.userId.startsWith("user_metadata")&&body.sessionId.startsWith("session_")},{headers:{"cache-control":"no-store"}});
    if(path==="/user-profile")return Response.json({user_id:body.userId,name:"Native account",email:body.userId+"@example.invalid",email_verified:true,workos_organization_ids:body.userId==="user_metadata_rpc"?["org_metadata_rpc"]:[]});
    if(path==="/current-identity")return Response.json({user_id:body.user_id,email:body.user_id===null?null:body.user_id+"@example.invalid",organizations:body.workos_organization_ids.map(workos_id=>({workos_id,name:"Current native workspace"}))});
    return new Response(null,{status:404});}};`;
  const mf = new Miniflare({
    workers: [
      {
        name: "core",
        modules: true,
        script: scripts[0],
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { CONTROL_CORE: "metadata-core" },
      },
      {
        name: "auth",
        modules: true,
        script: authScript,
        compatibilityDate: "2026-08-06",
        bindings: { JWKS: JSON.stringify(jwks) },
      },
      {
        name: "api",
        modules: true,
        script: scripts[1],
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: {
          CONTROL_RUNTIME: { name: "core", entrypoint: "ControlRuntime" },
          ACCOUNT_METADATA_RUNTIME: { name: "core", entrypoint: "AccountMetadataRuntime" },
          ACCOUNT_METADATA_LOST: { name: "core", entrypoint: "LostAccountMetadataRuntime" },
          AUTH_STATUS: "auth",
        },
      },
    ],
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const organizationId = newUlid();
    await applyWorkosSnapshot(
      { directory: db, router: new SharedCoreRouter(db) },
      {
        organizationId,
        workosOrganizationId: "org_metadata_rpc",
        state: "active",
        snapshotDigest: "44".repeat(32),
        snapshotFetchedAt: "2026-10-29T05:00:00.000Z",
        synchronizedAt: "2026-10-29T05:00:00.000Z",
        triggerEventId: "evt_metadata_rpc",
        auditEventId: newUlid(),
        memberships: [
          {
            workosUserId: "user_metadata_rpc",
            role: "admin",
            status: "active",
            digest: "55".repeat(32),
          },
        ],
      },
    );
    const api = await mf.getWorker("api"),
      auth = await mf.getWorker("auth"),
      now = Math.floor(Date.now() / 1000);
    const token = async (userId: string, organization = true) => {
      const encoded = [
        { alg: "RS256", kid: "metadata-key", typ: "JWT" },
        {
          iss: "https://api.workos.com/user_management/client_fixture",
          sub: userId,
          sid: `session_${userId.slice(5)}`,
          client_id: "client_fixture",
          iat: now,
          exp: now + 300,
          ...(organization ? { org_id: "org_metadata_rpc" } : {}),
        },
      ]
        .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
        .join(".");
      return (
        encoded +
        "." +
        Buffer.from(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keys.privateKey,
            new TextEncoder().encode(encoded),
          ),
        ).toString("base64url")
      );
    };
    const bearer = await token("user_metadata_rpc"),
      headers = { authorization: `Bearer ${bearer}` };
    const read = () => api.fetch("https://dev.app.ohmyho.st/v1/me/profile", { headers });
    expect(await (await read()).json()).toMatchObject({
      user_id: "user_metadata_rpc",
      signup_source: null,
      organization_ids: [organizationId],
    });
    const write = await api.fetch("https://dev.app.ohmyho.st/v1/me/signup-source", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        source: "native-campaign",
        utm: { utm_source: "日本語 🌍", utm_custom: "Launch" },
      }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ signup_source: "native-campaign" });
    const attribution = () =>
      db
        .prepare("SELECT origin_source,utm_parameters FROM user_signup WHERE workos_user_id=?")
        .bind("user_metadata_rpc")
        .first<{ origin_source: string | null; utm_parameters: string | null }>();
    expect(await attribution()).toEqual({
      origin_source: "native-campaign",
      utm_parameters: JSON.stringify({ utm_source: "日本語 🌍", utm_custom: "Launch" }),
    });
    expect(
      (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/signup-source", {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ source: "different", utm: { utm_source: "changed" } }),
        })
      ).status,
    ).toBe(200);
    expect((await attribution())?.utm_parameters).toBe(
      JSON.stringify({ utm_source: "日本語 🌍", utm_custom: "Launch" }),
    );
    expect(
      (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/signup-source", {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ source: null, utm: { not_utm: "invalid" } }),
        })
      ).status,
    ).toBe(400);
    const emptyHeaders = {
      authorization: `Bearer ${await token("user_metadata_empty", false)}`,
      "content-type": "application/json",
    };
    for (const utm of [{}, { utm_source: "too-late" }]) {
      expect(
        (
          await api.fetch("https://dev.app.ohmyho.st/v1/me/signup-source", {
            method: "PUT",
            headers: emptyHeaders,
            body: JSON.stringify({ source: null, utm }),
          })
        ).status,
      ).toBe(200);
    }
    expect(
      await db
        .prepare("SELECT utm_parameters FROM user_signup WHERE workos_user_id=?")
        .bind("user_metadata_empty")
        .first(),
    ).toEqual({ utm_parameters: "{}" });
    const lostHeaders = {
      authorization: `Bearer ${await token("user_metadata_lost", false)}`,
      "content-type": "application/json",
    };
    expect(
      (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/signup-source", {
          method: "PUT",
          headers: { ...lostHeaders, "x-fixture-mode": "lost" },
          body: JSON.stringify({ source: "retained-first-origin" }),
        })
      ).status,
    ).toBe(503);
    expect(
      await (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/profile", { headers: lostHeaders })
      ).json(),
    ).toMatchObject({ signup_source: "retained-first-origin" });
    expect(
      await db
        .prepare("SELECT utm_parameters FROM user_signup WHERE workos_user_id=?")
        .bind("user_metadata_lost")
        .first(),
    ).toEqual({ utm_parameters: null });
    expect(
      await (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/signup-source", {
          method: "PUT",
          headers: lostHeaders,
          body: JSON.stringify({ source: "must-not-replace" }),
        })
      ).json(),
    ).toMatchObject({ signup_source: "retained-first-origin" });
    expect(
      await (await api.fetch("https://dev.app.ohmyho.st/v1/me", { headers })).json(),
    ).toMatchObject({
      actor_id: "user:user_metadata_rpc",
      email: "user_metadata_rpc@example.invalid",
      organizations: [{ id: organizationId, name: "Current native workspace" }],
    });
    expect(
      (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/profile?user_id=user_metadata_rpc", {
          headers: { authorization: `Bearer ${await token("user_metadata_other", false)}` },
        })
      ).status,
    ).toBe(400);
    expect(
      await (
        await api.fetch("https://dev.app.ohmyho.st/v1/me/profile", {
          headers: { authorization: `Bearer ${await token("user_metadata_other", false)}` },
        })
      ).json(),
    ).toMatchObject({ user_id: "user_metadata_other", signup_source: null, organization_ids: [] });
    const providerBefore = await (await auth.fetch("https://fixture/fixture/stats")).json();
    for (const mode of ["missing", "wrong"])
      expect(
        (
          await api.fetch("https://dev.app.ohmyho.st/v1/me/profile", {
            headers: { ...headers, "x-fixture-mode": mode },
          })
        ).status,
      ).toBe(503);
    for (const binding of [
      "CONTROL_CORE",
      "CONTROL_GLOBAL",
      "CONTROL_DIRECTORY",
      "CONTROL_SHARD_0000",
      "CONTROL_SHARD_eu",
      "CONTROL_SHARD_",
    ])
      expect(
        (
          await api.fetch("https://dev.app.ohmyho.st/v1/me/profile", {
            headers: { ...headers, "x-fixture-mode": "raw:" + binding },
          })
        ).status,
      ).toBe(503);
    expect(await (await auth.fetch("https://fixture/fixture/stats")).json()).toEqual(
      providerBefore,
    );
    expect(await (await api.fetch("https://fixture/fixture/stats")).json()).toEqual({
      rawReads: 0,
    });
    host.env = { CONTROL_CORE: db };
    const entry = await import("../../control-store/src/worker-main.js"),
      runtime = new entry.AccountMetadataRuntime({}, { CONTROL_CORE: db });
    const authBinding = {
      fetch: async (request: Request) =>
        auth.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        }),
    };
    const ports = await createD1AccountMetadataPorts(
      runtime,
      authBinding,
      () => new Date("2026-10-29T05:00:00.000Z"),
    );
    const who = {
      actorId: "user:user_metadata_rpc",
      credentialId: "workos_session:session_metadata_rpc",
      authorizationPrincipal: {
        kind: "user" as const,
        subjectId: "user:user_metadata_rpc" as const,
      },
      organizationIds: [parseUlid(organizationId)],
    };
    expect(await ports.accountProfile.recordSource(who, "second-campaign")).toMatchObject({
      signup_source: "native-campaign",
    });
    expect(await ports.currentIdentity.read(who)).toMatchObject({
      email: "user_metadata_rpc@example.invalid",
    });
    expect("recordAccountSignupSource" in new entry.ControlRuntime({}, { CONTROL_CORE: db })).toBe(
      false,
    );
    for (const bad of [null, {}, { readCurrentIdentityMappings: async () => [] }])
      await expect(
        createD1AccountMetadataPorts(bad, authBinding, () => new Date()),
      ).rejects.toThrow("binding_required");
    const methods = {
      readCurrentIdentityMappings: async () => [],
      readAccountProfileFacts: async () => ({ unexpected: true }),
      recordAccountSignupSource: async () => ({ recorded: false }),
    };
    const invalid = await createD1AccountMetadataPorts(methods, authBinding, () => new Date());
    await expect(invalid.accountProfile.read(who)).rejects.toThrow("response_invalid");
    await expect(invalid.accountProfile.recordSource(who, "new")).rejects.toThrow(
      "response_invalid",
    );
    await expect(
      createD1AccountMetadataPorts(
        {
          ...methods,
          readCurrentIdentityMappings: async () => [
            { organization_id: organizationId, workos_organization_id: "org_metadata_rpc" },
          ],
        },
        authBinding,
        () => new Date(),
      ),
    ).rejects.toThrow("response_invalid");
  } finally {
    await mf.dispose();
  }
}, 120_000);

it("reads all 101 authorized workspaces in bounded identity batches", async () => {
  const { createCurrentIdentityPortWithMappings } = await import("../src/current-identity.js");
  const ids = Array.from({ length: 101 }, (_, index) =>
    parseUlid(index.toString().padStart(26, "0")),
  );
  const sizes: number[] = [];
  const port = createCurrentIdentityPortWithMappings(
    async (batch) =>
      batch.map((id) => ({ organization_id: id, workos_organization_id: `org_${id}` })),
    {
      fetch: async (request) => {
        const body = (await request.json()) as {
          user_id: string;
          workos_organization_ids: string[];
        };
        sizes.push(body.workos_organization_ids.length);
        return Response.json({
          user_id: body.user_id,
          email: "user@example.test",
          organizations: body.workos_organization_ids.map((workos_id) => ({
            workos_id,
            name: workos_id,
          })),
        });
      },
    },
  );
  const { createControlApi } = await import("../src/index.js");
  const { routeDependencies } = await import("./helpers/app-routes-fixture.js");
  const { createClient, getCurrentIdentity } = await import(
    "../../../packages/sdk-ts/src/index.js"
  );
  const { parseCurrentIdentity } = await import("../../product-cli/src/runtime-contract.js");
  for (const count of [100, 101]) {
    sizes.length = 0;
    const organizationIds = ids.slice(0, count);
    const principal = {
      actorId: "user:user_1",
      credentialId: "test",
      authorizationPrincipal: { kind: "user" as const, subjectId: "user:user_1" as const },
      organizationIds,
    };
    const app = createControlApi(
      routeDependencies({
        currentIdentity: port,
        authentication: { authenticate: async (token) => (token === "valid" ? principal : null) },
      }),
    );
    const response = await app.request("https://api.test/v1/me", {
      headers: { authorization: "Bearer valid" },
    });
    expect(response.status).toBe(200);
    const httpIdentity = await response.json();
    expect(httpIdentity).toMatchObject({
      actor_id: "user:user_1",
      email: "user@example.test",
      organization_ids: organizationIds,
    });
    expect(httpIdentity.organizations).toEqual(
      organizationIds.map((id) => ({ id, name: `org_${id}` })),
    );
    expect(sizes).toEqual(count === 100 ? [100] : [100, 1]);
    sizes.length = 0;
    const client = createClient({
      baseUrl: "https://api.test",
      auth: "valid",
      fetch: async (request, init) => app.fetch(new Request(request, init)),
    });
    const sdkIdentity = await getCurrentIdentity({}, { client });
    expect(sdkIdentity).toEqual(httpIdentity);
    // The CLI and local MCP consume this same strict result parser.
    expect(parseCurrentIdentity(sdkIdentity)).toEqual(httpIdentity);
    expect(sizes).toEqual(count === 100 ? [100] : [100, 1]);
  }
});
