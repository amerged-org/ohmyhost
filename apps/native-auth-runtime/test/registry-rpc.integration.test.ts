import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("registers, replays and revokes encrypted credentials through real private Worker and Durable Object RPC", async () => {
  const bundle = readFileSync(
    new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
    "utf8",
  );
  let local = bundle.replace(
    /function realm\(env2, scope\) \{[\s\S]*?\n\}(?=\n__name\(realm)/u,
    "function realm(env2, scope) { return env2.NATIVE_AUTH_ENVIRONMENTS.getByName(`${scope.projectId}:${scope.environmentId}`); }",
  );
  if (local === bundle) throw new Error("local_jurisdiction_fixture_rewrite_failed");
  const beforeInjection = local;
  local = local.replace(
    "  register(input) {\n    return this.#registry.register(input);\n  }",
    "  testResolvePrivate(scope) { return this.#registry.resolve(scope); }\n  testStored() { return this.ctx.storage.get('registration'); }\n  register(input) {\n    return this.#registry.register(input);\n  }",
  );
  if (local === beforeInjection) throw new Error("test_inspector_injection_failed");
  const inspector = `\nimport { WorkerEntrypoint as InspectorBase } from 'cloudflare:workers'; export class RegistryInspector extends InspectorBase { resolve(scope) { return this.env.NATIVE_AUTH_ENVIRONMENTS.getByName(scope.projectId+':'+scope.environmentId).testResolvePrivate(scope); } stored(scope) { return this.env.NATIVE_AUTH_ENVIRONMENTS.getByName(scope.projectId+':'+scope.environmentId).testStored(); } }`;
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
              path: fileURLToPath(new URL("./registry-client.mjs", import.meta.url)),
              contents: `
      const id='01K2F3G4H5J6K7M8N9P0QRSTVW', e='01K2F3G4H5J6K7M8N9P0QRSTVZ';
      const descriptor={organizationId:id,projectId:id,environmentId:e,operationId:id,claimId:id,providerProjectId:'prj_12345678901234567890',databaseId:'a1234567890123456789',regionId:'eu-dev',originHost:'pgcf.example.com',schema:'omh_auth_'+e.toLowerCase(),role:'omh_ar_'+e.toLowerCase(),targetVersion:1,registryVersion:1,registryReference:id+':'+e};
      const credential='postgres://'+descriptor.role+':private@pgcf.example.com/'+descriptor.databaseId+'?sslmode=require';
      export default {async fetch(_r,env){const first=await env.ADMIN.register({...descriptor,connectionString:credential}); const again=await env.ADMIN.register({...descriptor,connectionString:credential}); const resolved=await env.INSPECT.resolve({projectId:id,environmentId:e}); await env.ADMIN.revoke({receipt:first,operationId:id,claimId:id,registryVersion:2}); await env.ADMIN.revoke({receipt:first,operationId:id,claimId:id,registryVersion:2}); let denied=false;try{await env.INSPECT.resolve({projectId:id,environmentId:e})}catch{denied=true} const deletion={organizationId:id,projectId:id,environmentId:e,operationId:id,registryVersion:1,registryReference:id+':'+e}; await env.ADMIN.quiesceForDeletion(deletion); await env.ADMIN.purgeForDeletion(deletion); const stored=await env.INSPECT.stored({projectId:id,environmentId:e}); return Response.json({same:JSON.stringify(first)===JSON.stringify(again),metadataOnly:!JSON.stringify(first).includes('private'),resolved:resolved.connectionString===credential&&resolved.secret.length>=32,denied,purged:JSON.stringify(stored)===JSON.stringify({deleted:deletion})})}};`,
            },
          ],
          serviceBindings: {
            ADMIN: { name: "native", entrypoint: "NativeRegistryAdminService" },
            INSPECT: { name: "native", entrypoint: "RegistryInspector" },
          },
        },
        {
          name: "native",
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./registry-native.mjs", import.meta.url)),
              contents: local + inspector,
            },
          ],
          durableObjects: {
            NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
          },
          bindings: {
            NATIVE_AUTH_REGION_ID: "eu-dev",
            NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
            NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
          },
          serviceBindings: {
            NATIVE_AUTH_REGISTRY_AUTHORITY: { name: "authority", entrypoint: "Authority" },
          },
        },
        {
          name: "authority",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./registry-authority.mjs", import.meta.url)),
              contents: `
      import { WorkerEntrypoint } from 'cloudflare:workers'; let receipt;
      export class Authority extends WorkerEntrypoint { authorizeRegistration(value){receipt=value;return true} readRegistration(){return receipt} authorizeRevocation(){return true} authorizeDeletion(){return true} authorizeDeletionQuiescence(){return true} }
      export default {fetch(){return new Response(null,{status:404})}};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const response = await mf.dispatchFetch("https://client.example/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      same: true,
      metadataOnly: true,
      resolved: true,
      denied: true,
      purged: true,
    });
  } finally {
    await mf.dispose();
  }
}, 30_000);
