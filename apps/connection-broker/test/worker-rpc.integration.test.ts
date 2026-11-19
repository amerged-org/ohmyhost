function mustFixtureValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  migrationFiles,
  activateTestCore,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { coreBootstrapWorker } from "../../control-store/test/support/core-bootstrap.js";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function bundle(contents: string): Promise<string> {
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
  });
  return mustFixtureValue(result.outputFiles[0]).text;
}
test("broker calls the actual private Core Worker RPC while public fetch cannot call management", async () => {
  const [coreScript, brokerScript] = await Promise.all([
    bundle(
      'export {ConnectionBrokerRuntime} from "./apps/control-store/src/worker-main.ts"; export default {fetch(){return new Response("private",{status:404})}};',
    ),
    bundle(`import {createBroker} from './apps/connection-broker/src/authorization.ts';
      import {makeRegistration} from './apps/connection-broker/src/registry.ts';
      export default { async fetch(req,env) {
        const registration=makeRegistration('development');const b=createBroker({environment:'development',registration,registry:[registration],secrets:{clientId:'fixture',clientSecret:'fixture',vaultKey:btoa('x'.repeat(32))},qualified:true,core:env.CORE,observer:{async observeConnectionOrigin(){}},adapter:{async authorizationUrl(r,c,state){return 'https://provider.test/?state='+state},async exchange(){return {accessToken:'access',refreshToken:'refresh',idToken:'id',expiresIn:300}},async verifyIdentity(){return 'subject'},async refresh(){throw Error()},async revoke(){throw Error()}}});
        const u=new URL(req.url); if(u.pathname==='/test-begin')return Response.json(await b.beginBrowser(await req.json())); if(u.pathname==='/oauth/start')return b.start(req); if(u.pathname==='/oauth/callback')return b.callback(req); if(u.pathname==='/test-complete')return Response.json(await b.complete(await req.json())); return new Response('not found',{status:404}); }};`),
  ]);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "bootstrap",
          modules: true,
          script: coreBootstrapWorker,
          compatibilityDate: "2026-08-24",
          d1Databases: { CONTROL_CORE: "core" },
        },
        {
          name: "core",
          modules: true,
          script: coreScript,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { CONTROL_CORE: "core" },
        },
        {
          name: "broker",
          modules: true,
          script: brokerScript,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: { CORE: { name: "core", entrypoint: "ConnectionBrokerRuntime" } },
        },
      ],
    }),
  );
  try {
    const db = (await mf.getD1Database("CONTROL_CORE", "core")) as unknown as D1Database;
    const bootstrap = await mf.getWorker("bootstrap");
    const initialized = await bootstrap.fetch("http://fixture.invalid/", {
      method: "POST",
      body: JSON.stringify(migrationFiles("core").map((file) => splitStatements(file.sql))),
    });
    expect(initialized.status).toBe(200);
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      bindings: { CONTROL_CORE: db },
      dispose: async () => {},
    };
    const p = await seedProject(control);
    await db.batch([
      db
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(p.organizationId, STORED_NOW),
      db
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_connect','owner','active',1,unhex(?2),?3,'evt')",
        )
        .bind(p.organizationId, "00".repeat(32), STORED_NOW),
      db
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,'user','user:user_connect','owner',?3)",
        )
        .bind(p.organizationId, newUlid(), STORED_NOW),
    ]);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      principalId: "user:user_connect",
      sessionId: "session_connect",
      browserSession: {
        sessionId: "session_connect",
        userId: "user_connect",
        organizationId: null,
        tokenExpiresAt: 4102444800,
      },
      originatingCredential: {
        kind: "session",
        sessionId: "cli_origin",
        userId: "user_connect",
        workosOrganizationId: null,
        tokenExpiresAt: 4102444800,
      },
    };
    const worker = await mf.getWorker("broker");
    const begin = await worker.fetch("https://dev.connect.ohmyho.st/test-begin", {
      method: "POST",
      body: JSON.stringify(scope),
    });
    expect(begin.status).toBe(200);
    const { url } = (await begin.json()) as {
      url: string;
    };
    const start = await worker.fetch(url, { redirect: "manual" });
    expect(start.status).toBe(302);
    const state = mustFixtureValue(
        new URL(mustFixtureValue(start.headers.get("location"))).searchParams.get("state"),
      ),
      cookie = mustFixtureValue(mustFixtureValue(start.headers.get("set-cookie")).split(";")[0]);
    const callback = await worker.fetch(
      `https://dev.connect.ohmyho.st/oauth/callback?state=${state}&code=fixture`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    const result = mustFixtureValue(
      new URL(mustFixtureValue(callback.headers.get("location"))).searchParams.get("result"),
    );
    const complete = await worker.fetch("https://dev.connect.ohmyho.st/test-complete", {
      method: "POST",
      body: JSON.stringify({ result, principalId: scope.principalId, sessionId: scope.sessionId }),
    });
    expect(await complete.json()).toMatchObject({ state: "active", grantId: expect.any(String) });
    expect(
      (
        await worker.fetch(
          "https://dev.connect.ohmyho.st/ConnectionBrokerManagementService/beginBrowser",
        )
      ).status,
    ).toBe(404);
  } finally {
    await mf.dispose();
  }
}, 120000);

test("real workerd dispatches Make calls and refuses provider redirects", async () => {
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
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const prefix = `${json({ alg: "RS256", kid: "fixture" })}.${json({ iss: "https://www.make.com", aud: "fixture", sub: "owner", nonce: "nonce", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const token = `${prefix}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(prefix))))}`;
  const script = await bundle(`
    import { exchangeMakeCode, refreshMakeToken, revokeMakeToken } from './apps/connection-broker/src/providers/make-oauth.ts';
    import { listMakeOrganizations } from './apps/connection-broker/src/providers/make-catalog.ts';
    import { verifyMakeIdToken } from './apps/connection-broker/src/oidc.ts';
    import { makeRegistration } from './apps/connection-broker/src/registry.ts';
    export default { async fetch(req) { const r=makeRegistration('development'), client={clientId:'fixture',clientSecret:'secret'}; try {
      switch(new URL(req.url).pathname) {
        case '/exchange': await exchangeMakeCode(r,client,'code','v'.repeat(43)); break;
        case '/refresh': await refreshMakeToken(r,client,'refresh'); break;
        case '/revoke': await revokeMakeToken(r,client,'refresh'); break;
        case '/catalog': await listMakeOrganizations({zone:'eu2',accessToken:'access'}); break;
        case '/jwks': await verifyMakeIdToken(${JSON.stringify(token)},'fixture','nonce'); break;
        default: throw Error('unexpected');
      } return Response.json({ok:true}); } catch { return Response.json({ok:false}); } } }`);
  let redirects = false;
  const calls: string[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "provider-probe",
          modules: true,
          script,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          outboundService: async (request: Request) => {
            const url = new URL(request.url);
            calls.push(url.hostname + url.pathname);
            if (redirects)
              return new Response(null, {
                status: 302,
                headers: { location: "https://attacker.example/redirected" },
              });
            if (url.pathname === "/oauth/v2/oidc/jwks") return Response.json({ keys: [jwk] });
            if (url.pathname === "/api/v2/organizations")
              return Response.json({ organizations: [] });
            if (url.pathname === "/oauth/v2/revoke") return new Response(null, { status: 200 });
            return Response.json({
              access_token: "access",
              refresh_token: "refresh",
              id_token: "id",
              token_type: "Bearer",
              expires_in: 300,
            });
          },
        },
      ],
    }),
  );
  try {
    const worker = await mf.getWorker("provider-probe");
    for (const action of ["exchange", "refresh", "revoke", "catalog", "jwks"]) {
      calls.length = 0;
      expect(await (await worker.fetch(`https://example.test/${action}`)).json(), action).toEqual({
        ok: true,
      });
      expect(calls, action).toHaveLength(1);
      redirects = true;
      calls.length = 0;
      expect(await (await worker.fetch(`https://example.test/${action}`)).json(), action).toEqual({
        ok: false,
      });
      expect(calls, action).toHaveLength(1);
      expect(calls[0]).not.toContain("attacker.example");
      redirects = false;
    }
  } finally {
    await mf.dispose();
  }
}, 120000);
