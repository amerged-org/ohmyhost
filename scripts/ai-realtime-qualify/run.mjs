#!/usr/bin/env node
/*
 * Realtime qualification of the AI gateway: the real apps/ai-gateway Worker code, run in workerd (miniflare), with a
 * fake Core and always-success ratelimit bindings, against the real orq realtime service. Prints ONE sanitized JSON
 * evidence object on stdout. Worker logs and harness diagnostics go to stderr. See README.md in this directory.
 *
 *   node scripts/ai-realtime-qualify/run.mjs            full run: one text turn, then a clean close
 *   node scripts/ai-realtime-qualify/run.mjs --abrupt   client terminates the TCP socket after session.created
 */
/* global WebSocket, Response */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
// The miniflare (and its workerd) that wrangler of apps/ai-gateway ships, so the local runtime is the deploy toolchain.
const wranglerEntry = createRequire(join(repo, "apps/ai-gateway/package.json")).resolve("wrangler");
const miniflareEntry = createRequire(wranglerEntry).resolve("miniflare");
const { Log, LogLevel, Miniflare, convertV4MiniflareOptions } = await import(
  pathToFileURL(miniflareEntry).href
);
const gatewayEntry = join(repo, "apps/ai-gateway/src/worker-main.ts");
const gatewayTsconfig = join(repo, "apps/ai-gateway/tsconfig.json");
const coreScript = join(here, "core.mjs");
const SCRATCH_ROOT = process.env.AI_RT_DIR ?? join(tmpdir(), "ai-realtime-qualify");
// The untracked env file that holds ORQ_API_KEY: the checkout's own, or the one named by AI_RT_ENV_FILE.
const ENV_FILE = process.env.AI_RT_ENV_FILE ?? join(repo, ".env.local");
const ORQ_BASE_URL = "https://my.orq.ai/v3/router";
const ORQ_ORIGIN = "https://my.orq.ai";
const MODEL = "xai/grok-voice-3.0";
const COMPATIBILITY_DATE = "2026-10-01";
const COMPATIBILITY_FLAGS = ["nodejs_compat", "enable_request_signal"];
/** The gateway's key shape, copied from packages/platform/src/shared/ai-gateway.ts (AI_KEY_PATTERN). */
const AI_KEY_PATTERN = /^omh_ai_([0-7][0-9A-HJKMNP-TV-Z]{25})_[A-Za-z0-9_-]{43}$/u;
const TEST_ORGANIZATION_ID = "01H00000000000000000000702";
const TEST_ENVIRONMENT_ID = "01H00000000000000000000701";
const SETTLE_WAIT_MS = 40_000;
const SETTLE_GRACE_MS = 3_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Reads ORQ_API_KEY from the env file inside this process. The value is never logged, written or echoed. */
function readOrqKey(path) {
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith("ORQ_API_KEY="));
  if (line === undefined) throw new Error("ORQ_API_KEY is not set in the env file");
  const value = line
    .slice("ORQ_API_KEY=".length)
    .trim()
    .replace(/^(["'])(.*)\1$/u, "$2");
  if (value.length === 0) throw new Error("ORQ_API_KEY is empty in the env file");
  return value;
}

/** A gateway key for a test project, generated per run: it matches AI_KEY_PATTERN and exists nowhere but this process. */
function makeTestKey() {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(25);
  let projectId = "0";
  for (const byte of bytes) projectId += crockford[byte % crockford.length];
  const key = `omh_ai_${projectId}_${randomBytes(32).toString("base64url")}`;
  if (!AI_KEY_PATTERN.test(key))
    throw new Error("generated test key does not match AI_KEY_PATTERN");
  return { key, projectId };
}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Bundles the real gateway entry (worker-main.ts and its imports) into one ES module for workerd. */
async function bundleGateway(outfile) {
  await build({
    entryPoints: [gatewayEntry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    // "source" resolves @ohmyhost/platform to its TypeScript source, so no platform dist build is needed.
    conditions: ["source", "workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    tsconfig: gatewayTsconfig,
    logLevel: "warning",
  });
}

/** Miniflare's log goes to stderr, with the orq key redacted from any line. */
class StderrLog extends Log {
  constructor(secrets) {
    super(LogLevel.INFO);
    this.secrets = secrets;
  }
  log(message) {
    process.stderr.write(`${redact(message, this.secrets)}\n`);
  }
}

function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join("[redacted]");
  return out;
}

async function until(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/** The settle and release lines the fake Core recorded, found in the record file. */
function readRecords(recordFile) {
  let text = "";
  try {
    text = readFileSync(recordFile, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function waitForSettle(recordFile, timeoutMs) {
  const found = await until(
    () => readRecords(recordFile).some((record) => record.method === "settle"),
    timeoutMs,
  );
  return found;
}

/** The evidence of the recorded Core calls: counts, and the one settle input (no secret, no content). */
function summarizeRecords(records) {
  const settles = records.filter((record) => record.method === "settle");
  const releases = records.filter((record) => record.method === "release");
  const first = settles[0]?.input ?? null;
  // The cost is what the gateway's own settle path obtained from orq telemetry; the harness queries nothing itself.
  const costNanoUsd = first === null ? null : first.costNanoUsd;
  return {
    settleCalls: settles.length,
    releaseCalls: releases.length,
    traceId: first === null ? null : first.traceId,
    costNanoUsd,
    costRecorded: costNanoUsd !== null && BigInt(costNanoUsd) > 0n,
    settle:
      first === null
        ? null
        : {
            model: first.model,
            usageKeys: Object.keys(first.usage ?? {}).sort(),
          },
  };
}

async function runFull(port, testKey, recordFile, startedAt) {
  const eventTypes = [];
  let binaryFramesSeen = false;
  let closed = false;
  const closeCodes = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?model=${MODEL}`, {
    headers: { authorization: `Bearer ${testKey}` },
  });
  ws.binaryType = "arraybuffer";
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", () => resolveOpen(), { once: true });
    ws.addEventListener("error", () => rejectOpen(new Error("websocket error before open")), {
      once: true,
    });
    ws.addEventListener(
      "close",
      (event) => rejectOpen(new Error(`websocket closed before open with code ${event.code}`)),
      { once: true },
    );
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      binaryFramesSeen = true;
      return;
    }
    try {
      const type = JSON.parse(event.data).type;
      eventTypes.push(typeof type === "string" ? type : "untyped");
    } catch {
      eventTypes.push("unparsed_text");
    }
  });
  ws.addEventListener("close", (event) => {
    closed = true;
    closeCodes.push(event.code);
  });

  const created = await until(() => eventTypes.includes("session.created"), 30_000);
  if (!created) throw new Error("session.created was not seen within 30 s");
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "Say OK." }] },
    }),
  );
  ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["text"] } }));
  await until(() => eventTypes.includes("response.done") || closed, 20_000);
  const responseDone = eventTypes.includes("response.done");
  if (!closed) ws.close(1000, "qualification done");
  await until(() => closed, 10_000);

  const settled = await waitForSettle(recordFile, SETTLE_WAIT_MS);
  await sleep(SETTLE_GRACE_MS);
  return {
    scenario: "full-text-turn",
    responseDone,
    eventTypes,
    binaryFramesSeen,
    closeCodes,
    settleSeen: settled,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Upgrades a raw TCP socket by hand, so the client can end the connection with no close frame. */
async function runAbrupt(port, testKey, recordFile, startedAt) {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  const nonce = randomBytes(16).toString("base64");
  socket.write(
    [
      `GET /v1/realtime?model=${MODEL} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${nonce}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${testKey}`,
      "",
      "",
    ].join("\r\n"),
  );

  const eventTypes = [];
  let binaryFramesSeen = false;
  let serverCloseFrames = 0;
  let upgradeStatus = null;
  let buffer = Buffer.alloc(0);
  let fragments = null;
  let fragmentOpcode = 0;
  let sawCreated = false;
  let resolveCreated;
  const created = new Promise((resolveFn) => (resolveCreated = resolveFn));

  const handleMessage = (opcode, payload) => {
    if (opcode === 2) binaryFramesSeen = true;
    if (opcode === 8) serverCloseFrames += 1;
    if (opcode !== 1) return;
    try {
      const type = JSON.parse(payload.toString("utf8")).type;
      eventTypes.push(typeof type === "string" ? type : "untyped");
    } catch {
      eventTypes.push("unparsed_text");
    }
    if (eventTypes.at(-1) === "session.created" && !sawCreated) {
      sawCreated = true;
      resolveCreated();
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (upgradeStatus === null) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString("latin1");
      upgradeStatus = Number(head.split(" ")[1]);
      buffer = buffer.subarray(end + 4);
    }
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcodeBits = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcodeBits !== 0) fragmentOpcode = opcodeBits;
      fragments = Buffer.concat([fragments ?? Buffer.alloc(0), payload]);
      if (fin) {
        handleMessage(fragmentOpcode, fragments);
        fragments = null;
      }
    }
  });
  socket.on("error", () => {});

  const ok = await until(() => sawCreated, 30_000);
  if (!ok) {
    socket.destroy();
    throw new Error("session.created was not seen within 30 s");
  }
  socket.destroy();
  const settled = await waitForSettle(recordFile, SETTLE_WAIT_MS);
  await sleep(SETTLE_GRACE_MS);
  await created;
  return {
    scenario: "abrupt-after-session-created",
    upgradeStatus,
    eventTypes,
    binaryFramesSeen,
    clientCloseFrameSent: false,
    serverCloseFramesSeen: serverCloseFrames,
    settleSeen: settled,
    elapsedMs: Date.now() - startedAt,
  };
}

async function main() {
  const abrupt = process.argv.includes("--abrupt");
  const orqKey = readOrqKey(ENV_FILE);
  const { key: testKey, projectId } = makeTestKey();
  const secrets = [orqKey, testKey];

  const runDir = join(SCRATCH_ROOT, `${abrupt ? "abrupt" : "full"}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const recordFile = join(runDir, "core-calls.jsonl");
  writeFileSync(recordFile, "");
  const gatewayBundle = join(runDir, "gateway.mjs");
  await bundleGateway(gatewayBundle);

  const startedAt = Date.now();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new StderrLog(secrets),
      port: 0,
      workers: [
        {
          name: "gateway",
          modules: [
            {
              type: "ESModule",
              path: "gateway.mjs",
              contents: readFileSync(gatewayBundle, "utf8"),
            },
          ],
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: COMPATIBILITY_FLAGS,
          bindings: {
            ORQ_API_KEY: orqKey,
            ORQ_BASE_URL,
            ORQ_ORIGIN,
          },
          serviceBindings: {
            AI_RUNTIME: { name: "core", entrypoint: "AiGatewayRuntime" },
            PROJECT_LIMITER: { name: "core", entrypoint: "RateLimiter" },
            AUTH_LIMITER: { name: "core", entrypoint: "RateLimiter" },
          },
        },
        {
          name: "core",
          modules: [
            { type: "ESModule", path: "core.mjs", contents: readFileSync(coreScript, "utf8") },
          ],
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: COMPATIBILITY_FLAGS,
          bindings: {
            TEST_PROJECT_ID: projectId,
            TEST_KEY_SHA256: sha256Hex(testKey),
            TEST_ORGANIZATION_ID,
            TEST_ENVIRONMENT_ID,
          },
          serviceBindings: {
            RECORDER: async (request) => {
              appendFileSync(recordFile, `${await request.text()}\n`);
              return new Response("ok");
            },
          },
        },
      ],
    }),
  );

  let evidence;
  try {
    const url = await mf.ready;
    const port = Number(url.port);
    const scenario = abrupt
      ? await runAbrupt(port, testKey, recordFile, startedAt)
      : await runFull(port, testKey, recordFile, startedAt);
    const records = readRecords(recordFile);
    const summary = summarizeRecords(records);
    evidence = {
      ...scenario,
      ...summary,
      ok:
        summary.settleCalls === 1 &&
        summary.releaseCalls === 0 &&
        (abrupt || scenario.responseDone === true) &&
        scenario.settleSeen === true,
    };
  } catch (error) {
    evidence = {
      scenario: abrupt ? "abrupt-after-session-created" : "full-text-turn",
      ok: false,
      error: redact(error instanceof Error ? error.message : String(error), secrets),
      ...summarizeRecords(readRecords(recordFile)),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await mf.dispose();
  }
  process.stdout.write(`${redact(JSON.stringify(evidence, null, 2), secrets)}\n`);
  process.exitCode = evidence.ok ? 0 : 1;
}

await main();
