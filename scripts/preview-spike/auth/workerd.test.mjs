/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decodeValue } from "../capabilities/wire.mjs";
import { QA_FIXTURES } from "../capabilities/config.mjs";

// Real local workerd service bindings, with synthetic authority/backend; never hosted evidence.
test("workerd session binding uses immutable service props rather than guest headers", async () => {
  const scope = {
    platform: "development",
    fixture: "next-native-auth",
    region: "eu",
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    handle: "qa-auth",
    devOrigin: "https://dev-qa-auth.dev.check.omh.st",
    principalId: "qa-operator",
    devAccessEpoch: 3,
    previewId: "a".repeat(32),
    previewOrigin: `https://${"a".repeat(32)}-${"b".repeat(24)}.preview.dev.omh.st`,
    authGeneration: 7,
  };
  const id = (number) => String(number).padStart(26, "0");
  const manifest = {
    platform: "development",
    projects: QA_FIXTURES.map((fixture, index) =>
      fixture === "next-native-auth"
        ? {
            fixture,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            physicalEnvironmentId: id(30 + index),
            registrationVersion: 1,
            region: "eu",
            handle: scope.handle,
            origin: scope.devOrigin,
            principalId: scope.principalId,
            devAccessEpoch: scope.devAccessEpoch,
          }
        : {
            fixture,
            organizationId: id(1),
            projectId: id(10 + index),
            environmentId: id(20 + index),
            physicalEnvironmentId: id(30 + index),
            registrationVersion: 1,
            region: "eu",
            handle: `qa-${index}`,
            origin: `https://dev-qa-${index}.dev.check.omh.st`,
            principalId: "qa-operator",
            devAccessEpoch: 1,
          },
    ),
  };
  const source = fileURLToPath(new URL("./entrypoint.mjs", import.meta.url));
  const bundle = await build({
    entryPoints: [source],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  const authority = {
    platform: scope.platform,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    region: scope.region,
    previewId: scope.previewId,
    previewOrigin: scope.previewOrigin,
    authGeneration: scope.authGeneration,
    devAccessEpoch: scope.devAccessEpoch,
    revocationEpoch: 9,
    configurationRevision: 4,
    enabled: true,
    sourceCapable: true,
    paidAllowed: true,
    runtimeAllowed: true,
  };
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "guest-test",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "guest.mjs",
              contents: `export default { fetch(request, env) { return env.QA_AUTH.fetch(request); } };`,
            },
          ],
          serviceBindings: {
            QA_AUTH: {
              name: "auth-bridge",
              entrypoint: "QaNativeAuthSessionOutbound",
              props: { scope },
            },
          },
        },
        {
          name: "auth-bridge",
          compatibilityDate: "2026-08-24",
          bindings: { SPIKE_QA_MANIFEST: JSON.stringify(manifest) },
          modules: [
            { type: "ESModule", path: "auth-bridge.mjs", contents: bundle.outputFiles[0].text },
          ],
          serviceBindings: {
            QA_STABLE_PREVIEW_AUTHORITY: { name: "synthetic", entrypoint: "Authority" },
            QA_DEV_ACCESS: { name: "synthetic", entrypoint: "DevAccess" },
            QA_CREDIT: { name: "synthetic", entrypoint: "Credit" },
            QA_NATIVE_STABLE_PREVIEW: { name: "synthetic", entrypoint: "NativePreview" },
          },
        },
        {
          name: "synthetic",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "synthetic.mjs",
              contents: `
        import { WorkerEntrypoint } from 'cloudflare:workers';
        export class Authority extends WorkerEntrypoint {
          resolve(input) { return input.previewId === ${JSON.stringify(scope.previewId)} && input.authGeneration === 7 ? ${JSON.stringify(authority)} : null; }
        }
        export class DevAccess extends WorkerEntrypoint {
          authorizeDevAccessSession(input) { return input.projectId === ${JSON.stringify(scope.projectId)} && input.environmentId === ${JSON.stringify(scope.environmentId)} && input.devAccessEpoch === 3; }
        }
        export class Credit extends WorkerEntrypoint {
          read(input) { return { organizationId:input.organizationId, projectId:input.projectId, environmentId:input.environmentId,
            allowed:true, paidAllowed:true, reason:null, checkedAt:input.now, expiresAt:new Date(Date.now()+60000).toISOString() }; }
        }
        export class NativePreview extends WorkerEntrypoint {
          validateStablePreviewSession(input, cookie) { return input.previewId === ${JSON.stringify(scope.previewId)} && input.authGeneration === 7 && cookie === 'synthetic=1'
            ? {user:{id:'synthetic-user',email:'qa@example.invalid'},session:{id:'synthetic-session',expiresAt:'2099-01-01T00:00:00.000Z'}} : null; }
        }
        export default { fetch() { return new Response(null,{status:404}); } };`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const response = await runtime.dispatchFetch(
      "http://preview.capabilities/native-auth/session",
      {
        method: "POST",
        headers: { cookie: "synthetic=1", "x-project-id": "forged", "x-auth-generation": "999" },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(decodeValue(await response.text()), {
      user: { id: "synthetic-user", email: "qa@example.invalid" },
      session: { id: "synthetic-session", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
  } finally {
    await runtime.dispose();
  }
});
