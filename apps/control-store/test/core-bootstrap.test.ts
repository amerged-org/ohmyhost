import { Miniflare } from "miniflare";
import { expect, test, vi } from "vitest";
import type { D1Database } from "../src/d1-types.js";
import {
  activateTestCore,
  createTestControl,
  migrate,
  migrationFiles,
} from "./support/control-d1.js";
import {
  bootstrapCore,
  coreBootstrapWorker,
  initializeCoreFixture,
} from "./support/core-bootstrap.js";

function fixture() {
  return new Miniflare({
    modules: true,
    script: coreBootstrapWorker,
    d1Databases: { CONTROL_CORE: "core" },
  });
}

test("real migrations match the original fixture and fresh instances remain isolated", async () => {
  const reference = fixture();
  const candidate = fixture();
  let isolated: Awaited<ReturnType<typeof createTestControl>> | undefined;
  const started = performance.now();
  try {
    const oldDb = (await reference.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    await migrate(oldDb, "core");
    await activateTestCore(oldDb);
    const newDb = (await candidate.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    const files = migrationFiles("core");
    expect(files.length).toBeGreaterThan(0);
    const before = performance.now();
    expect(await bootstrapCore(candidate, files)).toBe(files.length);
    const bootstrapMs = performance.now() - before;
    await activateTestCore(newDb);
    const schema =
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    expect((await newDb.prepare(schema).all()).results).toEqual(
      (await oldDb.prepare(schema).all()).results,
    );
    expect((await newDb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await oldDb.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await newDb.prepare("SELECT * FROM core_authority_activation").all()).results).toEqual(
      (await oldDb.prepare("SELECT * FROM core_authority_activation").all()).results,
    );
    isolated = await createTestControl(2, { activated: false });
    expect(
      (
        await isolated.core.prepare("SELECT count(*) AS n FROM core_authority_activation").first()
      )?.["n"],
    ).toBe(0);
    expect(isolated.directory).toBe(isolated.core);
    expect(isolated.shards["CONTROL_SHARD_0000"]).toBe(isolated.core);
    expect(isolated.shards["CONTROL_SHARD_0001"]).toBe(isolated.core);
    await newDb.prepare("CREATE TABLE only_this_fixture (id INTEGER)").run();
    expect(
      await isolated.core
        .prepare("SELECT name FROM sqlite_schema WHERE name='only_this_fixture'")
        .first(),
    ).toBeNull();
    console.info(
      `core-bootstrap: ${files.length} migration batches, ${Math.round(bootstrapMs)}ms bootstrap, ${Math.round(performance.now() - started)}ms total`,
    );
  } finally {
    await isolated?.dispose();
    await candidate.dispose();
    await reference.dispose();
  }
}, 120_000);

test("a middle migration rolls back as a batch and prevents later files", async () => {
  const miniflare = fixture();
  try {
    const db = await miniflare.getD1Database("CONTROL_CORE");
    await expect(
      bootstrapCore(miniflare, [
        { name: "one", sql: "CREATE TABLE earlier (id INTEGER); INSERT INTO earlier VALUES (1);" },
        {
          name: "two",
          sql: "CREATE TABLE rolled_back (id INTEGER); INSERT INTO absent_table VALUES (1);",
        },
        { name: "three", sql: "CREATE TABLE later (id INTEGER);" },
      ]),
    ).rejects.toThrow();
    expect((await db.prepare("SELECT count(*) AS n FROM earlier").first())?.["n"]).toBe(1);
    expect(
      await db.prepare("SELECT name FROM sqlite_schema WHERE name='rolled_back'").first(),
    ).toBeNull();
    expect(
      await db.prepare("SELECT name FROM sqlite_schema WHERE name='later'").first(),
    ).toBeNull();
  } finally {
    await miniflare.dispose();
  }
});

test("initialization disposes exactly once and preserves its primary failure", async () => {
  const primary = new Error("original initialization failure");
  for (const cleanupFails of [false, true]) {
    for (const stage of ["database", "files", "dispatch", "activation"] as const) {
      const cleanup = new Error("cleanup failure");
      const dispose = vi.fn(async () => {
        if (cleanupFails) throw cleanup;
      });
      const broken = {
        getD1Database: vi.fn(async () => {
          if (stage === "database") throw primary;
          return {};
        }),
        dispatchFetch: vi.fn(async () => {
          if (stage === "dispatch") throw primary;
          return Response.json({ completed: 0 });
        }),
        dispose,
      };
      const failure = await initializeCoreFixture(
        broken as never,
        () => {
          if (stage === "files") throw primary;
          return [];
        },
        async () => {
          if (stage === "activation") throw primary;
        },
      ).catch((error: unknown) => error);
      if (cleanupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
      } else expect(failure).toBe(primary);
      expect(dispose).toHaveBeenCalledTimes(1);
    }
    for (const invalid of ["malformed", "incomplete", "failed"] as const) {
      const cleanup = new Error("cleanup failure");
      const dispose = vi.fn(async () => {
        if (cleanupFails) throw cleanup;
      });
      const activate = vi.fn(async () => {});
      const broken = {
        getD1Database: vi.fn(async () => ({})),
        dispatchFetch: vi.fn(async () =>
          invalid === "malformed"
            ? new Response("not-json")
            : invalid === "incomplete"
              ? Response.json({ completed: 0 })
              : Response.json({ error: "migration failed" }, { status: 500 }),
        ),
        dispose,
      };
      const failure = await initializeCoreFixture(
        broken as never,
        () => [{ name: "one", sql: "CREATE TABLE example (id INTEGER);" }],
        activate,
      ).catch((error: unknown) => error);
      const initializationError = cleanupFails ? (failure as AggregateError).cause : failure;
      if (invalid === "malformed") expect(initializationError).toBeInstanceOf(SyntaxError);
      else
        expect(initializationError).toMatchObject({
          message:
            invalid === "incomplete"
              ? "Core fixture migration receipt is invalid"
              : "migration failed",
        });
      if (cleanupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          cause: initializationError,
          errors: [initializationError, cleanup],
        });
      }
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(activate).not.toHaveBeenCalled();
    }
  }
});
