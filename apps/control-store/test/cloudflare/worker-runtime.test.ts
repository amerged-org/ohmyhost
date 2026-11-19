import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { expect, it } from "vitest";
import type { D1Database } from "../../src/d1-types.js";
import { activateTestCore, migrate, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";

it("runs the shipped CF Worker through its real Core capabilities, OAuth, imported-grant refresh and Mail component composition", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const tooling = createRequire(new URL("../../package.json", import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    tooling.resolve("wrangler/package.json"),
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
  const compile = async (path: string) => {
    const result = await build({
      entryPoints: [root + path],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2024",
      conditions: ["source", "workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["node:*", "cloudflare:workers"],
      banner: {
        js: 'import {createRequire as __fixtureRequire} from "node:module"; const require=__fixtureRequire("/fixture.js");',
      },
      plugins: [
        {
          name: "node-builtins",
          setup(builder) {
            builder.onResolve({ filter: /^[a-z_][a-z0-9_/-]*$/ }, ({ path }) =>
              builtinModules.includes(path) ? { path: "node:" + path, external: true } : undefined,
            );
          },
        },
      ],
      write: false,
      logLevel: "error",
    });
    const entry = result.outputFiles[0];
    if (!entry) throw new Error("Missing actual Worker bundle");
    return entry.text;
  };
  const [coreSource, cfSource] = await Promise.all([
    compile("apps/control-store/src/worker-main.ts"),
    compile("apps/cloudflare-domain-management/src/worker-main.ts"),
  ]);
  const compatibility = { compatibilityDate: "2026-08-29", compatibilityFlags: ["nodejs_compat"] };
  // This project has no Native realm; a policy call must fail, never fabricate an ACK.
  const nativePolicyGuard = `import {WorkerEntrypoint} from "cloudflare:workers";
    let calls=0;
    export class NativePolicyService extends WorkerEntrypoint {
      applyRealmPolicy() { calls++; throw new Error('Non-Native fixture requested Native policy'); }
    }
    export default {fetch() {return Response.json({calls});}};`;
  const engine = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "core",
          modules: true,
          script: coreSource,
          ...compatibility,
          d1Databases: { CONTROL_CORE: "cf-runtime" },
        },
        {
          name: "cf",
          modules: true,
          script: cfSource,
          ...compatibility,
          outboundService: "provider",
          bindings: {
            RUNTIME_CONFIGURATION_STATE: "configured",
            CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
            CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
            CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
            CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st",
            CLOUDFLARE_SAAS_API_TOKEN: "fixture-saas-domain-token-value",
            CLOUDFLARE_OAUTH_CLIENT_ID: "fixture-oauth-client-id",
            CLOUDFLARE_OAUTH_CLIENT_SECRET: "fixture-oauth-client-secret",
            CLOUDFLARE_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback",
            CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1",
            CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 65).toString("base64"),
            CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "1",
            CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "fixture-platform-web-domain-token",
          },
          serviceBindings: {
            GENERAL_CF_RUNTIME: { name: "core", entrypoint: "CloudflareDomainRuntime" },
            NATIVE_AUTH_ADMIN_US: {
              name: "ohmyho-native-auth-development-us",
              entrypoint: "NativePolicyService",
            },
            NATIVE_AUTH_ADMIN_EU: {
              name: "ohmyho-native-auth-development-eu",
              entrypoint: "NativePolicyService",
            },
            SCOPED_DNS_RUNTIME: { name: "core", entrypoint: "ScopedDnsRuntime" },
            APPLICATION_IDENTITY_RUNTIME: {
              name: "core",
              entrypoint: "ApplicationIdentityRuntime",
            },
            MAIL_DNS_RUNTIME: { name: "core", entrypoint: "MailDnsRuntime" },
            DEV_ACCESS: { name: "provider", entrypoint: "UnusedRuntime" },
            RUNTIME_PROBES: { name: "provider", entrypoint: "UnusedRuntime" },
          },
        },
        ...["us", "eu"].map((region) => ({
          name: `ohmyho-native-auth-development-${region}`,
          modules: true,
          ...compatibility,
          script: nativePolicyGuard,
        })),
        {
          name: "caller",
          modules: true,
          ...compatibility,
          script: `import {WorkerEntrypoint} from "cloudflare:workers";
      export default class extends WorkerEntrypoint {
        async fetch(request) {
          const {method,input}=await request.json();
          try {return Response.json(await this.env.CF[method](input));}
          catch(error) {return Response.json({error:error.name,message:error.message},{status:503});}
        }
      }`,
          serviceBindings: { CF: { name: "cf", entrypoint: "CloudflareDomainManagementService" } },
        },
        {
          name: "provider",
          modules: true,
          ...compatibility,
          script: `import {WorkerEntrypoint} from "cloudflare:workers";
      export class UnusedRuntime extends WorkerEntrypoint {}
      let refreshes=0,requests=[];
      export default {async fetch(request) {
        const u=new URL(request.url);
        if(u.origin==='https://fixture.invalid') return Response.json({refreshes,requests});
        requests.push(u.origin+u.pathname);
        if(u.origin==='https://dash.cloudflare.com' && u.pathname==='/oauth2/token') {
          const form=await request.formData();
          if(form.get('grant_type')==='refresh_token') refreshes++;
          return Response.json({access_token:'fixture-access-token-'+refreshes,
            refresh_token:'fixture-refresh-token-'+refreshes,token_type:'bearer',
            expires_in:3600,scope:'dns.write zone.read offline_access'});
        }
        if(u.origin==='https://api.cloudflare.com' && u.pathname==='/client/v4/zones')
          return Response.json({success:true,errors:[],messages:[],result:[{id:'d'.repeat(32),
            name:'example.test',status:'active',account:{id:'e'.repeat(32)}}],
            result_info:{page:1,per_page:50,total_pages:1,total_count:1,count:1}});
        return new Response(null,{status:503});
      }}`,
        },
      ],
    }),
  );
  try {
    const db = (await engine.getD1Database("CONTROL_CORE", "core")) as unknown as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: async () => {},
    };
    const p = await seedProject(control, { handle: "cf-worker-check" });
    const scope = { organizationId: p.organizationId, projectId: p.projectId };
    const caller = await engine.getWorker("caller");
    const call = async (method: string, input: unknown) => {
      const response = await caller.fetch("https://caller.invalid", {
        method: "POST",
        body: JSON.stringify({ method, input }),
      });
      const body = await response.json();
      if (response.status !== 200)
        throw new Error(`Actual CF ${method} failed: ${JSON.stringify(body)}`);
      return body as Record<string, unknown> | null;
    };
    await db
      .prepare(
        `INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,
      configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at)
      VALUES(?1,?2,'app.example.test',NULL,'awaiting_deployment','user:user_consent',unhex(?3),unhex(?4),?5,?5,NULL)`,
      )
      .bind(
        p.organizationId,
        p.projectId,
        "31".repeat(32),
        "32".repeat(32),
        "2026-10-29T00:00:00.123456Z",
      )
      .run();
    const actor = { ...scope, actorId: "user:user_consent" };
    const auth = await call("beginAuthorization", {
      ...actor,
      zone: "example.test",
      idempotencyKeySha256: "sha256:" + "41".repeat(32),
      requestSha256: "sha256:" + "42".repeat(32),
    });
    expect(auth).toHaveProperty("authorizationUrl");
    expect(await call("getStatus", actor)).toMatchObject({
      status: "pending",
      zone: "example.test",
    });
    const state = new URL(String(auth?.["authorizationUrl"])).searchParams.get("state");
    expect(
      await call("completeAuthorization", {
        code: "fixture-authorization-code",
        state,
        principalId: actor.actorId,
      }),
    ).toEqual({ status: "authorized" });
    expect(await call("getStatus", actor)).toMatchObject({
      status: "authorized",
      zone: "example.test",
    });
    // Captured Control grants retain nonzero PostgreSQL microseconds. A refresh must fence that exact version.
    await db
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_expires_at='2026-10-28T00:00:00.000000Z',updated_at='2026-10-28T00:00:00.123456Z' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId)
      .run();
    expect(await call("getStatus", actor)).toMatchObject({
      status: "authorized",
      zone: "example.test",
    });
    expect(await call("readApplicationDomainIdentity", actor)).toBeNull();
    expect(await call("getPaidDomain", actor)).toMatchObject({
      status: "suspended",
      suspensionReason: "paid_plan_required",
      hostname: "app.example.test",
    });
    const configured = await call("configureDomains", {
      ...actor,
      projectHandle: p.handle,
      idempotencyKeySha256: "sha256:" + "51".repeat(32),
      requestSha256: "sha256:" + "52".repeat(32),
    });
    expect(configured).toMatchObject({ status: 202 });
    const provider = await engine.getWorker("provider");
    const observed = await (await provider.fetch("https://fixture.invalid")).json();
    expect(observed).toMatchObject({ refreshes: 1 });
    for (const region of ["us", "eu"]) {
      const policy = await engine.getWorker(`ohmyho-native-auth-development-${region}`);
      expect(await (await policy.fetch("https://fixture.invalid")).json()).toEqual({ calls: 0 });
    }
    expect(
      await db.prepare("SELECT count(*) n FROM cloudflare_general_grant_uses").first(),
    ).toEqual({ n: 0 });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await engine.dispose();
  }
}, 120000);
