/* global Response, URL */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cloudflareClient } from "../scripts/control-core-cutover.mjs";
import {
  aiGatewayRows,
  apiRows,
  coreRows,
  creditServiceRow,
  parseSmokeArguments,
} from "../scripts/control-core-smoke.mjs";
import { PRIVATE_WORKER_PROFILES } from "../scripts/release-private-worker.mjs";

const ACCOUNT = "a".repeat(32);
const QUALIFICATION = "ab".repeat(32);

// The activation tables of the Core plus the six credit tables. The credit tables carry no CHECK here so that the
// invariants themselves can be broken; migration 0600 adds `CHECK (… >= 0)` to the amounts.
const CORE_SCHEMA = `
  CREATE TABLE core_layout (singleton INTEGER PRIMARY KEY, layout TEXT, command_namespace_version INTEGER);
  CREATE TABLE core_authority_activation (singleton INTEGER PRIMARY KEY, activation_id TEXT, qualification_sha256 BLOB);
  CREATE TABLE core_historical_import (singleton INTEGER PRIMARY KEY, closed_at TEXT);
  CREATE TABLE command_log (name TEXT, digest TEXT);
  CREATE TABLE organizations (organization_id TEXT PRIMARY KEY);`;
const CREDIT_SCHEMA = `
  CREATE TABLE credit_account (organization_id TEXT PRIMARY KEY, monthly_micros INTEGER NOT NULL, onetime_micros INTEGER NOT NULL, reserved_micros INTEGER NOT NULL, overrun_micros INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE project_credit (project_id TEXT PRIMARY KEY);
  CREATE TABLE credit_reservation (reservation_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, amount_micros INTEGER NOT NULL);
  CREATE TABLE credit_grant (key TEXT PRIMARY KEY);
  CREATE TABLE usage_cursor (source TEXT PRIMARY KEY, through TEXT NOT NULL);
  CREATE TABLE credit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at TEXT NOT NULL);`;
// 30 October 2026, 10:30 UTC: the credit-service passed at 10:27, so wfp stands at 10:00 and pgcf (two hours of provider
// lag) at 08:00; the daily sources finished yesterday and stand at today's midnight.
const NOW = Date.parse("2026-10-30T10:30:00.000Z");
const at = (iso) => `${iso.slice(0, 19)}.000000Z`;
const CURSORS = {
  wfp: "2026-10-30T10:00:00",
  pgcf: "2026-10-30T08:00:00",
  r2: "2026-10-30T00:00:00",
  resources: "2026-10-30T00:00:00",
};

/** A Core with one qualified activation, two organizations with one account each and a current cursor for every source. */
function core({ credit = true, cursors = CURSORS } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(CORE_SCHEMA);
  db.exec(`
    INSERT INTO core_layout VALUES (1, 'shared-core-v1', 1);
    INSERT INTO core_authority_activation VALUES (1, 'activation-1', X'${QUALIFICATION}');
    INSERT INTO core_historical_import VALUES (1, '2026-10-30T00:00:00Z');
    INSERT INTO command_log VALUES ('control-d1.compare', '${QUALIFICATION}');
    INSERT INTO organizations VALUES ('org-1'), ('org-2');`);
  if (credit) {
    db.exec(CREDIT_SCHEMA);
    db.exec(`
      INSERT INTO credit_account VALUES ('org-1', 200000000, 5000000, 0, 0), ('org-2', 0, 0, 0, 0);
      INSERT INTO credit_log(key, at) VALUES ('grant:one', '${at("2026-10-30T09:00:00")}');`);
    for (const [source, through] of Object.entries(cursors))
      db.prepare("INSERT INTO usage_cursor VALUES (?, ?)").run(source, at(through));
  }
  return db;
}

/** The `query(statements)` reader of the D1 REST API, answered by a real SQLite database. */
const reader = (db) => async (statements) =>
  statements.map(({ sql, params }) =>
    db
      .prepare(sql)
      .all(...params)
      .map((entry) => ({ ...entry })),
  );
const failing = (rows) => rows.filter(({ status }) => status === "FAIL").map(({ check }) => check);

test("a healthy Core passes the authority checks and every credit invariant", async () => {
  const rows = await coreRows(reader(core()), "development", { now: NOW });
  assert.deepEqual(
    rows.map(({ status }) => status),
    rows.map(() => "PASS"),
  );
  assert.deepEqual(
    rows.map(({ check }) => check),
    [
      "readControlAuthority: provider d1",
      "core layout shared-core-v1",
      "core authority activation rows",
      "core historical import still open",
      "core activation = compare receipt",
      "credit tables exist",
      "credit accounts negative",
      "credit organizations without exactly one account",
      "credit accounts whose reserved amount differs from their reservations",
      "credit usage cursors for every source",
      "credit usage cursors current",
      "credit log rotated, nothing older than 2 days",
      "credit population",
    ],
  );
  assert.match(rows[0].detail, /development, activation activation-1, qualification abababababab/u);
  assert.equal(rows.at(-1).detail, "2 accounts, 0 open reservations, 1 log rows");
  assert.match(
    rows.at(-3).detail,
    /^wfp 0\.5 h, pgcf 2\.5 h, r2 10\.5 h, resources 10\.5 h behind \(limits /u,
  );
});

test("each credit invariant fails on exactly its own violation", async () => {
  const RESERVED = "credit accounts whose reserved amount differs from their reservations";
  for (const [statement, expected] of [
    [
      "DELETE FROM credit_account WHERE organization_id = 'org-2'",
      ["credit organizations without exactly one account"],
    ],
    [
      "INSERT INTO organizations VALUES ('org-3')",
      ["credit organizations without exactly one account"],
    ],
    [
      "UPDATE credit_account SET monthly_micros = -1 WHERE organization_id = 'org-1'",
      ["credit accounts negative"],
    ],
    [
      "UPDATE credit_account SET onetime_micros = -1 WHERE organization_id = 'org-1'",
      ["credit accounts negative"],
    ],
    [
      "UPDATE credit_account SET overrun_micros = -1 WHERE organization_id = 'org-1'",
      ["credit accounts negative"],
    ],
    // A negative reserved amount is negative and also differs from the (empty) reservations.
    [
      "UPDATE credit_account SET reserved_micros = -1 WHERE organization_id = 'org-2'",
      ["credit accounts negative", RESERVED],
    ],
    // Reserve adds to the account and inserts the reservation; either half alone is a violation.
    ["UPDATE credit_account SET reserved_micros = 5 WHERE organization_id = 'org-1'", [RESERVED]],
    ["INSERT INTO credit_reservation VALUES ('r-1', 'org-1', 5)", [RESERVED]],
    ["INSERT INTO credit_reservation VALUES ('r-9', 'org-9', 5)", [RESERVED]],
    ["DELETE FROM usage_cursor WHERE source = 'r2'", ["credit usage cursors for every source"]],
  ]) {
    const db = core();
    db.exec(statement);
    assert.deepEqual(
      failing(await coreRows(reader(db), "development", { now: NOW })),
      expected,
      statement,
    );
  }
  // Both halves of a reservation together, and a cursor beyond the four sources, are not violations.
  const healthy = core();
  healthy.exec(`
    INSERT INTO credit_reservation VALUES ('r-1', 'org-1', 3), ('r-2', 'org-1', 2);
    UPDATE credit_account SET reserved_micros = 5 WHERE organization_id = 'org-1';
    INSERT INTO usage_cursor VALUES ('other', 'a')`);
  assert.deepEqual(failing(await coreRows(reader(healthy), "development", { now: NOW })), []);
});

test("usage cursors warn when late and a missing one is named, never judged as late", async () => {
  const warned = async (cursors) => {
    const rows = await coreRows(reader(core({ cursors })), "development", { now: NOW });
    const current = rows.find(({ check }) => check === "credit usage cursors current");
    return { failing: failing(rows), status: current.status, detail: current.detail };
  };
  const behind = (source, ms) => ({
    ...CURSORS,
    [source]: new Date(NOW - ms).toISOString(),
  });
  const HOUR = 3_600_000;
  // Every limit is inclusive and a late cursor is only a WARN: the credit invariants stay green.
  for (const [source, ok, late] of [
    ["wfp", 3 * HOUR, 3 * HOUR + 60_000],
    // pgcf lags two hours by design and is billed at minutes 27 and 57: it stands 3 h 27 min behind just before a pass.
    ["pgcf", 4 * HOUR, 4 * HOUR + 60_000],
    ["r2", 48 * HOUR, 48 * HOUR + 60_000],
    ["resources", 48 * HOUR, 48 * HOUR + 60_000],
  ]) {
    const current = await warned(behind(source, ok));
    assert.deepEqual([current.status, current.failing], ["PASS", []], source);
    const stale = await warned(behind(source, late));
    assert.deepEqual([stale.status, stale.failing], ["WARN", []], source);
    assert.match(stale.detail, new RegExp(`^behind: ${source} \\d+\\.\\d h \\(limits `, "u"));
  }
  // The worst steady state of pgcf (3 h 27 min behind) must not warn; 3 h would have. One failed pass leaves it
  // 3 h 57 min behind until the retry at minute 57, which still passes; a second failed pass in a row warns.
  assert.equal((await warned(behind("pgcf", 3 * HOUR + 27 * 60_000))).status, "PASS");
  assert.equal((await warned(behind("pgcf", 3 * HOUR + 57 * 60_000))).status, "PASS");
  // An absent cursor is the FAIL row's verdict; the freshness row only names it and warns.
  const withoutWfp = { pgcf: CURSORS.pgcf, r2: CURSORS.r2, resources: CURSORS.resources };
  const absent = await warned(withoutWfp);
  assert.deepEqual(absent.failing, ["credit usage cursors for every source"]);
  assert.equal(absent.status, "WARN");
  assert.match(absent.detail, /^absent, not billed: wfp \(limits /u);
  // An unreadable value is named, not silently current.
  const garbled = await warned({ ...CURSORS, r2: "a" });
  assert.equal(garbled.status, "WARN");
  assert.match(garbled.detail, /^behind: r2 unreadable /u);
});

test("the credit log warns when a row survived more than one missed rotation", async () => {
  const rotation = async (statement) => {
    const db = core();
    if (statement) db.exec(statement);
    const rows = await coreRows(reader(db), "development", { now: NOW });
    assert.deepEqual(failing(rows), []);
    return rows.find(({ check }) => check.startsWith("credit log rotated"));
  };
  assert.deepEqual(await rotation(), {
    check: "credit log rotated, nothing older than 2 days",
    status: "PASS",
    detail: "0 rows older than 2 days",
  });
  // Yesterday's rows wait for the cursors of the next 00:00 rotation: 30 hours old is current, an empty log is clean.
  assert.equal(
    (
      await rotation(
        `INSERT INTO credit_log(key, at) VALUES ('usage:old', '${at("2026-10-29T04:00:00")}')`,
      )
    ).status,
    "PASS",
  );
  assert.equal((await rotation("DELETE FROM credit_log")).status, "PASS");
  const stuck = await rotation(`
    INSERT INTO credit_log(key, at) VALUES ('usage:a', '${at("2026-10-28T10:29:59")}'), ('usage:b', '${at("2026-10-27T23:00:00")}')`);
  assert.equal(stuck.status, "WARN");
  assert.equal(
    stuck.detail,
    "2 rows older than 2 days, oldest 2026-10-27: the 00:00 UTC rotation is not archiving",
  );
});

test("the authority row fails without a qualified activation, and an empty credit model only warns", async () => {
  const unactivated = core();
  unactivated.exec("DELETE FROM core_authority_activation");
  const rows = await coreRows(reader(unactivated), "development", { now: NOW });
  assert.equal(rows[0].check, "readControlAuthority: provider d1");
  assert.equal(rows[0].status, "FAIL");
  assert.match(rows[0].detail, /not activated/u);

  const empty = core();
  empty.exec("DELETE FROM organizations; DELETE FROM credit_account");
  const populated = await coreRows(reader(empty), "development", { now: NOW });
  assert.deepEqual(failing(populated), []);
  assert.equal(populated.at(-1).status, "WARN");
});

test("a Core without the credit tables fails their existence and skips the invariants without throwing", async () => {
  const rows = await coreRows(reader(core({ credit: false })), "development", { now: NOW });
  assert.deepEqual(failing(rows), ["credit tables exist"]);
  assert.equal(rows.find(({ check }) => check === "credit tables exist").detail, "0 (want 6)");
  assert.deepEqual(rows.at(-1), {
    check: "credit invariants",
    status: "SKIP",
    detail: "the credit tables are missing",
  });
  // Dropping a single table of the six is just as visible.
  const partial = core();
  partial.exec("DROP TABLE credit_grant");
  assert.deepEqual(failing(await coreRows(reader(partial), "development", { now: NOW })), [
    "credit tables exist",
  ]);
});

test("the credit-service crons are read from the provider and must be exactly the closed profile", async () => {
  const requests = [];
  const schedules = (crons) => async (url, init) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    return new Response(
      JSON.stringify({ success: true, result: { schedules: crons.map((cron) => ({ cron })) } }),
    );
  };
  const read = (crons, environment = "development") =>
    creditServiceRow({
      accountId: ACCOUNT,
      token: "fixture-token",
      environment,
      fetcher: schedules(crons),
    });
  // Order is the provider's business: the closed profile is a set.
  for (const crons of [
    ["0 0 * * *", "27,57 * * * *"],
    ["27,57 * * * *", "0 0 * * *"],
  ])
    assert.equal((await read(crons)).status, "PASS");
  // The retired minute-7 usage run is not declared any more.
  assert.equal((await read(["7 * * * *", "0 0 * * *"])).status, "FAIL");
  assert.equal(
    requests.at(-1),
    `GET /client/v4/accounts/${ACCOUNT}/workers/scripts/${PRIVATE_WORKER_PROFILES.development.credit_service.name}/schedules`,
  );
  for (const crons of [
    [],
    ["27,57 * * * *"],
    ["0 0 * * *"],
    ["27,57 * * * *", "0 0 * * *", "* * * * *"],
  ])
    assert.equal((await read(crons)).status, "FAIL", crons.join("|"));
  assert.equal((await read(["0 0 * * *", "27,57 * * * *"], "production")).status, "PASS");
  assert.ok(
    requests
      .at(-1)
      .endsWith(
        `/workers/scripts/${PRIVATE_WORKER_PROFILES.production.credit_service.name}/schedules`,
      ),
  );
});

test("the public API probe reads the credit usage report without a query and rejects the retired shape", async () => {
  const org = "01ORG00000000000000000000A";
  const project = "01PJ000000000000000000000A";
  const operation = "01OP00000000000000000000A";
  const requested = [];
  let usage = {
    organization_id: org,
    as_of: "2026-10-30T10:30:00.000Z",
    unit: "microcredits",
    period: "2026-10",
    from: "2026-10-17T00:00:00.000Z",
    projects: [],
    days: [],
  };
  const answers = {
    "/v1/me": { organizations: [{ id: org }], organization_ids: [org] },
    "/v1/projects?limit=5": { items: [{ id: project, organization_id: org }] },
    [`/v1/projects/${project}`]: { id: project },
    [`/v1/organizations/${org}/credits`]: { available_micros: "900" },
    [`/v1/projects/${project}/status`]: {
      project_id: project,
      latest_operation: { id: operation },
    },
    [`/v1/operations/${operation}`]: { id: operation },
  };
  const fetcher = async (url) => {
    const path = url.slice(url.indexOf("/v1/"));
    requested.push(path);
    const body =
      path.split("?")[0] === `/v1/organizations/${org}/credit-usage` ? usage : answers[path];
    return body === undefined
      ? Response.json({ code: "resource_not_found" }, { status: 404 })
      : Response.json(body);
  };
  const probe = async () =>
    (await apiRows({ origin: "https://api.example", token: "smoke-token", write: false, fetcher }))
      .filter(({ check }) => check === "api read credit usage")
      .map(({ status, detail }) => `${status} ${detail}`);
  assert.deepEqual(await probe(), ["PASS HTTP 200"]);
  assert.ok(requested.includes(`/v1/organizations/${org}/credit-usage`));
  assert.ok(!requested.some((path) => path.includes("month=")));
  // The report of the retired contract (`data` rows, no days) and a report of another organization both fail.
  usage = { data: [] };
  assert.deepEqual(await probe(), ["FAIL HTTP 200"]);
  usage = {
    ...usage,
    organization_id: "01ORG00000000000000000000B",
    days: [],
    projects: [],
    unit: "microcredits",
  };
  assert.deepEqual(await probe(), ["FAIL HTTP 200"]);
});

const AI_ACCOUNT_ID = "00000000000000000000000000000001";
const CLOUDFLARE_FIXTURE_TOKEN = "fixture-cloudflare-token";
const AI_KEY = `omh_ai_${"0".repeat(26)}_${"A".repeat(43)}`;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const AI_ENVIRONMENTS = {
  development: {
    name: "ohmyho-ai-gateway-poc-private-fullstack",
    host: "ai.dev.ohmyho.st",
    core: "ohmyho-control-store-poc-private-fullstack",
    auth: "2204",
    project: "2202",
  },
  production: {
    name: "ohmyho-ai-gateway-production",
    host: "ai.ohmyho.st",
    core: "ohmyho-control-store-production",
    auth: "2203",
    project: "2201",
  },
};
const AI_CHECKS = [
  "ai-gateway bindings as declared",
  "ai-gateway crons",
  "ai-gateway has no workers.dev",
  "ai-gateway custom domain",
  "ai-gateway route answers without a key",
  "ai-gateway reaches the Core",
];
const DENIED = {
  status: 401,
  body: { error: { message: "The API key is missing or not valid.", code: "invalid_api_key" } },
};
const UNAVAILABLE = {
  status: 503,
  body: { error: { message: "The AI gateway is unavailable right now.", code: "ai_unavailable" } },
};

/** A correct ai-gateway of one environment as the provider and the gateway answer it. A test breaks one fact in place. */
function aiLive(environment) {
  const target = AI_ENVIRONMENTS[environment];
  return {
    settings: {
      bindings: [
        {
          type: "service",
          name: "AI_RUNTIME",
          service: target.core,
          entrypoint: "AiGatewayRuntime",
        },
        { type: "secret_text", name: "ORQ_API_KEY" },
        {
          type: "ratelimit",
          name: "AUTH_LIMITER",
          namespace_id: target.auth,
          simple: { limit: 120, period: 60 },
        },
        {
          type: "ratelimit",
          name: "PROJECT_LIMITER",
          namespace_id: target.project,
          simple: { limit: 600, period: 60 },
        },
        { type: "plain_text", name: "ORQ_BASE_URL", text: "https://my.orq.ai/v3/router" },
        { type: "plain_text", name: "ORQ_ORIGIN", text: "https://my.orq.ai" },
      ],
    },
    crons: ["*/10 * * * *"],
    subdomain: { enabled: false, previews_enabled: false },
    domains: [{ hostname: target.host, service: target.name, environment: "production" }],
    probe: () => DENIED,
  };
}

/** The provider API and the gateway's public route, answered from `live`; every call is recorded for the read-only checks. */
function aiFetcher(environment, live, calls = []) {
  const target = AI_ENVIRONMENTS[environment];
  const scripts = `/client/v4/accounts/${AI_ACCOUNT_ID}/workers/scripts/${target.name}`;
  const reply = (result) =>
    result === undefined
      ? Response.json({ success: false, errors: [] }, { status: 404 })
      : Response.json({ success: true, result });
  return async (url, init = {}) => {
    const { hostname, pathname } = new URL(url);
    calls.push({ method: init.method ?? "GET", url, authorization: init.headers?.authorization });
    if (hostname === "api.cloudflare.com") {
      const answers = {
        [`${scripts}/settings`]: live.settings,
        [`${scripts}/schedules`]: live.crons && { schedules: live.crons.map((cron) => ({ cron })) },
        [`${scripts}/subdomain`]: live.subdomain,
        [`/client/v4/accounts/${AI_ACCOUNT_ID}/workers/domains`]: live.domains,
      };
      return reply(answers[pathname]);
    }
    if (hostname !== target.host || pathname !== "/v1/models") throw new Error("unexpected URL");
    const answer = live.probe(init.headers?.authorization);
    return Response.json(answer.body, { status: answer.status });
  };
}

const aiRows = (environment, fetcher, { token = CLOUDFLARE_FIXTURE_TOKEN } = {}) =>
  aiGatewayRows({ repositoryRoot, accountId: AI_ACCOUNT_ID, token, environment, fetcher });

test("a correct ai-gateway passes all six rows in both environments, with only GET requests", async () => {
  for (const environment of ["development", "production"]) {
    const calls = [];
    const rows = await aiRows(environment, aiFetcher(environment, aiLive(environment), calls));
    assert.deepEqual(
      rows.map(({ check, status }) => [check, status]),
      AI_CHECKS.map((check) => [check, "PASS"]),
      environment,
    );
    assert.ok(
      calls.every(({ method }) => method === "GET"),
      environment,
    );
    // The probe without a key goes first and carries no authorization; the second one carries the well-formed key.
    const probes = calls.filter(
      ({ url }) => new URL(url).hostname === AI_ENVIRONMENTS[environment].host,
    );
    assert.deepEqual(
      probes.map(({ authorization }) => authorization),
      [undefined, `Bearer ${AI_KEY}`],
    );
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(CLOUDFLARE_FIXTURE_TOKEN) && !text.includes(AI_KEY), environment);
  }
});

test("each ai-gateway defect fails exactly its own row, in both environments", async () => {
  const defects = [
    [
      "missing ORQ_API_KEY binding",
      "ai-gateway bindings as declared",
      (live) => {
        live.settings.bindings = live.settings.bindings.filter(
          ({ name }) => name !== "ORQ_API_KEY",
        );
      },
    ],
    [
      "AI_RUNTIME on another entrypoint",
      "ai-gateway bindings as declared",
      (live) => {
        live.settings.bindings[0].entrypoint = "Other";
      },
    ],
    [
      "PROJECT_LIMITER missing",
      "ai-gateway bindings as declared",
      (live) => {
        live.settings.bindings = live.settings.bindings.filter(
          ({ name }) => name !== "PROJECT_LIMITER",
        );
      },
    ],
    [
      "ORQ_ORIGIN changed",
      "ai-gateway bindings as declared",
      (live) => {
        live.settings.bindings[5].text = "https://evil.example";
      },
    ],
    [
      "wrong cron list",
      "ai-gateway crons",
      (live) => {
        live.crons = ["*/5 * * * *"];
      },
    ],
    [
      "workers.dev enabled",
      "ai-gateway has no workers.dev",
      (live) => {
        live.subdomain = { enabled: true, previews_enabled: false };
      },
    ],
    [
      "no custom-domain row",
      "ai-gateway custom domain",
      (live) => {
        live.domains = [];
      },
    ],
    [
      "custom domain bound to another Worker",
      "ai-gateway custom domain",
      (live) => {
        live.domains[0].service = "ohmyho-ai-gateway-other";
      },
    ],
    [
      "two custom-domain rows",
      "ai-gateway custom domain",
      (live) => {
        live.domains = [live.domains[0], { ...live.domains[0] }];
      },
    ],
    [
      "probe answers 200 without a key",
      "ai-gateway route answers without a key",
      (live) => {
        live.probe = (authorization) =>
          authorization === undefined
            ? { status: 200, body: { object: "list", data: [] } }
            : DENIED;
      },
    ],
    [
      "probe answers 503 without a key",
      "ai-gateway route answers without a key",
      (live) => {
        live.probe = (authorization) => (authorization === undefined ? UNAVAILABLE : DENIED);
      },
    ],
    [
      "probe answers 503 for the unknown key",
      "ai-gateway reaches the Core",
      (live) => {
        live.probe = (authorization) => (authorization === undefined ? DENIED : UNAVAILABLE);
      },
    ],
  ];
  for (const environment of ["development", "production"]) {
    for (const [defect, check, break_] of defects) {
      const live = aiLive(environment);
      break_(live);
      const calls = [];
      const rows = await aiRows(environment, aiFetcher(environment, live, calls));
      assert.equal(rows.length, AI_CHECKS.length, `${environment} ${defect}`);
      assert.deepEqual(
        rows.filter(({ status }) => status === "FAIL").map(({ check }) => check),
        [check],
        `${environment} ${defect}`,
      );
      assert.ok(
        calls.every(({ method }) => method === "GET"),
        defect,
      );
      assert.ok(!JSON.stringify(rows).includes(CLOUDFLARE_FIXTURE_TOKEN), defect);
    }
  }
});

test("an absent ai-gateway is one FAIL row, and an unreachable route fails its own row without a crash", async () => {
  const absent = aiLive("development");
  absent.settings = undefined;
  assert.deepEqual(await aiRows("development", aiFetcher("development", absent)), [
    { check: "ai-gateway exists", status: "FAIL", detail: "absent" },
  ]);

  const unreachable = aiLive("production");
  const answer = aiFetcher("production", unreachable);
  const rows = await aiRows("production", (url, init) =>
    new URL(url).hostname === "ai.ohmyho.st"
      ? Promise.reject(new TypeError("fetch failed"))
      : answer(url, init),
  );
  assert.deepEqual(
    rows.filter(({ status }) => status === "FAIL").map(({ check, detail }) => [check, detail]),
    [
      ["ai-gateway route answers without a key", "unreachable"],
      ["ai-gateway reaches the Core", "unreachable"],
    ],
  );
});

test("the probe reports only the status and the closed code, never the body or the key", async () => {
  const live = aiLive("development");
  live.probe = (authorization) =>
    authorization === undefined
      ? DENIED
      : { status: 401, body: { error: { code: "invalid_api_key", message: `echo ${AI_KEY}` } } };
  const rows = await aiRows("development", aiFetcher("development", live));
  assert.equal(rows.at(-1).status, "PASS");
  assert.equal(rows.at(-1).detail, "HTTP 401 invalid_api_key");
  assert.ok(!JSON.stringify(rows).includes(AI_KEY));
});

test("the provider client stays read-only: the two new GETs are allowed and any other path is refused before a request", async () => {
  const request = cloudflareClient({
    accountId: AI_ACCOUNT_ID,
    token: CLOUDFLARE_FIXTURE_TOKEN,
    fetcher: async () => {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(request("GET", "/workers/domains/x"), { message: "CUTOVER_API_SCOPE" });
});

test("the ai group is selectable, part of the default groups and rejects unknown groups", () => {
  assert.deepEqual(parseSmokeArguments(["--environment", "development", "--only", "ai"]).only, [
    "ai",
  ]);
  assert.ok(parseSmokeArguments(["--environment", "development"]).only.includes("ai"));
  assert.throws(
    () => parseSmokeArguments(["--environment", "development", "--only", "ai,nope"]),
    /^Error: usage: control-core-smoke/u,
  );
});
