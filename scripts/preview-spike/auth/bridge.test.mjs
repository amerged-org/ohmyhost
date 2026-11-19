/* global Request, Response, ReadableStream, AbortController */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeValue } from "../capabilities/wire.mjs";
import { QA_FIXTURES } from "../capabilities/config.mjs";
import { handleQaAuthPublic, handleQaAuthSession, readQaAuthScope } from "./bridge.mjs";

const scope = Object.freeze({
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
});
const qaId = (number) => String(number).padStart(26, "0");
function manifestFor(scope) {
  return {
    platform: "development",
    projects: QA_FIXTURES.map((fixture, index) =>
      fixture === "next-native-auth"
        ? {
            fixture,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            physicalEnvironmentId: qaId(30 + index),
            registrationVersion: 1,
            region: "eu",
            handle: scope.handle,
            origin: scope.devOrigin,
            principalId: scope.principalId,
            devAccessEpoch: scope.devAccessEpoch,
          }
        : {
            fixture,
            organizationId: qaId(1),
            projectId: qaId(10 + index),
            environmentId: qaId(20 + index),
            physicalEnvironmentId: qaId(30 + index),
            registrationVersion: 1,
            region: "eu",
            handle: `qa-${index}`,
            origin: `https://dev-qa-${index}.dev.check.omh.st`,
            principalId: "qa-operator",
            devAccessEpoch: 1,
          },
    ),
  };
}
const now = () => Date.parse("2026-11-14T10:00:00.000Z");
function doubles() {
  let authority = {
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
  let grant = true;
  const calls = [];
  const env = {
    SPIKE_QA_MANIFEST: JSON.stringify(manifestFor(scope)),
    QA_STABLE_PREVIEW_AUTHORITY: {
      async resolve(identity) {
        calls.push(["resolve", identity]);
        return { ...authority };
      },
    },
    QA_DEV_ACCESS: {
      async authorizeDevAccessSession(value) {
        calls.push(["grant", value]);
        return grant;
      },
    },
    QA_CREDIT: {
      async read(value) {
        calls.push(["credit", value]);
        return {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          allowed: true,
          paidAllowed: true,
          reason: null,
          checkedAt: "2026-11-14T09:59:59.000Z",
          expiresAt: "2026-11-14T10:01:00.000Z",
        };
      },
    },
    QA_NATIVE_STABLE_PREVIEW: {
      async fetchStablePreview(request, identity, client) {
        calls.push(["fetch", request, identity, client]);
        return Response.json({ ok: true });
      },
      async validateStablePreviewSession(identity, cookie) {
        calls.push(["validate", identity, cookie]);
        return {
          user: { id: "synthetic-user", email: "example@example.invalid", internal: "omit" },
          session: {
            id: "synthetic-session",
            expiresAt: "2026-11-14T11:00:00.000Z",
            internal: "omit",
          },
          internal: "omit",
        };
      },
    },
  };
  return {
    env,
    calls,
    mutateAuthority: (values) => {
      authority = { ...authority, ...values };
    },
    revokeGrant: () => {
      grant = false;
    },
  };
}
function publicRequest(path = "/api/auth/v1/sign-in/email", headers = {}) {
  return new Request(`${scope.previewOrigin}${path}`, {
    method: "POST",
    headers: { origin: scope.previewOrigin, "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: "example@example.invalid", password: "local-only-synthetic" }),
  });
}
function sessionRequest(cookie = "example=synthetic") {
  return new Request("http://preview.capabilities/native-auth/session", {
    method: "POST",
    headers: { cookie },
  });
}
const client = { clientAddress: "192.0.2.1" };

test("strict Development scope pins tenant, preview origin and stable auth generation", () => {
  assert.deepEqual(readQaAuthScope(scope), scope);
  for (const bad of [
    { ...scope, platform: "production" },
    { ...scope, fixture: "next-edge" },
    {
      ...scope,
      previewOrigin: scope.previewOrigin.replace("preview.dev.omh.st", "preview.omh.st"),
    },
    { ...scope, previewId: "0".repeat(32) },
    { ...scope, authGeneration: 0 },
    { ...scope, commit: "a".repeat(40) },
    { ...scope, expiresAt: "2026-11-14T11:00:00Z" },
  ])
    assert.throws(() => readQaAuthScope(bad), /qa_auth_scope_invalid/);
});

test("public proxy only forwards allowlisted same-origin requests through trusted identity and removes forged headers", async () => {
  const d = doubles();
  const result = await handleQaAuthPublic(
    publicRequest(undefined, {
      "x-ohmyhost-project": "wrong",
      "x-forwarded-host": "wrong",
      forwarded: "for=203.0.113.9;host=foreign.invalid;proto=http",
      host: "foreign.invalid",
      "cf-connecting-ip": "203.0.113.4",
      authorization: "Bearer must-not-pass",
      cookie: "example=synthetic",
    }),
    d.env,
    scope,
    client,
    now,
  );
  assert.equal(result.status, 200);
  const call = d.calls.find((entry) => entry[0] === "fetch");
  assert.deepEqual(call[2], { previewId: scope.previewId, authGeneration: 7 });
  assert.deepEqual(call[3], client);
  for (const name of [
    "x-ohmyhost-project",
    "x-forwarded-host",
    "forwarded",
    "host",
    "cf-connecting-ip",
    "authorization",
  ])
    assert.equal(call[1].headers.get(name), null);
  assert.equal(call[1].headers.get("cookie"), "example=synthetic");
  assert.equal(d.calls.filter((entry) => entry[0] === "resolve").length, 2);
  assert.equal(d.calls.filter((entry) => entry[0] === "grant").length, 2);
  assert.equal(d.calls.filter((entry) => entry[0] === "credit").length, 2);
  assert.equal(
    (await handleQaAuthPublic(publicRequest("/api/auth/v1/admin"), d.env, scope, client, now))
      .status,
    404,
  );
  assert.equal(
    (
      await handleQaAuthPublic(
        publicRequest(undefined, { origin: "https://foreign.invalid" }),
        d.env,
        scope,
        client,
        now,
      )
    ).status,
    404,
  );
});

test("public GET Auth routes reject a supplied foreign Origin before admission and allow navigation without Origin", async () => {
  for (const path of ["/api/auth/v1/get-session", "/api/auth/v1/verify-email?token=synthetic"]) {
    for (const origin of [undefined, scope.previewOrigin, "https://foreign.invalid"]) {
      const d = doubles();
      const request = new Request(`${scope.previewOrigin}${path}`, {
        headers: origin === undefined ? {} : { origin },
      });
      const response = await handleQaAuthPublic(request, d.env, scope, client, now);
      assert.equal(
        response.status,
        origin === "https://foreign.invalid" ? 404 : 200,
        `${path}/${origin}`,
      );
      if (origin === "https://foreign.invalid") assert.deepEqual(d.calls, []);
      else assert.equal(d.calls.filter(([kind]) => kind === "fetch").length, 1);
    }
  }
});

test("session binding uses fixed scope, copies only documented fields and rechecks current authority", async () => {
  const d = doubles();
  const result = await handleQaAuthSession(sessionRequest(), d.env, scope, now);
  assert.equal(result.status, 200);
  assert.deepEqual(decodeValue(await result.text()), {
    user: { id: "synthetic-user", email: "example@example.invalid" },
    session: { id: "synthetic-session", expiresAt: "2026-11-14T11:00:00.000Z" },
  });
  assert.deepEqual(d.calls.find((entry) => entry[0] === "validate")[1], {
    previewId: scope.previewId,
    authGeneration: 7,
  });
  const repeated = await handleQaAuthSession(sessionRequest(), d.env, scope, now);
  assert.equal(repeated.status, 200); // A source commit or container generation is not an input.
  d.mutateAuthority({ authGeneration: 8 });
  assert.equal((await handleQaAuthSession(sessionRequest(), d.env, scope, now)).status, 503);
});

test("unknown, cross-tenant, revoked, unfunded and missing authorities fail closed", async () => {
  for (const change of [
    (d) => d.mutateAuthority({ organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    (d) => d.mutateAuthority({ projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    (d) => d.mutateAuthority({ environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    (d) => d.mutateAuthority({ previewOrigin: "https://foreign.invalid" }),
    (d) => d.mutateAuthority({ enabled: false }),
    (d) => d.mutateAuthority({ paidAllowed: false }),
    (d) => d.mutateAuthority({ sourceCapable: false }),
    (d) => d.mutateAuthority({ runtimeAllowed: false }),
    (d) => d.revokeGrant(),
    (d) => {
      delete d.env.SPIKE_QA_MANIFEST;
    },
    (d) => {
      const m = manifestFor(scope);
      m.projects.find((item) => item.fixture === "next-native-auth").projectId =
        "01ARZ3NDEKTSV4RRFFQ69G5FAY";
      d.env.SPIKE_QA_MANIFEST = JSON.stringify(m);
    },
    (d) => {
      d.env.QA_CREDIT.read = async () => ({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        allowed: true,
        paidAllowed: true,
        reason: null,
        checkedAt: "2026-11-14T09:59:00.000Z",
        expiresAt: "2026-11-14T09:59:59.000Z",
      });
    },
    (d) => {
      delete d.env.QA_STABLE_PREVIEW_AUTHORITY;
    },
    (d) => {
      delete d.env.QA_NATIVE_STABLE_PREVIEW;
    },
  ]) {
    const d = doubles();
    change(d);
    assert.equal((await handleQaAuthSession(sessionRequest(), d.env, scope, now)).status, 503);
    assert.equal(
      d.calls.some((entry) => entry[0] === "validate"),
      false,
    );
  }
});

test("post-dispatch Auth failure suppresses credentials and reports an unknown non-retryable outcome", async () => {
  for (const kind of ["public", "session"]) {
    for (const fault of [
      "revoked",
      "epoch-changed",
      "configuration-changed",
      "authority-failed",
      "lost-reply",
      "invalid-result",
    ]) {
      const d = doubles();
      let committed = 0;
      const execute = async () => {
        committed += 1;
        if (fault === "revoked") d.revokeGrant();
        if (fault === "epoch-changed") d.mutateAuthority({ revocationEpoch: 10 });
        if (fault === "configuration-changed") d.mutateAuthority({ configurationRevision: 5 });
        if (fault === "authority-failed")
          d.env.QA_STABLE_PREVIEW_AUTHORITY.resolve = async () => {
            throw new Error("private authority error");
          };
        if (fault === "lost-reply") throw new Error("private committed Auth operation");
        if (fault === "invalid-result") return kind === "public" ? {} : { user: {} };
        return kind === "public"
          ? new Response("private response", { headers: { "set-cookie": "must-not-pass=private" } })
          : {
              user: { id: "private-user", email: "private@example.invalid" },
              session: { id: "private-session", expiresAt: "2026-11-14T11:00:00Z" },
            };
      };
      if (kind === "public") d.env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview = execute;
      else d.env.QA_NATIVE_STABLE_PREVIEW.validateStablePreviewSession = execute;
      const response =
        kind === "public"
          ? await handleQaAuthPublic(publicRequest(), d.env, scope, client, now)
          : await handleQaAuthSession(sessionRequest(), d.env, scope, now);
      assert.equal(response.status, 409, `${kind}/${fault}`);
      assert.deepEqual(await response.json(), {
        error: "qa_auth_outcome_unknown",
        outcome: "unknown",
        retryable: false,
      });
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), null);
      assert.equal(committed, 1, `${kind}/${fault}`);
    }
  }
});

test("oversized streamed bodies and unexpected session transports cannot reach the backend", async () => {
  const d = doubles();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(65537));
      controller.close();
    },
  });
  const large = new Request(`${scope.previewOrigin}/api/auth/v1/sign-in/email`, {
    method: "POST",
    headers: { origin: scope.previewOrigin },
    body: stream,
    duplex: "half",
  });
  assert.equal((await handleQaAuthPublic(large, d.env, scope, client, now)).status, 503);
  assert.equal(
    d.calls.some((entry) => entry[0] === "fetch"),
    false,
  );
  const withBody = new Request("http://preview.capabilities/native-auth/session", {
    method: "POST",
    body: "forged",
  });
  assert.equal((await handleQaAuthSession(withBody, d.env, scope, now)).status, 404);
});

test("native cookies and redirects cannot escape the exact preview host", async () => {
  const correct = `__Host-omh_native_preview_${scope.previewId}.session_token=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax`;
  for (const [cookie, location, expected] of [
    [correct, "/", 200],
    [correct.replace("; HttpOnly", ";\tHttpOnly"), "/", 200],
    [correct.replace("; Path=/", "; Path=/; Domain=.omh.st"), "/", 409],
    [correct.replace("__Host-omh_native_preview_", "__Host-omh_native_"), "/", 409],
    [correct.replace("; HttpOnly", ""), "/", 409],
    [correct.replace("; HttpOnly", "; HttpOnly\u00a0"), "/", 409],
    [correct.replace("; Path=/", "; Path=/; Path=/elsewhere"), "/", 409],
    [correct.replace("; SameSite=Lax", "; SameSite=Lax; SameSite=None"), "/", 409],
    [correct.replace("; SameSite=Lax", "; SameSite=Lax; SameSite = None"), "/", 409],
    [correct.replace("; Path=/", "; Path=/; Domain = .omh.st"), "/", 409],
    [correct, "https://foreign.invalid/", 409],
  ]) {
    const d = doubles();
    d.env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview = async () =>
      new Response("ok", {
        headers: { "set-cookie": cookie, location },
      });
    assert.equal(
      (await handleQaAuthPublic(publicRequest(), d.env, scope, client, now)).status,
      expected,
    );
  }
});

test("a streamed response is bounded and revoked before any bytes are returned", async () => {
  const d = doubles();
  d.env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65537));
          controller.close();
        },
      }),
    );
  const oversized = await handleQaAuthPublic(publicRequest(), d.env, scope, client, now);
  assert.equal(oversized.status, 409);
  const x = doubles();
  x.env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          x.revokeGrant();
          controller.close();
        },
      }),
    );
  const revoked = await handleQaAuthPublic(publicRequest(), x.env, scope, client, now);
  assert.equal(revoked.status, 409);
});

test("an excessive stream of empty chunks is bounded before the Auth backend", async () => {
  const d = doubles();
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array());
    },
  });
  const request = new Request(`${scope.previewOrigin}/api/auth/v1/sign-in/email`, {
    method: "POST",
    headers: { origin: scope.previewOrigin },
    body: stream,
    duplex: "half",
  });
  const result = await handleQaAuthPublic(request, d.env, scope, client, now);
  assert.equal(result.status, 503);
  assert.equal(
    d.calls.some((entry) => entry[0] === "fetch"),
    false,
  );
});

test("aborted browser Auth cannot dispatch and later abort cannot return a successful mutation", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const d = doubles();
  const request = new Request(publicRequest(), { signal: aborted.signal });
  assert.equal((await handleQaAuthPublic(request, d.env, scope, client, now)).status, 503);
  assert.equal(
    d.calls.some(([name]) => name === "fetch"),
    false,
  );

  const controller = new AbortController();
  const during = doubles();
  during.env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview = async (incoming) => {
    controller.abort();
    assert.equal(incoming.signal.aborted, true);
    return Response.json({ ok: true });
  };
  const inflight = new Request(publicRequest(), { signal: controller.signal });
  const result = await handleQaAuthPublic(inflight, during.env, scope, client, now);
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), {
    error: "qa_auth_outcome_unknown",
    outcome: "unknown",
    retryable: false,
  });
});

test("a backend server failure after dispatch reports an unknown non-retryable outcome", async () => {
  const d = doubles();
  d.env.QA_NATIVE_STABLE_PREVIEW.fetchStablePreview = async () =>
    new Response(null, { status: 503 });
  const result = await handleQaAuthPublic(publicRequest(), d.env, scope, client, now);
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), {
    error: "qa_auth_outcome_unknown",
    outcome: "unknown",
    retryable: false,
  });
});
