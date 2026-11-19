import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";

it("drains an in-flight SQL mutation before acknowledging a real DO registry rotation", async () => {
  const db = await startTestPostgres();
  const projectId = "01K2F3G4H5J6K7M8N9P0QRSTVW",
    environmentId = "01K2F3G4H5J6K7M8N9P0QRSTVZ";
  const schema = `omh_auth_${environmentId.toLowerCase()}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  let persistence: string | undefined;
  let mf: Miniflare | undefined;
  let lock: PoolClient | undefined;
  try {
    persistence = await mkdtemp(join(tmpdir(), "native-custody-rpc-"));
    await db.pool.query(`CREATE SCHEMA ${schema}`);
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
    const userId = randomUUID();
    await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)', [
      userId,
      "Test",
      "rotation@example.test",
    ]);
    await pool.query("INSERT INTO native_user_policy (user_id,status) VALUES ($1,'active')", [
      userId,
    ]);
    await pool.query(
      "INSERT INTO native_realm_policy (singleton,enabled,revocation_epoch,configuration_revision) VALUES (true,true,1,1)",
    );
    const source = readFileSync(
      new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
      "utf8",
    );
    let bundle = source.replace(
      /function realm\(env2, scope\) \{[\s\S]*?\n\}(?=\n__name\(realm)/u,
      "function realm(env2, scope) { return env2.NATIVE_AUTH_ENVIRONMENTS.getByName(`${scope.projectId}:${scope.environmentId}`); }",
    );
    if (bundle === source) throw new Error("local_jurisdiction_fixture_rewrite_failed");
    const beforePool = bundle;
    bundle = bundle.replace(
      /function createNativeRealmPool\(config3, scope\) \{[\s\S]*?\n\}(?=\n__name\(createNativeRealmPool)/u,
      `function createNativeRealmPool(config3, scope) { return new Pool({connectionString:${JSON.stringify(connectionString)}, options:'-c search_path='+config3.schema, max:2}); }`,
    );
    if (bundle === beforePool) throw new Error("local_pg_fixture_rewrite_failed");
    const descriptorSource =
      "{organizationId:id,projectId:id,environmentId:e,operationId:id,claimId:id,providerProjectId:'prj_12345678901234567890',databaseId:'a1234567890123456789',regionId:'eu-dev',originHost:'pgcf.example.com',schema:'omh_auth_'+e.toLowerCase(),role:'omh_ar_'+e.toLowerCase(),targetVersion:1,registryVersion:1,registryReference:id+':'+e}";
    const configuration = (rotated = false, legacyReader = true) => ({
      ...convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "client",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./rotation-client.mjs", import.meta.url)),
                contents: `
        const id=${JSON.stringify(projectId)}, e=${JSON.stringify(environmentId)}, userId=${JSON.stringify(userId)};
        const descriptor=${descriptorSource};
        const connectionString='postgres://'+descriptor.role+':fixture@pgcf.example.com/'+descriptor.databaseId;
        export default {async fetch(request,env){const path=new URL(request.url).pathname; if(path==='/register'||path==='/rotate') return Response.json(await env.REG.register({...descriptor,registryVersion:path==='/rotate'?2:1,connectionString})); if(path==='/read') return Response.json(await env.ADMIN.listUsers({organizationId:id,projectId:id,environmentId:e,principalId:'user:owner',requestId:'read'})); if(path==='/mutate') return Response.json(await env.ADMIN.mutateUser({organizationId:id,projectId:id,environmentId:e,principalId:'user:owner',requestId:'req',idempotencyKey:'key',canonicalRequestDigest:new Uint8Array(32).fill(1),mutation:{action:'suspend',userId}})); return new Response(null,{status:404});}};`,
              },
            ],
            serviceBindings: {
              REG: { name: "native", entrypoint: "NativeRegistryAdminService" },
              ADMIN: { name: "native", entrypoint: "NativeAdminService" },
            },
          },
          {
            name: "native",
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./rotation-native.mjs", import.meta.url)),
                contents: bundle,
              },
            ],
            durableObjects: {
              NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
            },
            bindings: {
              NATIVE_AUTH_REGION_ID: "eu-dev",
              NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa((rotated ? "z" : "k").repeat(32)),
              NATIVE_AUTH_CUSTODY_KEY_VERSION: rotated ? 20261106 : 1,
              ...(rotated && legacyReader
                ? {
                    NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON: JSON.stringify({
                      1: btoa("k".repeat(32)),
                    }),
                  }
                : {}),
            },
            serviceBindings: {
              NATIVE_AUTH_REGISTRY_AUTHORITY: { name: "authority", entrypoint: "Authority" },
              NATIVE_AUTH_ADMIN_AUTHORITY: { name: "authority", entrypoint: "Authority" },
            },
          },
          {
            name: "authority",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./rotation-authority.mjs", import.meta.url)),
                contents: `import {WorkerEntrypoint} from 'cloudflare:workers'; const id=${JSON.stringify(projectId)},e=${JSON.stringify(environmentId)},descriptor=${descriptorSource}; let active=${rotated ? "{...descriptor,status:'active'}" : "undefined"}; export class Authority extends WorkerEntrypoint {authorizeRegistration(r){if(!active)active=r;return true} readRegistration(){return active} authorizeRevocation(){return true} authorizeOwnerOperation(){return true} authorizeAcceptedOperation(){return true} resolve(s){return {organizationId:s.organizationId,ownerEnabled:true,enabled:true,sourceCapable:true,paidAllowed:true,runtimeAllowed:true,revocationEpoch:1,realm:{projectId:s.projectId,environmentId:s.environmentId,canonicalOrigin:'https://app.example',realmGeneration:1,configurationRevision:1}}}} export default {fetch(){return new Response(null,{status:404})}};`,
              },
            ],
          },
        ],
      }),
      resourcePersistencePath: persistence,
    });
    mf = new Miniflare(configuration());
    expect((await mf.dispatchFetch("https://client.example/register")).status).toBe(200);
    // Restart the real workerd/DO against the same SQLite custody. No registration occurs
    // between these reloads: failure without reader 1 and recovery with it prove legacy reads.
    await mf.setOptions(configuration(true, false));
    expect((await mf.dispatchFetch("https://client.example/read")).status).toBe(500);
    await mf.setOptions(configuration(true));
    const recovered = await mf.dispatchFetch("https://client.example/read");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject([
      { email: "rotation@example.test", status: "active" },
    ]);
    lock = await pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT * FROM native_realm_policy WHERE singleton=true FOR UPDATE");
    const mutation = mf.dispatchFetch("https://client.example/mutate");
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const rows = await db.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%native_realm_policy%'",
      );
      blocked = rows.rowCount !== 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(blocked).toBe(true);
    let rotationDone = false;
    const rotation = mf.dispatchFetch("https://client.example/rotate").then((response) => {
      rotationDone = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rotationDone).toBe(false);
    await lock.query("COMMIT");
    lock.release();
    lock = undefined;
    expect((await mutation).status).toBe(200);
    expect((await rotation).status).toBe(200);
    expect(
      (await pool.query("SELECT status FROM native_user_policy WHERE user_id=$1", [userId]))
        .rows[0],
    ).toEqual({ status: "suspended" });
  } finally {
    if (lock) {
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }
    await mf?.dispose();
    if (persistence) await rm(persistence, { recursive: true, force: true });
    await pool.end();
    await db.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.stop();
  }
}, 60_000);
