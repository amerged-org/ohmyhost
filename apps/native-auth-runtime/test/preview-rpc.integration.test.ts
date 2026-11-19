import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("keeps Development preview identity on private workerd RPC and refuses foreign origins", async () => {
  const previewId = "a".repeat(32);
  const origin = `https://${previewId}-${"b".repeat(24)}.preview.dev.omh.st`;
  const identity = { previewId, authGeneration: 1 };
  const raw = readFileSync(
    new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
    "utf8",
  );
  const native = raw.replace(
    /function realm\(env2, scope\) \{[\s\S]*?\n\}(?=\n__name\(realm)/u,
    "function realm(env2, scope) { return env2.NATIVE_AUTH_ENVIRONMENTS.getByName(`${scope.projectId}:${scope.environmentId}`); }",
  );
  if (native === raw) throw new Error("local_jurisdiction_fixture_rewrite_failed");
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
              path: "client.mjs",
              contents: `
      export default { async fetch(request,env) { try { let u=new URL(request.url), id=${JSON.stringify(identity)};
        if (u.pathname==='/session') return Response.json(await env.NATIVE.validateStablePreviewSession(id,'unrelated=value'));
        if (u.pathname==='/bad-generation') id.authGeneration=2;
        const target=u.pathname==='/foreign'?'https://foreign.example/api/auth/v1/get-session':${JSON.stringify(`${origin}/api/auth/v1/get-session`)};
        return env.NATIVE.fetchStablePreview(new Request(target),id,{clientAddress:'127.0.0.1'});
      } catch { return new Response(null,{status:503}); } } };`,
            },
          ],
          serviceBindings: { NATIVE: { name: "native", entrypoint: "NativePreviewService" } },
        },
        {
          name: "native",
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./preview-native.mjs", import.meta.url)),
              contents: native,
            },
          ],
          bindings: {
            NATIVE_AUTH_REGION_ID: "eu-dev",
            NATIVE_AUTH_QA_PREVIEW_ENABLED: "development-only-v1",
            NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
            NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
          },
          durableObjects: {
            NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
          },
          serviceBindings: {
            NATIVE_AUTH_PREVIEW_AUTHORITY: { name: "authority", entrypoint: "Authority" },
          },
        },
        {
          name: "authority",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "authority.mjs",
              contents: `
      import { WorkerEntrypoint } from 'cloudflare:workers';
      export class Authority extends WorkerEntrypoint { resolveForNative(i) {
        if(i.previewId!==${JSON.stringify(previewId)} || i.authGeneration!==1) throw Error('auth_unavailable');
        return {organizationId:'01ARZ3NDEKTSV4RRFFQ69G5FAV',preview:i,realm:{projectId:'01ARZ3NDEKTSV4RRFFQ69G5FAW',environmentId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',canonicalOrigin:${JSON.stringify(origin)},realmGeneration:1,configurationRevision:1},revocationEpoch:1,enabled:true,sourceCapable:true,paidAllowed:true,runtimeAllowed:true,applicationName:'QA',signupPolicy:'open',allowedRedirectPaths:['/login','/reset-password','/accept-invitation'],resetPasswordPath:'/reset-password',invitationPath:'/accept-invitation'};
      } } export default {fetch(){return new Response(null,{status:404});}};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const session = await mf.dispatchFetch("https://client.example/session");
    expect(session.status).toBe(200);
    expect(await session.json()).toBeNull();
    expect((await mf.dispatchFetch("https://client.example/foreign")).status).toBe(503);
    expect((await mf.dispatchFetch("https://client.example/bad-generation")).status).toBe(503);
  } finally {
    await mf.dispose();
  }
}, 30_000);
