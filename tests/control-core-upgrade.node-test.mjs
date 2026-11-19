import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { URL, fileURLToPath } from "node:url";
import { canonical, sha256 } from "../scripts/control-d1-codec.mjs";
import { requireSchemaHeadForPin } from "../scripts/control-d1-target.mjs";
import {
  initializeUnservedTargetSchema,
  upgradeCoreSchema,
  schemaFingerprint,
} from "../scripts/control-d1-target.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const inventoryPath = "apps/control-store/migrations/core";

function fixtureGit(cwd, args) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString("utf8")
    .trim();
}

function commitFixture(cwd, message) {
  fixtureGit(cwd, ["add", "."]);
  fixtureGit(cwd, [
    "-c",
    "user.name=amerged test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    message,
  ]);
  return fixtureGit(cwd, ["rev-parse", "HEAD"]);
}

async function coreUpgradeRepository(context) {
  const root = await mkdtemp(join(tmpdir(), "omh-core-forward-migrations-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const retained = join(repositoryRoot, inventoryPath);
  const inventory = join(root, inventoryPath);
  const names = (await readdir(retained)).filter((name) => name.endsWith(".sql")).sort();
  const earlier = names.filter((name) => name.slice(0, 4) < "0509");
  const forward = names.filter((name) => name.slice(0, 4) >= "0509");
  assert.notEqual(earlier.length, 0);
  assert.notEqual(forward.length, 0);
  await mkdir(inventory, { recursive: true });
  fixtureGit(root, ["init", "-q", "--initial-branch=main"]);
  for (const name of earlier)
    await writeFile(join(inventory, name), await readFile(join(retained, name)));
  const before0509 = commitFixture(root, "Archived schema fixture before 0509");
  for (const name of forward)
    await writeFile(join(inventory, name), await readFile(join(retained, name)));
  commitFixture(root, "Current retained migration inventory");
  return { root, before0509, forward };
}

async function emptyCore(name) {
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script: "export default {fetch(){return new Response('unserved',{status:503})}}",
      d1Databases: { CONTROL_CORE: name },
    }),
  });
  return { db: await runtime.getD1Database("CONTROL_CORE"), dispose: () => runtime.dispose() };
}

test("an activated Core takes forward migrations and unchanged-schema descendant attestations through its recorded head while preserving rows", async (context) => {
  const { root: migrationRoot, before0509, forward } = await coreUpgradeRepository(context);
  const old = await emptyCore("upgrade-old"),
    fresh = await emptyCore("upgrade-fresh");
  try {
    await initializeUnservedTargetSchema(old.db, migrationRoot, { sourceCommit: before0509 });
    await old.db
      .prepare(
        "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES('control-d1.remote-attestation:v1:n','omh.control-core.remote-target/v1','d',?,1)",
      )
      .bind(JSON.stringify({ sourceCommit: before0509 }))
      .run();
    await old.db.prepare("INSERT INTO signup_sources(source_id) VALUES('kept-row')").run();
    const stamp = (byte) => Uint8Array.from(Buffer.alloc(32, byte));
    await old.db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256) VALUES(1,'11111111-2222-4333-8444-555555555555','2026-10-30T00:00:00.000000Z',NULL,?,?)",
      )
      .bind(stamp(1), stamp(2))
      .run();
    const meterTrigger = () =>
      old.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='usage_valuations_require_financial_receipt'",
        )
        .first();
    assert.equal((await meterTrigger()).sql.includes("ses.us-east-1.recipients"), false);

    // The Core stands at the revision before 0509: every migration from 0509 on that the checkout carries is applied,
    // in order, and the old metering trigger is gone afterwards.
    const upgraded = await upgradeCoreSchema(old.db, migrationRoot);
    assert.deepEqual(upgraded.applied, forward);
    assert.equal(await meterTrigger(), null);
    assert.equal(
      (await old.db.prepare("SELECT source_id FROM signup_sources").first()).source_id,
      "kept-row",
    );
    assert.equal(
      (await old.db.prepare("SELECT count(*) n FROM core_authority_activation").first()).n,
      1,
    );

    // The result is exactly the schema a fresh migration of the same revision produces, and a repeat is a no-op.
    await initializeUnservedTargetSchema(fresh.db, migrationRoot);
    assert.equal(await schemaFingerprint(old.db), await schemaFingerprint(fresh.db));
    assert.deepEqual((await upgradeCoreSchema(old.db, migrationRoot)).applied, []);

    // A code-only descendant must acquire a new source-bound schema head without pretending a migration ran.
    // A private Git fixture makes equal, changed, reordered and removed immutable inventories independent of main.
    const fixture = await mkdtemp(join(tmpdir(), "omh-core-source-attestation-"));
    const inventory = join(fixture, "apps/control-store/migrations/core");
    const git = (args) => fixtureGit(fixture, args);
    const commit = (message) => commitFixture(fixture, message);
    const sourceOnly = await emptyCore("upgrade-source-only");
    const wrongBase = await emptyCore("upgrade-source-wrong-base");
    try {
      await mkdir(inventory, { recursive: true });
      await writeFile(
        join(inventory, "0001_initial.sql"),
        "CREATE TABLE core_layout(singleton INTEGER PRIMARY KEY);\n" +
          "CREATE TABLE command_log(command_id TEXT PRIMARY KEY,name TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,applied_at INTEGER NOT NULL);\n",
      );
      await writeFile(
        join(inventory, "0002_rows.sql"),
        "CREATE TABLE retained(value TEXT NOT NULL);\nCREATE TABLE core_authority_activation(singleton INTEGER PRIMARY KEY);\n",
      );
      git(["init", "-q", "--initial-branch=main"]);
      const base = commit("schema base");
      await writeFile(join(fixture, "runtime.js"), "export const version = 1;\n");
      const first = commit("code only one");
      await writeFile(join(fixture, "runtime.js"), "export const version = 2;\n");
      const second = commit("code only two");
      await writeFile(join(fixture, "runtime.js"), "export const version = 3;\n");
      const third = commit("code only three");
      await initializeUnservedTargetSchema(sourceOnly.db, fixture, { sourceCommit: base });
      await initializeUnservedTargetSchema(wrongBase.db, fixture, { sourceCommit: base });
      await sourceOnly.db.prepare("INSERT INTO retained(value) VALUES('preserved')").run();
      await sourceOnly.db
        .prepare("INSERT INTO core_authority_activation(singleton) VALUES(1)")
        .run();
      const fingerprint = await schemaFingerprint(sourceOnly.db);
      const initialReceipt = await sourceOnly.db
        .prepare("SELECT * FROM command_log WHERE command_id='control-d1.schema:v1'")
        .first();
      const migrated = await upgradeCoreSchema(sourceOnly.db, fixture, {
        sourceCommit: first,
        previousCommit: base,
      });
      assert.deepEqual(migrated.applied, []);
      assert.equal(migrated.pin.revision, first);
      assert.equal(await schemaFingerprint(sourceOnly.db), fingerprint);
      assert.deepEqual(
        await sourceOnly.db
          .prepare("SELECT * FROM command_log WHERE command_id='control-d1.schema:v1'")
          .first(),
        initialReceipt,
      );
      const receipt = await sourceOnly.db
        .prepare("SELECT * FROM command_log WHERE command_id LIKE 'control-d1.schema-upgrade:v1:%'")
        .first();
      assert.deepEqual(JSON.parse(receipt.result), {
        applied: [],
        from: initialReceipt.digest,
        schemaSha256: fingerprint,
        sourceCommit: first,
      });
      assert.equal(
        (
          await sourceOnly.db
            .prepare("SELECT count(*) n FROM command_log WHERE name='control-d1.schema-migration'")
            .first()
        ).n,
        0,
      );
      assert.equal(
        (await sourceOnly.db.prepare("SELECT value FROM retained").first()).value,
        "preserved",
      );
      assert.equal(
        (await sourceOnly.db.prepare("SELECT singleton FROM core_authority_activation").first())
          .singleton,
        1,
      );
      assert.deepEqual(
        (await upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: first })).applied,
        [],
      );
      assert.equal(
        (await sourceOnly.db.prepare("SELECT count(*) n FROM command_log").first()).n,
        2,
      );
      assert.deepEqual(
        (await upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: second })).applied,
        [],
      );
      const unchangedRows = (
        await sourceOnly.db.prepare("SELECT * FROM command_log ORDER BY command_id").all()
      ).results;
      await assert.rejects(
        upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: first }),
        /UPGRADE_NOT_FORWARD/u,
      );
      await assert.rejects(
        upgradeCoreSchema(wrongBase.db, fixture, { sourceCommit: first, previousCommit: second }),
        /UPGRADE_BASE_MISMATCH/u,
      );

      git(["checkout", "-q", "--detach", second]);
      const originalSql = await readFile(join(inventory, "0002_rows.sql"), "utf8");
      await writeFile(
        join(inventory, "0002_rows.sql"),
        originalSql + "CREATE TABLE changed(x INTEGER);\n",
      );
      const changed = commit("conflicting migration SQL");
      await assert.rejects(
        upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: changed }),
        /UPGRADE_NOT_FORWARD/u,
      );
      git(["checkout", "-q", "--detach", second]);
      await rename(join(inventory, "0002_rows.sql"), join(inventory, "0003_rows.sql"));
      const reordered = commit("renumbered migration");
      await assert.rejects(
        upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: reordered }),
        /UPGRADE_NOT_FORWARD/u,
      );
      git(["checkout", "-q", "--detach", second]);
      await rm(join(inventory, "0002_rows.sql"));
      const removed = commit("removed migration");
      await assert.rejects(
        upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: removed }),
        /UPGRADE_NOT_FORWARD/u,
      );
      git(["checkout", "-q", "--detach", base]);
      await writeFile(join(fixture, "sibling.js"), "export const sibling = true;\n");
      const sibling = commit("non-descendant equal inventory");
      await assert.rejects(
        upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: sibling }),
        /UPGRADE_NOT_FORWARD/u,
      );
      assert.deepEqual(
        (await sourceOnly.db.prepare("SELECT * FROM command_log ORDER BY command_id").all())
          .results,
        unchangedRows,
      );
      await sourceOnly.db.prepare("CREATE TABLE foreign_table(x INTEGER)").run();
      await assert.rejects(
        upgradeCoreSchema(sourceOnly.db, fixture, { sourceCommit: third }),
        /TARGET_SCHEMA_DRIFT/u,
      );
      assert.deepEqual(
        (await sourceOnly.db.prepare("SELECT * FROM command_log ORDER BY command_id").all())
          .results,
        unchangedRows,
      );
    } finally {
      await sourceOnly.dispose();
      await wrongBase.dispose();
      await rm(fixture, { recursive: true, force: true });
    }

    // A Core whose schema moved away from its recorded head is not upgraded.
    const drifted = await emptyCore("upgrade-drifted");
    try {
      await initializeUnservedTargetSchema(drifted.db, migrationRoot, {
        sourceCommit: before0509,
      });
      await drifted.db.prepare("CREATE TABLE foreign_table(x INTEGER)").run();
      await assert.rejects(
        upgradeCoreSchema(drifted.db, migrationRoot, { previousCommit: before0509 }),
        /TARGET_SCHEMA_DRIFT/u,
      );
    } finally {
      await drifted.dispose();
    }
  } finally {
    await old.dispose();
    await fresh.dispose();
  }
});

test("a Core release accepts only the schema receipt head that the source commit pins", () => {
  const pin = {
    layout: "shared-core-v1",
    revision: "a".repeat(40),
    migrations: [{ name: "0001_example.sql", sha256: "b".repeat(64) }],
  };
  const head = (digest) => ({
    command_id: "control-d1.schema:v1",
    name: "control-d1.schema",
    digest,
    result: JSON.stringify({ schemaSha256: "c".repeat(64) }),
  });
  requireSchemaHeadForPin([head(sha256(Buffer.from(canonical(pin))))], pin);
  assert.throws(() => requireSchemaHeadForPin([head("d".repeat(64))], pin), /TARGET_UNATTESTED/u);
});
