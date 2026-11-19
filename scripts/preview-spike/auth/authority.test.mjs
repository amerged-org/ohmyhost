/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { QA_FIXTURES } from "../capabilities/config.mjs";

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
};
const id = (n) => String(n).padStart(26, "0");
const manifest = {
  platform: "development",
  projects: QA_FIXTURES.map((fixture, index) =>
    fixture === scope.fixture
      ? {
          fixture,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          physicalEnvironmentId: id(30 + index),
          registrationVersion: 1,
          region: scope.region,
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

test("private QA state and real workerd RPC recheck Core and keep Auth generation through wake", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./authority.mjs", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  const runtime = new Miniflare(
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
      export default { async fetch(request, env) { try { const {method,input}=await request.json();
        if(method==='set') return Response.json(await env.CORE.set(input));
        return Response.json(await env[method==='create'||method==='rotate'||method==='revoke'||method==='retire'?'MANAGE':'READ'][method](input));
      } catch { return new Response(null,{status:503}); } } };`,
            },
          ],
          serviceBindings: {
            MANAGE: { name: "qa", entrypoint: "QaStablePreviewManagement" },
            READ: { name: "qa", entrypoint: "QaStablePreviewAuthority" },
            CORE: { name: "core", entrypoint: "Core" },
          },
        },
        {
          name: "qa",
          compatibilityDate: "2026-08-24",
          modules: [{ type: "ESModule", path: "qa.mjs", contents: bundle.outputFiles[0].text }],
          bindings: { SPIKE_QA_MANIFEST: JSON.stringify(manifest) },
          durableObjects: {
            QA_PREVIEW_STATES: { className: "QaStablePreviewState", useSQLite: true },
          },
          serviceBindings: {
            QA_REALM_AUTHORITY: { name: "core", entrypoint: "Core" },
            QA_DEV_ACCESS: { name: "core", entrypoint: "Core" },
          },
        },
        {
          name: "core",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "core.mjs",
              contents: `
      import { WorkerEntrypoint } from 'cloudflare:workers'; let change={}, hold=false, waiting=0;
      export class Core extends WorkerEntrypoint {
        set(input){if(input.hold){hold=true;return true;} if(input.probe)return waiting>0; if(input.release){hold=false;return true;}change=input;return true;}
        async authorizeDevAccessSession(i){if(hold){waiting++;await new Promise(r=>setTimeout(r,500));waiting--;}return !change.revoke && i.projectId===${JSON.stringify(scope.projectId)} && i.environmentId===${JSON.stringify(scope.environmentId)} && i.principalId==='qa-operator' && i.devAccessEpoch===3;}
        resolve(i){if(change.lost) throw Error('unavailable');return {organizationId:${JSON.stringify(scope.organizationId)},region:'eu',deploymentId:'01ARZ3NDEKTSV4RRFFQ69G5FAY',
          realm:{projectId:i.projectId,environmentId:i.environmentId,canonicalOrigin:'https://app.example',realmGeneration:9,configurationRevision:4},
          revocationEpoch:9,enabled:!change.disabled,sourceCapable:!change.sourceLost,paidAllowed:!change.unpaid,runtimeAllowed:!change.storageLost,
          applicationName:'QA',signupPolicy:'open',allowedRedirectPaths:['/login','/reset-password','/accept-invitation'],resetPasswordPath:'/reset-password',invitationPath:'/accept-invitation'};}
      } export default {fetch(){return new Response(null,{status:404});}};`,
            },
          ],
        },
      ],
    }),
  );
  async function call(method, input) {
    const response = await runtime.dispatchFetch("https://test.invalid", {
      method: "POST",
      body: JSON.stringify({ method, input }),
    });
    return response.ok ? response.json() : null;
  }
  try {
    const first = { previewId: scope.previewId, authGeneration: 1 };
    assert.deepEqual(await call("create", scope), first);
    assert.deepEqual(await call("create", scope), first);
    const before = await call("resolve", first);
    assert.deepEqual(before, {
      platform: "development",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      region: "eu",
      previewId: scope.previewId,
      previewOrigin: scope.previewOrigin,
      authGeneration: 1,
      devAccessEpoch: 3,
      revocationEpoch: 9,
      configurationRevision: 4,
      enabled: true,
      sourceCapable: true,
      paidAllowed: true,
      runtimeAllowed: true,
    });
    const native = await call("resolveForNative", first);
    assert.equal(native.realm.canonicalOrigin, scope.previewOrigin);
    assert.deepEqual(native.preview, first);
    assert.equal((await call("resolve", first)).authGeneration, 1); // no source or process generation participates
    for (const change of [
      { revoke: true },
      { disabled: true },
      { sourceLost: true },
      { unpaid: true },
      { storageLost: true },
      { lost: true },
    ]) {
      await call("set", change);
      assert.equal(await call("resolve", first), null);
    }
    await call("set", {});
    assert.equal(await call("create", { ...scope, projectId: id(99) }), null);
    const second = { previewId: scope.previewId, authGeneration: 2 };
    assert.deepEqual(await call("rotate", first), second);
    assert.equal(await call("resolve", first), null);
    assert.deepEqual((await call("resolveForNative", second)).preview, second);
    assert.equal(await call("rotate", first), null);
    assert.equal(await call("retire", first), null); // stale generation cannot retire the successor
    assert.deepEqual((await call("resolveForNative", second)).preview, second);
    assert.equal(await call("revoke", second), true);
    assert.equal(await call("revoke", second), true);
    assert.equal(await call("resolve", second), null);
    assert.equal(await call("create", scope), null); // terminal; no resurrection
    const lostScope = {
      ...scope,
      previewId: "c".repeat(32),
      previewOrigin: `https://${"c".repeat(32)}-${"b".repeat(24)}.preview.dev.omh.st`,
    };
    const lostIdentity = { previewId: lostScope.previewId, authGeneration: 1 };
    await call("create", lostScope); // treat the successful create reply as lost
    assert.equal(await call("retire", lostIdentity), true);
    assert.equal(await call("retire", lostIdentity), true);
    assert.equal(await call("resolve", lostIdentity), null);
    assert.equal(await call("create", lostScope), null);

    const delayedScope = {
      ...scope,
      previewId: "d".repeat(32),
      previewOrigin: `https://${"d".repeat(32)}-${"b".repeat(24)}.preview.dev.omh.st`,
    };
    const delayedIdentity = { previewId: delayedScope.previewId, authGeneration: 1 };
    await call("set", { hold: true });
    const delayedCreate = call("create", delayedScope);
    let entered = false;
    for (let count = 0; count < 20 && !entered; count += 1)
      entered = await call("set", { probe: true });
    assert.equal(entered, true);
    assert.equal(await call("retire", delayedIdentity), true);
    await call("set", { release: true });
    assert.equal(await delayedCreate, null);
    assert.equal(await call("create", delayedScope), null);
  } finally {
    await runtime.dispose();
  }
});
