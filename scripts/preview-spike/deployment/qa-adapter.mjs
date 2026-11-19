/* global AbortSignal, Buffer, fetch, process, setTimeout, clearTimeout */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { assertControlTarget } from "./control-target.mjs";

const CONTROL = "https://control.preview.dev.omh.st";
const SESSION = /^[a-f0-9]{32}$/u;
const MESSAGE = /^[a-zA-Z0-9-]{1,80}$/u;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/u;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 100;
const DEFAULT_INBOX_DEADLINE = 180_000;
const DEFAULT_POLL = 5_000;

function address(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}
function aliasOf(alias, base) {
  if (!address(alias) || !address(base)) return false;
  const [local, domain] = alias.toLowerCase().split("@");
  const [baseLocal, baseDomain] = base.toLowerCase().split("@");
  const prefix = `${baseLocal.split("+")[0]}+`;
  return domain === baseDomain && local.startsWith(prefix) && local.length > prefix.length;
}
function active(signal) {
  if (signal?.aborted) throw new Error("inbox_aborted");
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function validMessage(message) {
  return (
    exact(message, ["id", "to", "from", "subject", "text", "receivedAt"]) &&
    typeof message.id === "string" &&
    message.id.length > 0 &&
    message.id.length <= 1024 &&
    address(message.to) &&
    address(message.from) &&
    typeof message.subject === "string" &&
    message.subject.length <= 1024 &&
    typeof message.text === "string" &&
    Buffer.byteLength(message.text, "utf8") <= 1_000_000 &&
    typeof message.receivedAt === "string" &&
    Number.isFinite(Date.parse(message.receivedAt))
  );
}

async function privateQueue(path) {
  if (typeof path !== "string" || !isAbsolute(path) || ["", ".", ".."].includes(basename(path)))
    throw new Error("inbox_queue_invalid");
  const parent = await realpath(dirname(path));
  const directory = await stat(parent);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && directory.uid !== process.getuid())
  )
    throw new Error("inbox_queue_invalid");
  const handle = await open(
    join(parent, basename(path)),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const file = await handle.stat();
  if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
    await handle.close();
    throw new Error("inbox_queue_invalid");
  }
  return handle;
}

/** Private metadata queue plus one-way, bounded stdin responses. Message bodies never reach disk. */
function inboxBroker({ handle, stdin, timeoutMs, pollMs, now }) {
  if (!stdin || typeof stdin.on !== "function" || stdin.isTTY === true)
    throw new Error("inbox_pipe_required");
  let text = "",
    failure,
    busy = false,
    closed = false;
  const pending = new Map();
  function fail(error) {
    if (failure) return;
    failure = error;
    for (const settle of pending.values()) settle.reject(error);
    pending.clear();
  }
  function parse(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new Error("inbox_response_invalid"));
      return;
    }
    if (
      !exact(value, ["requestId", "messages"]) ||
      !/^[a-f0-9]{32}$/u.test(value.requestId ?? "") ||
      !Array.isArray(value.messages) ||
      value.messages.length > MAX_MESSAGES ||
      !value.messages.every(validMessage)
    ) {
      fail(new Error("inbox_response_invalid"));
      return;
    }
    const settle = pending.get(value.requestId);
    // Responses for an aborted or expired request cannot satisfy a later request.
    if (settle) settle.resolve(value.messages);
  }
  function onData(chunk) {
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
      fail(new Error("inbox_response_invalid"));
      text = "";
      return;
    }
    let end;
    while ((end = text.indexOf("\n")) !== -1) {
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      if (!line) {
        fail(new Error("inbox_response_invalid"));
        return;
      }
      parse(line);
      if (failure) return;
    }
  }
  const onEnd = () => fail(new Error("inbox_pipe_closed"));
  stdin.setEncoding("utf8");
  stdin.on("data", onData);
  stdin.once("end", onEnd);
  stdin.once("error", onEnd);
  stdin.unref?.();
  async function request(metadata, signal, deadline) {
    active(signal);
    if (failure) throw failure;
    if (closed) throw new Error("inbox_pipe_closed");
    const requestId = randomBytes(16).toString("hex");
    const response = new Promise((resolve, reject) => {
      let timer;
      const finish = (callback, value) => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, new Error("inbox_aborted"));
      pending.set(requestId, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => finish(reject, new Error("inbox_timeout")),
        Math.max(1, deadline - now()),
      );
      if (signal?.aborted) onAbort();
    });
    // The signal may fire while the private queue is being synced.
    response.catch(() => {});
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, requestId, ...metadata })}\n`);
      await handle.sync();
    } catch {
      const current = pending.get(requestId);
      if (current) current.reject(new Error("inbox_queue_failed"));
    }
    return response;
  }
  return {
    async read(metadata, signal) {
      if (busy) throw new Error("inbox_busy");
      busy = true;
      try {
        const deadline = now() + timeoutMs;
        while (now() < deadline) {
          const messages = await request(metadata, signal, deadline);
          active(signal);
          if (messages.length) return messages;
          try {
            await delay(Math.min(pollMs, Math.max(1, deadline - now())), undefined, { signal });
          } catch {
            throw new Error("inbox_aborted");
          }
        }
        throw new Error("inbox_timeout");
      } finally {
        busy = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      fail(new Error("inbox_pipe_closed"));
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.pause();
      await handle.close();
    },
  };
}

/** Operator-supplied values are exact Development QA scope; no credentials are created or printed. */
export async function createQaAdapter(
  { fixture },
  {
    env = process.env,
    stdin = process.stdin,
    fetchImpl = fetch,
    targetVerifier = assertControlTarget,
    timeoutMs = DEFAULT_INBOX_DEADLINE,
    pollMs = DEFAULT_POLL,
    now = () => Date.now(),
    monotonicNow = () => performance.now(),
  } = {},
) {
  if (
    !["next-native-auth", "next-app-mail"].includes(fixture) ||
    !address(env.SPIKE_QA_MAIL_RECIPIENT) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 900_000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60_000 ||
    typeof monotonicNow !== "function"
  )
    throw new Error("qa_adapter_invalid");
  let users, sender;
  if (fixture === "next-native-auth") {
    const a = env.SPIKE_QA_AUTH_A_EMAIL,
      b = env.SPIKE_QA_AUTH_B_EMAIL;
    const passwordA = env.SPIKE_QA_AUTH_A_PASSWORD,
      passwordB = env.SPIKE_QA_AUTH_B_PASSWORD;
    sender = env.SPIKE_QA_AUTH_SENDER;
    if (
      !address(sender) ||
      !aliasOf(a, env.SPIKE_QA_MAIL_RECIPIENT) ||
      !aliasOf(b, env.SPIKE_QA_MAIL_RECIPIENT) ||
      a.toLowerCase() === b.toLowerCase() ||
      typeof passwordA !== "string" ||
      passwordA.length < 12 ||
      passwordA.length > 128 ||
      typeof passwordB !== "string" ||
      passwordB.length < 12 ||
      passwordB.length > 128
    )
      throw new Error("auth_scope_invalid");
    users = [
      { email: a, password: passwordA, name: "Preview QA A" },
      { email: b, password: passwordB, name: "Preview QA B" },
    ];
  } else {
    sender = env.SPIKE_QA_MAIL_SENDER;
    if (
      !address(sender) ||
      typeof env.SPIKE_CONTROL_TOKEN !== "string" ||
      env.SPIKE_CONTROL_TOKEN.length < 32 ||
      env.SPIKE_CONTROL_TOKEN.length > 1024 ||
      typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
      !env.CLOUDFLARE_API_TOKEN ||
      !/^[a-f0-9]{32}$/u.test(env.PREVIEW_SPIKE_ROUTE_ID ?? "") ||
      !/^[a-f0-9-]{36}$/u.test(env.PREVIEW_SPIKE_WORKER_VERSION_ID ?? "") ||
      typeof targetVerifier !== "function" ||
      typeof fetchImpl !== "function"
    )
      throw new Error("mail_scope_invalid");
  }
  const handle = await privateQueue(env.SPIKE_QA_INBOX_QUEUE);
  let broker;
  try {
    broker = inboxBroker({ handle, stdin, timeoutMs, pollMs, now });
  } catch (error) {
    await handle.close();
    throw error;
  }
  const validScope = (sessionId, id) => SESSION.test(sessionId ?? "") && MESSAGE.test(id ?? "");
  return {
    async auth({ sessionId, signal } = {}) {
      active(signal);
      if (fixture !== "next-native-auth" || !SESSION.test(sessionId ?? ""))
        throw new Error("auth_scope_invalid");
      return { users: users.map((user) => ({ ...user })), sender };
    },
    async mail({ sessionId, id, signal } = {}) {
      active(signal);
      if (fixture !== "next-app-mail" || !validScope(sessionId, id))
        throw new Error("mail_scope_invalid");
      return { recipient: env.SPIKE_QA_MAIL_RECIPIENT, sender };
    },
    async armMail({ sessionId, id, signal, deadlineAt } = {}) {
      active(signal);
      if (fixture !== "next-app-mail" || !validScope(sessionId, id))
        throw new Error("mail_scope_invalid");
      const started = monotonicNow();
      deadlineAt ??= started + 60_000;
      if (!Number.isFinite(started) || !Number.isFinite(deadlineAt) || deadlineAt <= started)
        throw new Error("control_target_unverified");
      deadlineAt = Math.min(deadlineAt, started + 60_000);
      const target = {
        accountId: "00000000000000000000000000000001",
        zoneId: "0000000000000000000000000000000b",
        routeId: env.PREVIEW_SPIKE_ROUTE_ID,
        workerVersionId: env.PREVIEW_SPIKE_WORKER_VERSION_ID,
        token: env.CLOUDFLARE_API_TOKEN,
        fetcher: fetchImpl,
        signal,
        deadlineAt,
        now: monotonicNow,
      };
      if ((await targetVerifier(target)) !== true) throw new Error("control_target_unverified");
      active(signal);
      const remaining = deadlineAt - monotonicNow();
      if (remaining <= 0) throw new Error("control_target_unverified");
      let requestFailed = false;
      try {
        const response = await fetchImpl(`${CONTROL}/__spike/sessions/${sessionId}/mail-permit`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(30_000, remaining)))),
          ]),
          headers: {
            authorization: `Bearer ${env.SPIKE_CONTROL_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id }),
        });
        if (signal?.aborted || response.status !== 204) requestFailed = true;
      } catch {
        requestFailed = true;
      }
      try {
        if ((await targetVerifier(target)) !== true) throw new Error("control_target_unverified");
        if (requestFailed || signal?.aborted || monotonicNow() >= deadlineAt)
          throw new Error("uncertain");
      } catch {
        throw new Error("mail_permit_unknown");
      }
    },
    async readInbox({ kind, recipient, since, subject, signal } = {}) {
      active(signal);
      if (
        !Number.isSafeInteger(since) ||
        since < 0 ||
        (fixture === "next-native-auth" &&
          (kind !== "verification" ||
            !users.some((user) => user.email === recipient) ||
            subject !== undefined)) ||
        (fixture === "next-app-mail" &&
          (kind !== "mail" ||
            recipient !== env.SPIKE_QA_MAIL_RECIPIENT ||
            typeof subject !== "string" ||
            !/^Preview acceptance [A-Za-z0-9-]{1,80}$/u.test(subject)))
      )
        throw new Error("inbox_scope_invalid");
      return broker.read(
        { kind, recipient, since, ...(subject === undefined ? {} : { subject }) },
        signal,
      );
    },
    close: () => broker.close(),
  };
}

/** Same module can be used as the benchmark's absolute-path local browser driver. */
export async function openBrowser({ env = process.env, loader = (url) => import(url) } = {}) {
  const module = env.PREVIEW_SPIKE_PLAYWRIGHT_MODULE,
    executable = env.PREVIEW_SPIKE_CHROME_BINARY;
  if (
    typeof module !== "string" ||
    !isAbsolute(module) ||
    typeof executable !== "string" ||
    !isAbsolute(executable)
  )
    throw new Error("browser_driver_required");
  try {
    const modulePath = await realpath(module),
      binaryPath = await realpath(executable);
    const [moduleFile, binaryFile] = await Promise.all([stat(modulePath), stat(binaryPath)]);
    if (!moduleFile.isFile() || !binaryFile.isFile() || (binaryFile.mode & 0o111) === 0)
      throw new Error("invalid");
    const playwright = await loader(pathToFileURL(modulePath).href);
    if (typeof playwright?.chromium?.launch !== "function") throw new Error("invalid");
    return await playwright.chromium.launch({ headless: true, executablePath: binaryPath });
  } catch {
    throw new Error("browser_driver_invalid");
  }
}
