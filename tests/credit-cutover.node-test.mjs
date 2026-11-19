import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  initUsageCursors,
  parseCreditArguments,
  usageCursorValues,
} from "../scripts/credit-cutover.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const accountId = "a".repeat(32);
const databaseId = "22222222-2222-4222-8222-222222222222";
const STOPPED = "2026-10-30T09:20:41.123Z";
const HOUR = "2026-10-30T09:00:00.000000Z";
const MIDNIGHT = "2026-10-30T00:00:00.000000Z";

/** The Cloudflare D1 API answering the fixed Core's lookup by name, exactly as the operator tests do. */
const provider =
  (environment) =>
  async ({ path }) => {
    const database = {
      uuid: databaseId,
      name: `ohmyho-control-core-${environment}`,
      jurisdiction: "eu",
      read_replication: { mode: "disabled" },
    };
    return { result: path.includes("?name=") ? [database] : database };
  };

/** A D1 binding over a real SQLite database: prepare/bind/all/run and an all-or-nothing batch. */
function d1(sqlite) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({
      results: sqlite
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })),
    }),
    run: async () => {
      sqlite.prepare(sql).run(...params);
      return { success: true };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const entry of statements) results.push(await entry.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function harness(context, environment = "development") {
  const root = await mkdtemp(join(tmpdir(), "omh-credit-cutover-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "source");
  const custody = join(root, "custody");
  await mkdir(join(repositoryRoot, "apps/control-store/src"), { recursive: true });
  await mkdir(custody, { mode: 0o700 });
  await chmod(custody, 0o700);
  await writeFile(
    join(repositoryRoot, "apps/control-store/wrangler.jsonc"),
    await readFile(join(SOURCE, "apps/control-store/wrangler.jsonc")),
  );
  await writeFile(
    join(repositoryRoot, "apps/control-store/src/worker-main.ts"),
    "export default {};\n",
  );
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE usage_cursor (source TEXT PRIMARY KEY, through TEXT NOT NULL) STRICT");
  const sessions = [];
  let clock = 0;
  const open = async (input) => {
    sessions.push({ upgrade: input.upgrade, environment: input.contract.environment });
    return { proof: {}, db: d1(sqlite), dispose: async () => sessions.push("disposed") };
  };
  const journal = (patch = {}) =>
    writeFile(
      join(custody, `control-core-cutover-${environment}.json`),
      `${JSON.stringify({
        schemaVersion: "omh.control-core-cutover/v1",
        environment,
        phase: "stopped",
        stop: { startedAt: "2026-10-30T09:20:06.000Z", stoppedAt: STOPPED },
        ...patch,
      })}\n`,
      { mode: 0o600 },
    );
  const run = (extra = {}) =>
    initUsageCursors(
      { accountId, environment, custody, repositoryRoot, ...extra },
      {
        request: provider(environment),
        inspect: async () => ({ repositoryRoot, sha: "b".repeat(40) }),
        inspectRelease: async ({ cwd }) => {
          assert.equal(cwd, repositoryRoot);
          return { repositoryRoot, sha: "b".repeat(40) };
        },
        verifyCommit: async ({ sha, existingOnly }) => {
          assert.equal(sha, "b".repeat(40));
          assert.equal(existingOnly, true);
        },
        open,
        // Every session names its own packet directory by the second, so each call is a later second.
        now: () => new Date(Date.parse("2026-10-30T09:30:00.000Z") + 1000 * (clock += 1)),
      },
    );
  const rows = () =>
    Object.fromEntries(
      sqlite
        .prepare("SELECT source, through FROM usage_cursor ORDER BY source")
        .all()
        .map(({ source, through }) => [source, through]),
    );
  return { custody, sqlite, sessions, journal, run, rows };
}

test("the cursors start at the stop hour for wfp and pgcf and at the stop day's midnight for r2 and resources", () => {
  assert.deepEqual(usageCursorValues(STOPPED), {
    wfp: HOUR,
    pgcf: HOUR,
    r2: MIDNIGHT,
    resources: MIDNIGHT,
  });
  // The floors are exact at the boundaries: the last millisecond of a day stays in it, the first of the next does not.
  assert.deepEqual(usageCursorValues("2026-10-30T23:59:59.999Z"), {
    wfp: "2026-10-30T23:00:00.000000Z",
    pgcf: "2026-10-30T23:00:00.000000Z",
    r2: MIDNIGHT,
    resources: MIDNIGHT,
  });
  assert.deepEqual(usageCursorValues("2026-10-31T00:00:00.000Z"), {
    wfp: "2026-10-31T00:00:00.000000Z",
    pgcf: "2026-10-31T00:00:00.000000Z",
    r2: "2026-10-31T00:00:00.000000Z",
    resources: "2026-10-31T00:00:00.000000Z",
  });
  assert.throws(() => usageCursorValues("later"), /CREDIT_STOP_TIME/u);
});

test("init-cursors inserts the four rows through the upgrade binding of the fixed Core, idempotently, and prints no identity", async (context) => {
  const h = await harness(context);
  await h.journal();
  const result = await h.run();
  assert.deepEqual(result, {
    environment: "development",
    stoppedAt: STOPPED,
    cursors: { wfp: HOUR, pgcf: HOUR, r2: MIDNIGHT, resources: MIDNIGHT },
    inserted: ["wfp", "pgcf", "r2", "resources"],
    unchanged: [],
  });
  assert.deepEqual(h.rows(), { pgcf: HOUR, r2: MIDNIGHT, resources: MIDNIGHT, wfp: HOUR });
  assert.deepEqual(h.sessions, [{ upgrade: true, environment: "development" }, "disposed"]);
  // Only metadata: neither the account, the database id nor a path is printed; the packet lives in the custody.
  const printed = JSON.stringify(result);
  assert.ok(!printed.includes(accountId) && !printed.includes(databaseId));
  assert.ok((await readdir(h.custody)).some((name) => name.endsWith("-packet")));

  // A repeat changes nothing; a partial state is completed.
  assert.deepEqual(
    { ...(await h.run()), cursors: undefined },
    {
      environment: "development",
      stoppedAt: STOPPED,
      cursors: undefined,
      inserted: [],
      unchanged: ["wfp", "pgcf", "r2", "resources"],
    },
  );
  h.sqlite.exec("DELETE FROM usage_cursor WHERE source IN ('pgcf', 'resources')");
  const completed = await h.run();
  assert.deepEqual(
    [completed.inserted, completed.unchanged],
    [
      ["pgcf", "resources"],
      ["wfp", "r2"],
    ],
  );
  assert.deepEqual(h.rows(), { pgcf: HOUR, r2: MIDNIGHT, resources: MIDNIGHT, wfp: HOUR });
});

test("init-cursors refuses a row with another value and writes nothing, so an advanced cursor is never rewound", async (context) => {
  const h = await harness(context);
  await h.journal();
  // The service advanced wfp by an hour: the command must not move it back, and must not fill the rest either.
  h.sqlite.exec("INSERT INTO usage_cursor VALUES ('wfp', '2026-10-30T10:00:00.000000Z')");
  await assert.rejects(h.run(), (error) => {
    assert.equal(error.message, "CREDIT_CURSOR_CONFLICT");
    assert.deepEqual(error.detail, ["wfp"]);
    return true;
  });
  assert.deepEqual(h.rows(), { wfp: "2026-10-30T10:00:00.000000Z" });
  assert.deepEqual(h.sessions.at(-1), "disposed");
  // A different form of the same instant is also a different value.
  h.sqlite.exec(
    "UPDATE usage_cursor SET through = '2026-10-30T09:00:00.000Z' WHERE source = 'wfp'",
  );
  await assert.rejects(h.run(), /CREDIT_CURSOR_CONFLICT/u);
});

test("init-cursors needs a finished stop of the same environment in the custody before it opens the Core", async (context) => {
  const h = await harness(context);
  await assert.rejects(h.run(), /CUTOVER_STOP_NOT_RECORDED/u);
  for (const patch of [
    { stop: { startedAt: STOPPED } },
    { stop: undefined, phase: "snapshotted" },
    { stop: { stoppedAt: "yesterday" } },
    { stop: { stoppedAt: "2026-10-30T09:20:41Z" } },
    { environment: "production" },
    { schemaVersion: "other" },
  ]) {
    await h.journal(patch);
    await assert.rejects(h.run(), /CUTOVER_STOP_NOT_RECORDED/u, JSON.stringify(patch));
  }
  await assert.rejects(h.run({ environment: "staging" }), /CUTOVER_ENVIRONMENT/u);
  // A custody directory that other users can read is refused like the cutover tool's.
  await chmod(h.custody, 0o755);
  await assert.rejects(h.run(), /CUTOVER_CUSTODY/u);
  assert.deepEqual(h.sessions, []);
  assert.deepEqual(h.rows(), {});
});

test("init-cursors takes the production stop and a Production Core, and the arguments are exact", async (context) => {
  const h = await harness(context, "production");
  await h.journal({ stop: { stoppedAt: "2026-11-02T00:00:00.000Z" } });
  const result = await h.run();
  assert.equal(result.environment, "production");
  assert.deepEqual(h.rows(), {
    pgcf: "2026-11-02T00:00:00.000000Z",
    r2: "2026-11-02T00:00:00.000000Z",
    resources: "2026-11-02T00:00:00.000000Z",
    wfp: "2026-11-02T00:00:00.000000Z",
  });
  assert.equal(h.sessions[0].environment, "production");

  assert.deepEqual(
    parseCreditArguments([
      "init-cursors",
      "--environment",
      "development",
      "--custody",
      "/private/c",
      "--confirm",
      "development",
    ]),
    { command: "init-cursors", environment: "development", custody: "/private/c" },
  );
  for (const bad of [
    [],
    ["init-cursors"],
    ["init-cursors", "--environment", "development", "--custody", "/private/c"],
    ["init-cursors", "--environment", "production", "--custody", "/c", "--confirm", "development"],
    ["init-cursors", "--environment", "staging", "--custody", "/c", "--confirm", "staging"],
    ["init-cursors", "--environment", "development", "--confirm", "development"],
    ["init-cursors", "--environment", "development", "--environment", "development"],
    ["migrate", "--environment", "development", "--custody", "/c", "--confirm", "development"],
  ])
    assert.throws(() => parseCreditArguments(bad), /usage/u, JSON.stringify(bad));
});
