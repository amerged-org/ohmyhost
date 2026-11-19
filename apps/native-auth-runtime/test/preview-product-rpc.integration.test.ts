import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("uses private workerd RPC for product preview sessions and rejects old or foreign capability fences", async () => {
  const previewId = "01J00000000000000000000001";
  const projectId = "01J00000000000000000000002";
  const environmentId = "01J00000000000000000000003";
  const token = "a".repeat(52);
  const origin = `https://${token}.preview.dev.omh.st`;
  const hash = createHash("sha256").update(token).digest("hex");
  const source = {
    sourceConnectionId: previewId,
    sourceGeneration: 1,
    sequence: 3,
    commitSha: "a".repeat(40),
  };
  const record = {
    previewId,
    projectId,
    environmentId,
    organizationId: previewId,
    runtimeGeneration: 1,
    tokenGeneration: 1,
    authGeneration: 7,
    targetSource: source,
    appliedSource: source,
    region: "eu",
    retirement: "none",
  };
  const authority = {
    organizationId: previewId,
    realm: {
      projectId,
      environmentId,
      canonicalOrigin: null,
      realmGeneration: 2,
      configurationRevision: 1,
    },
    ownerEnabled: true,
    storageReady: true,
    paidAllowed: true,
    runtimeAllowed: true,
    revocationEpoch: 2,
    applicationName: "App",
    signupPolicy: "open",
    allowedRedirectPaths: ["/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
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
              contents: `export default {async fetch(req,env){try{const p=new URL(req.url).pathname;const f={previewId:${JSON.stringify(previewId)},runtimeGeneration:1,tokenGeneration:p==='/rotated'?2:1};const publicOrigin=p==='/foreign'?'https://foreign.example':${JSON.stringify(origin)};return Response.json(await env.NATIVE.validatePreviewSession({fence:f,publicOrigin,cookie:'unrelated=value'}));}catch{return new Response(null,{status:503})}}};`,
            },
          ],
          serviceBindings: {
            NATIVE: { name: "native", entrypoint: "NativeProductPreviewService" },
          },
        },
        {
          name: "native",
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./preview-product-native.mjs", import.meta.url)),
              contents: native,
            },
          ],
          bindings: {
            NATIVE_AUTH_REGION_ID: "eu-dev",
            PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
            NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
            NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
          },
          durableObjects: {
            NATIVE_AUTH_ENVIRONMENTS: { className: "NativeAuthEnvironment", useSQLite: true },
          },
          serviceBindings: {
            PREVIEW_CONTROL: { name: "authority", entrypoint: "Lookup" },
            NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY: { name: "authority", entrypoint: "Native" },
          },
        },
        {
          name: "authority",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "authority.mjs",
              contents: `import {WorkerEntrypoint} from 'cloudflare:workers';const record=${JSON.stringify(record)}, authority=${JSON.stringify(authority)};export class Lookup extends WorkerEntrypoint{resolveTokenHash(i){return i.tokenHash===${JSON.stringify(hash)}?record:null}}export class Native extends WorkerEntrypoint{resolve(i){return i.previewId===record.previewId&&i.runtimeGeneration===1&&i.tokenGeneration===1?{preview:record,authority,registration:{},launchAllowed:true}:null}}export default {fetch(){return new Response(null,{status:404})}};`,
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
    expect((await mf.dispatchFetch("https://client.example/rotated")).status).toBe(503);
  } finally {
    await mf.dispose();
  }
}, 30_000);
