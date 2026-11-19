import { expect, it } from "vitest";

import type { D1Database } from "../src/d1-types.js";
import { verifyCoreLayout } from "../src/core.js";
import { SharedCoreRouter } from "../src/router.js";
import { createControlStore } from "../src/store.js";
import { createTestControl } from "./support/control-d1.js";

const ID = "10000000-0000-4000-8000-000000000001";
const ACTIVATION = "20000000-0000-4000-8000-000000000001";
const START = "2026-10-28T00:00:00.000000Z";
const END = "2026-10-28T00:01:00.000000Z";
const MANIFEST = "aa".repeat(32),
  SOURCE = "bb".repeat(32),
  DDL = "cc".repeat(32),
  COMPARISON = "dd".repeat(32);
function open(
  db: D1Database,
  tables: unknown = [
    "wfp_candidate_receipts",
    "wfp_candidate_cleanup_receipts",
    "wfp_publish_receipts",
  ],
) {
  return db
    .prepare(
      "INSERT INTO core_historical_import(singleton,import_id,manifest_sha256,source_fingerprint_sha256,expected_runtime_schema_sha256,temporal_tables,started_at) VALUES(1,?,unhex(?),unhex(?),unhex(?),?,?)",
    )
    .bind(ID, MANIFEST, SOURCE, DDL, JSON.stringify(tables), START)
    .run();
}
function close(db: D1Database, ddl = DDL) {
  return db
    .prepare(
      "UPDATE core_historical_import SET closed_at=?,comparison_sha256=unhex(?),restored_runtime_schema_sha256=unhex(?) WHERE import_id=?",
    )
    .bind(END, COMPARISON, ddl, ID)
    .run();
}
function activate(db: D1Database, comparison = COMPARISON) {
  return db
    .prepare(
      "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256) VALUES(1,?,?,?,unhex(?),unhex(?))",
    )
    .bind(ACTIVATION, END, ID, comparison, DDL)
    .run();
}

it("refuses fresh/loading runtime authority, closes only with exact comparison and restored DDL, then activates once", async () => {
  const control = await createTestControl(2, { activated: false });
  try {
    const router = new SharedCoreRouter(control.core),
      store = createControlStore(control.bindings);
    await expect(router.assertLayout()).rejects.toThrow("no qualified immutable activation");
    await expect(store.billing.admitPaidProjectDomain({})).rejects.toThrow(
      "no qualified immutable activation",
    );
    await open(control.core);
    await expect(store.identity.applyOrganizationSnapshot({})).rejects.toThrow(
      "no qualified immutable activation",
    );
    expect(
      (await control.core.prepare("SELECT organization_id FROM organizations").all()).results,
    ).toEqual([]);
    await expect(activate(control.core)).rejects.toThrow("no open historical import");
    await expect(close(control.core, "ee".repeat(32))).rejects.toThrow(/closes once|CHECK/u);
    await close(control.core);
    await expect(router.assertLayout()).rejects.toThrow("no qualified immutable activation");
    await expect(activate(control.core, "ee".repeat(32))).rejects.toThrow(
      "exact closed qualified historical context",
    );
    await activate(control.core);
    await router.assertLayout();
    // The earlier failed positive-cache attempt was cleared; the same runtime store now sees activation.
    await expect(store.billing.admitPaidProjectDomain({})).rejects.not.toThrow(
      "no qualified immutable activation",
    );
    for (const sql of [
      "UPDATE core_historical_import SET closed_at=closed_at",
      "DELETE FROM core_historical_import",
      "UPDATE core_authority_activation SET activated_at=activated_at",
      "DELETE FROM core_authority_activation",
    ])
      await expect(control.core.prepare(sql).run()).rejects.toThrow(
        /immutable|never deleted|closes once/u,
      );
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
});

it("never reopens import after an activation cached by any runtime, including a fresh qualified target", async () => {
  const control = await createTestControl();
  try {
    const router = new SharedCoreRouter(control.core);
    await router.assertLayout();
    await expect(open(control.core)).rejects.toThrow("ever-activated authority");
    await router.assertLayout();
    await expect(
      control.core.prepare("DELETE FROM core_authority_activation").run(),
    ).rejects.toThrow("never deleted");
    expect(
      (await control.core.prepare("SELECT import_id FROM core_historical_import").all()).results,
    ).toEqual([]);
  } finally {
    await control.dispose();
  }
});

it("accepts only an exact closed temporal table allowlist and never changes the attested import identity", async () => {
  const control = await createTestControl(2, { activated: false });
  try {
    for (const tables of [
      ["organizations"],
      ["wfp_candidate_receipts", "wfp_candidate_receipts"],
      [1],
    ])
      await expect(open(control.core, tables)).rejects.toThrow("closed exact table allowlist");
    await open(control.core, []);
    for (const sql of [
      "UPDATE core_historical_import SET manifest_sha256=zeroblob(32)",
      "UPDATE core_historical_import SET temporal_tables='[\"wfp_candidate_receipts\"]'",
      "UPDATE core_historical_import SET started_at='2026-10-28T00:00:01.000000Z'",
      "DELETE FROM core_historical_import",
    ])
      await expect(control.core.prepare(sql).run()).rejects.toThrow(/immutable|never deleted/u);
    await close(control.core);
    await expect(open(control.core)).rejects.toThrow(/UNIQUE/u);
  } finally {
    await control.dispose();
  }
});

it("refuses a missing activation migration but preserves a transient activation-read failure for retry", async () => {
  const control = await createTestControl(2, { activated: false });
  try {
    const network = new Error("Network connection lost");
    const disconnected: D1Database = {
      prepare(sql) {
        const inner = control.core.prepare(sql);
        return !sql.includes("core_authority_activation")
          ? inner
          : {
              bind: (...values) => inner.bind(...values),
              first: async () => {
                throw network;
              },
              all: () => inner.all(),
              run: () => inner.run(),
            };
      },
      batch: (statements) => control.core.batch(statements),
    };
    await expect(verifyCoreLayout(disconnected)).rejects.toBe(network);
    await control.core.prepare("DROP TABLE core_authority_activation").run();
    await expect(verifyCoreLayout(control.core)).rejects.toThrow(
      "no qualified immutable activation",
    );
  } finally {
    await control.dispose();
  }
});
