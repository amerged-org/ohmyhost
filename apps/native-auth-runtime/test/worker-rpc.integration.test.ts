import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativeAuthPostgresEngine } from "../src/postgres-engine.js";

function localJurisdiction(bundle: string): string {
  const result = bundle.replace(
    /function realm\(env2, scope\) \{[\s\S]*?\n\}(?=\n__name\(realm)/u,
    "function realm(env2, scope) { return env2.NATIVE_AUTH_ENVIRONMENTS.getByName(`${scope.projectId}:${scope.environmentId}`); }",
  );
  if (result === bundle) throw new Error("local_jurisdiction_fixture_rewrite_failed");
  return result;
}

it("exposes only scoped session validation over a real Worker RPC binding", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "client",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./rpc-client.mjs", import.meta.url)),
              contents: `
          export default { async fetch(request, env) {
            try { await env.AUTH.validateSession({cookie:'__Host-omh_native.session_token=probe', projectId:'foreign'}); return new Response('unexpected'); }
            catch (error) { return Response.json({error:error.message, observed:await env.OBSERVED.read()}, {status:503}); }
          } };
        `,
            },
          ],
          serviceBindings: {
            AUTH: {
              name: "native",
              entrypoint: "NativeSessionService",
              props: {
                projectId: "project-a",
                environmentId: "dev",
                deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
              },
            },
            OBSERVED: { name: "authority", entrypoint: "Authority" },
          },
        },
        {
          name: "native",
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./native-worker.mjs", import.meta.url)),
              contents: localJurisdiction(
                readFileSync(
                  new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
                  "utf8",
                ),
              ),
            },
          ],
          serviceBindings: {
            NATIVE_AUTH_AUTHORITY: { name: "authority", entrypoint: "Authority" },
          },
          durableObjects: {
            NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
          },
          bindings: {
            NATIVE_AUTH_REGION_ID: "us-dev",
            NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
            NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
          },
        },
        {
          name: "authority",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./authority.mjs", import.meta.url)),
              contents: `
          import { WorkerEntrypoint } from 'cloudflare:workers';
          let observed;
          export class Authority extends WorkerEntrypoint {
            resolve(scope) {
              observed = scope;
              return { deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX', realm: {...scope, canonicalOrigin:'https://app.example', realmGeneration:1, configurationRevision:1}, revocationEpoch:1, enabled:false, sourceCapable:true, paidAllowed:true, runtimeAllowed:true };
            }
            read() { return observed; }
          }
          export default { fetch: () => new Response(null, {status:404}) };
        `,
            },
          ],
        },
      ],
    }),
  );
  try {
    const response = await mf.dispatchFetch("https://client.example/");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "auth_unavailable",
      observed: {
        projectId: "project-a",
        environmentId: "dev",
        deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      },
    });
  } finally {
    await mf.dispose();
  }
}, 30_000);

it("validates a real PostgreSQL session through a scoped workerd binding", async () => {
  const db = await startTestPostgres();
  const schema = `native_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const origin = "https://app.example";
  const secret = "private-test-only-secret-at-least-32-characters";
  let verificationUrl = "";
  let engine: ReturnType<typeof createNativeAuthPostgresEngine> | undefined;
  let mf: Miniflare | undefined;
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(
        new URL("../migrations/002-invitation-receipt-digest.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    engine = createNativeAuthPostgresEngine(
      {
        connectionString,
        schema,
        canonicalOrigin: origin,
        applicationName: "Test",
        secret,
        sendMail: async (message) => {
          verificationUrl = message.url;
        },
      },
      { handle: (_request, execute) => execute(), validate: async (session) => session },
      (configuration) => new Pool(configuration),
    );
    const current = engine;
    const email = `rpc-${randomUUID()}@example.test`;
    const password = "correct-horse-battery-123"; // gitleaks:allow -- disposable local test password
    const request = (path: string, body: object) =>
      current.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await request("/sign-up/email", { name: "Test", email, password })).status).toBe(200);
    expect(verificationUrl).toBeTruthy();
    expect((await current.handle(new Request(verificationUrl))).status).toBeLessThan(400);
    const login = await request("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const session = await current.validateSession(cookie);
    if (!session) throw new Error("session missing");
    await pool.query("insert into native_user_policy (user_id, status) values ($1, 'active')", [
      session.user.id,
    ]);
    await pool.query(
      "insert into native_session_policy (session_id, realm_epoch, user_epoch, authenticated_at) values ($1, 1, 0, now())",
      [session.session.id],
    );
    const config = {
      connectionString,
      schema,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret,
    };
    // Local-only TCP fixture: production bundle retains the PGCF WSS-only pool factory.
    const productionBundle = readFileSync(
      new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
      "utf8",
    );
    let localBundle = productionBundle.replace(
      /function createNativeRealmPool\(config3, scope\) \{[\s\S]*?\n\}(?=\n__name\(createNativeRealmPool)/u,
      "function createNativeRealmPool(config3, scope) { return new Pool({connectionString:config3.connectionString, options:`-c search_path=${config3.schema}`, max:2}); }",
    );
    if (localBundle === productionBundle) throw new Error("local_pg_fixture_rewrite_failed");
    localBundle = localJurisdiction(localBundle);
    const beforeRegistry = localBundle;
    localBundle = localBundle.replace(
      /function createNativeAuthRegistry\(input\) \{[\s\S]*?\n\}(?=\n__name\(createNativeAuthRegistry)/u,
      `function createNativeAuthRegistry(input) { return {resolve: async () => ({...${JSON.stringify(config)},target:{provider:'pgcf',host:'sql.pgcf.example',databaseId:'d1234567890123456789',role:'unused'},receipt:{organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',registryVersion:1,targetVersion:1}})}; }`,
    );
    if (localBundle === beforeRegistry) throw new Error("local_registry_fixture_rewrite_failed");
    mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "client",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./live-client.mjs", import.meta.url)),
                contents: `export default { async fetch(request, env) {
                  if (new URL(request.url).pathname.startsWith('/admin')) {
                    const path = new URL(request.url).pathname;
                    if (path === '/admin/source-off') {
                      await env.CONTROL.sourceOff();
                      try { await env.ADMIN.applyRealmPolicy({organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',configurationRevision:1,revocationEpoch:2,enabled:true,canonicalOrigin:'https://app.example'}); return new Response('ok'); } catch { return new Response('unavailable',{status:503}); }
                    }
                    if (path === '/admin/pause') {
                      await env.CONTROL.pause();
                      try { await env.ADMIN.applyRealmPolicy({organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',configurationRevision:2,revocationEpoch:3,enabled:false,canonicalOrigin:'https://app.example'}); return new Response('ok'); } catch { return new Response('unavailable',{status:503}); }
                    }
                    if (path === '/admin/suspend' || path === '/admin/reactivate' || path === '/admin/delete') {
                      try { return Response.json(await env.ADMIN.mutateUser({organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',principalId:'owner',requestId:'r2',idempotencyKey:path,canonicalRequestDigest:new Uint8Array(32).fill(path === '/admin/suspend' ? 1 : path === '/admin/reactivate' ? 2 : 3),mutation:{action:path.slice('/admin/'.length),userId:await request.text()}})); } catch { return new Response('unavailable',{status:503}); }
                    }
                    if (path === '/admin/provider' || path === '/admin/provider-github') {
                      try { return Response.json(await env.ADMIN.applyProviderPolicy({organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',provider:path.endsWith('github') ? 'github' : 'google',configurationRevision:1,enabled:true})); }
                      catch { return new Response('unavailable', {status:503}); }
                    }
                    if (path === '/admin/lost-origin') {
                      await env.CONTROL.invalidateOrigin();
                      try { await env.ADMIN.applyRealmPolicy({organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',configurationRevision:3,revocationEpoch:4,enabled:false,canonicalOrigin:null}); return new Response('ok'); }
                      catch { return new Response('unavailable', {status:503}); }
                    }
                    if (path === '/admin/users' || path === '/admin/member') {
                      try { return Response.json(await env.ADMIN.listUsers({organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',principalId:path === '/admin/users' ? 'owner' : 'member',requestId:'r1'})); }
                      catch { return new Response('forbidden', {status:403}); }
                    }
                    try { await env.ADMIN.applyRealmPolicy({organizationId:path === '/admin/foreign' ? 'org-b' : '01ARZ3NDEKTSV4RRFFQ69G5FAZ',projectId:'project-a',environmentId:'dev',configurationRevision:path === '/admin/stale' ? 0 : 1,revocationEpoch:1,enabled:true,canonicalOrigin:'https://app.example'}); return new Response('ok'); }
                    catch { return new Response('unavailable', {status:503}); }
                  }
                  if (new URL(request.url).pathname === '/public') {
                    return env.PUBLIC.fetchPublic(new Request('https://app.example/api/auth/v1/get-session', {headers:{cookie:await request.text()}}), {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}, {clientAddress:'192.0.2.1'});
                  }
                  if (new URL(request.url).pathname === '/social') return env.PUBLIC.fetchPublic(new Request('https://app.example/api/auth/v1/sign-in/social',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:await request.text()}), {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}, {clientAddress:'192.0.2.55'});
                  if (new URL(request.url).pathname === '/signup' || new URL(request.url).pathname === '/login') {
                    const path = new URL(request.url).pathname === '/signup' ? '/sign-up/email' : '/sign-in/email';
                    return env.PUBLIC.fetchPublic(new Request('https://app.example/api/auth/v1'+path,{method:'POST',headers:{origin:'https://app.example','content-type':'application/json','idempotency-key':'fixture-signup-key'},body:await request.text()}), {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}, {clientAddress:'192.0.2.55'});
                  }
                  if (new URL(request.url).pathname === '/invite') return env.PUBLIC.fetchPublic(new Request('https://app.example/api/auth/v1/accept-invitation',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json','idempotency-key':'fixture-invite-key'},body:await request.text()}), {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}, {clientAddress:'192.0.2.88'});
                  if (new URL(request.url).pathname === '/mail') return Response.json(await env.CONTROL.readMail());
                  if (new URL(request.url).pathname === '/verify') return env.PUBLIC.fetchPublic(new Request(await request.text()), {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}, {clientAddress:'192.0.2.55'});
                  if (new URL(request.url).pathname === '/rate') {
                    const scope = {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1};
                    const codes = [];
                    for (let i = 0; i < 6; i++) codes.push((await env.PUBLIC.fetchPublic(new Request('https://app.example/api/auth/v1/sign-in/email', {method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:'{}'}), scope, {clientAddress:'192.0.2.1'})).status);
                    return Response.json(codes);
                  }
                  if (new URL(request.url).pathname === '/oversize') {
                    return env.PUBLIC.fetchPublic(new Request('https://app.example/api/auth/v1/sign-up/email', {method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:'x'.repeat(17000)}), {projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}, {clientAddress:'192.0.2.1'});
                  }
                  if (new URL(request.url).pathname === '/old') {
                    try { await env.AUTH_OLD.validateSession({cookie:await request.text()}); return new Response('unexpected'); }
                    catch { return new Response('unavailable', {status:503}); }
                  }
                  return Response.json(await env.AUTH.validateSession({cookie:await request.text()}));
                } };`,
              },
            ],
            serviceBindings: {
              AUTH: {
                name: "native",
                entrypoint: "NativeSessionService",
                props: {
                  projectId: "project-a",
                  environmentId: "dev",
                  deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                },
              },
              AUTH_OLD: {
                name: "native",
                entrypoint: "NativeSessionService",
                props: {
                  projectId: "project-a",
                  environmentId: "dev",
                  deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
                },
              },
              ADMIN: { name: "native", entrypoint: "NativeAdminService" },
              PUBLIC: { name: "native", entrypoint: "NativePublicService" },
              CONTROL: { name: "private", entrypoint: "Authority" },
            },
          },
          {
            name: "native",
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./live-native.mjs", import.meta.url)),
                contents: localBundle,
              },
            ],
            serviceBindings: {
              NATIVE_AUTH_AUTHORITY: { name: "private", entrypoint: "Authority" },
              NATIVE_AUTH_ADMIN_AUTHORITY: { name: "private", entrypoint: "Authority" },
              NATIVE_AUTH_REGISTRY: { name: "private", entrypoint: "Registry" },
              NATIVE_AUTH_REGISTRY_AUTHORITY: { name: "private", entrypoint: "Registry" },
              NATIVE_AUTH_MAIL_AUTHORITY: { name: "private", entrypoint: "Authority" },
              NATIVE_AUTH_MAIL: { name: "private", entrypoint: "Mail" },
            },
            durableObjects: {
              NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
            },
            bindings: {
              NATIVE_AUTH_REGION_ID: "us-dev",
              NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
              NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
            },
            ratelimits: {
              NATIVE_AUTH_GENERAL_LIMITER: {
                namespace_id: "9901",
                simple: { limit: 100, period: 60 },
              },
              NATIVE_AUTH_SIGNIN_LIMITER: {
                namespace_id: "9902",
                simple: { limit: 5, period: 60 },
              },
              NATIVE_AUTH_SIGNUP_LIMITER: {
                namespace_id: "9903",
                simple: { limit: 3, period: 60 },
              },
              NATIVE_AUTH_REALM_LIMITER: {
                namespace_id: "9905",
                simple: { limit: 3000, period: 60 },
              },
              NATIVE_AUTH_RESET_LIMITER: { namespace_id: "9904", simple: { limit: 3, period: 60 } },
            },
          },
          {
            name: "private",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./live-private.mjs", import.meta.url)),
                contents: `
          import { WorkerEntrypoint } from 'cloudflare:workers';
          let originValue = ${JSON.stringify(origin)}, revision = 1, epoch = 1, source = true, owner = true, lastMail = null, mailCount = 0;
          export class Authority extends WorkerEntrypoint {
            resolve(scope) { return {organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',ownerEnabled:owner,realm:{...scope,canonicalOrigin:originValue,realmGeneration:epoch,configurationRevision:revision},revocationEpoch:epoch,enabled:owner && originValue !== null,sourceCapable:source,paidAllowed:true,runtimeAllowed:true,applicationName:'Test',signupPolicy:'open',allowedRedirectPaths:['/login','/reset-password','/accept-invitation'],resetPasswordPath:'/reset-password',invitationPath:'/accept-invitation'}; }
            authorizeOwnerOperation(input) { return input.principalId === 'owner'; }
            authorizeAcceptedOperation() { return true; }
            authorizeNativeMail() { return {canonicalOrigin:originValue}; }
            readMail() { return {...lastMail, count:mailCount}; }
            resolveProvider(scope) { return {...scope, configurationRevision:revision, enabled:true}; }
            sourceOff() { source = false; epoch = 2; }
            pause() { owner = false; revision = 2; epoch = 3; }
            invalidateOrigin() { originValue = null; revision = 3; epoch = 4; }
          }
          export class Mail extends WorkerEntrypoint { sendNativeAuthMail(message) { lastMail = message; mailCount++; return {status:'accepted'}; } }
          export class Registry extends WorkerEntrypoint { resolve() { return ${JSON.stringify(config)}; } readRegistration() { return {organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAZ',registryVersion:1,targetVersion:1}; } }
          export default { fetch: () => new Response(null, {status:404}) };
        `,
              },
            ],
          },
        ],
      }),
    );
    const applied = await mf.dispatchFetch("https://client.example/admin");
    expect(applied.status).toBe(200);
    expect((await mf.dispatchFetch("https://client.example/admin/foreign")).status).toBe(503);
    expect((await mf.dispatchFetch("https://client.example/admin/stale")).status).toBe(503);
    const realmPolicy = await pool.query(
      "select enabled, revocation_epoch from native_realm_policy where singleton = true",
    );
    expect(realmPolicy.rows[0]).toMatchObject({ enabled: true, revocation_epoch: "1" });
    const providerApplied = await mf.dispatchFetch("https://client.example/admin/provider");
    expect(providerApplied.status).toBe(200);
    expect(await providerApplied.json()).toEqual({ outcome: "applied" });
    const githubApplied = await mf.dispatchFetch("https://client.example/admin/provider-github");
    expect(githubApplied.status).toBe(200);
    expect(await githubApplied.json()).toEqual({ outcome: "applied" });
    // Even an enabled trusted authority cannot start either social flow without the private resolver.
    for (const provider of ["google", "github"]) {
      const social = await mf.dispatchFetch("https://client.example/social", {
        method: "POST",
        body: JSON.stringify({ provider, callbackURL: "/login" }),
      });
      expect(social.status).toBe(403);
    }

    const newEmail = `public-${randomUUID()}@example.test`;
    const signup = await mf.dispatchFetch("https://client.example/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Public", email: newEmail, password }),
    });
    expect(signup.status).toBe(200);
    expect(signup.headers.getSetCookie()).toHaveLength(0);
    const replaySignup = await mf.dispatchFetch("https://client.example/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Public", email: newEmail, password }),
    });
    expect(replaySignup.status).toBe(200);
    const mail = (await (await mf.dispatchFetch("https://client.example/mail")).json()) as {
      url: string;
      count: number;
    };
    expect(mail.count).toBe(1);
    expect(new URL(mail.url).pathname).toBe("/api/auth/v1/verify-email");
    const verified = await mf.dispatchFetch("https://client.example/verify", {
      method: "POST",
      body: mail.url,
      redirect: "manual",
    });
    expect(verified.status).toBeLessThan(400);
    expect(verified.headers.getSetCookie()).toHaveLength(0);
    const publicLogin = await mf.dispatchFetch("https://client.example/login", {
      method: "POST",
      body: JSON.stringify({ email: newEmail, password }),
    });
    expect(publicLogin.status).toBe(200);
    expect(publicLogin.headers.getSetCookie().join("; ")).toContain("omh_native");
    expect(await publicLogin.clone().json()).not.toHaveProperty("token");
    const invitedId = randomUUID();
    const inviteToken = randomBytes(32).toString("base64url");
    await pool.query('insert into "user" (id,name,email,"emailVerified") values ($1,$2,$3,false)', [
      invitedId,
      "Invited",
      `invite-${randomUUID()}@example.test`,
    ]);
    await pool.query("insert into native_user_policy (user_id,status) values ($1,'pending')", [
      invitedId,
    ]);
    await pool.query(
      "insert into native_invitation (token_digest,user_id,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,1,1,0,now()+interval '24 hours')",
      [createHash("sha256").update(inviteToken).digest(), invitedId],
    );
    const invitationBody = JSON.stringify({
      token: inviteToken,
      password: "strong-invitation-password",
      name: "Invited",
    });
    const accepted = await mf.dispatchFetch("https://client.example/invite", {
      method: "POST",
      body: invitationBody,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.getSetCookie()).toHaveLength(0);
    expect(await accepted.json()).toEqual({ status: "accepted" });
    expect(
      (
        await mf.dispatchFetch("https://client.example/invite", {
          method: "POST",
          body: invitationBody,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mf.dispatchFetch("https://client.example/invite", {
          method: "POST",
          body: JSON.stringify({
            token: inviteToken,
            password: "different-invitation-password",
            name: "Invited",
          }),
        })
      ).status,
    ).toBe(400);
    const ownerUsers = await mf.dispatchFetch("https://client.example/admin/users");
    expect(ownerUsers.status).toBe(200);
    expect(await ownerUsers.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: session.user.id, email })]),
    );
    expect((await mf.dispatchFetch("https://client.example/admin/member")).status).toBe(403);
    const response = await mf.dispatchFetch("https://client.example/", {
      method: "POST",
      body: cookie,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(session);
    expect(
      (await mf.dispatchFetch("https://client.example/old", { method: "POST", body: cookie }))
        .status,
    ).toBe(503);
    const publicResponse = await mf.dispatchFetch("https://client.example/public", {
      method: "POST",
      body: cookie,
    });
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("cache-control")).toBe("no-store");
    expect(await publicResponse.json()).toMatchObject({ user: { id: session.user.id } });
    const limited = await mf.dispatchFetch("https://client.example/rate");
    const rateResults = (await limited.json()) as number[];
    expect(rateResults).toHaveLength(6);
    expect(rateResults.every((status) => status === 400 || status === 429)).toBe(true);
    const oversized = await mf.dispatchFetch("https://client.example/oversize");
    expect(oversized.status).toBe(413);
    await pool.query("update native_user_policy set status='suspended' where user_id=$1", [
      session.user.id,
    ]);
    const denied = await mf.dispatchFetch("https://client.example/", {
      method: "POST",
      body: cookie,
    });
    expect(await denied.json()).toBeNull();
    expect((await mf.dispatchFetch("https://client.example/admin/source-off")).status).toBe(200);
    expect((await mf.dispatchFetch("https://client.example/admin/users")).status).toBe(200);
    expect(
      (
        await mf.dispatchFetch("https://client.example/admin/suspend", {
          method: "POST",
          body: invitedId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await mf.dispatchFetch("https://client.example/public", { method: "POST", body: cookie }))
        .status,
    ).toBe(503);
    expect((await mf.dispatchFetch("https://client.example/admin/pause")).status).toBe(200);
    expect(
      (
        await mf.dispatchFetch("https://client.example/admin/reactivate", {
          method: "POST",
          body: invitedId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await mf.dispatchFetch("https://client.example/admin/delete", {
          method: "POST",
          body: invitedId,
        })
      ).status,
    ).toBe(200);
    expect((await pool.query('select 1 from "user" where id=$1', [invitedId])).rowCount).toBe(0);
    expect((await mf.dispatchFetch("https://client.example/admin/lost-origin")).status).toBe(200);
    const fenced = await pool.query(
      "select revocation_epoch from native_realm_policy where singleton = true",
    );
    expect(fenced.rows[0]).toMatchObject({ revocation_epoch: "4" });
  } finally {
    await mf?.dispose();
    await engine?.close();
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("preserves the private DO profile path when its trusted caller clock is one millisecond ahead", async () => {
  const scope = {
    projectId: "01M6PG6R7A0B8YJ9PBMZ9AB565",
    environmentId: "01M6PG6R7A0B8YJ9PBMZ9AB56A",
    deploymentId: "01M6SD6T45F1HD6YTBRZ721JF0",
  };
  let bundle = localJurisdiction(
    readFileSync(new URL("../dist/worker-bundle/worker-main.js", import.meta.url), "utf8"),
  );
  const marker = "unwrapNativeLatencySession(result, void 0,";
  if (bundle.split(marker).length !== 2) throw new Error("local_profile_fixture_rewrite_failed");
  bundle = bundle.replace(
    marker,
    "unwrapNativeLatencySession(result, record => { localProfiles.push(JSON.parse(record)); },",
  );
  bundle +=
    "\nconst localProfiles = []; export function readLocalProfiles() { return localProfiles.splice(0); }\n";
  for (const receiverLag of [0, 1]) {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "client",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./deadline-client.mjs", import.meta.url)),
                contents: `
            export default { async fetch(request, env) {
              let rpcThrew = false;
              try { await env.AUTH.validateSession({cookie:'__Host-omh_native.session_token=probe'}); } catch { rpcThrew = true; }
              return Response.json({rpcThrew, ...await env.RECORDS.read()}, {status:rpcThrew ? 503 : 200});
            } };
          `,
              },
            ],
            serviceBindings: {
              AUTH: { name: "native", entrypoint: "NativeSessionService", props: scope },
              RECORDS: { name: "native", entrypoint: "LocalRecords" },
            },
          },
          {
            name: "native",
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./deadline-native.mjs", import.meta.url)),
                contents: `
              import {WorkerEntrypoint} from 'cloudflare:workers';
              import {NativeSessionService,NativeAuthEnvironment,readLocalProfiles} from './deadline-bundle.mjs';
              export {NativeSessionService};
              export class LocalEnvironment extends NativeAuthEnvironment {
                evidence = null;
                async validateSession(scope,cookie,deadlineAt,diagnostic) {
                  const originalNow = Date.now;
                  Date.now = () => deadlineAt - 15000 - ${receiverLag};
                  this.evidence = {receiverFutureByMs:deadlineAt-Date.now()-15000,returnedEnvelope:false};
                  try {
                    const result = await super.validateSession(scope,cookie,deadlineAt,diagnostic);
                    this.evidence.returnedEnvelope = result?.kind === 'native_private_session_v2';
                    return result;
                  } finally {Date.now=originalNow;}
                }
                readEvidence() {return this.evidence;}
              }
              export class LocalRecords extends WorkerEntrypoint {
                async read() {return {profiles:readLocalProfiles(),evidence:await this.env.NATIVE_AUTH_ENVIRONMENTS.getByName('${scope.projectId}:${scope.environmentId}').readEvidence()};}
              }
              export default {fetch:()=>new Response(null,{status:404})};
            `,
              },
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./deadline-bundle.mjs", import.meta.url)),
                contents: bundle,
              },
            ],
            durableObjects: {
              NATIVE_AUTH_ENVIRONMENTS: { className: "LocalEnvironment", useSQLite: true },
            },
            bindings: {
              NATIVE_AUTH_REGION_ID: "us-dev",
              NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
              NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
              NATIVE_AUTH_LATENCY_PROFILE: "c5-development-v1",
              NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE: "v1",
            },
          },
        ],
      }),
    );
    try {
      const response = await mf.dispatchFetch("https://client.example/protected");
      expect(response.status).toBe(503);
      const observed = (await response.json()) as {
        rpcThrew: boolean;
        evidence: { receiverFutureByMs: number; returnedEnvelope: boolean };
        profiles: Array<{ kind: string; outcome: string }>;
      };
      expect(observed.rpcThrew).toBe(true);
      expect(observed.evidence).toEqual({
        receiverFutureByMs: receiverLag,
        returnedEnvelope: true,
      });
      // Missing local registration still fails closed, but now through the body catch/profile rather than the clock guard.
      expect(observed.profiles).toHaveLength(1);
      expect(observed.profiles[0]).toMatchObject({
        kind: "native_private_latency_v3",
        outcome: "unavailable",
      });
    } finally {
      await mf.dispose();
    }
  }
});
