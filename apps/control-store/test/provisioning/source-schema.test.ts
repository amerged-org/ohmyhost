import { parseUlid } from "@ohmyhost/platform";
import { recordGithubSourceConnection } from "../../src/catalog/provisioning/github-registration.js";
import { SharedCoreRouter } from "../../src/router.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";
import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createTestControl, migrationFiles } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { workflowFixture } from "./workflow-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { guard } from "../../src/guards.js";
import type { D1Database } from "../../src/d1-types.js";
async function targetAccepts(db: D1Database, sql: string, values: unknown[]) {
  try {
    await db.batch([db.prepare(sql).bind(...values), guard(db, "precondition_changed", "1")]);
    throw new Error("Missing expected fixture rollback");
  } catch (e) {
    if (e instanceof Error && e.message.includes("guard_precondition_changed")) return true;
    if (e instanceof Error && e.message.includes("CHECK constraint")) return false;
    if (e instanceof Error && e.message.includes("FOREIGN KEY")) return false;
    throw e;
  }
}
it("keeps the seven-field GitHub catalogue and its static shape, calendar and FK rules", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    expect(
      (
        await c.core.prepare("PRAGMA table_info(github_source_connections)").all<{ name: string }>()
      ).results.map((v) => v.name),
    ).toEqual([
      "source_connection_id",
      "organization_id",
      "project_id",
      "billing_epoch_id",
      "provider",
      "external_repository_id",
      "created_at",
    ]);
    const base: Record<string, unknown> = {
        source_connection_id: newUlid(),
        organization_id: r.p.organizationId,
        project_id: r.p.projectId,
        billing_epoch_id: r.p.billingEpochId,
        provider: "github",
        external_repository_id: "42",
        created_at: "2026-10-28T11:00:00.123456Z",
      },
      columns = Object.keys(base),
      sql = `INSERT INTO github_source_connections(${columns}) VALUES(${columns.map(() => "?")})`;
    for (const [patch, accepted] of [
      [{}, true],
      [{ external_repository_id: "9007199254740991" }, true],
      [{ external_repository_id: "9007199254740992" }, false],
      [{ external_repository_id: "01" }, false],
      [{ external_repository_id: "1e2" }, false],
      [{ provider: "managed" }, false],
      [{ created_at: "2026-02-30T11:00:00.123456Z" }, false],
      [{ created_at: "2026-10-28T1x:00:00.123456Z" }, false],
      [{ billing_epoch_id: newUlid() }, false],
      [{ source_connection_id: newUlid() + "\0tail" }, false],
    ] as [Record<string, unknown>, boolean][]) {
      const row: Record<string, unknown> = { ...base, ...patch };
      expect(
        await targetAccepts(
          c.core,
          sql,
          columns.map((k) => row[k]),
        ),
        JSON.stringify(patch),
      ).toBe(accepted);
    }
    const input = {
      sourceConnectionId: parseUlid(newUlid()),
      organizationId: parseUlid(r.p.organizationId),
      projectId: parseUlid(r.p.projectId),
      billingEpochId: parseUlid(r.p.billingEpochId),
      externalRepositoryId: "9007199254740991",
      createdAt: "2026-10-28T11:00:00.123Z",
    };
    const lost = losingWriteResponses(c.core, 1),
      ctx = { directory: lost, router: new SharedCoreRouter(lost) };
    expect(await recordGithubSourceConnection(ctx, input)).toBe("existing");
    expect(await recordGithubSourceConnection(ctx, input)).toBe("existing");
    for (const table of ["github_source_connections", "source_connections"]) {
      expect(
        (
          await c.core
            .prepare(
              `SELECT source_connection_id,organization_id,project_id,billing_epoch_id,provider,external_repository_id FROM ${table} WHERE source_connection_id=?`,
            )
            .bind(input.sourceConnectionId)
            .all()
        ).results,
        table,
      ).toEqual([
        {
          source_connection_id: input.sourceConnectionId,
          organization_id: r.p.organizationId,
          project_id: r.p.projectId,
          billing_epoch_id: r.p.billingEpochId,
          provider: "github",
          external_repository_id: "9007199254740991",
        },
      ]);
    }
    await expect(
      recordGithubSourceConnection(ctx, { ...input, externalRepositoryId: "43" }),
    ).rejects.toMatchObject({ name: "GithubSourceConnectionConflictError" });
    const second = { ...input, sourceConnectionId: parseUlid(newUlid()) };
    await c.core
      .prepare(
        "CREATE TRIGGER github_authority_late_failure BEFORE INSERT ON source_connections BEGIN SELECT RAISE(ABORT,'late github authority'); END",
      )
      .run();
    await expect(
      recordGithubSourceConnection(
        { directory: c.core, router: new SharedCoreRouter(c.core) },
        second,
      ),
    ).rejects.toThrow("late github authority");
    expect(
      await c.core
        .prepare("SELECT count(*) n FROM github_source_connections WHERE source_connection_id=?")
        .bind(second.sourceConnectionId)
        .first(),
    ).toEqual({ n: 0 });
    await c.core.prepare("DROP TRIGGER github_authority_late_failure").run();
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 60_000);
it("keeps the fourteen-field archive catalogue and its reference, byte, epoch and scope rules, retaining optional provider evidence independently", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    expect(
      (
        await c.core.prepare("PRAGMA table_info(source_archives)").all<{ name: string }>()
      ).results.map((v) => v.name),
    ).toEqual([
      "operation_id",
      "organization_id",
      "project_id",
      "billing_epoch_id",
      "provider",
      "source_connection_id",
      "external_repository_id",
      "requested_commit_sha",
      "resolved_commit_sha",
      "archive_format",
      "sha256",
      "byte_length",
      "object_ref",
      "acquired_at",
    ]);
    const base: Record<string, unknown> = {
        operation_id: r.input.operationId,
        organization_id: r.p.organizationId,
        project_id: r.p.projectId,
        billing_epoch_id: r.p.billingEpochId,
        provider: "github",
        source_connection_id: r.source,
        external_repository_id: "42",
        requested_commit_sha: "a".repeat(40),
        resolved_commit_sha: "a".repeat(40),
        archive_format: "tar.gz",
        sha256: new Uint8Array(32).fill(3),
        byte_length: 123,
        object_ref: `archive_${r.input.operationId}_${newUlid()}`,
        acquired_at: "2026-10-28T11:00:00.123456Z",
      },
      columns = Object.keys(base);
    const cases: [Record<string, unknown>, boolean][] = [
      [{}, true],
      [{ object_ref: `archive_${newUlid()}_${newUlid()}` }, false],
      [
        { object_ref: `r2-version:ohmyho-builds-development-eu/source.tar.gz#${"a".repeat(32)}` },
        true,
      ],
      [
        { object_ref: `r2-version:ohmyho-builds-production/source😀.tar.gz#${"b".repeat(32)}` },
        true,
      ],
      [{ object_ref: `r2-version:ohmyho-builds-production/a\u00a0b#${"b".repeat(32)}` }, false],
      [{ object_ref: `r2-version:ohmyho-builds-production/a?b#${"b".repeat(32)}` }, false],
      [{ object_ref: `r2-version:wrong-bucket/source#${"a".repeat(32)}` }, false],
      [{ byte_length: 9007199254740991 }, true],
      [{ byte_length: 9007199254740992 }, false],
      [{ byte_length: 0 }, false],
      [{ sha256: new Uint8Array(31) }, false],
      [{ requested_commit_sha: "0".repeat(40), resolved_commit_sha: "0".repeat(40) }, false],
      [{ resolved_commit_sha: "b".repeat(40) }, false],
      [{ external_repository_id: "43" }, false],
      [{ billing_epoch_id: newUlid() }, false],
      [{ provider: "other" }, false],
      [{ acquired_at: "2026-10-28T11:2x:00.123456Z" }, false],
    ];
    for (const [patch, accepted] of cases) {
      const row: Record<string, unknown> = { ...base, ...patch };
      expect(
        await targetAccepts(
          c.core,
          `INSERT INTO source_archives(${columns}) VALUES(${columns.map(() => "?")})`,
          columns.map((k) => row[k]),
        ),
        String(patch["object_ref"] ?? Object.keys(patch)),
      ).toBe(accepted);
    }
  } finally {
    await c.dispose();
  }
}, 60_000);
it("creates the two missing original custody families atomically only on an unserved Core", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default{}",
    d1Databases: ["CONTROL_CORE"],
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database,
      ddl = migrationFiles("core").find((v) => v.name.startsWith("0455"));
    if (!ddl) throw new Error("Source custody prerequisite missing");
    for (const f of migrationFiles("core").filter((v) => !v.name.startsWith("0455")))
      await db.batch(splitStatements(f.sql).map((v) => db.prepare(v)));
    await expect(
      db.batch([
        ...splitStatements(ddl.sql).map((v) => db.prepare(v)),
        guard(db, "precondition_changed", "1"),
      ]),
    ).rejects.toThrow("guard_precondition_changed");
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM sqlite_schema WHERE name IN('github_source_connections','source_archives')",
        )
        .first(),
    ).toEqual({ n: 0 });
    await db.batch(splitStatements(ddl.sql).map((v) => db.prepare(v)));
    await db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00.000000Z',zeroblob(32),zeroblob(32))",
      )
      .run();
    await expect(db.batch(splitStatements(ddl.sql).map((v) => db.prepare(v)))).rejects.toThrow(
      "guard_precondition_changed",
    );
  } finally {
    await mf.dispose();
  }
});
