import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  migrateFixedCore,
  observeFixedCore,
  parseOperatorArguments,
} from "../scripts/control-core-operator.mjs";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const accountId = "a".repeat(32);
const databaseId = "22222222-2222-4222-8222-222222222222";
const database = (environment, extra = {}) => ({
  uuid: databaseId,
  name: `ohmyho-control-core-${environment}`,
  jurisdiction: "eu",
  read_replication: { mode: "disabled" },
  ...extra,
});
/** A provider that lists by name and answers the detail read; the listing may hold several rows. */
const provider =
  (rows) =>
  async ({ method, path }) => {
    assert.equal(method, "GET");
    if (path.includes("?name="))
      return { result: rows.filter(({ name }) => path.includes(`name=${name}&`)) };
    return { result: rows.find(({ uuid }) => path.endsWith(uuid)) };
  };

test("the operator names the fixed EU Core of an environment exactly and refuses anything else", async () => {
  for (const environment of ["development", "production"])
    assert.deepEqual(
      await observeFixedCore(
        { accountId, environment },
        { request: provider([database(environment)]) },
      ),
      {
        environment,
        databaseName: `ohmyho-control-core-${environment}`,
        databaseId,
        jurisdiction: "eu",
        readReplication: "disabled",
      },
    );
  const rows = (...extra) => provider([database("development"), ...extra]);
  await assert.rejects(
    observeFixedCore({ accountId, environment: "production" }, { request: rows() }),
    /does not exist/u,
  );
  for (const changed of [{ jurisdiction: "us" }, { read_replication: { mode: "auto" } }])
    await assert.rejects(
      observeFixedCore(
        { accountId, environment: "development" },
        { request: provider([database("development", changed)]) },
      ),
      /UNVERIFIED/u,
    );
  await assert.rejects(
    observeFixedCore(
      { accountId, environment: "development" },
      { request: rows(database("development", { uuid: "33333333-3333-4333-8333-333333333333" })) },
    ),
    /UNVERIFIED/u,
  );
  assert.deepEqual(parseOperatorArguments(["observe", "--environment", "production"]), {
    command: "observe",
    environment: "production",
    custody: undefined,
  });
  assert.deepEqual(
    parseOperatorArguments([
      "migrate",
      "--environment",
      "development",
      "--custody",
      "/private/c",
      "--confirm",
      "development",
    ]),
    { command: "migrate", environment: "development", custody: "/private/c" },
  );
  for (const bad of [
    [],
    ["observe"],
    ["observe", "--environment", "staging"],
    ["observe", "--environment", "production", "--confirm", "production"],
    ["migrate", "--environment", "production", "--custody", "/private/c"],
    [
      "migrate",
      "--environment",
      "production",
      "--custody",
      "/private/c",
      "--confirm",
      "development",
    ],
    ["migrate", "--environment", "production", "--confirm", "production"],
    ["destroy", "--environment", "development"],
  ])
    assert.throws(() => parseOperatorArguments(bad), /usage/u, JSON.stringify(bad));
});

test("migrating prepares a private packet for the observed fixed Core and reports only non-secret facts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omh-core-operator-"));
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
  const sourceCommit = "b".repeat(40);
  const inspect = async () => ({ repositoryRoot, sha: sourceCommit });
  const inspectRelease = async () => ({
    repositoryRoot,
    sha: sourceCommit,
    branch: "feat/feedback-mail",
  });
  const verifyCommit = async ({ sha, existingOnly }) => {
    assert.equal(sha, sourceCommit);
    assert.equal(existingOnly, true);
    return 1;
  };
  let opened;
  let disposed = false;
  const open = async (input) => {
    opened = input;
    return {
      proof: { sourceCommit, schemaSha256: "e".repeat(64), authorityActivation: "not-certified" },
      db: {
        prepare: () => ({
          all: async () => ({
            results: [
              { type: "table", n: 300 },
              { type: "trigger", n: 579 },
            ],
          }),
        }),
      },
      dispose: async () => {
        disposed = true;
      },
    };
  };
  const result = await migrateFixedCore(
    { accountId, environment: "development", custody, repositoryRoot },
    {
      request: provider([database("development")]),
      inspect,
      inspectRelease,
      verifyCommit,
      open,
      now: () => new Date("2026-10-29T10:00:00.000Z"),
    },
  );
  assert.deepEqual(result, {
    environment: "development",
    sourceCommit,
    schemaSha256: "e".repeat(64),
    authorityActivation: "not-certified",
    objects: { table: 300, trigger: 579 },
  });
  assert.ok(disposed);
  assert.equal(opened.contract.configuration.name, "ohmyho-control-store-poc-private-fullstack");
  assert.equal(
    opened.contract.configuration.d1_databases[0].database_name,
    "ohmyho-control-core-development",
  );
  assert.equal(opened.contract.configuration.d1_databases[0].database_id, databaseId);
  // The packet (which holds the resource id) lives in the private custody, not in the report.
  assert.deepEqual((await readdir(custody)).sort(), ["development-20261029T100000000Z-packet"]);
  assert.ok(!JSON.stringify(result).includes(databaseId));
  await assert.rejects(
    migrateFixedCore(
      { accountId, environment: "production", custody, repositoryRoot },
      { request: provider([database("development")]), inspect, inspectRelease, verifyCommit, open },
    ),
    /does not exist/u,
  );
  let touchedProvider = false;
  await assert.rejects(
    migrateFixedCore(
      { accountId, environment: "development", custody, repositoryRoot },
      {
        inspectRelease: async () => {
          throw new Error("branch is not pushed");
        },
        verifyCommit,
        request: async () => {
          touchedProvider = true;
        },
        inspect,
        open,
      },
    ),
    /branch is not pushed/u,
  );
  assert.equal(touchedProvider, false);
  await assert.rejects(
    migrateFixedCore(
      { accountId, environment: "development", custody, repositoryRoot },
      {
        inspectRelease,
        verifyCommit: async () => {
          throw new Error("CI not green");
        },
        request: async () => {
          touchedProvider = true;
        },
        inspect,
        open,
      },
    ),
    /CI not green/u,
  );
  assert.equal(touchedProvider, false);
  let inspections = 0;
  await assert.rejects(
    migrateFixedCore(
      { accountId, environment: "development", custody, repositoryRoot },
      {
        inspectRelease: async () => ({
          repositoryRoot,
          sha: ++inspections === 1 ? sourceCommit : "c".repeat(40),
          branch: "feat/feedback-mail",
        }),
        verifyCommit,
        request: provider([database("development")]),
        inspect,
        open,
      },
    ),
    /source changed before mutation/u,
  );
});
