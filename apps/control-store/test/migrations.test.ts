import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GUARD_CODES } from "../src/guards.js";
import { createTestControl, migrationFiles, type TestControl } from "./support/control-d1.js";
import { splitStatements } from "./support/sql.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
});
afterAll(async () => control.dispose());

describe("checked-in D1 migrations", () => {
  it("apply to one real D1 database and create the Directory and tenant schemas together", async () => {
    const names = (
      await control.core
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "command_log",
        "core_layout",
        "guard_fail",
        "org_directory",
        "shard_buckets",
        "shards",
        "work_due",
        "organizations",
        "organization_memberships",
        "outbox_events",
      ]),
    );
  });

  it("carries one named CHECK per guard code in the one core catalog", async () => {
    const row = await control.core
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'guard_fail'")
      .first<{ sql: string }>();
    const declared = [...(row?.sql ?? "").matchAll(/CONSTRAINT guard_([a-z_]+) CHECK/gu)].map(
      (m) => m[1],
    );
    expect(declared).toEqual([...GUARD_CODES, "unregistered"]);
  });

  it("enforces the stored timestamp form and aborts the batch on a violated guard", async () => {
    const shard = control.core;
    await expect(
      control.core
        .prepare(
          "INSERT INTO org_directory(organization_id, workos_organization_id, bucket, state, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'org_badtime', 1, 'active', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      shard.batch([
        shard.prepare(
          "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES ('c1', 'n', 'd', '{}', 1)",
        ),
        shard.prepare("INSERT INTO guard_fail(code) SELECT 'claim_lost' WHERE 1"),
      ]),
    ).rejects.toThrow(/guard_claim_lost/u);
    expect(
      (await shard.prepare("SELECT count(*) AS n FROM command_log").first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("never stores an organization without a real routing bucket, so a live fence cannot be bypassed", async () => {
    const shard = control.core;
    const insert = (bucket: string) =>
      shard
        .prepare(
          `INSERT INTO organizations(organization_id, workos_organization_id, state, mapping_revision, snapshot_sha256, snapshot_fetched_at, synchronized_at, created_at, updated_at, bucket) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'org_bucketless', 'active', 1, zeroblob(32), '2026-10-28T00:00:00.000000Z', '2026-10-28T00:00:00.000000Z', '2026-10-28T00:00:00.000000Z', '2026-10-28T00:00:00.000000Z', ${bucket})`,
        )
        .run();
    for (const bucket of ["-1", "1024", "NULL"])
      await expect(insert(bucket)).rejects.toThrow(/CHECK constraint failed|NOT NULL constraint/u);
    await expect(insert("1023")).resolves.toBeDefined();
  });
});

describe("test SQL splitter", () => {
  it("keeps trigger bodies, CASE expressions, strings and comments in one statement each", () => {
    const sql = `-- header
CREATE TABLE a (x TEXT CHECK (x <> 'a;b'));
/* block; comment */
CREATE TRIGGER t BEFORE UPDATE ON a WHEN OLD.x = 'q' BEGIN SELECT CASE WHEN 1 THEN 2 END; SELECT RAISE(ABORT, 'no'); END;
INSERT INTO a VALUES ("it""s;")
-- trailing comment only
;
WITH values_to_update(x) AS (
  SELECT 'new'
)
UPDATE a SET x = (SELECT x FROM values_to_update);
UPDATE a SET x = 'another';
`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(5);
    expect(statements[1]).toContain("SELECT RAISE(ABORT, 'no'); END");
    expect(statements[2]).toContain('"it""s;"');
  });

  it("reads every checked-in migration into whole statements", () => {
    for (const kind of ["core", "directory", "shard"] as const) {
      for (const file of migrationFiles(kind)) {
        const statements = splitStatements(file.sql);
        // Migration statements start at the beginning of a line. A WITH ... )\nUPDATE continuation
        // is still one statement; count standalone updates without counting that CTE twice.
        // A lost or merged statement fails here, and a single-statement migration is legitimate.
        const declared =
          file.sql.match(/^(CREATE|INSERT|(?<!\)\n)UPDATE|DELETE|DROP|ALTER|WITH|PRAGMA)\b/gmu) ??
          [];
        expect(declared.length, file.name).toBeGreaterThan(0);
        expect(statements, file.name).toHaveLength(declared.length);
        for (const statement of statements)
          expect(statement).toMatch(
            /^(--[^\n]*\n|\s)*(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|WITH|PRAGMA)/u,
          );
      }
    }
  });
});
