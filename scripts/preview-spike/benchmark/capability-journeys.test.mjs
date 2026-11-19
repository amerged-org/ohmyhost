/* global Request */
import test from "node:test";
import assert from "node:assert/strict";
import { handleQaAuthPublic } from "../auth/bridge.mjs";
import {
  exerciseNotes,
  exerciseUsable,
  exerciseMail,
  startAuthJourney,
  startCapabilityJourney,
  verificationTokenFromInbox,
} from "./capability-journeys.mjs";

const origin = "https://fixture.example.invalid";

// A small Playwright-shaped double verifies control flow only. It is not hosted evidence.
function notesPage({ broken = false, auth = false, mailFailure = false } = {}) {
  const fields = new Map(),
    rows = new Map(),
    calls = [];
  let latest, waiter;
  const page = {
    url: () => `${origin}/`,
    calls,
    rows,
    reload: async () => calls.push("reload"),
    waitForResponse(predicate) {
      return new Promise((resolve, reject) => {
        waiter = (response) =>
          predicate(response) ? resolve(response) : reject(Error("wrong_response"));
      });
    },
    locator(selector) {
      return {
        fill: async (value) => fields.set(selector, value),
        waitFor: async () => {},
        filter: ({ hasText }) => ({
          waitFor: async () => {
            assert.ok(typeof latest === "string" && hasText.test(latest));
          },
        }),
        textContent: async () => latest,
        async click() {
          let method,
            body,
            path = "/api/notes";
          if (selector === "#mail-send") {
            path = "/api/mail";
            method = "POST";
            body = { receipt: { state: "accepted", messageId: "m", requestId: "r" } };
            latest = JSON.stringify(body);
          } else if (selector === "#auth-readiness") {
            path = "/api/readiness";
            method = "GET";
            body = { ready: !broken };
            latest = broken ? "DB unavailable" : "DB ready";
          } else {
            method =
              selector === "#note-save" ? "POST" : selector === "#note-delete" ? "DELETE" : "GET";
            const id = fields.get("#note-id"),
              value = fields.get("#note-body");
            if (method === "POST") {
              rows.set(id, value);
              body = { note: { id, body: value } };
            } else if (method === "DELETE") body = { deleted: rows.delete(id) };
            else body = { notes: [...rows].map(([id, body]) => ({ id, body })) };
            latest = JSON.stringify(body);
          }
          calls.push(`${method} ${path}`);
          const response = {
            url: () => `${origin}${path}`,
            request: () => ({ method: () => method }),
            status: () => (broken && !auth ? 503 : 200),
            ok: () => (!broken || auth) && !(path === "/api/mail" && mailFailure),
            json: async () => body,
          };
          waiter(response);
        },
      };
    },
  };
  return page;
}

test("TanStack server functions use POST and their rendered JSON result", async () => {
  let output = "";
  const response = {
    url: () => `${origin}/_serverFn/actual-id`,
    request: () => ({ method: () => "POST", headers: () => ({ "x-tsr-serverfn": "true" }) }),
    ok: () => true,
  };
  const page = {
    url: () => `${origin}/`,
    locator: () => ({
      textContent: async () => output,
      click: async () => {
        output = JSON.stringify({ notes: [] });
      },
    }),
    waitForResponse: async (predicate) => {
      assert.equal(predicate(response), true);
      return response;
    },
    waitForFunction: async (_predicate, before) => {
      assert.notEqual(output, before);
    },
  };
  await exerciseUsable(page, "tanstack-start");
  assert.equal(output, '{"notes":[]}');
});

test("two browser contexts verify and log in distinct users, isolate their notes and revoke logout cookies", async () => {
  const previewId = "a".repeat(32);
  const previewOrigin = `https://${previewId}-${"b".repeat(24)}.preview.dev.omh.st`;
  const scope = {
    platform: "development",
    fixture: "next-native-auth",
    organizationId: "0".repeat(26),
    projectId: "1".repeat(26),
    environmentId: "2".repeat(26),
    region: "eu",
    handle: "qa-auth",
    devOrigin: "https://dev-qa-auth.dev.check.omh.st",
    principalId: "user:test",
    devAccessEpoch: 1,
    previewId,
    previewOrigin,
    authGeneration: 1,
  };
  for (const headers of [{ origin: "https://foreign.invalid" }, {}]) {
    const denied = await handleQaAuthPublic(
      new Request(`${previewOrigin}/api/auth/v1/sign-in/email`, { method: "POST", headers }),
      {},
      scope,
      { clientAddress: "127.0.0.1" },
    );
    assert.equal(
      denied.status,
      404,
      "the real Auth bridge conceals a refused Origin before admission",
    );
  }
  function authBrowser({ shared = false } = {}) {
    const contexts = [],
      sharedRows = new Map();
    return {
      contexts,
      async newContext() {
        const rows = shared ? sharedRows : new Map(),
          fields = new Map();
        let loggedIn = false,
          output = "",
          waiter;
        const context = {
          closed: false,
          cookies: async () =>
            loggedIn
              ? [
                  {
                    name: "__Host-omh_native_preview_test.session_token",
                    value: "private",
                    secure: true,
                    httpOnly: true,
                    sameSite: "Lax",
                    path: "/",
                    domain: "fixture.example.invalid",
                  },
                ]
              : [],
          close: async () => {
            context.closed = true;
          },
          async newPage() {
            return page;
          },
        };
        const page = {
          url: () => `${origin}/`,
          context: () => context,
          goto: async () => {},
          reload: async () => {},
          waitForResponse: (predicate) =>
            new Promise((resolve, reject) => {
              waiter = (path, method) => {
                const response = {
                  url: () => `${origin}${path}`,
                  request: () => ({ method: () => method }),
                  ok: () => true,
                  status: () => 200,
                  json: async () => JSON.parse(output),
                };
                if (predicate(response)) resolve(response);
                else reject(new Error("wrong_response"));
              };
            }),
          request: {
            get: async (url, options) => ({
              status: () =>
                url.includes("verify-email")
                  ? 400
                  : options?.headers?.cookie
                    ? 401
                    : loggedIn
                      ? 200
                      : 401,
            }),
            post: async (url, options) => ({
              status: () =>
                url.includes("/api/notes") ? 403 : options?.headers?.origin !== origin ? 404 : 401,
            }),
          },
          locator(selector) {
            return {
              fill: async (value) => fields.set(selector, value),
              waitFor: async () => {},
              textContent: async () => output,
              filter: ({ hasText }) => ({
                waitFor: async () => assert.equal(hasText.test(output), true),
              }),
              async click() {
                let path, method;
                if (selector.startsWith("#auth-")) {
                  const kind = selector.slice(6);
                  path = {
                    signup: "/api/auth/v1/sign-up/email",
                    verify: "/api/auth/v1/verify-email",
                    login: "/api/auth/v1/sign-in/email",
                    logout: "/api/auth/v1/sign-out",
                  }[kind];
                  method = kind === "verify" ? "GET" : "POST";
                  if (kind === "login") loggedIn = true;
                  if (kind === "logout") loggedIn = false;
                } else {
                  path = "/api/notes";
                  method =
                    selector === "#note-save"
                      ? "POST"
                      : selector === "#note-delete"
                        ? "DELETE"
                        : "GET";
                  const id = fields.get("#note-id"),
                    body = fields.get("#note-body");
                  if (method === "POST") {
                    rows.set(id, body);
                    output = JSON.stringify({ note: { id, body } });
                  } else if (method === "DELETE")
                    output = JSON.stringify({ deleted: rows.delete(id) });
                  else
                    output = JSON.stringify({
                      notes: [...rows].map(([id, body]) => ({ id, body })),
                    });
                }
                waiter(path, method);
              },
            };
          },
        };
        contexts.push(context);
        return context;
      },
    };
  }
  const sender = "sender@example.invalid";
  const users = ["first", "second"].map((name) => ({
    name,
    email: `${name}@example.invalid`,
    password: "strong-password-here",
  }));
  const readInbox = async ({ recipient }) => [
    {
      id: `msg-${recipient}`,
      to: recipient,
      from: sender,
      subject: "Verify your Fixture email",
      text: `Verify your Fixture email\n\n${origin}/api/auth/v1/verify-email?token=private-token&callbackURL=%2F\n`,
      receivedAt: new Date().toISOString(),
    },
  ];
  const browser = authBrowser();
  const audit = [];
  const journey = await startAuthJourney({
    browser,
    url: `${origin}/`,
    users,
    sender,
    readInbox,
    recordSignup: async (event) => audit.push(event),
  });
  await journey.continuity();
  await journey.finish();
  await journey.close();
  assert.equal(browser.contexts.length, 2);
  assert.equal(
    browser.contexts.every((context) => context.closed),
    true,
  );
  assert.deepEqual(
    audit.map((event) => [event.event, event.outcome]),
    [
      ["intent", undefined],
      ["result", "confirmed"],
      ["intent", undefined],
      ["result", "confirmed"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(audit), /example\.invalid|strong-password/);
  await assert.rejects(
    startAuthJourney({
      browser: authBrowser({ shared: true }),
      url: `${origin}/`,
      users,
      sender,
      readInbox,
    }),
    /auth_isolation_failed/,
  );
  await assert.rejects(
    startAuthJourney({
      browser: authBrowser(),
      url: `${origin}/`,
      users: [users[0], users[0]],
      sender,
      readInbox,
    }),
    /auth_adapter_required/,
  );
});

test("a usable page requires a hydrated browser action and a successful database response", async () => {
  for (const fixture of [
    "react-vite",
    "vanilla-vite",
    "next-edge",
    "astro-edge",
    "next-app-mail",
  ]) {
    const page = notesPage();
    await exerciseUsable(page, fixture);
    assert.deepEqual(page.calls, ["GET /api/notes"]);
  }
  const auth = notesPage({ auth: true });
  await exerciseUsable(auth, "next-native-auth");
  assert.deepEqual(auth.calls, ["GET /api/readiness"]);
  await assert.rejects(
    exerciseUsable(notesPage({ broken: true }), "react-vite"),
    /database_read_failed/,
  );
  await assert.rejects(
    exerciseUsable(notesPage({ broken: true, auth: true }), "next-native-auth"),
    /auth_database_readiness_failed/,
  );
  await assert.rejects(exerciseUsable(notesPage(), "other"), /fixture_invalid/);
});

test("database journey creates, updates, reads after reload, deletes, and verifies deletion", async () => {
  const page = notesPage();
  await exerciseNotes(page, { id: "qa-unique-1" });
  assert.deepEqual(page.calls, [
    "POST /api/notes",
    "POST /api/notes",
    "reload",
    "GET /api/notes",
    "DELETE /api/notes",
    "GET /api/notes",
  ]);
  assert.equal(page.rows.size, 0);
  await assert.rejects(exerciseNotes(page, { id: "not valid" }), /note_id_invalid/);
  const redirected = notesPage();
  redirected.reload = async () => {
    redirected.url = () => "https://other.invalid/";
  };
  await assert.rejects(exerciseNotes(redirected, { id: "qa-unique-2" }), /browser_origin_changed/);
});

test("verification tokens are extracted from one fresh, matching inbox message and scoped URL", () => {
  const startedAt = Date.parse("2026-11-15T12:00:00.000Z");
  const message = {
    id: "inbox-1",
    to: "user@example.invalid",
    from: "sender@example.invalid",
    subject: "Verify your Fixture email",
    text: `Verify your Fixture email\n\n${origin}/api/auth/v1/verify-email?token=private-token&callbackURL=%2F\n`,
    receivedAt: new Date(startedAt + 1000).toISOString(),
  };
  const args = { recipient: message.to, sender: message.from, origin, startedAt };
  assert.equal(verificationTokenFromInbox([message], args), "private-token");
  for (const change of [
    { to: "other@example.invalid" },
    { from: "other@example.invalid" },
    { receivedAt: new Date(startedAt - 60000).toISOString() },
    { text: message.text.replace(origin, "https://other.invalid") },
    { text: message.text.replace("callbackURL=%2F", "callbackURL=https%3A%2F%2Fother.invalid") },
  ])
    assert.throws(
      () => verificationTokenFromInbox([{ ...message, ...change }], args),
      /verification_inbox_unverified/,
    );
  assert.throws(
    () => verificationTokenFromInbox([message, { ...message, id: "inbox-2" }], args),
    /verification_inbox_unverified/,
  );
  assert.throws(() => verificationTokenFromInbox(true, args), /verification_inbox_unverified/);
});

test("mail requires matching accepted receipts and one actual fresh inbox message", async () => {
  const id = "mail-unique-1",
    startedAt = Date.parse("2026-11-15T12:00:00.000Z");
  let sends = 0,
    inputKey;
  const receipt = { state: "accepted", requestId: "request-1", messageId: "message-1" };
  const page = {
    url: () => `${origin}/`,
    waitForResponse: async (predicate) => {
      const response = {
        url: () => `${origin}/api/mail`,
        request: () => ({ method: () => "POST" }),
        ok: () => true,
        json: async () => ({ receipt }),
      };
      assert.equal(predicate(response), true);
      return response;
    },
    locator: (selector) => ({
      fill: async (v) => {
        if (selector === "#mail-key") inputKey = v;
      },
      click: async () => {
        sends += 1;
      },
    }),
  };
  const message = {
    id: "inbox-1",
    to: "recipient@example.invalid",
    from: "sender@example.invalid",
    subject: `Preview acceptance ${id}`,
    text: `Preview acceptance ${id}`,
    receivedAt: new Date(startedAt + 1000).toISOString(),
  };
  const options = {
    id,
    key: "public-fixture-marker",
    recipient: message.to,
    sender: message.from,
    startedAt,
    readInbox: async () => [message],
  };
  assert.deepEqual(await exerciseMail(page, options), {
    mailReceiptMatched: true,
    mailDeliveredOnce: true,
  });
  assert.equal(sends, 2);
  assert.equal(inputKey, "");
  await assert.rejects(
    exerciseMail(page, { ...options, readInbox: async () => true }),
    /mail_delivery_unverified/,
  );
  await assert.rejects(
    exerciseMail(page, {
      ...options,
      readInbox: async () => [message, { ...message, id: "inbox-2" }],
    }),
    /mail_delivery_unverified/,
  );
  await assert.rejects(
    exerciseMail(page, {
      ...options,
      readInbox: async () => [message, { ...message, id: "inbox-2", text: "modified" }],
    }),
    /mail_delivery_unverified/,
  );
  await assert.rejects(
    exerciseMail(page, { ...options, readInbox: async () => [{ ...message, text: "wrong" }] }),
    /mail_delivery_unverified/,
  );
});

test("an uncertain mail operation is recorded before arming and is never retried", async () => {
  const page = notesPage({ mailFailure: true }),
    audit = [];
  let arms = 0;
  const qa = {
    mail: async () => ({
      recipient: "recipient@example.invalid",
      sender: "sender@example.invalid",
    }),
    armMail: async ({ id }) => {
      arms += 1;
      assert.equal(audit[0].messageId, id);
      assert.equal(audit[0].event, "intent");
    },
    readInbox: async () => {
      throw new Error("must not read inbox after unknown send");
    },
  };
  await assert.rejects(
    startCapabilityJourney({
      browser: {},
      page,
      fixture: "next-app-mail",
      url: `${origin}/`,
      sessionId: "session",
      qa,
      recordOperation: async (event) => audit.push(event),
    }),
    /mail_send_failed/,
  );
  assert.equal(arms, 1);
  assert.equal(page.calls.filter((call) => call === "POST /api/mail").length, 1);
  assert.equal(audit[1].outcome, "unknown");
  assert.equal(audit[0].messageId, audit[1].messageId);
});
