import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";

it("projects and drains preview policy through real Worker and Realm DO RPC", async () => {
  const db = await startTestPostgres();
  const schema = `preview_rpc_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("test_postgres_unavailable");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const previewId = "01J00000000000000000000001",
    projectId = "01J00000000000000000000002",
    environmentId = "01J00000000000000000000003",
    organizationId = "01J00000000000000000000004";
  const fence = { previewId, runtimeGeneration: 1, tokenGeneration: 1 };
  const receipt = { organizationId, projectId, environmentId, registryVersion: 1 };
  const preview = {
    ...fence,
    authGeneration: 1,
    organizationId,
    projectId,
    environmentId,
    region: "eu",
  };
  const authority = {
    organizationId,
    realm: {
      projectId,
      environmentId,
      canonicalOrigin: null,
      realmGeneration: 1,
      configurationRevision: 1,
    },
    ownerEnabled: true,
    storageReady: true,
    paidAllowed: true,
    runtimeAllowed: true,
    revocationEpoch: 1,
    applicationName: "Preview",
    signupPolicy: "open",
    allowedRedirectPaths: ["/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  let mf: Miniflare | undefined;
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/004-preview-policy.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy(enabled,revocation_epoch,configuration_revision) values(false,1,1)",
    );
    const raw = readFileSync(
      new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
      "utf8",
    );
    let bundle = raw.replace(
      /function realm\(env2, scope\) \{[\s\S]*?\n\}(?=\n__name\(realm)/u,
      "function realm(env2, scope) { return env2.NATIVE_AUTH_ENVIRONMENTS.getByName(`${scope.projectId}:${scope.environmentId}`); }",
    );
    bundle = bundle.replace(
      /function createNativeRealmPool\(config3, scope\) \{[\s\S]*?\n\}(?=\n__name\(createNativeRealmPool)/u,
      "function createNativeRealmPool(config3, scope) { return new Pool({connectionString:config3.connectionString,options:`-c search_path=${config3.schema}`,max:2}); }",
    );
    bundle = bundle.replace(
      /function createNativeAuthRegistry\(input\) \{[\s\S]*?\n\}(?=\n__name\(createNativeAuthRegistry)/u,
      `function createNativeAuthRegistry(input) { return {resolve:async()=>({connectionString:${JSON.stringify(connectionString)},schema:${JSON.stringify(schema)},secret:'local-only-secret',receipt:${JSON.stringify(receipt)}})}; }`,
    );
    if (bundle === raw || bundle.includes("function createNativeAuthRegistry(input) {\n"))
      throw new Error("local_native_fixture_rewrite_failed");
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
                path: "client.mjs",
                contents: `export default {async fetch(req,env){try{const input=${JSON.stringify({ fence, authGeneration: 1, revocationEpoch: 1, configurationRevision: 1 })};if(new URL(req.url).pathname==='/drain'){await env.PREVIEW.drainPreview({fence:input.fence});return new Response('ok')}return Response.json(await env.POLICY.applyPreviewRealmPolicy(input))}catch{return new Response(null,{status:503})}}};`,
              },
            ],
            serviceBindings: {
              POLICY: { name: "native", entrypoint: "NativeProductPreviewPolicyService" },
              PREVIEW: { name: "native", entrypoint: "NativeProductPreviewService" },
            },
          },
          {
            name: "native",
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            modules: [
              {
                type: "ESModule",
                path: fileURLToPath(new URL("./preview-policy-native.mjs", import.meta.url)),
                contents: bundle,
              },
            ],
            bindings: {
              NATIVE_AUTH_REGION_ID: "eu-dev",
              NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
              NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
            },
            durableObjects: {
              NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
            },
            serviceBindings: {
              NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY: { name: "authority", entrypoint: "Authority" },
            },
          },
          {
            name: "authority",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: "authority.mjs",
                contents: `import {WorkerEntrypoint} from 'cloudflare:workers';const preview=${JSON.stringify(preview)},authority=${JSON.stringify(authority)},registration=${JSON.stringify(receipt)};export class Authority extends WorkerEntrypoint{resolve(){return {preview,authority,registration,launchAllowed:true}}resolveDrain(){return {...preview,hasRegistration:true,registration}}recordDrain(){}}export default {fetch(){return new Response(null,{status:404})}};`,
              },
            ],
          },
        ],
      }),
    );
    const applied = await mf.dispatchFetch("https://client.example/apply");
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ outcome: "applied" });
    expect(
      (
        await pool.query("select enabled from native_preview_realm_policy where preview_id=$1", [
          previewId,
        ])
      ).rows,
    ).toEqual([{ enabled: true }]);
    expect((await pool.query("select enabled from native_realm_policy")).rows).toEqual([
      { enabled: false },
    ]);
    expect((await mf.dispatchFetch("https://client.example/drain")).status).toBe(200);
  } finally {
    if (mf) await mf.dispose();
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
