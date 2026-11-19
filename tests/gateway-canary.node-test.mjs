/* global Buffer, Request, Response, TextEncoder, URL, console */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createFunctionsFrameworkAdapter } from "../packages/adapter-functions/dist/index.js";
import { parseOhmyhostConfigYaml } from "../packages/contracts/dist/index.js";
import { admitExpandOnlyMigrations } from "../packages/contracts/dist/database-migration-admission.js";
import {
  databaseContractCodes,
  workerModuleFindings,
} from "../packages/contracts/dist/framework-source-rules.js";
import * as canary from "../fixtures/gateway-canary/src/verdict.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "fixtures/gateway-canary");

// The deployment values a real canary receives; every key is a sentinel the logs must never repeat.
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MAIL_URL = "https://ohmyho-mail-gateway-poc-private-fullstack.your-omh-account.workers.dev";
const STORAGE_URL =
  "https://ohmyho-storage-gateway-poc-private-fullstack.your-omh-account.workers.dev";
const R2_URL = "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com/canary";
const MAIL_KEY = "m".repeat(43);
const STORAGE_KEY = "s".repeat(43);
const SCHEDULED_AT = Date.UTC(2026, 9, 23, 10, 3, 0);
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------------------------
// Table 1: what each leg's observed answer means. Columns: name, leg, observation, verdict and,
// optionally, whether the documented client accepted the answer (default true).
// ---------------------------------------------------------------------------------------------
const seen = (status, contentType, code, extra) => ({
  kind: "response",
  status,
  contentType,
  code,
  egressOutcome: null,
  stage: null,
  egressDenied: false,
  ...extra,
});
const json = (status, code = null, extra = {}) => seen(status, "application/json", code, extra);
const plain = (status, extra = {}) => seen(status, "text/plain", null, extra);
const html = (status) => seen(status, "text/html", null, {});
const DENIED = plain(403, { egressDenied: true });
const KEY_LOOKUP = { stage: "key_lookup" };
const NOT_SENT = { kind: "not_sent" };
const FETCH_FAILED = { kind: "fetch_failed" };

const LEG_ROWS = [
  // ok: the healthy answer of every leg, and never an outcome header
  ["ok: mail impossible key", "mail_unauthorized", json(401, "unauthorized"), "ok"],
  [
    "ok: storage impossible key reached the key lookup",
    "storage_unauthorized",
    json(401, "unauthorized", KEY_LOOKUP),
    "ok",
  ],
  [
    "ok: forged claim, valid key, absent object",
    "storage_absent_object",
    json(404, "object_not_found"),
    "ok",
  ],
  ["ok: unlisted origin refused by the egress", "egress_control", DENIED, "ok"],
  ["ok: reserve", "storage_reserve", json(200), "ok"],
  ["ok: signed PUT", "storage_put", plain(200), "ok"],
  ["ok: signed PUT already stored", "storage_put", seen(412, "application/xml", null, {}), "ok"],
  ["ok: complete", "storage_complete", json(200), "ok"],
  ["ok: signed read capability", "storage_read_capability", json(200), "ok"],
  ["ok: signed GET", "storage_read", plain(200), "ok"],
  ["ok: delete of the previous object", "storage_delete", json(200), "ok"],
  [
    "ok: delete with nothing to erase",
    "storage_delete",
    json(409, "storage_gateway_conflict"),
    "ok",
  ],
  [
    "ok: delete settling after the provider answered",
    "storage_delete",
    json(409, "storage_delete_pending"),
    "ok",
  ],
  ["ok: mail send accepted", "mail_send", json(202), "ok"],
  // relay_misconfigured: anything the relay or entrypoint contract does not produce
  [
    "relay: outcome header on a relay refusal",
    "storage_absent_object",
    json(403, "gateway_not_enabled", { egressOutcome: "not_enabled" }),
    "relay_misconfigured",
  ],
  [
    "relay: outcome header on a relay-made 503",
    "storage_absent_object",
    json(503, "storage_gateway_unavailable", { egressOutcome: "origin_unbound" }),
    "relay_misconfigured",
  ],
  [
    "relay: outcome header beats a healthy answer",
    "mail_unauthorized",
    json(401, "unauthorized", { egressOutcome: "route_denied" }),
    "relay_misconfigured",
  ],
  [
    "relay: text/plain 403 from the egress on a gateway leg",
    "storage_absent_object",
    DENIED,
    "relay_misconfigured",
  ],
  ["relay: text/plain 503 from the egress", "mail_send", plain(503), "relay_misconfigured"],
  [
    "relay: 401 where the forged-claim probe expected 404",
    "storage_absent_object",
    json(401, "unauthorized"),
    "relay_misconfigured",
  ],
  [
    "relay: storage 401 without the stage header",
    "storage_unauthorized",
    json(401, "unauthorized"),
    "relay_misconfigured",
  ],
  [
    "relay: storage 401 with another stage",
    "storage_unauthorized",
    json(401, "unauthorized", { stage: "marker" }),
    "relay_misconfigured",
  ],
  [
    "relay: html 404 from a public host nobody serves",
    "storage_absent_object",
    html(404),
    "relay_misconfigured",
  ],
  [
    "relay: fetch rejected on a gateway leg",
    "mail_unauthorized",
    FETCH_FAILED,
    "relay_misconfigured",
  ],
  [
    "relay: unknown route",
    "mail_unauthorized",
    json(404, "resource_not_found"),
    "relay_misconfigured",
  ],
  [
    "relay: the other gateway's unavailable code",
    "storage_reserve",
    json(503, "mail_gateway_unavailable"),
    "relay_misconfigured",
  ],
  ["relay: complete still pending", "storage_complete", json(202), "relay_misconfigured"],
  ["relay: signed PUT refused by the egress", "storage_put", DENIED, "relay_misconfigured"],
  [
    "relay: signed GET answered by a gateway 503",
    "storage_read",
    json(503, "storage_gateway_unavailable"),
    "relay_misconfigured",
  ],
  [
    "relay: healthy status without a JSON content type",
    "storage_reserve",
    plain(200),
    "relay_misconfigured",
  ],
  [
    "relay: a success document that carries a code",
    "storage_reserve",
    json(200, "unauthorized"),
    "relay_misconfigured",
  ],
  [
    "relay: the documented client refused a healthy-looking 200",
    "storage_reserve",
    json(200),
    "relay_misconfigured",
    false,
  ],
  // gateway_io_blocked: the gateway answers, but its own network or database IO fails
  [
    "io: storage 503 after validation",
    "storage_absent_object",
    json(503, "storage_gateway_unavailable"),
    "gateway_io_blocked",
  ],
  [
    "io: mail 503",
    "mail_unauthorized",
    json(503, "mail_gateway_unavailable"),
    "gateway_io_blocked",
  ],
  [
    "io: complete 503, provider HEAD blocked",
    "storage_complete",
    json(503, "storage_gateway_unavailable"),
    "gateway_io_blocked",
  ],
  [
    "io: delete 503",
    "storage_delete",
    json(503, "storage_gateway_unavailable"),
    "gateway_io_blocked",
  ],
  ["io: mail send 503", "mail_send", json(503, "mail_gateway_unavailable"), "gateway_io_blocked"],
  // policy_not_enforced: the unlisted origin was not refused
  ["policy: unlisted origin answered", "egress_control", html(200), "policy_not_enforced"],
  [
    "policy: fetch failed, no egress policy attached",
    "egress_control",
    FETCH_FAILED,
    "policy_not_enforced",
  ],
  [
    "policy: the egress tried to reach the origin",
    "egress_control",
    plain(502),
    "policy_not_enforced",
  ],
  [
    "policy: a 403 that is not the egress denial",
    "egress_control",
    plain(403),
    "policy_not_enforced",
  ],
  ["policy: a JSON 403", "egress_control", json(403, "forbidden"), "policy_not_enforced"],
  ["relay: the egress failed closed", "egress_control", plain(503), "relay_misconfigured"],
  [
    "relay: outcome header on the control leg",
    "egress_control",
    plain(403, { egressDenied: true, egressOutcome: "route_denied" }),
    "relay_misconfigured",
  ],
  // canary_misconfigured: the canary's own request, key or account is what was refused
  ["canary: nothing was sent", "storage_reserve", NOT_SENT, "canary_misconfigured"],
  [
    "canary: nothing was sent on the control leg",
    "egress_control",
    NOT_SENT,
    "canary_misconfigured",
  ],
  [
    "canary: key unknown to the key lookup",
    "storage_absent_object",
    json(401, "unauthorized", KEY_LOOKUP),
    "canary_misconfigured",
  ],
  ["canary: mail key rejected", "mail_send", json(401, "unauthorized"), "canary_misconfigured"],
  [
    "canary: payment required",
    "mail_send",
    json(402, "paid_plan_required"),
    "canary_misconfigured",
  ],
  [
    "canary: request refused",
    "storage_reserve",
    json(400, "invalid_request"),
    "canary_misconfigured",
  ],
  ["canary: quota", "storage_reserve", json(413, "storage_quota_exceeded"), "canary_misconfigured"],
  [
    "canary: daily mail limit",
    "mail_send",
    json(429, "mail_send_daily_limit"),
    "canary_misconfigured",
  ],
  [
    "canary: sender suspended",
    "mail_send",
    json(423, "mail_reputation_suspended"),
    "canary_misconfigured",
  ],
  [
    "canary: reserve conflict",
    "storage_reserve",
    json(409, "storage_conflict"),
    "canary_misconfigured",
  ],
  [
    "canary: provider rejected the recipient",
    "mail_send",
    json(502, "mail_rejected"),
    "canary_misconfigured",
  ],
  [
    "canary: delete conflict of another kind",
    "storage_delete",
    json(409, "storage_conflict"),
    "canary_misconfigured",
  ],
];

const DATABASE_ROWS = [
  ["ok", null, "ok"],
  ["database unavailable", "database_unavailable", "database_unavailable"],
  ["response refused by the client", "database_response_invalid", "database_unavailable"],
  ["transaction outcome unknown", "database_transaction_outcome_unknown", "database_unavailable"],
  ["statement failure", "40001", "database_unavailable"],
  ["unknown failure", "unknown", "database_unavailable"],
  ["binding missing", "database_binding_missing", "canary_misconfigured"],
  ["query refused by the client", "database_query_invalid", "canary_misconfigured"],
];

// Table 2: the pure helpers around the verdicts.
const leg = (name, verdict) => ({ leg: name, verdict, observation: null, failure: null });
const cheapOk = canary.TICK_PLANS.cheap.map(({ leg: name }) => leg(name, "ok"));
const deepOk = canary.TICK_PLANS.deep.map(({ leg: name }) => leg(name, "ok"));
const SUMMARY_ROWS = [
  ["every planned cheap leg ok", "cheap", cheapOk, "ok"],
  ["every planned deep leg ok", "deep", deepOk, "ok"],
  ["no leg ran", "cheap", [], "canary_misconfigured"],
  ["a planned leg is missing and nothing is red", "deep", deepOk.slice(1), "canary_misconfigured"],
  [
    "a red leg explains the legs it skipped",
    "deep",
    [leg("storage_reserve", "relay_misconfigured")],
    "relay_misconfigured",
  ],
  [
    "policy_not_enforced is the headline",
    "cheap",
    [
      leg("egress_control", "policy_not_enforced"),
      leg("mail_unauthorized", "gateway_io_blocked"),
      leg("database_query", "database_unavailable"),
    ],
    "policy_not_enforced",
  ],
  [
    "gateway_io_blocked outranks relay and database",
    "cheap",
    [
      leg("storage_absent_object", "relay_misconfigured"),
      leg("mail_unauthorized", "gateway_io_blocked"),
      leg("database_query", "database_unavailable"),
    ],
    "gateway_io_blocked",
  ],
  [
    "relay_misconfigured outranks database and canary",
    "cheap",
    [
      leg("database_query", "database_unavailable"),
      leg("storage_absent_object", "relay_misconfigured"),
      leg("mail_unauthorized", "canary_misconfigured"),
    ],
    "relay_misconfigured",
  ],
  [
    "database_unavailable outranks canary_misconfigured",
    "cheap",
    [
      leg("database_query", "database_unavailable"),
      leg("mail_unauthorized", "canary_misconfigured"),
    ],
    "database_unavailable",
  ],
  [
    "only canary_misconfigured",
    "cheap",
    [leg("mail_unauthorized", "canary_misconfigured")],
    "canary_misconfigured",
  ],
];

const DESCRIBE_ROWS = [
  [
    "json code",
    { status: 401, contentType: "application/json", body: '{"code":"unauthorized"}' },
    { contentType: "application/json", code: "unauthorized" },
  ],
  [
    "json with parameters and a request id",
    {
      status: 502,
      contentType: "Application/JSON; charset=utf-8",
      body: '{"code":"mail_rejected","request_id":"x"}',
    },
    { contentType: "application/json", code: "mail_rejected" },
  ],
  [
    "json success document has no code",
    { status: 200, contentType: "application/json", body: '{"state":"ready"}' },
    { code: null },
  ],
  ["malformed json", { status: 200, contentType: "application/json", body: "{" }, { code: null }],
  [
    "json array",
    { status: 200, contentType: "application/json", body: '["unauthorized"]' },
    { code: null },
  ],
  [
    "oversized json",
    {
      status: 200,
      contentType: "application/json",
      body: `{"code":"a","pad":"${"x".repeat(9000)}"}`,
    },
    { code: null },
  ],
  [
    "unrecognizable code",
    { status: 400, contentType: "application/json", body: '{"code":"Bad code!"}' },
    { code: "unrecognized" },
  ],
  [
    "code in a text body is ignored",
    { status: 403, contentType: "text/plain", body: '{"code":"unauthorized"}' },
    { code: null },
  ],
  [
    "egress denial text",
    {
      status: 403,
      contentType: "text/plain; charset=utf-8",
      body: "Egress denied: https://x is not listed",
    },
    { contentType: "text/plain", egressDenied: true },
  ],
  [
    "denial text in html is not a denial",
    { status: 403, contentType: "text/html", body: "Egress denied: x" },
    { egressDenied: false },
  ],
  [
    "other text is not a denial",
    { status: 403, contentType: "text/plain", body: "error code: 1010" },
    { egressDenied: false },
  ],
  [
    "missing content type",
    { status: 200, contentType: null, body: "" },
    { contentType: null, code: null },
  ],
  [
    "outcome and stage tokens",
    {
      status: 401,
      contentType: "application/json",
      body: "{}",
      egressOutcome: "transport_error",
      stage: "key_lookup",
    },
    { egressOutcome: "transport_error", stage: "key_lookup" },
  ],
  [
    "a hostile header value is not echoed",
    {
      status: 401,
      contentType: "application/json",
      body: "{}",
      egressOutcome: "<script>",
      stage: "a b",
    },
    { egressOutcome: "unrecognized", stage: "unrecognized" },
  ],
];

const RECIPIENT = "qa@example.test";
const FULL_ENVIRONMENT = {
  GATEWAY_CANARY_RECIPIENT: RECIPIENT,
  OHMYHOST_PROJECT_ID: PROJECT,
  OHMYHOST_ENVIRONMENT_ID: ENVIRONMENT,
  OHMYHOST_MAIL_GATEWAY_URL: MAIL_URL,
  OHMYHOST_MAIL_KEY: MAIL_KEY,
  OHMYHOST_STORAGE_GATEWAY_URL: STORAGE_URL,
  OHMYHOST_STORAGE_KEY: STORAGE_KEY,
};
const CONFIGURATION_ROWS = [
  ["complete", {}, []],
  ["recipient missing", { GATEWAY_CANARY_RECIPIENT: undefined }, ["GATEWAY_CANARY_RECIPIENT"]],
  [
    "recipient malformed",
    { GATEWAY_CANARY_RECIPIENT: "a\r\nBcc: b@example.test" },
    ["GATEWAY_CANARY_RECIPIENT"],
  ],
  ["project id missing", { OHMYHOST_PROJECT_ID: undefined }, ["OHMYHOST_PROJECT_ID"]],
  [
    "environment id not a ULID",
    { OHMYHOST_ENVIRONMENT_ID: "environment" },
    ["OHMYHOST_ENVIRONMENT_ID"],
  ],
  [
    "mail url with a path",
    { OHMYHOST_MAIL_GATEWAY_URL: `${MAIL_URL}/v1` },
    ["OHMYHOST_MAIL_GATEWAY_URL"],
  ],
  [
    "mail url over http",
    { OHMYHOST_MAIL_GATEWAY_URL: MAIL_URL.replace("https", "http") },
    ["OHMYHOST_MAIL_GATEWAY_URL"],
  ],
  [
    "storage url with credentials",
    { OHMYHOST_STORAGE_GATEWAY_URL: "https://u:p@example.com" },
    ["OHMYHOST_STORAGE_GATEWAY_URL"],
  ],
  ["mail key too short", { OHMYHOST_MAIL_KEY: "short" }, ["OHMYHOST_MAIL_KEY"]],
  ["storage key not a string", { OHMYHOST_STORAGE_KEY: 7 }, ["OHMYHOST_STORAGE_KEY"]],
  [
    "several at once, in declaration order",
    { OHMYHOST_STORAGE_KEY: undefined, OHMYHOST_PROJECT_ID: undefined },
    ["OHMYHOST_PROJECT_ID", "OHMYHOST_STORAGE_KEY"],
  ],
];

// ---------------------------------------------------------------------------------------------
// Table 3: the real worker, bundled like the platform bundles it, run against a model of the
// customer -> egress -> gateway chain. Every call to the global fetch and to the database binding
// is one subrequest.
// ---------------------------------------------------------------------------------------------
const reply = (status, body, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
      ...headers,
    },
  });

function capability(operation, objectKey, length) {
  return {
    operation,
    objectKey,
    url: R2_URL,
    expiresAt: new Date(SCHEDULED_AT + 300_000).toISOString(),
    expectedContentLength: length,
    requiredHeaders:
      operation === "PUT" ? { "content-type": "text/plain" } : { "x-signed-read": "1" },
  };
}

/** The chain the canary sees. Each option reproduces one state of the platform. */
function chain(options = {}) {
  const {
    stamp = true, // the egress overwrites x-ohmyhost-egress-project-id with the dispatcher value
    storage = "healthy", // healthy | tcp_blocked | fetch_blocked | unserved
    mail = "healthy", // healthy | tcp_blocked | fetch_blocked
    control = "denied", // denied | open | unavailable | rejects
    reserve = "ready", // ready | completed | malformed
    previous = "present", // present | missing
    r2 = "healthy", // healthy | denied: the egress refuses the R2 origin
    outcome = null, // answer every storage call with a relay refusal carrying this outcome
  } = options;
  return async (request, call) => {
    const url = new URL(request.url);
    if (url.origin === new URL(canary.UNLISTED_ORIGIN).origin) {
      if (control === "rejects") throw new TypeError("fetch failed");
      if (control === "open")
        return reply(200, "<html>open</html>", { "content-type": "text/html" });
      if (control === "unavailable") return reply(503, "Egress policy unavailable");
      return reply(403, "Egress denied: the origin is not listed in runtime.egress.allow.");
    }
    if (url.origin === new URL(R2_URL).origin) {
      if (r2 === "denied") return reply(403, "Egress denied: the origin is not listed.");
      return request.method === "PUT" ? new Response(null, { status: 200 }) : reply(200, "bytes");
    }
    const bearer = (call.headers["authorization"] ?? "").slice("Bearer ".length);
    if (url.origin === MAIL_URL) {
      if (mail === "tcp_blocked") return reply(503, { code: "mail_gateway_unavailable" });
      if (bearer !== MAIL_KEY) return reply(401, { code: "unauthorized" });
      if (mail === "fetch_blocked") return reply(503, { code: "mail_gateway_unavailable" });
      return reply(202, { state: "accepted", request_id: ULID, message_id: "message-1" });
    }
    assert.equal(url.origin, STORAGE_URL, `unexpected origin ${url.origin}`);
    if (storage === "unserved") {
      // The egress before the relay: a public fetch of the gateway's workers.dev host, which
      // has no listener.
      return reply(404, "<html>There is nothing here yet</html>", { "content-type": "text/html" });
    }
    if (outcome !== null) {
      return reply(
        503,
        { code: "storage_gateway_unavailable" },
        { "x-ohmyhost-egress-outcome": outcome },
      );
    }
    const body = JSON.parse(call.body);
    const header = stamp ? PROJECT : (call.headers["x-ohmyhost-egress-project-id"] ?? "");
    if (header !== body.projectId) return reply(401, { code: "unauthorized" });
    if (storage === "tcp_blocked") return reply(503, { code: "storage_gateway_unavailable" });
    if (bearer !== STORAGE_KEY) {
      return reply(401, { code: "unauthorized" }, { "x-ohmyhost-gateway-stage": "key_lookup" });
    }
    const blocked = reply(503, { code: "storage_gateway_unavailable" });
    if (url.pathname === "/v1/downloads") {
      if (body.objectKey === canary.ABSENT_OBJECT_KEY)
        return reply(404, { code: "object_not_found" });
      if (storage === "fetch_blocked") return blocked;
      return reply(200, { state: "ready", capability: capability("GET", body.objectKey, 40) });
    }
    if (storage === "fetch_blocked") return blocked;
    if (url.pathname === "/v1/uploads") {
      if (reserve === "malformed") return reply(200, { state: "ready" });
      if (reserve === "completed") return reply(200, { state: "completed", transfer_id: ULID });
      return reply(200, {
        state: "ready",
        transfer_id: ULID,
        capability: capability("PUT", body.objectKey, body.contentLength),
      });
    }
    if (url.pathname === "/v1/uploads/complete") {
      return reply(200, { state: "completed", transfer_id: ULID });
    }
    assert.equal(url.pathname, "/v1/deletions");
    if (previous === "missing") return reply(409, { code: "storage_gateway_conflict" });
    return reply(200, { state: "completed", deletion_id: ULID });
  };
}

function databaseBinding(calls, failing = null) {
  const result = { command: "SELECT", rows: [{ ok: 1 }], rowCount: 1 };
  const guard = (name) => {
    calls.push(name);
    if (failing === name) throw new Error("socket closed");
  };
  return {
    async query() {
      guard("query");
      return result;
    },
    async transaction(queries) {
      guard("transaction");
      return queries.map(() => result);
    },
    async open() {
      guard("open");
      return {
        async query() {
          guard("held_query");
          return result;
        },
        async close() {
          guard("close");
        },
      };
    },
  };
}

async function loadWorker() {
  const runtime = (name) => join(root, "packages/customer-runtime/src", name);
  const bundle = await build({
    entryPoints: [join(fixture, "src/ohmyhost/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    alias: {
      "@ohmyhost/customer-runtime/database": runtime("database.ts"),
      "@ohmyhost/customer-runtime/mail": runtime("mail.ts"),
      "@ohmyhost/customer-runtime/storage": runtime("storage.ts"),
    },
  });
  const source = Buffer.from(bundle.outputFiles[0].text).toString("base64");
  return (await import(`data:text/javascript;base64,${source}`)).default;
}

/** Runs one scheduled invocation and returns everything it did. */
async function run(
  worker,
  { cron, scheduledTime = SCHEDULED_AT, environment = {}, model = chain(), failing },
) {
  const calls = [];
  const database = [];
  const lines = [];
  const retries = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const call = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.clone().text(),
    };
    calls.push(call);
    return model(request, call);
  };
  console.log = (...parts) => lines.push(parts.join(" "));
  console.error = console.log;
  let thrown = null;
  try {
    await worker.scheduled(
      { cron, scheduledTime, type: "scheduled", noRetry: () => retries.push(lines.length) },
      {
        ...FULL_ENVIRONMENT,
        OHMYHOST_DATABASE: databaseBinding(database, failing),
        ...environment,
      },
      {},
    );
  } catch (error) {
    thrown = error;
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  }
  const report = lines.length === 0 ? null : JSON.parse(lines.at(-1));
  return {
    calls,
    database,
    lines,
    retries,
    thrown,
    report,
    subrequests: calls.length + database.length,
  };
}

const paths = (calls) => calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);

/** Every red run calls noRetry once, throws, and logs one line that repeats no secret. */
function assertRed(result, verdict, redLeg) {
  assert.equal(
    result.thrown?.message.includes(verdict),
    true,
    `throws ${verdict}: ${result.thrown}`,
  );
  assert.equal(
    result.retries.length,
    1,
    "noRetry is called once, so a retry cannot resend the mail",
  );
  assert.equal(result.lines.length, 1, "one verdict line");
  assert.equal(result.report.event, "gateway_canary");
  assert.equal(result.report.verdict, verdict);
  if (redLeg !== undefined) assert.equal(result.report.legs[redLeg], verdict, redLeg);
  const output = `${result.lines.join("\n")}\n${result.thrown?.message}`;
  for (const secret of [
    MAIL_KEY,
    STORAGE_KEY,
    PROJECT,
    ENVIRONMENT,
    MAIL_URL,
    STORAGE_URL,
    "workers.dev",
  ]) {
    assert.equal(output.includes(secret), false, `the output repeats ${secret.slice(0, 12)}`);
  }
}

function assertGreen(result, tick, replayed = false) {
  assert.equal(result.thrown, null, String(result.thrown));
  assert.deepEqual(result.retries, []);
  assert.equal(result.lines.length, 1);
  assert.equal(result.report.verdict, "ok");
  assert.equal(result.report.tick, tick);
  if (replayed) assert.ok(result.subrequests < canary.plannedSubrequests(tick));
  else {
    assert.equal(result.subrequests, canary.plannedSubrequests(tick), "spends exactly the plan");
    assert.equal(result.report.replayed, undefined, "a normal run probes every leg");
  }
  assert.ok(result.subrequests <= canary.SUBREQUEST_BUDGET);
}

const CHEAP = { cron: canary.CHEAP_CRON };
const DEEP = { cron: canary.DEEP_CRON };
const identity = canary.tickIdentity(SCHEDULED_AT);

const TICK_ROWS = [
  [
    "cheap tick on a healthy chain is green and sends the forged claim and the impossible key",
    CHEAP,
    (result) => {
      assertGreen(result, "cheap");
      assert.equal(result.report.scheduledAt, "2026-10-23T10:03:00.000Z");
      assert.deepEqual(paths(result.calls), ["POST /v1/send", "POST /v1/downloads", "GET /"]);
      const [mail, storage, control] = result.calls;
      assert.equal(mail.headers.authorization, `Bearer ${canary.IMPOSSIBLE_KEY}`);
      assert.equal(mail.headers["idempotency-key"], identity.probeKey);
      assert.equal(storage.headers.authorization, `Bearer ${STORAGE_KEY}`);
      assert.equal(storage.headers["x-ohmyhost-egress-project-id"], canary.FORGED_PROJECT_ID);
      assert.deepEqual(JSON.parse(storage.body), {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        objectKey: canary.ABSENT_OBJECT_KEY,
      });
      assert.equal(new URL(control.url).origin, new URL(canary.UNLISTED_ORIGIN).origin);
      assert.deepEqual(result.database, ["query", "transaction", "open", "held_query", "close"]);
    },
  ],
  [
    "deep tick on a healthy chain is green, erases the previous hour and repeats its keys on a retry",
    DEEP,
    async (result, worker) => {
      assertGreen(result, "deep");
      assert.deepEqual(paths(result.calls), [
        "POST /v1/downloads",
        "POST /v1/uploads",
        "PUT /canary",
        "POST /v1/uploads/complete",
        "POST /v1/downloads",
        "GET /canary",
        "POST /v1/deletions",
        "POST /v1/send",
      ]);
      const [unauthorized, reserve, put, , readable, get, erase, send] = result.calls;
      assert.equal(
        put.headers["content-type"],
        "text/plain",
        "the PUT carries its required headers",
      );
      assert.equal(get.headers["x-signed-read"], "1", "the GET carries its required headers");
      assert.equal(unauthorized.headers.authorization, `Bearer ${canary.IMPOSSIBLE_KEY}`);
      assert.equal(JSON.parse(reserve.body).objectKey, identity.objectKey);
      assert.equal(reserve.headers["idempotency-key"], identity.uploadKey);
      assert.equal(JSON.parse(readable.body).objectKey, identity.objectKey);
      assert.equal(JSON.parse(erase.body).objectKey, identity.previous.objectKey);
      assert.equal(erase.headers["idempotency-key"], identity.previous.deleteKey);
      assert.equal(send.headers["idempotency-key"], identity.mailKey);
      assert.equal(JSON.parse(send.body).to, RECIPIENT);
      const again = await run(worker, DEEP);
      assert.deepEqual(
        again.calls.map(({ headers, body }) => [headers["idempotency-key"], body]),
        result.calls.map(({ headers, body }) => [headers["idempotency-key"], body]),
      );
    },
  ],
  [
    "deep tick tolerates the first run having nothing to erase and a replayed reservation",
    { ...DEEP, model: chain({ previous: "missing", reserve: "completed" }) },
    (result) => {
      assertGreen(result, "deep", true);
      assert.deepEqual(
        result.report.replayed,
        ["storage_put", "storage_complete"],
        "a leg that was not probed says so in the log",
      );
      assert.deepEqual(paths(result.calls), [
        "POST /v1/downloads",
        "POST /v1/uploads",
        "POST /v1/downloads",
        "GET /canary",
        "POST /v1/deletions",
        "POST /v1/send",
      ]);
    },
  ],
  [
    "a relay that keeps the forged claim turns the cheap tick red",
    { ...CHEAP, model: chain({ stamp: false }) },
    (result) => {
      assertRed(result, "relay_misconfigured", "storage_absent_object");
      assert.equal(result.report.legs.mail_unauthorized, "ok");
    },
  ],
  [
    "before the trains the old egress reads relay_misconfigured on storage and ok everywhere else",
    { ...CHEAP, model: chain({ storage: "unserved" }) },
    async (result, worker) => {
      assertRed(result, "relay_misconfigured", "storage_absent_object");
      assert.deepEqual(result.report.legs, {
        mail_unauthorized: "ok",
        storage_absent_object: "relay_misconfigured",
        egress_control: "ok",
        database_query: "ok",
        database_transaction: "ok",
        database_connection: "ok",
      });
      const deep = await run(worker, { ...DEEP, model: chain({ storage: "unserved" }) });
      assertRed(deep, "relay_misconfigured", "storage_unauthorized");
      assert.deepEqual(
        deep.report.legs,
        {
          storage_unauthorized: "relay_misconfigured",
          storage_reserve: "relay_misconfigured",
          storage_delete: "relay_misconfigured",
          mail_send: "ok",
        },
        "no signed leg runs; gateway_io_blocked needs a gateway that answers its own JSON 503",
      );
    },
  ],
  [
    "a relay refusal with an outcome header turns every storage leg red",
    { ...DEEP, model: chain({ outcome: "origin_unbound" }) },
    (result) => {
      assertRed(result, "relay_misconfigured", "storage_unauthorized");
      assert.equal(result.report.legs.mail_send, "ok");
      assert.equal(result.report.red[0].outcome, "origin_unbound");
      assert.equal(result.report.legs.storage_delete, "relay_misconfigured");
      assert.deepEqual(
        paths(result.calls),
        ["POST /v1/downloads", "POST /v1/uploads", "POST /v1/deletions", "POST /v1/send"],
        "the legs that need the reservation are skipped; the erase and the mail send are independent",
      );
    },
  ],
  [
    "recurrence, TCP blocked only: both gateways answer 503 and the cheap tick is red",
    { ...CHEAP, model: chain({ storage: "tcp_blocked", mail: "tcp_blocked" }) },
    (result) => {
      assertRed(result, "gateway_io_blocked");
      assert.equal(result.report.legs.mail_unauthorized, "gateway_io_blocked");
      assert.equal(result.report.legs.storage_absent_object, "gateway_io_blocked");
      assert.equal(result.report.legs.egress_control, "ok");
      assert.equal(result.subrequests, canary.plannedSubrequests("cheap"));
    },
  ],
  [
    "recurrence, fetch blocked only: the cheap tick cannot see it",
    { ...CHEAP, model: chain({ storage: "fetch_blocked", mail: "fetch_blocked" }) },
    (result) => assertGreen(result, "cheap"),
  ],
  [
    "recurrence, fetch blocked only: the deep tick is red at the first provider call",
    { ...DEEP, model: chain({ storage: "fetch_blocked", mail: "fetch_blocked" }) },
    (result) => {
      assertRed(result, "gateway_io_blocked", "storage_reserve");
      assert.equal(result.report.legs.storage_unauthorized, "ok");
      assert.equal(result.report.legs.storage_delete, "gateway_io_blocked");
      assert.equal(result.report.legs.mail_send, "gateway_io_blocked");
      assert.deepEqual(paths(result.calls), [
        "POST /v1/downloads",
        "POST /v1/uploads",
        "POST /v1/deletions",
        "POST /v1/send",
      ]);
    },
  ],
  [
    "an unlisted origin that is answered turns the cheap tick red",
    { ...CHEAP, model: chain({ control: "open" }) },
    (result) => assertRed(result, "policy_not_enforced", "egress_control"),
  ],
  [
    "an unlisted origin whose fetch throws means no egress policy is attached",
    { ...CHEAP, model: chain({ control: "rejects" }) },
    (result) => assertRed(result, "policy_not_enforced", "egress_control"),
  ],
  [
    "an egress that fails closed is a relay fault",
    { ...CHEAP, model: chain({ control: "unavailable" }) },
    (result) => assertRed(result, "relay_misconfigured", "egress_control"),
  ],
  [
    "a failing database leg is red and the next legs still run",
    { ...CHEAP, failing: "query" },
    (result) => {
      assertRed(result, "database_unavailable", "database_query");
      assert.equal(result.report.legs.database_transaction, "ok");
      assert.equal(result.report.legs.database_connection, "ok");
      assert.equal(result.report.red[0].failure, "database_unavailable");
    },
  ],
  [
    "a missing database binding is the canary's own fault",
    { ...CHEAP, environment: { OHMYHOST_DATABASE: undefined } },
    (result) => assertRed(result, "canary_misconfigured", "database_query"),
  ],
  [
    "an egress that refuses the R2 origin turns the deep tick red and completes nothing",
    { ...DEEP, model: chain({ r2: "denied" }) },
    (result) => {
      assertRed(result, "relay_misconfigured", "storage_put");
      assert.equal(
        result.report.legs.storage_complete,
        undefined,
        "no completion after a failed PUT",
      );
      assert.equal(result.report.legs.storage_read, undefined);
      assert.equal(result.report.legs.storage_delete, "ok");
      assert.equal(result.report.legs.mail_send, "ok");
      assert.deepEqual(paths(result.calls), [
        "POST /v1/downloads",
        "POST /v1/uploads",
        "PUT /canary",
        "POST /v1/deletions",
        "POST /v1/send",
      ]);
    },
  ],
  [
    "the documented client refuses a malformed reserve answer and nothing is uploaded",
    { ...DEEP, model: chain({ reserve: "malformed" }) },
    (result) => {
      assertRed(result, "relay_misconfigured", "storage_reserve");
      assert.equal(paths(result.calls).includes("PUT /canary"), false);
      assert.equal(result.report.legs.mail_send, "ok");
    },
  ],
  [
    "an incomplete configuration sends nothing and names only the variables",
    { ...CHEAP, environment: { OHMYHOST_STORAGE_KEY: undefined, OHMYHOST_MAIL_KEY: "short" } },
    (result) => {
      assertRed(result, "canary_misconfigured");
      assert.deepEqual(result.report.missing, ["OHMYHOST_MAIL_KEY", "OHMYHOST_STORAGE_KEY"]);
      assert.equal(result.subrequests, 0);
    },
  ],
  [
    "an undeclared cron or an invalid scheduled time sends nothing",
    { cron: "* * * * *" },
    async (result, worker) => {
      assertRed(result, "canary_misconfigured");
      assert.equal(result.subrequests, 0);
      const invalid = await run(worker, { ...CHEAP, scheduledTime: Number.NaN });
      assertRed(invalid, "canary_misconfigured");
      assert.equal(invalid.subrequests, 0);
    },
  ],
  [
    "the health route answers without touching mail, storage or the database",
    null,
    async (_result, worker) => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = () => assert.fail("the health route must not call the network");
      try {
        const answer = (path) => worker.fetch(new Request(`https://canary.example${path}`), {});
        assert.equal((await answer(canary.HEALTH_PATH)).status, 200);
        assert.equal((await answer("/")).status, 200, "the default healthcheck path answers too");
        assert.equal((await answer("/other")).status, 404);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  ],
];

// ---------------------------------------------------------------------------------------------
// Table 4: properties of the files themselves.
// ---------------------------------------------------------------------------------------------
async function fixtureFiles() {
  const entries = await readdir(fixture, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(fixture, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split("/").includes("node_modules") && !path.endsWith(".DS_Store"))
    .sort();
}

/** The storage client's logical object key grammar (packages/customer-runtime/src/storage.ts). */
function validObjectKey(key) {
  return (
    new TextEncoder().encode(key).byteLength <= 512 &&
    key.split("/").every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(part))
  );
}

function entropy(text) {
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values())
    bits -= (count / text.length) * Math.log2(count / text.length);
  return bits;
}

const PROPERTY_ROWS = [
  [
    "each tick plans at most eight subrequests, two below the customer limit of ten",
    async () => {
      for (const tick of ["cheap", "deep"]) {
        const plan = canary.TICK_PLANS[tick];
        assert.ok(canary.plannedSubrequests(tick) <= 8, tick);
        assert.equal(new Set(plan.map(({ leg: name }) => name)).size, plan.length);
        assert.ok(
          plan.every(({ subrequests }) => Number.isInteger(subrequests) && subrequests >= 1),
        );
      }
      assert.equal(canary.SUBREQUEST_BUDGET, 8);
      assert.deepEqual(
        canary.TICK_PLANS.cheap.map(({ subrequests }) => subrequests),
        [1, 1, 1, 1, 1, 3],
      );
    },
  ],
  [
    "the impossible key is a valid key shape with low entropy, so no secret scan flags it",
    async () => {
      assert.match(canary.IMPOSSIBLE_KEY, /^[A-Za-z0-9_-]{43}$/u);
      assert.ok(entropy(canary.IMPOSSIBLE_KEY) < 2, "gitleaks reports generic keys from 3.5 bits");
      assert.notEqual(canary.IMPOSSIBLE_KEY, MAIL_KEY);
      assert.match(canary.FORGED_PROJECT_ID, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
      assert.equal(new URL(canary.UNLISTED_ORIGIN).origin, canary.UNLISTED_ORIGIN);
      assert.ok(validObjectKey(canary.ABSENT_OBJECT_KEY));
    },
  ],
  [
    "the tick identity is deterministic, valid for the gateways and erases the previous hour",
    async () => {
      assert.equal(identity.stamp, "20261023T100300000Z");
      assert.deepEqual(canary.tickIdentity(SCHEDULED_AT), identity);
      assert.equal(identity.previous.stamp, canary.tickIdentity(SCHEDULED_AT - HOUR).stamp);
      assert.notEqual(identity.objectKey, identity.previous.objectKey);
      assert.notEqual(canary.tickIdentity(SCHEDULED_AT + HOUR).objectKey, identity.objectKey);
      assert.equal(canary.tickIdentity(SCHEDULED_AT + HOUR).previous.objectKey, identity.objectKey);
      for (const key of [
        identity.probeKey,
        identity.uploadKey,
        identity.mailKey,
        identity.previous.deleteKey,
      ]) {
        assert.match(key, /^[A-Za-z0-9._:-]{1,128}$/u);
      }
      for (const key of [identity.objectKey, identity.previous.objectKey]) {
        assert.ok(validObjectKey(key), key);
      }
      for (const bad of [Number.NaN, 0.5, -1, 1000, 8.64e15, Infinity, "1"]) {
        assert.equal(canary.tickIdentity(bad), null, String(bad));
      }
      assert.equal(canary.tickForCron(canary.CHEAP_CRON), "cheap");
      assert.equal(canary.tickForCron(canary.DEEP_CRON), "deep");
      assert.equal(canary.tickForCron("* * * * *"), null);
    },
  ],
  [
    "ohmyhost.yaml declares the functions project the code expects",
    async () => {
      const config = parseOhmyhostConfigYaml(
        await readFile(join(fixture, "ohmyhost.yaml"), "utf8"),
      );
      assert.equal(config.runtime.mode, "functions");
      assert.equal(config.runtime.healthcheck, canary.HEALTH_PATH);
      assert.deepEqual(config.runtime.egress.allow, [], "gateway origins are never listed");
      assert.deepEqual(
        [...config.functions.crons].sort(),
        [canary.CHEAP_CRON, canary.DEEP_CRON].sort(),
      );
      assert.equal(config.database.enabled, true);
      assert.equal(config.mail.enabled, true);
      // eu: the region of the project created for the canary, which storage.jurisdiction must
      // equal, and the only R2 data-plane host with recorded use (r2Endpoint in the provider).
      assert.deepEqual(
        { ...config.storage },
        { provider: "r2", jurisdiction: "eu", public: false },
      );
      assert.equal(config.build.install, "pnpm install --frozen-lockfile --ignore-scripts");
    },
  ],
  [
    "package.json and the lockfile pin the published runtime alias and nothing else",
    async () => {
      const manifest = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
      assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
      assert.deepEqual(Object.keys(manifest.dependencies), ["@ohmyhost/customer-runtime"]);
      assert.match(
        manifest.dependencies["@ohmyhost/customer-runtime"],
        /^npm:@amerged\/ohmyhost-runtime@\d+\.\d+\.\d+$/u,
      );
      assert.equal(manifest.devDependencies, undefined);
      const lock = await readFile(join(fixture, "pnpm-lock.yaml"), "utf8");
      assert.ok(lock.includes(manifest.dependencies["@ohmyhost/customer-runtime"]));
      assert.ok(lock.includes("integrity: sha512-"));
    },
  ],
  [
    "the platform's own planner and source rules accept the fixture",
    async () => {
      const files = await fixtureFiles();
      assert.deepEqual(files, [
        "ohmyhost.yaml",
        "package.json",
        "pnpm-lock.yaml",
        "postgres/migrations/20261023000000_gateway_canary_ping.sql",
        "src/ohmyhost/worker.ts",
        "src/verdict.ts",
      ]);
      const manifest = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
      const repositoryConfig = parseOhmyhostConfigYaml(
        await readFile(join(fixture, "ohmyhost.yaml"), "utf8"),
      );
      const adapter = createFunctionsFrameworkAdapter({ loadPackageJson: async () => manifest });
      const application = { root: repositoryConfig.applicationRoot, files };
      const plan = await adapter.plan({
        repositoryConfig,
        repositoryConfigEvidence: {
          scope: "repository",
          path: "ohmyhost.yaml",
          reason: "authoritative repository configuration",
        },
        application,
        detection: await adapter.detect(application),
      });
      assert.equal(plan.adapter, "functions");
      assert.equal(plan.installCommand, "pnpm install --frozen-lockfile --ignore-scripts");
      assert.deepEqual(plan.functions.crons, repositoryConfig.functions.crons);
      assert.deepEqual(plan.database, { enabled: true, migrations: "postgres/migrations" });
      assert.equal(plan.mail.enabled, true);
      assert.equal(plan.storage.enabled, true);

      const worker = await readFile(join(fixture, "src/ohmyhost/worker.ts"), "utf8");
      assert.deepEqual(
        workerModuleFindings({
          path: "src/ohmyhost/worker.ts",
          source: worker,
          fetch: true,
          scheduled: true,
        }),
        [],
      );
      for (const path of files.filter((name) => name.endsWith(".ts"))) {
        const source = await readFile(join(fixture, path), "utf8");
        assert.deepEqual(databaseContractCodes(source), [], path);
        assert.equal(
          /\bOHMYHOST_(?:MAIL|STORAGE)_GATEWAY\b/u.test(source),
          false,
          `${path} uses a legacy binding`,
        );
      }
      const migration = await readFile(
        join(fixture, "postgres/migrations/20261023000000_gateway_canary_ping.sql"),
      );
      assert.equal(
        admitExpandOnlyMigrations([
          { path: "20261023000000_gateway_canary_ping.sql", body: migration },
        ]).statementCount,
        1,
      );
    },
  ],
];

test("the gateway canary classifies every failure, stays inside its budget and fails loudly", async (t) => {
  for (const [name, legName, observation, verdict, accepted] of LEG_ROWS) {
    await t.test(`leg: ${name}`, () => {
      assert.equal(canary.classifyGatewayLeg(legName, observation, accepted), verdict);
    });
  }
  for (const [name, failure, verdict] of DATABASE_ROWS) {
    await t.test(`database: ${name}`, () => {
      assert.equal(canary.classifyDatabaseLeg(failure), verdict);
    });
  }
  assert.deepEqual(
    new Set([...LEG_ROWS.map((row) => row[3]), ...DATABASE_ROWS.map((row) => row[2])]),
    new Set(canary.VERDICTS),
    "the tables exercise all six verdicts",
  );
  assert.deepEqual(
    [
      canary.errorCode({ code: "40001" }),
      canary.errorCode(new Error("x")),
      canary.errorCode(null),
      canary.errorCode({ code: "a b" }),
    ],
    ["40001", "unknown", "unknown", "unrecognized"],
  );
  for (const [name, tick, legs, verdict] of SUMMARY_ROWS) {
    await t.test(`summary: ${name}`, () => {
      assert.equal(canary.summarize(tick, legs), verdict);
    });
  }
  for (const [name, digest, expected] of DESCRIBE_ROWS) {
    await t.test(`describe: ${name}`, () => {
      const base = { egressOutcome: null, stage: null };
      assert.deepEqual(
        { ...canary.describeResponse({ ...base, ...digest }) },
        {
          kind: "response",
          status: digest.status,
          contentType:
            digest.contentType === null
              ? null
              : digest.contentType.split(";")[0].trim().toLowerCase(),
          code: null,
          egressOutcome: null,
          stage: null,
          egressDenied: false,
          ...expected,
        },
      );
    });
  }
  for (const [name, patch, missing] of CONFIGURATION_ROWS) {
    await t.test(`configuration: ${name}`, () => {
      const result = canary.readConfiguration({ ...FULL_ENVIRONMENT, ...patch });
      if (missing.length === 0) {
        assert.equal(result.ok, true);
        assert.equal(result.configuration.storageKey, STORAGE_KEY);
        assert.equal(result.configuration.mailGatewayUrl, MAIL_URL);
      } else {
        assert.deepEqual({ ...result }, { ok: false, missing });
      }
    });
  }
  const worker = await loadWorker();
  for (const [name, options, check] of TICK_ROWS) {
    await t.test(`worker: ${name}`, async () => {
      await check(options === null ? null : await run(worker, options), worker);
    });
  }
  for (const [name, check] of PROPERTY_ROWS) {
    await t.test(`files: ${name}`, check);
  }
});
