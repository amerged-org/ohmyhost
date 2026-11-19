/* global URL */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  activateAuthority,
  closeImport,
  readActivation,
  recordComparison,
} from "../scripts/control-d1-activation.mjs";
import { bindingQuery } from "../scripts/control-d1-bulk.mjs";
import { runCli } from "../scripts/control-d1-migration.mjs";
import { openLocalTarget, schemaFingerprint } from "../scripts/control-d1-target.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const IMPORT = "10000000-0000-4000-8000-000000000001";
const CORE = "30000000-0000-4000-8000-000000000001";
const TARGET = "development";
const hex = (character) => character.repeat(64);
const at = (seconds) => new Date(Date.parse("2026-10-29T12:00:00.000Z") + seconds * 1000);
let directory;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "control-d1-activation-"));
  await chmod(directory, 0o700);
});
after(() => rm(directory, { recursive: true, force: true }));

/** A real local D1 with the real Core schema and an open import context, as the first import round leaves it. */
async function openImport() {
  const target = await openLocalTarget({ repositoryRoot });
  const { db } = target;
  await db
    .prepare(
      "INSERT INTO core_historical_import(singleton,import_id,manifest_sha256,source_fingerprint_sha256,expected_runtime_schema_sha256,temporal_tables,started_at) VALUES(1,?,unhex(?),unhex(?),unhex(?),'[]','2026-10-29T11:00:00.000000Z')",
    )
    .bind(IMPORT, hex("a"), hex("b"), await schemaFingerprint(db))
    .run();
  return target;
}
const receipt = (db, commandId, name, seconds) =>
  db
    .prepare(
      "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES (?,?,?,'{}',?)",
    )
    .bind(commandId, name, hex("0"), at(seconds).getTime())
    .run();
const compared = (db, captureId, comparisonSha256, seconds) =>
  recordComparison(db, {
    captureId,
    targetId: TARGET,
    planDigest: hex("c"),
    comparisonSha256,
    tables: 223,
    now: () => at(seconds),
  });

test("the import closes only on the attested comparison of a complete, unchanged final round, then activates once", async () => {
  const { db, dispose } = await openImport();
  try {
    await assert.rejects(activateAuthority(db), /IMPORT_NOT_CLOSED/u);
    await assert.rejects(closeImport(db, { comparisonSha256: "nope" }), /COMPARISON_DIGEST/u);
    await assert.rejects(
      closeImport(db, { comparisonSha256: hex("d") }),
      /COMPARISON_RECEIPT_MISSING/u,
    );

    // The comparison receipt is the round's own record; replay is exact and a different digest for the same round conflicts.
    await compared(db, "capture-1", hex("d"), 10);
    await compared(db, "capture-1", hex("d"), 99);
    await assert.rejects(compared(db, "capture-1", hex("e"), 11), /REPLAY_CONFLICT/u);
    await assert.rejects(
      closeImport(db, { comparisonSha256: hex("d") }),
      /COMPARISON_ROUND_INCOMPLETE/u,
    );

    await receipt(db, `control-d1-phase:v1:capture-1:${TARGET}`, "control-d1.phase", 5);
    await receipt(db, "late-import", "control-d1.import", 20);
    await assert.rejects(
      closeImport(db, { comparisonSha256: hex("d") }),
      /IMPORT_CHANGED_AFTER_COMPARISON/u,
    );

    // A newer final round with its own comparison supersedes the stale one.
    await receipt(db, `control-d1-phase:v1:capture-2:${TARGET}`, "control-d1.phase", 21);
    await compared(db, "capture-2", hex("f"), 30);
    await db.prepare("CREATE TABLE zz_schema_drift(x INTEGER)").run();
    await assert.rejects(closeImport(db, { comparisonSha256: hex("f") }), /TARGET_SCHEMA_DRIFT/u);
    await db.prepare("DROP TABLE zz_schema_drift").run();

    const closed = await closeImport(db, { comparisonSha256: hex("f"), now: () => at(40) });
    assert.deepEqual(closed, {
      importId: IMPORT,
      comparisonSha256: hex("f"),
      closedAt: "2026-10-29T12:00:40.000000Z",
      replayed: false,
    });
    assert.equal((await closeImport(db, { comparisonSha256: hex("f") })).replayed, true);
    await assert.rejects(closeImport(db, { comparisonSha256: hex("d") }), /IMPORT_ALREADY_CLOSED/u);
    // Closing is final: nothing more is compared into the same context.
    await assert.rejects(compared(db, "capture-3", hex("9"), 41), /IMPORT_CONTEXT_CLOSED/u);

    assert.equal(await readActivation(bindingQuery(db)), null);
    await assert.rejects(activateAuthority(db, { now: () => at(10) }), /ACTIVATION_CLOCK/u);
    assert.equal(
      (await db.prepare("SELECT count(*) n FROM core_authority_activation").first()).n,
      0,
    );

    const activation = await activateAuthority(db, {
      now: () => at(50),
      newId: () => "20000000-0000-4000-8000-000000000001",
    });
    assert.equal(activation.activation_id, "20000000-0000-4000-8000-000000000001");
    assert.equal(activation.qualification_sha256, hex("f"));
    assert.equal(activation.runtime_schema_sha256, await schemaFingerprint(db));
    assert.equal(activation.replayed, false);

    // Replay is exact and never rewrites the activation.
    assert.equal((await activateAuthority(db)).replayed, true);
    assert.deepEqual(
      await readActivation(bindingQuery(db)).then(({ activation_id: id }) => id),
      activation.activation_id,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) n FROM core_authority_activation").first()).n,
      1,
    );
    await assert.rejects(
      db.prepare("DELETE FROM core_authority_activation").run(),
      /never deleted/u,
    );
  } finally {
    await dispose();
  }
});

test("the CLI closes and activates with explicit confirmations and replays an activated Core from the provider readback", async () => {
  const target = await openImport();
  const { db } = target;
  try {
    await receipt(db, `control-d1-phase:v1:capture-1:${TARGET}`, "control-d1.phase", 5);
    await compared(db, "capture-1", hex("d"), 10);
    const config = join(directory, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        repositoryRoot,
        remote: { environment: "development", custody: directory },
      }),
      { mode: 0o600 },
    );
    const dependencies = {
      openRemote: async () => ({ db, dispose: async () => {}, databaseId: CORE }),
      observeCore: async () => ({ databaseId: CORE }),
      remoteQuery: () => bindingQuery(db),
    };
    const run = (...args) => runCli([...args, "--config", config], dependencies);
    await assert.rejects(run("close-import", "--comparison", "abc"), /CONFIRMATION/u);
    await assert.rejects(run("activate", "--confirm", "production"), /CONFIRMATION/u);
    await assert.rejects(run("activate", "--confirm", "development"), /IMPORT_NOT_CLOSED/u);
    assert.equal((await run("close-import", "--comparison", hex("d"))).replayed, false);
    const activated = await run("activate", "--confirm", "development");
    assert.match(activated.activation_id, /^[0-9a-f-]{36}$/u);
    assert.equal(activated.environment, "development");
    // The operator target refuses an activated Core; the repeat answers from the readback alone.
    const repeat = await runCli(["activate", "--config", config, "--confirm", "development"], {
      ...dependencies,
      openRemote: async () => assert.fail("an activated Core is not reopened"),
    });
    assert.equal(repeat.activation_id, activated.activation_id);
    assert.equal(repeat.replayed, true);
  } finally {
    await target.dispose();
  }
});
