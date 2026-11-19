/* global AbortController, Request, Response, URL, ReadableStream, TextEncoder, setTimeout, clearTimeout */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import ts from "typescript";
import {
  armMailPermit,
  cleanupMailPermit,
  gateMailIngress,
  guestMailConfiguration,
  handleMailOutbound,
  peekMailPermit,
  readMailPermitStatus,
  GUEST_ACCEPTANCE,
  GUEST_MAIL_KEY,
} from "./adapter.mjs";
import { createPermitOps } from "./permit.mjs";

const now = () => Date.parse("2026-11-14T12:00:00.000Z");
const id = (number) => String(number).padStart(26, "0");
const sessionId = "a".repeat(32);
const operator = "O".repeat(40); // synthetic test values, never real credentials
const mailKey = "M".repeat(43);
const recipient = "qa@example.invalid";
const scope = {
  platform: "development",
  fixture: "next-app-mail",
  organizationId: id(1),
  projectId: id(2),
  environmentId: id(3),
  handle: "qa-mail",
  origin: "https://dev-qa-mail.dev.check.omh.st",
  principalId: "qa-operator",
  devAccessEpoch: 7,
  recipient,
};

// Real local workerd RPC/DO wiring, backed by synthetic services only; no provider request occurs.
async function checkPrivateWorkerd() {
  const source = fileURLToPath(new URL("./worker.mjs", import.meta.url));
  const privateWorker = await build({
    stdin: {
      contents: `export { QaMailPermit, QaMailPrivate } from ${JSON.stringify(source)};
        export default { fetch() { return new Response(null,{status:404}); } };`,
      loader: "js",
      resolveDir: fileURLToPath(new URL("./", import.meta.url)),
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
          name: "client",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "client.mjs",
              contents: `
        export default { async fetch(request,env) { const u=new URL(request.url);
          if (u.hostname==='status.invalid') return Response.json(await env.PRIVATE.status({sessionId:${JSON.stringify(sessionId)}}));
          if (u.hostname==='config.invalid') return Response.json(await env.PRIVATE.configuration());
          if (u.hostname==='cleanup.invalid') return Response.json(await env.PRIVATE.cleanup({sessionId:${JSON.stringify(sessionId)},generation:1}));
          return u.hostname==='control.preview.dev.omh.st'
            ? env.PRIVATE.arm(request,${JSON.stringify(sessionId)})
            : env.PRIVATE.send(request,{sessionId:${JSON.stringify(sessionId)},generation:1}); } };`,
            },
          ],
          serviceBindings: { PRIVATE: { name: "private-mail", entrypoint: "QaMailPrivate" } },
        },
        {
          name: "private-mail",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: "private-mail.mjs",
              contents: privateWorker.outputFiles[0].text,
            },
          ],
          bindings: {
            QA_MAIL_SCOPE: JSON.stringify(scope),
            QA_MAIL_OPERATOR_TOKEN: operator,
          },
          durableObjects: {
            QA_MAIL_PERMITS: { className: "QaMailPermit", useSQLite: true },
          },
          serviceBindings: {
            QA_SPIKE_MAIL_AUTHORITY: { name: "synthetic", entrypoint: "SpikeMailAuthority" },
            QA_MAIL_KEY_CUSTODY: { name: "synthetic", entrypoint: "Custody" },
            QA_DEV_ACCESS: { name: "synthetic", entrypoint: "Dev" },
            QA_CREDIT: { name: "synthetic", entrypoint: "Credit" },
            QA_MAIL_AUTHORITY: { name: "synthetic", entrypoint: "Authority" },
            MAIL_GATEWAY: { name: "synthetic", entrypoint: "Gateway" },
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
        export class SpikeMailAuthority extends WorkerEntrypoint { readMailSession(i) {
          return Object.keys(i).length===1 && i.sessionId===${JSON.stringify(sessionId)}
            ? {sessionId:i.sessionId,generation:1,expiresAt:Date.now()+60000} : null; } }
        export class Dev extends WorkerEntrypoint { authorizeDevAccessSession(i) { return i.projectId===${JSON.stringify(scope.projectId)} && i.devAccessEpoch===7; } }
        export class Credit extends WorkerEntrypoint { read(i) { return {organizationId:i.organizationId,projectId:i.projectId,environmentId:i.environmentId,allowed:true,paidAllowed:true,reason:null,checkedAt:i.now,expiresAt:new Date(Date.now()+60000).toISOString()}; } }
        export class Authority extends WorkerEntrypoint { authorizeKey(i) { return {organizationId:${JSON.stringify(scope.organizationId)},projectId:i.projectId,environmentId:${JSON.stringify(scope.environmentId)},domain:'example.invalid'}; } }
        export class Custody extends WorkerEntrypoint { read() { return ${JSON.stringify(mailKey)}; } }
        export class Gateway extends WorkerEntrypoint { async fetch(request) { const body=await request.json();
          if(request.redirect!=='manual' || request.headers.get('authorization')!==${JSON.stringify(`Bearer ${mailKey}`)} || body.to!==${JSON.stringify(recipient)}) return new Response(null,{status:403});
          return Response.json({state:'accepted',request_id:${JSON.stringify(id(4))},message_id:'workerd-synthetic'},{status:202}); } }
        export default { fetch(){return new Response(null,{status:404});} };`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const configuration = await runtime.dispatchFetch("https://config.invalid/");
    const guest = await configuration.json();
    assert.equal(guest.OHMYHOST_MAIL_KEY, GUEST_MAIL_KEY);
    assert.equal(guest.PREVIEW_MAIL_RECIPIENT, recipient);
    assert.equal(JSON.stringify(guest).includes(mailKey), false);
    assert.equal(JSON.stringify(guest).includes(operator), false);
    const arm = await runtime.dispatchFetch(
      `https://control.preview.dev.omh.st/__spike/sessions/${sessionId}/mail-permit`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
        body: JSON.stringify({ id: "run-1" }),
      },
    );
    assert.equal(arm.status, 204);
    const send = await runtime.dispatchFetch("https://qa-mail.invalid/v1/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GUEST_MAIL_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "run-1",
      },
      body: JSON.stringify({
        project_id: scope.projectId,
        to: recipient,
        subject: "Preview acceptance run-1",
        text: "Preview acceptance run-1",
      }),
    });
    assert.equal(send.status, 202);
    assert.deepEqual(await send.json(), {
      state: "accepted",
      request_id: id(4),
      message_id: "workerd-synthetic",
    });
    const status = await runtime.dispatchFetch("https://status.invalid/");
    assert.equal((await status.json()).state, "accepted");
    const cleanup = await runtime.dispatchFetch("https://cleanup.invalid/");
    assert.deepEqual(await cleanup.json(), { deleted: true });
    assert.equal(await (await runtime.dispatchFetch("https://status.invalid/")).json(), null);
  } finally {
    await runtime.dispose();
  }
}

function storage() {
  const values = new Map();
  let tail = Promise.resolve();
  return {
    get: async (key) => values.get(key),
    transaction: async (fn) => {
      const work = tail.then(() =>
        fn({
          get: async (key) => values.get(key),
          put: async (key, value) => values.set(key, value),
          delete: async (key) => values.delete(key),
        }),
      );
      tail = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    },
  };
}
function setup() {
  const backing = storage();
  const permit = createPermitOps(backing, sessionId, now);
  const calls = [];
  const controls = {
    authorized: true,
    funded: true,
    correctMailScope: true,
    ready: true,
    gatewayState: "accepted",
    mailKey,
  };
  const env = {
    QA_MAIL_SCOPE: JSON.stringify(scope),
    QA_MAIL_OPERATOR_TOKEN: operator,
    QA_MAIL_KEY_CUSTODY: {
      async read(...args) {
        assert.deepEqual(args, []);
        return controls.mailKey;
      },
    },
    QA_MAIL_PERMITS: { getByName: () => permit },
    QA_SPIKE_MAIL_AUTHORITY: {
      async readMailSession(input) {
        assert.deepEqual(Object.keys(input), ["sessionId"]);
        return input.sessionId === sessionId && controls.ready
          ? { sessionId, generation: 1, expiresAt: now() + 60_000 }
          : null;
      },
    },
    QA_DEV_ACCESS: { authorizeDevAccessSession: async () => controls.authorized },
    QA_CREDIT: {
      read: async () => ({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        allowed: controls.funded,
        paidAllowed: controls.funded,
        reason: controls.funded ? null : "project_budget_exceeded",
        checkedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + 60_000).toISOString(),
      }),
    },
    QA_MAIL_AUTHORITY: {
      authorizeKey: async () => ({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: controls.correctMailScope ? scope.environmentId : id(99),
        domain: "example.invalid",
      }),
    },
    MAIL_GATEWAY: {
      async fetch(request) {
        calls.push({
          authorization: request.headers.get("authorization"),
          project: request.headers.get("x-ohmyhost-egress-project-id"),
          redirect: request.redirect,
          body: await request.json(),
        });
        if (controls.gatewayState === "failure") throw new Error("private details must not escape");
        if (controls.gatewayState === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://foreign.invalid/" },
          });
        if (controls.gatewayState === "malformed")
          return Response.json(
            {
              state: "accepted",
              request_id: id(4),
              message_id: "test-message",
              extra: "untrusted",
            },
            { status: 202 },
          );
        if (controls.gatewayState === "wrongtype")
          return new Response(
            JSON.stringify({ state: "accepted", request_id: id(4), message_id: "test-message" }),
            { status: 202, headers: { "content-type": "text/plain" } },
          );
        return Response.json(
          controls.gatewayState === "accepted"
            ? { state: "accepted", request_id: id(4), message_id: "test-message" }
            : { state: "uncertain", request_id: id(4) },
          { status: 202 },
        );
      },
    },
  };
  env.QA_MAIL_PRIVATE = { peek: (input) => peekMailPermit(input, env) };
  return { env, calls, controls, backing };
}
const armRequest = (token = operator, message = "run-1") =>
  new Request(`https://control.preview.dev.omh.st/__spike/sessions/${sessionId}/mail-permit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: message }),
  });
const ingressRequest = (message = "run-1", auth = GUEST_ACCEPTANCE, path = "/api/mail") =>
  new Request(`https://preview.example.invalid${path}`, {
    method: "POST",
    headers: {
      origin: "https://preview.example.invalid",
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: message }),
  });
const outboundRequest = (overrides = {}) =>
  new Request("https://qa-mail.invalid/v1/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${GUEST_MAIL_KEY}`,
      "content-type": "application/json",
      "idempotency-key": "run-1",
    },
    body: JSON.stringify({
      project_id: scope.projectId,
      to: recipient,
      subject: "Preview acceptance run-1",
      text: "Preview acceptance run-1",
      ...overrides,
    }),
  });

test("operator-only session permit binds one message and exactly two attempts", async () => {
  const config = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.equal(config.error, undefined);
  assert.deepEqual(config.config.durable_objects.bindings, [
    { name: "QA_MAIL_PERMITS", class_name: "QaMailPermit" },
  ]);
  assert.deepEqual(
    config.config.services.find((service) => service.binding === "QA_SPIKE_MAIL_AUTHORITY"),
    {
      binding: "QA_SPIKE_MAIL_AUTHORITY",
      service: "ohmyho-preview-spike-development",
      entrypoint: "SpikeMailAuthority",
    },
  );
  assert.deepEqual(
    config.config.services.find((service) => service.binding === "QA_MAIL_KEY_CUSTODY"),
    {
      binding: "QA_MAIL_KEY_CUSTODY",
      service: "ohmyho-runtime-secret-delivery-poc-private-fullstack",
      entrypoint: "QaPreviewMailKey",
    },
  );
  assert.equal(config.config.account_id, "00000000000000000000000000000001");
  assert.equal(config.config.workers_dev, false);
  assert.equal(config.config.preview_urls, false);
  assert.equal(config.config.routes, undefined);
  const bootstrap = ts.parseConfigFileTextToJson(
    "wrangler.bootstrap.jsonc",
    await readFile(new URL("./wrangler.bootstrap.jsonc", import.meta.url), "utf8"),
  );
  assert.equal(bootstrap.error, undefined);
  assert.deepEqual(bootstrap.config, {
    ...config.config,
    services: config.config.services.filter(
      (service) => service.binding !== "QA_SPIKE_MAIL_AUTHORITY",
    ),
  });
  const { env, backing } = setup();
  assert.deepEqual(await guestMailConfiguration(env, now), {
    OHMYHOST_MAIL_GATEWAY_URL: "https://qa-mail.invalid",
    OHMYHOST_MAIL_KEY: GUEST_MAIL_KEY,
    OHMYHOST_PROJECT_ID: scope.projectId,
    PREVIEW_ACCEPTANCE_KEY: GUEST_ACCEPTANCE,
    PREVIEW_MAIL_RECIPIENT: recipient,
  });
  assert.equal(await readMailPermitStatus({ sessionId }, env), null);
  await assert.rejects(
    readMailPermitStatus({ sessionId: "bad" }, env),
    /qa_mail_status_unavailable/,
  );
  assert.equal((await armMailPermit(armRequest("wrong"), env, sessionId, now)).status, 403);
  assert.equal((await armMailPermit(armRequest(), env, sessionId, now)).status, 204);
  assert.deepEqual(await readMailPermitStatus({ sessionId }, env), {
    id: "run-1",
    generation: 1,
    state: "ready",
    attempts: 0,
    expiresAt: now() + 120_000,
  });
  assert.equal((await armMailPermit(armRequest(), env, sessionId, now)).status, 409);
  const permit = env.QA_MAIL_PERMITS.getByName(sessionId);
  const { scopeHash } = await backing.get("mailPermit");
  assert.equal(await permit.peek({ sessionId, generation: 2, id: "run-1", scopeHash }), false);
  assert.equal(await permit.peek({ sessionId, generation: 1, id: "wrong", scopeHash }), false);
  assert.deepEqual(
    await Promise.all(
      [1, 2, 3].map(() => permit.consume({ sessionId, generation: 1, id: "run-1", scopeHash })),
    ),
    [true, false, false],
  );
  assert.equal(
    await permit.complete({ sessionId, generation: 1, id: "run-1", scopeHash }, "accepted"),
    true,
  );
  assert.equal(await permit.consume({ sessionId, generation: 1, id: "run-1", scopeHash }), true);
  assert.equal(
    await permit.complete({ sessionId, generation: 1, id: "run-1", scopeHash }, "not_sent"),
    true,
  );
  assert.equal((await permit.status()).state, "accepted");
  assert.equal(await permit.consume({ sessionId, generation: 1, id: "run-1", scopeHash }), true);
  assert.equal(
    await permit.complete({ sessionId, generation: 1, id: "run-1", scopeHash }, "unknown"),
    true,
  );
  assert.equal(await permit.consume({ sessionId, generation: 1, id: "run-1", scopeHash }), false);
  assert.equal((await permit.status()).state, "unknown");
  let time = now();
  const expiring = createPermitOps(storage(), sessionId, () => time);
  const temporary = { sessionId, generation: 1, id: "run-1", scopeHash: "b".repeat(64) };
  assert.equal(await expiring.arm(temporary), true);
  time += 120_001;
  assert.equal(await expiring.peek(temporary), false);
  assert.equal(await expiring.consume(temporary), false);
  const locked = createPermitOps(storage(), sessionId, () => time);
  assert.equal(await locked.arm(temporary), true);
  assert.equal(await locked.consume(temporary), true);
  assert.equal(await locked.cleanup({ sessionId, generation: 1 }), false);
  assert.equal(await locked.complete(temporary, "unknown"), true);
  time += 120_001;
  assert.equal(await locked.arm(temporary), false);
  assert.equal((await locked.status()).state, "unknown");
  assert.equal(await locked.cleanup({ sessionId, generation: 1 }), false);
  const disposable = setup();
  assert.deepEqual(await cleanupMailPermit({ sessionId, generation: 0 }, disposable.env), {
    deleted: true,
  });
  assert.equal((await armMailPermit(armRequest(), disposable.env, sessionId, now)).status, 204);
  assert.deepEqual(await cleanupMailPermit({ sessionId, generation: 2 }, disposable.env), {
    deleted: false,
  });
  assert.deepEqual(await cleanupMailPermit({ sessionId, generation: 1 }, disposable.env), {
    deleted: true,
  });
  assert.equal(await disposable.backing.get("mailPermit"), undefined);
  await assert.rejects(
    cleanupMailPermit({ sessionId, generation: -1 }, disposable.env),
    /qa_mail_cleanup_unavailable/,
  );
  const other = setup();
  other.env.QA_MAIL_SCOPE = JSON.stringify({ ...scope, platform: "production" });
  assert.equal((await armMailPermit(armRequest(), other.env, sessionId, now)).status, 503);
  assert.equal((await armMailPermit(armRequest(), env, "b".repeat(32), now)).status, 403);
  const fakeKey = setup();
  fakeKey.controls.mailKey = GUEST_MAIL_KEY;
  assert.equal((await armMailPermit(armRequest(), fakeKey.env, sessionId, now)).status, 403);
  const noCustody = setup();
  noCustody.env.QA_MAIL_KEY = mailKey;
  delete noCustody.env.QA_MAIL_KEY_CUSTODY;
  assert.equal((await armMailPermit(armRequest(), noCustody.env, sessionId, now)).status, 503);
  assert.equal(await guestMailConfiguration(noCustody.env, now), null);
  assert.equal(await noCustody.backing.get("mailPermit"), undefined);
  assert.equal(noCustody.calls.length, 0);
  const custodyError = setup();
  custodyError.env.QA_MAIL_KEY_CUSTODY.read = async () => {
    throw new Error(`sensitive-${mailKey}`);
  };
  const unavailable = await armMailPermit(armRequest(), custodyError.env, sessionId, now);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { code: "mail_gateway_unavailable" });
  assert.equal(custodyError.calls.length, 0);
  const custodyLost = setup();
  assert.equal((await armMailPermit(armRequest(), custodyLost.env, sessionId, now)).status, 204);
  delete custodyLost.env.QA_MAIL_KEY_CUSTODY;
  assert.equal((await readMailPermitStatus({ sessionId }, custodyLost.env)).state, "ready");
  assert.deepEqual(await cleanupMailPermit({ sessionId, generation: 1 }, custodyLost.env), {
    deleted: true,
  });
  const disconnected = setup();
  delete disconnected.env.QA_SPIKE_MAIL_AUTHORITY;
  let legacyReads = 0;
  disconnected.env.SANDBOX = {
    getByName() {
      legacyReads++;
      return {
        status: async () => ({
          config: { fixture: "next-app-mail" },
          generation: 1,
          ready: true,
          running: true,
        }),
      };
    },
  };
  disconnected.env.SPIKE_LIMIT = {
    getByName() {
      legacyReads++;
      return { current: async () => ({ id: sessionId, expiresAt: now() + 60_000 }) };
    },
  };
  assert.equal((await armMailPermit(armRequest(), disconnected.env, sessionId, now)).status, 503);
  assert.equal(
    (await gateMailIngress(ingressRequest(), disconnected.env, sessionId, now)).response.status,
    503,
  );
  assert.equal(
    (
      await handleMailOutbound(
        outboundRequest(),
        disconnected.env,
        { sessionId, generation: 1 },
        now,
      )
    ).status,
    503,
  );
  assert.equal(legacyReads, 0);
  assert.equal(await disconnected.backing.get("mailPermit"), undefined);
  assert.equal(disconnected.calls.length, 0);
  for (const snapshot of [
    null,
    true,
    { sessionId: "b".repeat(32), generation: 1, expiresAt: now() + 60_000 },
    { sessionId, generation: 0, expiresAt: now() + 60_000 },
    { sessionId, generation: 1.5, expiresAt: now() + 60_000 },
    { sessionId, generation: 1, expiresAt: now() },
    { sessionId, generation: 1, expiresAt: Infinity },
    { sessionId, generation: 1, expiresAt: now() + 60_000, active: true },
  ]) {
    const denied = setup();
    denied.env.QA_SPIKE_MAIL_AUTHORITY.readMailSession = async () => snapshot;
    assert.equal((await armMailPermit(armRequest(), denied.env, sessionId, now)).status, 403);
    assert.equal(await denied.backing.get("mailPermit"), undefined);
    assert.equal(denied.calls.length, 0);
  }
  const reused = setup();
  const duplicate = "D".repeat(43);
  reused.controls.mailKey = duplicate;
  reused.env.QA_MAIL_OPERATOR_TOKEN = duplicate;
  assert.equal(
    (await armMailPermit(armRequest(duplicate), reused.env, sessionId, now)).status,
    403,
  );
  const streamRequest = (body) =>
    new Request(`https://control.preview.dev.omh.st/__spike/sessions/${sessionId}/mail-permit`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body,
      duplex: "half",
    });
  let count = 0;
  const emptyChunks = new ReadableStream({
    pull(controller) {
      if (count++ < 1025) controller.enqueue(new Uint8Array());
      else {
        controller.enqueue(new TextEncoder().encode('{"id":"run-1"}'));
        controller.close();
      }
    },
  });
  const oversized = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(2049));
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  let timer;
  const [emptyResult, cancelResult] = await Promise.all([
    armMailPermit(streamRequest(emptyChunks), setup().env, sessionId, now),
    Promise.race([
      armMailPermit(streamRequest(oversized), setup().env, sessionId, now),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 500);
      }),
    ]),
  ]);
  clearTimeout(timer);
  assert.equal(emptyResult.status, 503);
  assert.equal(cancelResult?.status, 503);
  let canceled = false;
  const noEnd = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"run-1"}'));
    },
    cancel() {
      canceled = true;
    },
  });
  const incomplete = await armMailPermit(streamRequest(noEnd), setup().env, sessionId, now);
  assert.equal(incomplete.status, 503);
  assert.equal(canceled, true);
});

test("fixture ingress accepts only an armed exact route and never forwards a secret", async () => {
  const { env } = setup();
  assert.equal((await gateMailIngress(ingressRequest(), env, sessionId, now)).response.status, 403);
  assert.equal((await armMailPermit(armRequest(), env, sessionId, now)).status, 204);
  const result = await gateMailIngress(ingressRequest("run-1", operator), env, sessionId, now);
  assert.equal(result.request.headers.get("authorization"), `Bearer ${GUEST_ACCEPTANCE}`);
  assert.notEqual(result.request.headers.get("authorization"), `Bearer ${operator}`);
  assert.equal(
    (await gateMailIngress(ingressRequest("wrong"), env, sessionId, now)).response.status,
    403,
  );
  assert.equal(
    (await gateMailIngress(ingressRequest("run-1", operator, "/api%2Fmail"), env, sessionId, now))
      .response.status,
    404,
  );
  assert.equal(
    (await gateMailIngress(ingressRequest("run-1", operator, "/api/mail/"), env, sessionId, now))
      .response.status,
    404,
  );
  const nonBoolean = { ...env, QA_MAIL_PRIVATE: { peek: async () => ({ authorized: true }) } };
  assert.equal(
    (await gateMailIngress(ingressRequest(), nonBoolean, sessionId, now)).response.status,
    403,
  );
});

test("fixture ingress permits safe encoded Next chunks without weakening the route gate", async () => {
  const { env } = setup();
  const observed = [
    "/_next/static/chunks/0zix_%40swc_helpers_cjs_0hi-e474n4mns._.js",
    "/_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client_hmr-client_ts_1l3f3x0di7ae6._.js",
  ];
  for (const method of ["GET", "HEAD"]) {
    for (const path of observed) {
      const request = new Request(`https://preview.example.test${path}?v=1`, {
        method,
        headers: { authorization: "Bearer synthetic" },
      });
      const result = await gateMailIngress(request, env, sessionId, now);
      assert.equal(result.response, undefined);
      assert.equal(result.request.url, request.url);
      assert.equal(result.request.headers.get("authorization"), null);
    }
  }
  for (const [method, path] of [
    ["GET", "/api%2Fmail"],
    ["GET", "/_next/static/chunks/%5Bx%5D%2efile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%2ffile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%5cfile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%2f..%2ffile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%5c..%5cfile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%252ffile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%00file.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D%zzfile.js"],
    ["GET", "/_next/static/chunks/%5Bx%5D.txt"],
    ["GET", "/other/%5Bx%5D.js"],
    ["POST", "/_next/static/chunks/%5Bx%5D.js"],
  ]) {
    const request = new Request(`https://preview.example.test${path}`, { method });
    assert.equal((await gateMailIngress(request, env, sessionId, now)).response.status, 404);
  }
});

test("private relay injects a real-binding key only for the permitted QA message", async () => {
  const { env, calls, controls } = setup();
  assert.equal((await armMailPermit(armRequest(), env, sessionId, now)).status, 204);
  const props = { sessionId, generation: 1 };
  for (const snapshot of [
    null,
    true,
    { sessionId: "b".repeat(32), generation: 1, expiresAt: now() + 60_000 },
    { sessionId, generation: 2, expiresAt: now() + 60_000 },
    { sessionId, generation: 1, expiresAt: now() },
    { sessionId, generation: 1, expiresAt: now() + 60_000, ready: true },
  ]) {
    const denied = setup();
    assert.equal((await armMailPermit(armRequest(), denied.env, sessionId, now)).status, 204);
    denied.env.QA_SPIKE_MAIL_AUTHORITY.readMailSession = async () => snapshot;
    assert.equal((await handleMailOutbound(outboundRequest(), denied.env, props, now)).status, 403);
    assert.equal((await denied.backing.get("mailPermit")).attempts, 0);
    assert.equal(denied.calls.length, 0);
  }
  const disconnected = setup();
  assert.equal((await armMailPermit(armRequest(), disconnected.env, sessionId, now)).status, 204);
  delete disconnected.env.QA_SPIKE_MAIL_AUTHORITY;
  assert.equal(
    (await handleMailOutbound(outboundRequest(), disconnected.env, props, now)).status,
    503,
  );
  assert.equal((await disconnected.backing.get("mailPermit")).attempts, 0);
  assert.equal(disconnected.calls.length, 0);
  const revoked = setup();
  assert.equal((await armMailPermit(armRequest(), revoked.env, sessionId, now)).status, 204);
  let sessionReads = 0;
  revoked.env.QA_SPIKE_MAIL_AUTHORITY.readMailSession = async () =>
    ++sessionReads === 1 ? { sessionId, generation: 1, expiresAt: now() + 60_000 } : null;
  assert.equal((await handleMailOutbound(outboundRequest(), revoked.env, props, now)).status, 403);
  assert.equal(sessionReads, 2);
  assert.equal((await revoked.backing.get("mailPermit")).attempts, 0);
  assert.equal(revoked.calls.length, 0);
  const rotated = setup();
  assert.equal((await armMailPermit(armRequest(), rotated.env, sessionId, now)).status, 204);
  rotated.controls.mailKey = "R".repeat(43);
  assert.equal(await peekMailPermit({ sessionId, generation: 1, id: "run-1" }, rotated.env), false);
  assert.equal((await handleMailOutbound(outboundRequest(), rotated.env, props, now)).status, 403);
  assert.equal((await rotated.backing.get("mailPermit")).attempts, 0);
  assert.equal(rotated.calls.length, 0);
  const rotating = setup();
  assert.equal((await armMailPermit(armRequest(), rotating.env, sessionId, now)).status, 204);
  let keyReads = 0;
  rotating.env.QA_MAIL_KEY_CUSTODY.read = async () => (++keyReads === 1 ? mailKey : "R".repeat(43));
  assert.equal((await handleMailOutbound(outboundRequest(), rotating.env, props, now)).status, 403);
  assert.equal(keyReads, 2);
  assert.equal((await rotating.backing.get("mailPermit")).attempts, 0);
  assert.equal(rotating.calls.length, 0);
  assert.equal(
    (await handleMailOutbound(outboundRequest({ to: "other@example.invalid" }), env, props, now))
      .status,
    403,
  );
  assert.equal(
    (await handleMailOutbound(outboundRequest({ project_id: id(99) }), env, props, now)).status,
    403,
  );
  assert.equal(
    (await handleMailOutbound(outboundRequest({ subject: "arbitrary" }), env, props, now)).status,
    403,
  );
  assert.equal(
    (await handleMailOutbound(outboundRequest({ from: "other@example.invalid" }), env, props, now))
      .status,
    403,
  );
  assert.equal(
    (await handleMailOutbound(outboundRequest(), env, { sessionId, generation: 2 }, now)).status,
    403,
  );
  controls.correctMailScope = false;
  assert.equal((await handleMailOutbound(outboundRequest(), env, props, now)).status, 403);
  controls.correctMailScope = true;
  controls.authorized = false;
  assert.equal((await handleMailOutbound(outboundRequest(), env, props, now)).status, 403);
  controls.authorized = true;
  controls.funded = false;
  assert.equal((await handleMailOutbound(outboundRequest(), env, props, now)).status, 403);
  controls.funded = true;
  assert.equal(calls.length, 0);
  const first = await handleMailOutbound(outboundRequest(), env, props, now);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    state: "accepted",
    request_id: id(4),
    message_id: "test-message",
  });
  assert.equal(calls[0].authorization, `Bearer ${mailKey}`);
  assert.equal(calls[0].project, scope.projectId);
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[0].body.to, recipient);
  controls.gatewayState = "uncertain";
  const second = await handleMailOutbound(outboundRequest(), env, props, now);
  assert.equal(second.status, 202);
  assert.equal((await second.json()).state, "uncertain");
  assert.equal((await handleMailOutbound(outboundRequest(), env, props, now)).status, 403);
  assert.equal(calls.length, 2);
  for (const mode of ["failure", "malformed", "wrongtype", "redirect"]) {
    const candidate = setup();
    candidate.controls.gatewayState = mode;
    assert.equal((await armMailPermit(armRequest(), candidate.env, sessionId, now)).status, 204);
    const response = await handleMailOutbound(outboundRequest(), candidate.env, props, now);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: "qa_mail_outcome_unknown" });
    assert.equal(candidate.calls.length, 1);
    assert.equal(
      (await handleMailOutbound(outboundRequest(), candidate.env, props, now)).status,
      403,
    );
    assert.equal((await armMailPermit(armRequest(), candidate.env, sessionId, now)).status, 409);
    assert.equal(candidate.calls.length, 1);
  }
  const concurrent = setup();
  assert.equal((await armMailPermit(armRequest(), concurrent.env, sessionId, now)).status, 204);
  let releaseGateway;
  let gatewayStarted;
  const started = new Promise((resolve) => {
    gatewayStarted = resolve;
  });
  const released = new Promise((resolve) => {
    releaseGateway = resolve;
  });
  concurrent.env.MAIL_GATEWAY.fetch = async () => {
    concurrent.calls.push({});
    gatewayStarted();
    await released;
    return Response.json(
      { state: "accepted", request_id: id(4), message_id: "test-message" },
      { status: 202 },
    );
  };
  const firstPending = handleMailOutbound(outboundRequest(), concurrent.env, props, now);
  await started;
  assert.equal(
    (await handleMailOutbound(outboundRequest(), concurrent.env, props, now)).status,
    403,
  );
  assert.equal((await armMailPermit(armRequest(), concurrent.env, sessionId, now)).status, 409);
  assert.equal(concurrent.calls.length, 1);
  releaseGateway();
  assert.equal((await firstPending).status, 202);
  assert.equal(
    (await handleMailOutbound(outboundRequest(), concurrent.env, props, now)).status,
    202,
  );
  assert.equal(concurrent.calls.length, 2);
  const aborted = setup();
  assert.equal((await armMailPermit(armRequest(), aborted.env, sessionId, now)).status, 204);
  const preAbort = new AbortController();
  preAbort.abort();
  assert.equal(
    (
      await handleMailOutbound(
        new Request(outboundRequest(), { signal: preAbort.signal }),
        aborted.env,
        props,
        now,
      )
    ).status,
    503,
  );
  assert.equal((await aborted.backing.get("mailPermit")).attempts, 0);
  const inFlightAbort = new AbortController();
  let dispatchStarted;
  const dispatched = new Promise((resolve) => {
    dispatchStarted = resolve;
  });
  aborted.env.MAIL_GATEWAY.fetch = (request) =>
    new Promise((_resolve, reject) => {
      dispatchStarted();
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const interrupted = handleMailOutbound(
    new Request(outboundRequest(), { signal: inFlightAbort.signal }),
    aborted.env,
    props,
    now,
  );
  await dispatched;
  inFlightAbort.abort();
  assert.deepEqual(await (await interrupted).json(), { code: "qa_mail_outcome_unknown" });
  assert.equal((await readMailPermitStatus({ sessionId }, aborted.env)).state, "unknown");
  assert.equal((await armMailPermit(armRequest(), aborted.env, sessionId, now)).status, 409);
  const changed = setup();
  assert.equal((await armMailPermit(armRequest(), changed.env, sessionId, now)).status, 204);
  changed.env.QA_MAIL_SCOPE = JSON.stringify({ ...scope, recipient: "other@example.invalid" });
  assert.equal(
    (
      await handleMailOutbound(
        outboundRequest({ to: "other@example.invalid" }),
        changed.env,
        props,
        now,
      )
    ).status,
    403,
  );
  assert.equal(changed.calls.length, 0);
  changed.env.QA_MAIL_SCOPE = JSON.stringify(scope);
  changed.env.QA_MAIL_OPERATOR_TOKEN = "N".repeat(40);
  assert.equal(
    (await gateMailIngress(ingressRequest(), changed.env, sessionId, now)).response.status,
    403,
  );
  await checkPrivateWorkerd();
});
