/* global Response, Request, URL */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { handleRequest } from "../router.mjs";

const token = "a-private-local-test-token-at-least-32-bytes";
const domain = "preview.dev.omh.st";
const secretHeader = { authorization: `Bearer ${token}`, "content-type": "application/json" };

function environment() {
  const events = [];
  let lease = null;
  const limiter = {
    async claim(id) {
      if (lease) return false;
      lease = { id };
      return true;
    },
    async current() {
      return lease;
    },
    async release(id) {
      if (lease?.id === id) lease = null;
    },
  };
  const stub = {
    async initialize(value) {
      events.push(["initialize", value]);
    },
    async status() {
      events.push(["status"]);
      return { running: false };
    },
    async edit(value) {
      events.push(["edit", value]);
      return { revision: 1 };
    },
    async activity() {
      events.push(["activity"]);
      return { woke: false };
    },
    async fetch(request) {
      events.push(["preview", request.url]);
      return new Response("fixture");
    },
  };
  return {
    events,
    env: {
      SPIKE_CONTROL_TOKEN: token,
      SPIKE_PREVIEW_DOMAIN: domain,
      SPIKE_LIMIT: {
        getByName() {
          return limiter;
        },
      },
      SANDBOX: {
        idFromName(id) {
          events.push(["instance-id", id]);
          return { toString: () => id.repeat(2) };
        },
        getByName(id) {
          events.push(["lookup", id]);
          return stub;
        },
      },
    },
  };
}

test("control API authenticates before looking up or starting any session", async () => {
  const { env, events } = environment();
  const unauthorized = await handleRequest(
    new Request(`https://control.${domain}/__spike/sessions`, {
      method: "POST",
      body: JSON.stringify({ fixture: "next-edge", instance: "basic" }),
    }),
    env,
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(events, []);
  const invalid = await handleRequest(
    new Request(`https://control.${domain}/__spike/sessions`, {
      method: "POST",
      headers: secretHeader,
      body: JSON.stringify({ fixture: "nope", instance: "basic" }),
    }),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(events, []);
});

test("container actor identity is returned only by authenticated control status", async () => {
  const id = "1".repeat(32);
  const { env, events } = environment();
  const path = `/__spike/sessions/${id}/status`;
  const unauthorized = await handleRequest(new Request(`https://control.${domain}${path}`), env);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(events, []);
  const publicHost = await handleRequest(
    new Request(`https://fixture.${domain}${path}`, { headers: secretHeader }),
    env,
  );
  assert.equal(publicHost.status, 404);
  assert.deepEqual(events, []);
  const status = await handleRequest(
    new Request(`https://control.${domain}${path}`, { headers: secretHeader }),
    env,
  );
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { running: false, containerInstanceId: id.repeat(2) });
  assert.deepEqual(events, [["lookup", id], ["status"], ["instance-id", id]]);

  env.SANDBOX.idFromName = () => ({ toString: () => "A".repeat(64) });
  const invalid = await handleRequest(
    new Request(`https://control.${domain}${path}`, { headers: secretHeader }),
    env,
  );
  assert.equal(invalid.status, 500);
  assert.deepEqual(await invalid.json(), { error: "operation_failed" });
});

test("the control ID matches the actual local workerd Durable Object actor ID", async () => {
  const source = fileURLToPath(new URL("../router.mjs", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import {handleRequest} from ${JSON.stringify(source)};
        import {DurableObject} from 'cloudflare:workers';
        export class Sandbox extends DurableObject { status() { return {running:false,actorId:this.ctx.id.toString()}; } }
        export class Limiter extends DurableObject {}
        export default {fetch:handleRequest};`,
      loader: "js",
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
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
          name: "actor-id-test",
          compatibilityDate: "2026-08-24",
          modules: [{ type: "ESModule", path: "worker.mjs", contents: bundle.outputFiles[0].text }],
          bindings: { SPIKE_CONTROL_TOKEN: token, SPIKE_PREVIEW_DOMAIN: domain },
          durableObjects: {
            SANDBOX: { className: "Sandbox", useSQLite: true },
            SPIKE_LIMIT: { className: "Limiter", useSQLite: true },
          },
        },
      ],
    }),
  );
  try {
    const id = "a".repeat(32);
    const response = await runtime.dispatchFetch(
      `https://control.${domain}/__spike/sessions/${id}/status`,
      { headers: secretHeader },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.containerInstanceId, /^[a-f0-9]{64}$/u);
    assert.equal(result.containerInstanceId, result.actorId);
    assert.notEqual(result.containerInstanceId, id.repeat(2));
  } finally {
    await runtime.dispose();
  }
});

test("created hostname routes to the same sandbox, status does not wake it, and edits stay bounded", async () => {
  const { env, events } = environment();
  const created = await handleRequest(
    new Request(`https://control.${domain}/__spike/sessions`, {
      method: "POST",
      headers: secretHeader,
      body: JSON.stringify({ fixture: "next-edge", instance: "basic" }),
    }),
    env,
  );
  const { id, url } = await created.json();
  assert.equal(created.status, 201);
  const status = await handleRequest(
    new Request(`https://control.${domain}/__spike/sessions/${id}/status`, {
      headers: secretHeader,
    }),
    env,
  );
  assert.deepEqual(await status.json(), { running: false, containerInstanceId: id.repeat(2) });
  assert.ok(events.some((event) => event[0] === "instance-id" && event[1] === id));
  assert.equal(
    events.some((event) => event[0] === "preview"),
    false,
  );
  const badEdit = await handleRequest(
    new Request(`https://control.${domain}/__spike/sessions/${id}/edit`, {
      method: "POST",
      headers: secretHeader,
      body: JSON.stringify({ path: "src/../../secret", content: "x" }),
    }),
    env,
  );
  assert.equal(badEdit.status, 400);
  const app = await handleRequest(new Request(url), env);
  assert.equal(await app.text(), "fixture");
  assert.deepEqual(events.at(-2), ["lookup", id]);
  assert.equal(events.at(-1)[0], "preview");
  const inactive = await handleRequest(
    new Request(`${url}__spike/activity`, {
      method: "POST",
      headers: {
        origin: "https://attacker.test",
        "sec-fetch-site": "cross-site",
        "x-spike-activity": "1",
      },
    }),
    env,
  );
  assert.equal(inactive.status, 404);
  const active = await handleRequest(
    new Request(`${url}__spike/activity`, {
      method: "POST",
      headers: {
        origin: new URL(url).origin,
        "sec-fetch-site": "same-origin",
        "x-spike-activity": "1",
      },
    }),
    env,
  );
  assert.deepEqual(await active.json(), { woke: false });
  assert.equal(events.at(-1)[0], "activity");
  const forged = await handleRequest(new Request(url.replace(id, `${id.slice(0, -1)}z`)), env);
  assert.equal(forged.status, 404);
});
