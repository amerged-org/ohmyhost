#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPrivate, writeExclusive } from "./control-d1-artifacts.mjs";
import { restQuery } from "./control-d1-bulk.mjs";
import { observeFixedCore } from "./control-core-operator.mjs";
import { cloudflareClient, controlCoreWriters, runCutover } from "./control-core-cutover.mjs";
import { controlCoreCloudflareClient } from "./control-core-resource.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { privateWorkerDefinition } from "./release-private-worker.mjs";
import { parseJsonc } from "./platform-release.mjs";

/**
 * Runbook section 4 as one read-mostly operator command: Core authority and content (D1 REST API, read-only), the public
 * API with a real token, the Control Workers' logs and the Queue/cron state against the pre-stop snapshot. It prints one
 * pass/fail table and exits 1 on any FAIL. Credentials come from the process environment only and are never printed.
 */
const usage =
  "usage: control-core-smoke --environment development|production [--confirm production] [--only core,api,logs,queues,ai] [--custody <dir>] [--counts <file>] [--record <file>] [--minutes <n>] [--allow-write]";
const ORIGINS = { development: "https://dev.app.ohmyho.st", production: "https://app.ohmyho.st" };
const GROUPS = ["core", "api", "logs", "queues", "ai"];
const FORBIDDEN = "core_configuration|outcome_unknown";
const row = (check, status, detail = "") => ({ check, status, detail });
const verdict = (check, ok, detail) => row(check, ok ? "PASS" : "FAIL", detail);
const sql = (text, params = []) => ({ sql: text, params });
const codeOf = (e) => (/^[A-Z][A-Z0-9_]{2,}$/u.test(e?.message ?? "") ? e.message : "FAILED");

/** One fixed-width table plus a summary line. */
export function renderTable(rows) {
  const width = (key) => Math.max(key.length, ...rows.map((entry) => entry[key].length));
  const [a, b] = [width("check"), width("status")];
  const line = (x, y, z) => `${x.padEnd(a)}  ${y.padEnd(b)}  ${z}`.trimEnd();
  const n = (status) => rows.filter((entry) => entry.status === status).length;
  return [
    line("CHECK", "STATUS", "DETAIL"),
    ...rows.map((entry) => line(entry.check, entry.status, entry.detail)),
    `${n("PASS")} pass, ${n("FAIL")} fail, ${n("WARN")} warn, ${n("SKIP")} skipped`,
  ].join("\n");
}

/** Every Core check is one count, `[name, FROM ..., wanted n]`; invariants count violations (wanted 0). */
const LAYOUT = "core_layout WHERE layout = 'shared-core-v1' AND command_namespace_version = 1";
const RECEIPT =
  "core_authority_activation a JOIN command_log c ON c.name = 'control-d1.compare' AND c.digest = lower(hex(a.qualification_sha256))";
/** The six tables of the simple credit model: amounts, project periods, build reservations, grants, cursors, log. */
const CREDIT_TABLES = [
  "credit_account",
  "project_credit",
  "credit_reservation",
  "credit_grant",
  "usage_cursor",
  "credit_log",
];
const TABLES = `sqlite_master WHERE type = 'table' AND name IN (${CREDIT_TABLES.map((name) => `'${name}'`).join(", ")})`;
const NEGATIVE =
  "credit_account WHERE monthly_micros < 0 OR onetime_micros < 0 OR reserved_micros < 0 OR overrun_micros < 0";
const NOT_ONE_ACCOUNT =
  "organizations o WHERE (SELECT count(*) FROM credit_account a WHERE a.organization_id = o.organization_id) <> 1";
/** `reserved_micros` is the sum of the organization's open reservations: reserve adds to both, settle and release remove both. */
const RESERVED_DIFFERS = `(
  SELECT a.organization_id FROM credit_account a
    WHERE a.reserved_micros <> (SELECT COALESCE(SUM(r.amount_micros), 0) FROM credit_reservation r WHERE r.organization_id = a.organization_id)
  UNION
  SELECT r.organization_id FROM credit_reservation r
    WHERE NOT EXISTS (SELECT 1 FROM credit_account a WHERE a.organization_id = r.organization_id)
)`;
/** The operator inserts one cursor per usage source at cutover; the credit-service advances them. */
const SOURCES = ["wfp", "pgcf", "r2", "resources"];
const CURSORS = `usage_cursor WHERE source IN (${SOURCES.map((source) => `'${source}'`).join(", ")})`;
export const CORE_CHECKS = [
  ["core layout shared-core-v1", LAYOUT, 1],
  ["core authority activation rows", "core_authority_activation", 1],
  ["core historical import still open", "core_historical_import WHERE closed_at IS NULL", 0],
  ["core activation = compare receipt", RECEIPT, 1],
  ["credit tables exist", TABLES, CREDIT_TABLES.length],
];
export const CREDIT_CHECKS = [
  ["credit accounts negative", NEGATIVE, 0],
  ["credit organizations without exactly one account", NOT_ONE_ACCOUNT, 0],
  ["credit accounts whose reserved amount differs from their reservations", RESERVED_DIFFERS, 0],
  ["credit usage cursors for every source", CURSORS, SOURCES.length],
];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * How far behind `now` a cursor may be before the table warns. The credit-service passes at minutes 27 and 57 of every
 * hour, and the cursor of a source stands at the end of its last complete window, so the worst steady age is the one
 * just before the pass at :27. wfp waits 5 minutes after the hour (cursor at the hour, at most 1 h 27 min behind).
 * pgcf bills only hours the provider finalized 2 hours ago (`PGCF_LAG_MS`: the pass of clock hour h bills through
 * h-2:00, so the cursor is at most 3 h 27 min behind, and 3 h would warn every hour from :00 to :27). The provider needs
 * about 20 minutes after that mark to finalize every database (measured on 31 October 2026: the hour starting 09:00
 * was final between 12:00:04 and 12:18:04), which the pass at :27 clears and the pass at :57 repeats. r2 waits 1 h and
 * bills finished UTC days (at most 25 h 27 min behind), resources the same without the wait (at most 24 h 27 min).
 * One failed pass stays below every limit (wfp 1 h 57 min, pgcf 3 h 57 min, until the retry at :57). A second failed
 * pass in a row passes the 4 h of pgcf (4 h 27 min); wfp tolerates three failed passes in a row (2 h 57 min) and warns
 * at four. No limit changes, so pgcf stays at 4 h.
 */
export const CURSOR_MAX_AGE_MS = Object.freeze({
  wfp: 3 * HOUR_MS,
  pgcf: 4 * HOUR_MS,
  r2: 2 * DAY_MS,
  resources: 2 * DAY_MS,
});
/** The 00:00 UTC rotation archives every row before today; a row older than this survived more than one missed rotation. */
export const LOG_MAX_AGE_MS = 2 * DAY_MS;
const hours = (ms) => `${(ms / HOUR_MS).toFixed(1)} h`;

/**
 * WARN, never FAIL: a late cursor is an outage of the service that its own retry may already be repairing, and a cursor
 * that is absent is judged by the FAIL row above (the service never creates one; `credit-cutover init-cursors` does).
 */
function cursorRow(cursors, now) {
  const through = new Map(
    cursors.map((entry) => [entry.source, Date.parse(`${entry.through.slice(0, 23)}Z`)]),
  );
  const late = [];
  const absent = [];
  const age = [];
  for (const [source, limit] of Object.entries(CURSOR_MAX_AGE_MS)) {
    const at = through.get(source);
    if (at === undefined) absent.push(source);
    else if (!(now - at <= limit))
      late.push(`${source} ${Number.isNaN(at) ? "unreadable" : hours(now - at)}`);
    else age.push(`${source} ${hours(now - at)}`);
  }
  const limits = `limits ${Object.entries(CURSOR_MAX_AGE_MS)
    .map(([source, limit]) => `${source} ${hours(limit)}`)
    .join(", ")}`;
  const problems = [
    ...(late.length === 0 ? [] : [`behind: ${late.join(", ")}`]),
    ...(absent.length === 0 ? [] : [`absent, not billed: ${absent.join(", ")}`]),
  ];
  return row(
    "credit usage cursors current",
    problems.length === 0 ? "PASS" : "WARN",
    problems.length === 0
      ? `${age.join(", ")} behind (${limits})`
      : `${problems.join("; ")} (${limits})`,
  );
}

function rotationRow({ n, oldest }) {
  return row(
    "credit log rotated, nothing older than 2 days",
    n === 0 ? "PASS" : "WARN",
    n === 0
      ? "0 rows older than 2 days"
      : `${n} rows older than 2 days, oldest ${oldest.slice(0, 10)}: the 00:00 UTC rotation is not archiving`,
  );
}

/**
 * The Core authority and content, evaluated from outside over any `query(statements)` reader (the D1 REST API still
 * answers once the Core is activated): `readControlAuthority` is a private RPC, so its predicate (layout, one
 * activation, no open import) is read from the same tables. The credit invariants run only on a Core that has the
 * credit tables; `now` dates the cursor and rotation rows.
 */
export async function coreRows(query, environment, { now = Date.now() } = {}) {
  const answers = await query([
    ...CORE_CHECKS.map(([, from]) => sql(`SELECT count(*) n FROM ${from}`)),
    sql("SELECT activation_id, lower(hex(qualification_sha256)) q FROM core_authority_activation"),
  ]);
  const counts = CORE_CHECKS.map(([, , want], i) => [answers[i][0].n, want]);
  const [activation] = answers.at(-1);
  const authority = counts.slice(0, 3).every(([n, want]) => n === want);
  const who =
    authority &&
    `${environment}, activation ${activation.activation_id}, qualification ${activation.q.slice(0, 12)}`;
  const rows = [
    verdict(
      "readControlAuthority: provider d1",
      authority,
      who || "no closed qualified authority (not activated): Core RPCs answer core_configuration",
    ),
    ...CORE_CHECKS.map(([name], i) =>
      verdict(name, counts[i][0] === counts[i][1], `${counts[i][0]} (want ${counts[i][1]})`),
    ),
  ];
  const [tables, wanted] = counts.at(-1);
  if (tables !== wanted)
    return [...rows, row("credit invariants", "SKIP", "the credit tables are missing")];
  const population =
    "SELECT (SELECT count(*) FROM credit_account) a, (SELECT count(*) FROM credit_reservation) r, (SELECT count(*) FROM credit_log) l";
  // Stored timestamps are `YYYY-MM-DDTHH:MM:SS.ffffffZ`, so the cutoff compares as a string.
  const cutoff = `${new Date(now - LOG_MAX_AGE_MS).toISOString().slice(0, 23)}000Z`;
  const credit = await query([
    ...CREDIT_CHECKS.map(([, from]) => sql(`SELECT count(*) n FROM ${from}`)),
    sql(population),
    sql("SELECT source, through FROM usage_cursor"),
    sql("SELECT count(*) n, min(at) oldest FROM credit_log WHERE at < ?", [cutoff]),
  ]);
  const [{ a, r, l }] = credit.at(-3);
  return [
    ...rows,
    ...CREDIT_CHECKS.map(([name, , want], i) =>
      verdict(name, credit[i][0].n === want, `${credit[i][0].n} (want ${want})`),
    ),
    cursorRow(credit.at(-2), now),
    rotationRow(credit.at(-1)[0]),
    row(
      "credit population",
      a > 0 ? "PASS" : "WARN",
      `${a} accounts, ${r} open reservations, ${l} log rows${a > 0 ? "" : ": empty, the credit checks are vacuous"}`,
    ),
  ];
}

/** The identity the Core Worker is configured with, from the provider: what `readControlAuthority` reports. */
export async function workerRow({ accountId, token, environment, databaseId }) {
  const request = cloudflareClient({ accountId, token });
  const name = CONTROL_CORE_WORKER_PROFILES[environment];
  const path = `/workers/scripts/${name}`;
  const [{ result: settings }, { result: deployments }] = await Promise.all([
    request("GET", `${path}/settings`),
    request("GET", `${path}/deployments`),
  ]);
  const bound = (type, key) => settings.bindings.find((b) => b.name === key && b.type === type);
  const [live] = deployments.deployments?.[0]?.versions ?? [];
  const ok =
    bound("d1", "CONTROL_CORE")?.id === databaseId &&
    bound("plain_text", "CONTROL_CORE_DATABASE_ID")?.text === databaseId &&
    bound("plain_text", "CONTROL_PLATFORM_ENVIRONMENT")?.text === environment &&
    live?.percentage === 100;
  return verdict(
    "core worker bound to the fixed Core",
    ok,
    `${name} ${live?.version_id?.slice(0, 8)}`,
  );
}

/** The credit-service schedules from the provider: the usage passes at minutes 27 and 57 and the daily log rotation of the closed profile. */
export async function creditServiceRow({ accountId, token, environment, fetcher = fetch }) {
  const { name, crons } = privateWorkerDefinition({ environment, profile: "credit_service" });
  const request = cloudflareClient({ accountId, token, fetcher });
  const { result } = await request("GET", `/workers/scripts/${name}/schedules`);
  const live = (result?.schedules ?? []).map(({ cron }) => cron).sort();
  return verdict(
    "credit-service crons present",
    isDeepStrictEqual(live, crons),
    `${name}: ${live.join(" | ")}`,
  );
}

/** Exact per-table counts; `baseline` (`{table: rows}`, recorded right after activation) must equal them. */
export async function countRows(query, { baseline } = {}) {
  const [names] = await query([
    sql(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf*' ORDER BY name",
    ),
  ]);
  const counts = {};
  for (let from = 0; from < names.length; from += 50) {
    const slice = names.slice(from, from + 50);
    const answers = await query(slice.map(({ name }) => sql(`SELECT count(*) n FROM "${name}"`)));
    slice.forEach(({ name }, index) => (counts[name] = answers[index][0].n));
  }
  const shape = `${names.length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`;
  const check = "row counts equal import";
  if (baseline === undefined)
    return { counts, row: row(check, "SKIP", `${shape}; no --counts file`) };
  const all = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  const differ = [...all]
    .filter((t) => counts[t] !== baseline[t])
    .map((t) => `${t} ${baseline[t]}->${counts[t]}`);
  return {
    counts,
    row: verdict(
      check,
      differ.length === 0,
      differ.length === 0 ? shape : `${differ.length} differ: ${differ.slice(0, 5).join(", ")}`,
    ),
  };
}

/** Typed reads through the real public API, then one idempotent write (feedback: zero credits, no provider call) and its replay. */
export async function apiRows({ origin, token, write, fetcher = fetch }) {
  const rows = [];
  const call = async (method, path, body, key) => {
    const headers = { authorization: `Bearer ${token}`, "x-request-id": `smoke-${randomUUID()}` };
    if (body)
      Object.assign(headers, { "content-type": "application/json", "idempotency-key": key });
    const init = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const response = await fetcher(`${origin}${path}`, init);
    const json = await response.json().catch(() => null);
    return {
      ok: response.status === (body ? 201 : 200),
      json,
      note: `HTTP ${response.status} ${json?.code ?? ""}`.trim(),
    };
  };
  const probe = async (check, path, accept, body, key) => {
    const result = await call(body ? "POST" : "GET", path, body, key).catch(() => ({
      note: "unreachable",
    }));
    const ok = result.ok && accept(result.json);
    rows.push(verdict(`api ${check}`, ok, result.note));
    return ok ? result.json : null;
  };
  const me = await probe("read identity", "/v1/me", (j) => Array.isArray(j?.organizations));
  const page = await probe("list projects", "/v1/projects?limit=5", (j) => Array.isArray(j?.items));
  const project = page?.items[0];
  const org = project?.organization_id ?? me?.organization_ids[0];
  if (!project || !org)
    return [
      ...rows,
      row("api project, credit, operation, write probes", "SKIP", "no project in scope"),
    ];
  // The usage report takes no query: it is the last 14 UTC days (`days`) and the month so far per project (`projects`).
  const reads = [
    ["read project", `/v1/projects/${project.id}`, (j) => j?.id === project.id],
    ["read credits", `/v1/organizations/${org}/credits`, (j) => /^\d+$/u.test(j?.available_micros)],
    [
      "read credit usage",
      `/v1/organizations/${org}/credit-usage`,
      (j) =>
        j?.organization_id === org &&
        j.unit === "microcredits" &&
        Array.isArray(j.days) &&
        Array.isArray(j.projects),
    ],
  ];
  for (const [check, path, accept] of reads) await probe(check, path, accept);
  const status = await probe(
    "read project status",
    `/v1/projects/${project.id}/status`,
    (j) => j?.project_id === project.id,
  );
  const operation = status?.latest_operation?.id;
  if (operation)
    await probe("read operation", `/v1/operations/${operation}`, (j) => j?.id === operation);
  else rows.push(row("api read operation", "SKIP", "project has no operation"));
  if (!write)
    return [...rows, row("api idempotent write and replay", "SKIP", "pass --allow-write")];
  const key = `smoke-${randomUUID()}`;
  const report = {
    organization_id: org,
    kind: "issue",
    title: "[smoke] Control D1 verification",
    description: `Automated post-cutover smoke call ${key}; no action needed.`,
  };
  const stored = (j) => typeof j?.id === "string";
  const first = await probe("write feedback", "/v1/feedback", stored, report, key);
  const same = (j) => j?.id === first?.id;
  if (first) await probe("replay feedback, same key", "/v1/feedback", same, report, key);
  return rows;
}

/** Error and forbidden-code counts per Control Worker: two account-wide observability queries grouped by Worker. */
export async function logRows({ accountId, token, services, minutes, fetcher = fetch }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;
  const count = async (filters, needle) => {
    const to = Date.now();
    const parameters = { filters, calculations: [{ operator: "count" }] };
    parameters.groupBys = [{ type: "string", value: "$metadata.service" }];
    if (needle) parameters.needle = { value: needle, isRegex: true, matchCase: false };
    const body = { queryId: `smoke-${randomUUID()}`, view: "calculations", limit: 500, parameters };
    body.timeframe = { from: to - minutes * 60_000, to };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const init = { method: "POST", headers, body: JSON.stringify(body), redirect: "error" };
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const json = await response.json();
    if (!response.ok || json?.success !== true) throw new Error("TELEMETRY_REFUSED");
    return new Map(
      (json.result?.calculations?.[0]?.aggregates ?? []).map((a) => [a.groupKey, a.value]),
    );
  };
  const level = [{ key: "$metadata.level", operation: "eq", type: "string", value: "error" }];
  const [errors, forbidden] = [await count(level), await count([], FORBIDDEN)];
  const hits = (found) =>
    services
      .filter((s) => found.get(s) > 0)
      .map((s) => `${s.replace(/^ohmyho-?/u, "")} ${found.get(s)}`);
  const [bad, noisy] = [hits(forbidden), hits(errors)];
  const all = `${services.length} Workers`;
  return [
    verdict(
      `logs without ${FORBIDDEN.replace("|", " / ")}, ${minutes} min`,
      bad.length === 0,
      bad.join(", ") || all,
    ),
    row(
      `logs error events, ${minutes} min`,
      noisy.length === 0 ? "PASS" : "WARN",
      noisy.slice(0, 6).join(", ") || all,
    ),
  ];
}

/** The checked-in profile of the ai-gateway Worker of one environment: what the live Worker must declare. */
export async function aiGatewayProfile({ repositoryRoot, environment }) {
  const file = join(repositoryRoot, "apps/ai-gateway", `wrangler.${environment}.jsonc`);
  const config = parseJsonc((await readFile(file)).toString("utf8"));
  const domains = (config.routes ?? []).filter(({ custom_domain: custom }) => custom === true);
  const [ai] = (config.services ?? []).filter(({ binding }) => binding === "AI_RUNTIME");
  if (domains.length !== 1 || (config.routes ?? []).length !== 1 || ai === undefined)
    throw new Error("AI_GATEWAY_PROFILE");
  return {
    name: config.name,
    host: domains[0].pattern,
    crons: [...(config.triggers?.crons ?? [])].sort(),
    core: ai.service,
    entrypoint: ai.entrypoint,
    ratelimits: (config.ratelimits ?? []).map(({ name, namespace_id: namespace }) => ({
      name,
      namespace: String(namespace),
    })),
    vars: { ORQ_BASE_URL: config.vars?.ORQ_BASE_URL, ORQ_ORIGIN: config.vars?.ORQ_ORIGIN },
  };
}

/** A gateway answer as the probe reports it: the status and the closed error code (never the body or a key). */
async function gatewayAnswer(fetcher, url, headers) {
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const json = await response.json().catch(() => null);
    const code = json?.error?.code;
    return { status: response.status, code: /^[a-z_]{1,40}$/u.test(code ?? "") ? code : "none" };
  } catch {
    return undefined;
  }
}

/**
 * The ai-gateway Worker of one environment, read from the provider and probed on its public host: bindings, crons,
 * workers.dev, the single custom domain, then the route without a key and with a well-formed unknown key (both 401 when
 * the Worker and the Core are wired). Only GET requests; the Worker's secret and the key never appear in a row.
 */
export async function aiGatewayRows({
  repositoryRoot,
  accountId,
  token,
  environment,
  fetcher = fetch,
}) {
  const profile = await aiGatewayProfile({ repositoryRoot, environment });
  const request = cloudflareClient({ accountId, token, fetcher });
  const path = `/workers/scripts/${profile.name}`;
  let settings;
  try {
    ({ result: settings } = await request("GET", `${path}/settings`));
  } catch (error) {
    const detail = error.status === 404 ? "absent" : codeOf(error);
    return [row("ai-gateway exists", "FAIL", detail)];
  }
  const observe = async (check, run) => {
    try {
      return await run();
    } catch (error) {
      return row(check, "FAIL", codeOf(error));
    }
  };
  const bindings = settings?.bindings ?? [];
  const plain = (key) =>
    bindings.find(({ type, name }) => type === "plain_text" && name === key)?.text;
  const service = bindings.find(({ type, name }) => type === "service" && name === "AI_RUNTIME");
  const limit = (name, namespace) => {
    const live = bindings.find((entry) => entry.type === "ratelimit" && entry.name === name);
    return (
      live !== undefined &&
      (live.namespace_id === undefined || String(live.namespace_id) === namespace)
    );
  };
  const checks = [
    [
      "AI_RUNTIME",
      profile.core === CONTROL_CORE_WORKER_PROFILES[environment] &&
        service?.service === profile.core &&
        service?.entrypoint === profile.entrypoint,
    ],
    [
      "ORQ_API_KEY",
      bindings.some(({ type, name }) => type === "secret_text" && name === "ORQ_API_KEY"),
    ],
    ...profile.ratelimits.map(({ name, namespace }) => [name, limit(name, namespace)]),
    ["ORQ_BASE_URL", plain("ORQ_BASE_URL") === profile.vars.ORQ_BASE_URL],
    ["ORQ_ORIGIN", plain("ORQ_ORIGIN") === profile.vars.ORQ_ORIGIN],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const bound = row(
    "ai-gateway bindings as declared",
    missing.length === 0 ? "PASS" : "FAIL",
    missing.length === 0
      ? `${profile.name}: ${checks.map(([name]) => name).join(", ")}`
      : `not as declared: ${missing.join(", ")}`,
  );
  const scheduled = await observe("ai-gateway crons", async () => {
    const { result } = await request("GET", `${path}/schedules`);
    const live = (result?.schedules ?? []).map(({ cron }) => cron).sort();
    return verdict(
      "ai-gateway crons",
      isDeepStrictEqual(live, profile.crons),
      live.join(" | ") || "none",
    );
  });
  const dev = await observe("ai-gateway has no workers.dev", async () => {
    const { result } = await request("GET", `${path}/subdomain`);
    const off = result?.enabled === false && result?.previews_enabled === false;
    return verdict(
      "ai-gateway has no workers.dev",
      off,
      `enabled ${result?.enabled}, previews ${result?.previews_enabled}`,
    );
  });
  const domain = await observe("ai-gateway custom domain", async () => {
    const { result } = await request("GET", "/workers/domains", {
      query: { hostname: profile.host },
    });
    const found = Array.isArray(result) ? result : [];
    const ok =
      found.length === 1 &&
      found[0].service === profile.name &&
      found[0].hostname === profile.host &&
      found[0].environment === "production";
    return verdict(
      "ai-gateway custom domain",
      ok,
      `${profile.host}: ${found.length} row(s), want 1 for ${profile.name}`,
    );
  });
  const url = `https://${profile.host}/v1/models`;
  const denied = (answer) => answer?.status === 401 && answer.code === "invalid_api_key";
  const detail = (answer) =>
    answer === undefined ? "unreachable" : `HTTP ${answer.status} ${answer.code}`;
  const keyless = await gatewayAnswer(fetcher, url);
  const route = verdict("ai-gateway route answers without a key", denied(keyless), detail(keyless));
  const unknown = `Bearer omh_ai_${"0".repeat(26)}_${"A".repeat(43)}`;
  const core = await gatewayAnswer(fetcher, url, { authorization: unknown });
  const reached = verdict("ai-gateway reaches the Core", denied(core), detail(core));
  return [bound, scheduled, dev, domain, route, reached];
}

export function parseSmokeArguments(argv) {
  const names = ["environment", "confirm", "custody", "counts", "record-counts", "minutes", "only"];
  const spec = {
    ...Object.fromEntries(names.map((name) => [name, { type: "string" }])),
    "allow-write": { type: "boolean" },
  };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: spec, strict: true }));
  } catch {
    throw new Error(usage);
  }
  const options = {
    ...values,
    minutes: Number(values.minutes ?? 30),
    only: (values.only ?? GROUPS.join(",")).split(","),
  };
  const { environment, confirm, minutes, only } = options;
  const known = Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment) && minutes > 0;
  if (
    !known ||
    only.some((g) => !GROUPS.includes(g)) ||
    (environment === "production" && confirm !== "production")
  )
    throw new Error(usage);
  return { ...options, allowWrite: values["allow-write"] === true };
}

export async function runSmoke(options, deps = {}) {
  const { env = process.env, fetcher = fetch } = deps;
  const repositoryRoot = deps.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url));
  const { environment, only } = options;
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token } = env;
  const rows = [];
  // A group fails as one row, never as a crash, so the table always shows every other group.
  const group = async (name, run) => {
    try {
      rows.push(...[await run()].flat());
    } catch (error) {
      rows.push(row(name, "FAIL", codeOf(error)));
    }
  };
  if (only.includes("core")) {
    let core;
    await group("core fixed Core resource", async () => {
      core = await observeFixedCore(
        { accountId, environment },
        { request: controlCoreCloudflareClient({ token }) },
      );
      return row("core fixed Core resource", "PASS", `${core.databaseName}, ${core.jurisdiction}`);
    });
    if (core) {
      const { databaseId } = core;
      const query = restQuery({ accountId, databaseId });
      await group("core authority and credit", () => coreRows(query, environment));
      await group("core worker", () => workerRow({ accountId, token, environment, databaseId }));
      await group("credit-service", () =>
        creditServiceRow({ accountId, token, environment, fetcher }),
      );
      await group("core row counts", async () => {
        const read = async (path) =>
          JSON.parse((await readPrivate(resolve(path))).toString("utf8"));
        const counted = await countRows(query, {
          baseline: options.counts && (await read(options.counts)),
        });
        const record = options["record-counts"];
        if (record) await writeExclusive(resolve(record), `${JSON.stringify(counted.counts)}\n`);
        return counted.row;
      });
    }
  }
  if (only.includes("api")) {
    const origin = env.OHMYHOST_SMOKE_ORIGIN ?? ORIGINS[environment];
    const [smoke, write] = [
      env.OHMYHOST_SMOKE_TOKEN,
      environment === "development" || options.allowWrite,
    ];
    if (smoke === undefined) rows.push(row("api probes", "SKIP", "OHMYHOST_SMOKE_TOKEN not set"));
    else if (new URL(origin).protocol !== "https:")
      rows.push(row("api probes", "FAIL", "origin must be https"));
    else await group("api probes", () => apiRows({ origin, token: smoke, write, fetcher }));
  }
  if (only.includes("ai"))
    await group("ai-gateway", () =>
      aiGatewayRows({ repositoryRoot, accountId, token, environment, fetcher }),
    );
  if (only.includes("logs"))
    await group("logs", async () => {
      const { writers } = await controlCoreWriters({ repositoryRoot, environment });
      const services = [CONTROL_CORE_WORKER_PROFILES[environment], ...writers];
      return logRows({ accountId, token, services, minutes: options.minutes, fetcher });
    });
  // The cutover tool's own `status`: crons, Queue settings and the maintenance variable against the pre-stop snapshot.
  const queues = "queues and crons equal pre-stop snapshot";
  if (only.includes("queues") && options.custody === undefined)
    rows.push(row(queues, "SKIP", "pass --custody <dir> of the cutover journal"));
  else if (only.includes("queues"))
    await group(queues, async () => {
      const confirm = environment === "production" ? "production" : undefined;
      const status = await runCutover(
        { command: "status", environment, custody: options.custody, confirm },
        { env },
      );
      const on = Object.values(status.maintenance).includes("on");
      const detail = `phase ${status.phase}, ${status.diff.length} differences${on ? ", maintenance on" : ""}`;
      return verdict(queues, status.diff.length === 0 && !on, detail);
    });
  return rows;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseSmokeArguments(process.argv.slice(2));
    const rows = await runSmoke(options);
    console.log(`control-core-smoke ${options.environment}\n${renderTable(rows)}`);
    process.exitCode = rows.some(({ status }) => status === "FAIL") ? 1 : 0;
  } catch (error) {
    console.error(error.message === usage ? usage : `control-core-smoke ${codeOf(error)}`);
    process.exitCode = 2;
  }
}
