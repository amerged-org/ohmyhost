/* global AbortController, Response, setTimeout, queueMicrotask */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createQaAdapter, openBrowser } from "./qa-adapter.mjs";
import { assertControlTarget } from "./control-target.mjs";

const fixtureEnv = (queue) => ({
  SPIKE_QA_INBOX_QUEUE: queue,
  SPIKE_QA_MAIL_RECIPIENT: "inbox@example.invalid",
  SPIKE_QA_MAIL_SENDER: "sender@example.invalid",
  SPIKE_QA_AUTH_SENDER: "auth@example.invalid",
  SPIKE_QA_AUTH_A_EMAIL: "inbox+first@example.invalid",
  SPIKE_QA_AUTH_B_EMAIL: "inbox+second@example.invalid",
  SPIKE_QA_AUTH_A_PASSWORD: "synthetic-password-a",
  SPIKE_QA_AUTH_B_PASSWORD: "synthetic-password-b",
  SPIKE_CONTROL_TOKEN: "synthetic-control-token-not-real-1234567890",
  CLOUDFLARE_API_TOKEN: "synthetic-api-token-not-real-1234567890",
  PREVIEW_SPIKE_ROUTE_ID: "c".repeat(32),
  PREVIEW_SPIKE_WORKER_VERSION_ID: "00000000-0000-4000-8000-000000000001",
});
const sessionId = "a".repeat(32);
async function nextLine(path, index = 0) {
  for (let i = 0; i < 100; i += 1) {
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length > index) return JSON.parse(lines[index]);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("request_not_queued");
}

test("auth adapter supplies exactly two scoped QA aliases and relays inbox bodies only through stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spike-qa-"));
  const queue = join(dir, "inbox.jsonl"),
    stdin = new PassThrough();
  let adapter;
  try {
    adapter = await createQaAdapter(
      { fixture: "next-native-auth" },
      { env: fixtureEnv(queue), stdin },
    );
    const auth = await adapter.auth({ sessionId });
    assert.deepEqual(
      auth.users.map((user) => user.email),
      ["inbox+first@example.invalid", "inbox+second@example.invalid"],
    );
    assert.equal(auth.sender, "auth@example.invalid");
    const reading = adapter.readInbox({
      kind: "verification",
      recipient: auth.users[0].email,
      since: Date.now(),
    });
    const request = await nextLine(queue);
    assert.equal(request.version, 1);
    assert.equal(request.kind, "verification");
    assert.match(request.requestId, /^[a-f0-9]{32}$/u);
    const message = {
      id: "mail-id",
      to: auth.users[0].email,
      from: auth.sender,
      subject: "Verify your QA email",
      text: "private-verification-token",
      receivedAt: new Date().toISOString(),
    };
    stdin.write(`${JSON.stringify({ requestId: request.requestId, messages: [message] })}\n`);
    assert.deepEqual(await reading, [message]);
    assert.equal((await stat(queue)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(queue, "utf8"),
      /private-verification-token|synthetic-password|control-token/,
    );
    await assert.rejects(
      adapter.readInbox({
        kind: "verification",
        recipient: "elsewhere@example.invalid",
        since: Date.now(),
      }),
      /inbox_scope_invalid/,
    );
  } finally {
    if (adapter) await adapter.close();
    stdin.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty mailbox responses poll again and abort stops pending reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spike-qa-"));
  const queue = join(dir, "inbox.jsonl"),
    stdin = new PassThrough();
  let adapter;
  try {
    adapter = await createQaAdapter(
      { fixture: "next-app-mail" },
      { env: fixtureEnv(queue), stdin, pollMs: 1 },
    );
    const started = Date.now();
    const reading = adapter.readInbox({
      kind: "mail",
      recipient: "inbox@example.invalid",
      since: started,
      subject: "Preview acceptance mail-unique",
    });
    const first = await nextLine(queue);
    stdin.write(`${JSON.stringify({ requestId: first.requestId, messages: [] })}\n`);
    const second = await nextLine(queue, 1);
    assert.notEqual(second.requestId, first.requestId);
    const message = {
      id: "mail-id",
      to: "inbox@example.invalid",
      from: "sender@example.invalid",
      subject: "Preview acceptance mail-unique",
      text: "Preview acceptance mail-unique",
      receivedAt: new Date().toISOString(),
    };
    stdin.write(`${JSON.stringify({ requestId: second.requestId, messages: [message] })}\n`);
    assert.deepEqual(await reading, [message]);
    const controller = new AbortController();
    const aborted = adapter.readInbox({
      kind: "mail",
      recipient: message.to,
      since: started,
      subject: message.subject,
      signal: controller.signal,
    });
    await nextLine(queue, 2);
    controller.abort();
    await assert.rejects(aborted, /inbox_aborted/);
  } finally {
    if (adapter) await adapter.close();
    stdin.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mail permit is bound to fixed control origin, session, ID and operator token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spike-qa-"));
  const queue = join(dir, "inbox.jsonl"),
    stdin = new PassThrough(),
    calls = [];
  let adapter;
  let targetChecks = 0,
    denyTarget = false,
    rejectPost = false;
  const targetContexts = [];
  const monotonic = 100;
  try {
    adapter = await createQaAdapter(
      { fixture: "next-app-mail" },
      {
        env: fixtureEnv(queue),
        stdin,
        monotonicNow: () => monotonic,
        targetVerifier: async (input) => {
          targetChecks++;
          targetContexts.push(input);
          if (denyTarget) throw new Error("control_target_unverified");
          return true;
        },
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return new Response(null, { status: rejectPost ? 503 : 204 });
        },
      },
    );
    assert.deepEqual(await adapter.mail({ sessionId, id: "mail-1" }), {
      recipient: "inbox@example.invalid",
      sender: "sender@example.invalid",
    });
    const caller = new AbortController();
    const deadlineAt = monotonic + 5000;
    await adapter.armMail({ sessionId, id: "mail-1", signal: caller.signal, deadlineAt });
    assert.ok(targetContexts.every((input) => input.signal === caller.signal));
    assert.ok(targetContexts.every((input) => input.now() === monotonic));
    assert.deepEqual(
      targetContexts.map((input) => input.deadlineAt),
      [deadlineAt, deadlineAt],
    );
    assert.equal(
      calls[0].url,
      `https://control.preview.dev.omh.st/__spike/sessions/${sessionId}/mail-permit`,
    );
    assert.equal(calls[0].init.redirect, "error");
    assert.deepEqual(JSON.parse(calls[0].init.body), { id: "mail-1" });
    assert.equal(
      calls[0].init.headers.authorization,
      `Bearer ${fixtureEnv(queue).SPIKE_CONTROL_TOKEN}`,
    );
    await assert.rejects(adapter.armMail({ sessionId, id: "bad/id" }), /mail_scope_invalid/);
    assert.equal(calls.length, 1);
    assert.equal(targetChecks, 2, "target identity is sampled before and after permit dispatch");
    await assert.rejects(
      adapter.armMail({ sessionId, id: "expired", deadlineAt: monotonic - 1 }),
      /control_target_unverified/,
    );
    assert.equal(calls.length, 1);
    assert.equal(targetChecks, 2, "an expired absolute budget cannot dispatch a guard or POST");
    rejectPost = true;
    await assert.rejects(
      adapter.armMail({ sessionId, id: "failed", deadlineAt: monotonic + 600_000 }),
      /mail_permit_unknown/,
    );
    assert.equal(calls.length, 2, "a failed permit POST is dispatched exactly once");
    assert.equal(targetChecks, 4, "a failed permit POST still receives a postcheck");
    assert.equal(targetContexts[2].deadlineAt, targetContexts[3].deadlineAt);
    assert.equal(targetContexts[2].deadlineAt, monotonic + 60_000);
    denyTarget = true;
    await assert.rejects(adapter.armMail({ sessionId, id: "mail-2" }), /control_target_unverified/);
    assert.equal(calls.length, 2, "target drift sends no control bearer");
    for (const abortPhase of ["before", "after"]) {
      const abortCaller = new AbortController();
      const abortStdin = new PassThrough();
      const env = fixtureEnv(join(dir, `${abortPhase}.jsonl`));
      const account = "00000000000000000000000000000001";
      const zone = "0000000000000000000000000000000b";
      const contexts = [];
      let accountReads = 0,
        afterAbortReads = 0,
        posts = 0;
      const guarded = await createQaAdapter(
        { fixture: "next-app-mail" },
        {
          env,
          stdin: abortStdin,
          monotonicNow: () => 0,
          targetVerifier: (input) => {
            contexts.push(input);
            return assertControlTarget(input);
          },
          fetchImpl: async (url, request) => {
            if (request.method === "POST") {
              posts++;
              return new Response(null, { status: 204 });
            }
            if (abortCaller.signal.aborted) afterAbortReads++;
            let result;
            if (url.endsWith(`/accounts/${account}`)) {
              accountReads++;
              if (accountReads === (abortPhase === "before" ? 1 : 2)) {
                queueMicrotask(() => abortCaller.abort());
                return new Response(null, { status: 503 });
              }
              result = { id: account };
            } else if (url.endsWith(`/zones/${zone}`))
              result = { id: zone, name: "omh.st", account: { id: account } };
            else if (url.endsWith("/workers/routes"))
              result = [
                {
                  id: env.PREVIEW_SPIKE_ROUTE_ID,
                  pattern: "*.preview.dev.omh.st/*",
                  script: "ohmyho-preview-spike-development",
                },
              ];
            else
              result = {
                deployments: [
                  {
                    id: "d".repeat(32),
                    versions: [
                      { percentage: 100, version_id: env.PREVIEW_SPIKE_WORKER_VERSION_ID },
                    ],
                  },
                ],
              };
            return new Response(JSON.stringify({ success: true, result }), { status: 200 });
          },
        },
      );
      try {
        await assert.rejects(
          guarded.armMail({ sessionId, id: `abort-${abortPhase}`, signal: abortCaller.signal }),
          abortPhase === "before" ? /control_target_unverified/ : /mail_permit_unknown/,
        );
        assert.equal(afterAbortReads, 0, "canonical target retries inherit caller cancellation");
        assert.equal(posts, abortPhase === "before" ? 0 : 1);
        assert.ok(contexts.every((input) => input.signal === abortCaller.signal));
        assert.ok(contexts.every((input) => input.now() === 0));
        assert.ok(contexts.every((input) => input.deadlineAt === contexts[0].deadlineAt));
      } finally {
        await guarded.close();
        abortStdin.destroy();
      }
    }
  } finally {
    if (adapter) await adapter.close();
    stdin.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsafe queue paths, unrelated aliases, malformed broker output and uncertain permit fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spike-qa-"));
  const queue = join(dir, "inbox.jsonl"),
    stdin = new PassThrough();
  let adapter;
  try {
    const badEnv = { ...fixtureEnv(queue), SPIKE_QA_AUTH_B_EMAIL: "stranger@example.invalid" };
    await assert.rejects(
      createQaAdapter({ fixture: "next-native-auth" }, { env: badEnv, stdin }),
      /auth_scope_invalid/,
    );
    await writeFile(queue, "existing", { mode: 0o600 });
    await assert.rejects(
      createQaAdapter({ fixture: "next-app-mail" }, { env: fixtureEnv(queue), stdin }),
      /EEXIST|inbox_queue_invalid/,
    );
    await rm(queue);
    await chmod(dir, 0o755);
    await assert.rejects(
      createQaAdapter({ fixture: "next-app-mail" }, { env: fixtureEnv(queue), stdin }),
      /inbox_queue_invalid/,
    );
    await chmod(dir, 0o700);
    adapter = await createQaAdapter(
      { fixture: "next-app-mail" },
      {
        env: fixtureEnv(queue),
        stdin,
        targetVerifier: async () => true,
        fetchImpl: async () => new Response(null, { status: 503 }),
      },
    );
    await assert.rejects(adapter.armMail({ sessionId, id: "mail-1" }), /mail_permit_unknown/);
    const reading = adapter.readInbox({
      kind: "mail",
      recipient: "inbox@example.invalid",
      since: Date.now(),
      subject: "Preview acceptance mail-1",
    });
    await nextLine(queue);
    stdin.write("not-json\n");
    await assert.rejects(reading, /inbox_response_invalid/);
  } finally {
    if (adapter) await adapter.close();
    stdin.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser driver uses an explicitly selected local Playwright and Chrome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spike-qa-"));
  try {
    const module = join(dir, "playwright.mjs"),
      binary = join(dir, "chrome");
    await writeFile(module, "export {}", { mode: 0o600 });
    await writeFile(binary, "", { mode: 0o700 });
    let options;
    const browser = { close: async () => {} };
    const result = await openBrowser({
      env: { PREVIEW_SPIKE_PLAYWRIGHT_MODULE: module, PREVIEW_SPIKE_CHROME_BINARY: binary },
      loader: async () => ({
        chromium: {
          launch: async (value) => {
            options = value;
            return browser;
          },
        },
      }),
    });
    assert.equal(result, browser);
    assert.equal(options.executablePath, await realpath(binary));
    assert.equal(options.headless, true);
    await assert.rejects(
      openBrowser({ env: {}, loader: async () => ({}) }),
      /browser_driver_required/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
