import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { D1Database, D1Result } from "../src/d1-types.js";
import { classifyFailure, guard } from "../src/guards.js";
import {
  CommandConflictError,
  StoreBusyError,
  StoreOutcomeUnknownError,
  runCommand,
  type Command,
} from "../src/run-command.js";
import { createTestControl, losingResponses, type TestControl } from "./support/control-d1.js";

let control: TestControl;
let db: D1Database;
beforeAll(async () => {
  control = await createTestControl(1);
  db = Object.values(control.shards)[0] as D1Database;
  await db
    .prepare(
      "CREATE TABLE counter (id TEXT PRIMARY KEY, version INTEGER NOT NULL, value INTEGER NOT NULL) STRICT",
    )
    .run();
  await db.prepare("CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT").run();
  await db.prepare("INSERT INTO counter VALUES ('c', 0, 0)").run();
});
afterAll(async () => control.dispose());

const noSleep = () => Promise.resolve();

/** Shape B: read the version, decide, write under a compare-and-swap, abort the batch when it moved. */
function increment(id: string): Command<{ version: number; value: number }, number> {
  return {
    name: "counter.increment",
    input: { id },
    retryOn: ["row_version_conflict"],
    read: async (reader) =>
      (await reader
        .prepare("SELECT version, value FROM counter WHERE id = ?")
        .bind(id)
        .first()) as { version: number; value: number },
    decide: (seen) => ({
      statements: [
        db
          .prepare(
            "UPDATE counter SET version = version + 1, value = value + 1 WHERE id = ?1 AND version = ?2",
          )
          .bind(id, seen.version),
        guard(db, "row_version_conflict", "changes() = 0"),
      ],
      result: () => seen.value + 1,
    }),
  };
}

function note(id: string, body: string, commandId?: string): Command<null, string> {
  return {
    name: "note.add",
    input: { id, body },
    ...(commandId === undefined ? {} : { commandId, now: 1 }),
    naturalKeyTables: ["note"],
    read: async () => null,
    decide: () => ({
      statements: [db.prepare("INSERT INTO note(id, body) VALUES (?, ?)").bind(id, body)],
      result: () => `added:${id}`,
      logResult: { id },
    }),
    fromLog: (logged) => `added:${(logged as { id: string }).id}`,
    lookup: async (reader) => {
      const row = await reader
        .prepare("SELECT body FROM note WHERE id = ?")
        .bind(id)
        .first<{ body: string }>();
      return row?.body === body ? `added:${id}` : undefined;
    },
  };
}

describe("runCommand", () => {
  it("never loses an update between concurrent version-guarded writers", async () => {
    const stats = { attempts: 0, conflicts: 0, unknown: 0 };
    let conflicts = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        runCommand(db, increment("c"), { maxAttempts: 30, sleep: noSleep, stats }).then((value) => {
          conflicts += stats.conflicts;
          return value;
        }),
      ),
    );
    const done = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    const row = await db
      .prepare("SELECT version, value FROM counter WHERE id = 'c'")
      .first<{ version: number; value: number }>();
    expect(done).toBe(12);
    expect(row).toEqual({ version: 12, value: 12 });
    expect(conflicts).toBeGreaterThan(0);
  });

  it("ends the exhaustion messages with the wire code the consumers match", async () => {
    const alwaysStale: Command<null, number> = {
      name: "counter.alwaysStale",
      input: {},
      retryOn: ["row_version_conflict"],
      read: async () => null,
      decide: () => ({
        statements: [guard(db, "row_version_conflict", "1 = 1")],
        result: () => 0,
      }),
    };
    await expect(runCommand(db, alwaysStale, { maxAttempts: 2, sleep: noSleep })).rejects.toThrow(
      /lost the race: store_busy$/u,
    );
    // A batch that never reaches the database: the outcome stays unknown and the code is on the message.
    const unreachable = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async () => {
        throw new Error("Network connection lost");
      },
    } as unknown as D1Database;
    await expect(
      runCommand(unreachable, increment("c"), { maxAttempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/outcome unknown after 2 attempts: store_outcome_unknown$/u);
  });

  it("reports store_busy, known not applied, when every attempt loses the race", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        runCommand(db, increment("c"), { maxAttempts: 1, sleep: noSleep }),
      ),
    );
    const failed = results.filter((result) => result.status === "rejected");
    const ok = results.length - failed.length;
    expect(failed.length).toBeGreaterThan(0);
    for (const failure of failed)
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(StoreBusyError);
    const row = await db
      .prepare("SELECT value FROM counter WHERE id = 'c'")
      .first<{ value: number }>();
    expect(row?.value).toBe(12 + ok);
  });

  it("answers a repeated command id from the log and refuses a changed request", async () => {
    expect(await runCommand(db, note("n1", "first", "cmd-1"))).toBe("added:n1");
    expect(await runCommand(db, note("n1", "first", "cmd-1"))).toBe("added:n1");
    await expect(runCommand(db, note("n1", "changed", "cmd-1"))).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(runCommand(db, note("n1", "changed", "cmd-1"))).rejects.toBeInstanceOf(
      CommandConflictError,
    );
    expect(
      (await db.prepare("SELECT count(*) AS n FROM note WHERE id = 'n1'").first<{ n: number }>())
        ?.n,
    ).toBe(1);
  });

  it("refuses a command id reused by a different command with identical input", async () => {
    const input = { id: "x1", body: "same" };
    const first: Command<null, string> = { ...note("x1", "same", "cmd-x"), name: "note.add" };
    const other: Command<null, string> = {
      ...note("x1", "same", "cmd-x"),
      name: "note.other",
      decide: () => ({
        statements: [db.prepare("INSERT INTO note(id, body) VALUES ('x-other', 'never')")],
        result: () => "applied-other",
      }),
    };
    expect(first.input).toEqual(input);
    expect(other.input).toEqual(input);
    expect(await runCommand(db, first)).toBe("added:x1");
    await expect(runCommand(db, other)).rejects.toMatchObject({
      code: "idempotency_conflict",
      reason: "command_name",
    });
    // Same command, same input: the lost-ACK / retry path still answers from the log.
    expect(await runCommand(db, first)).toBe("added:x1");
    const row = await db
      .prepare("SELECT name FROM command_log WHERE command_id = 'cmd-x'")
      .first<{ name: string }>();
    expect(row?.name).toBe("note.add");
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM note WHERE id = 'x-other'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("hands plan.result only the effect results, never the command_log insert", async () => {
    const returning = (commandId?: string): Command<null, string> => ({
      name: "note.returning",
      input: { id: "r1" },
      ...(commandId === undefined ? {} : { commandId, now: 1 }),
      read: async () => null,
      decide: () => ({
        statements: [
          db.prepare("INSERT INTO note(id, body) VALUES ('r1', 'ret') RETURNING id, body"),
        ],
        result: (results) => {
          const rows = (results[0]?.results ?? []) as { id: string; body: string }[];
          return `${results.length}:${rows[0]?.id ?? "none"}:${rows[0]?.body ?? "none"}`;
        },
        logResult: { id: "r1" },
      }),
      fromLog: () => "from-log",
    });
    expect(await runCommand(db, returning("cmd-r"))).toBe("1:r1:ret");
    expect(await runCommand(db, returning("cmd-r"))).toBe("from-log");
  });

  it("requires fromLog for a command with an id when it has to answer from the log", async () => {
    const withoutReader: Command<null, string> = {
      ...note("n0", "zero", "cmd-0"),
      fromLog: undefined as never,
    };
    await runCommand(db, note("n0", "zero", "cmd-0"));
    await expect(runCommand(db, withoutReader)).rejects.toThrow(/needs fromLog/u);
  });

  it("recovers from a lost response through the command log", async () => {
    const stats = { attempts: 0, conflicts: 0, unknown: 0 };
    const result = await runCommand(losingResponses(db, 1), note("n2", "second", "cmd-2"), {
      sleep: noSleep,
      stats,
    });
    expect(result).toBe("added:n2");
    expect(stats.unknown).toBe(1);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM note WHERE id = 'n2'").first<{ n: number }>())
        ?.n,
    ).toBe(1);
  });

  it("recovers from a lost response through the natural key lookup", async () => {
    const result = await runCommand(losingResponses(db, 1), note("n3", "third"), {
      sleep: noSleep,
    });
    expect(result).toBe("added:n3");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM note WHERE id = 'n3'").first<{ n: number }>())
        ?.n,
    ).toBe(1);
  });

  it("reports store_outcome_unknown when the outcome cannot be resolved", async () => {
    const reader = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (): Promise<D1Result[]> => {
        throw new Error("Network connection lost");
      },
    };
    await expect(
      runCommand(reader, note("n4", "fourth"), { maxAttempts: 2, sleep: noSleep }),
    ).rejects.toBeInstanceOf(StoreOutcomeUnknownError);
  });

  it("returns the replay of a decided command and rethrows a rejection or an unknown failure", async () => {
    const replay: Command<null, string> = {
      name: "x",
      input: {},
      read: async () => null,
      decide: () => ({ replay: "again" }),
    };
    expect(await runCommand(db, replay)).toBe("again");
    const rejected: Command<null, string> = {
      name: "x",
      input: {},
      read: async () => null,
      decide: () => ({ reject: new RangeError("no") }),
    };
    await expect(runCommand(db, rejected)).rejects.toThrow("no");
    const broken: Command<null, string> = {
      name: "x",
      input: {},
      read: async () => null,
      decide: () => ({
        statements: [db.prepare("INSERT INTO missing_table VALUES (1)")],
        result: () => "never",
      }),
    };
    await expect(runCommand(db, broken)).rejects.toThrow(/no such table/u);
  });

  it("aborts the whole batch when a guard fires", async () => {
    const guarded: Command<null, string> = {
      name: "guarded",
      input: {},
      read: async () => null,
      decide: () => ({
        statements: [
          db.prepare("INSERT INTO note(id, body) VALUES ('g', 'x')"),
          guard(db, "claim_lost", "1"),
        ],
        result: () => "never",
      }),
    };
    await expect(runCommand(db, guarded)).rejects.toThrow(/guard_claim_lost/u);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM note WHERE id = 'g'").first<{ n: number }>())?.n,
    ).toBe(0);
  });
});

describe("classifyFailure", () => {
  it("separates guards, unique violations, transient faults and the rest", () => {
    expect(
      classifyFailure(
        new Error("D1_ERROR: CHECK constraint failed: guard_claim_lost: SQLITE_CONSTRAINT"),
      ),
    ).toEqual({ kind: "guard", code: "claim_lost" });
    expect(
      classifyFailure(new Error("UNIQUE constraint failed: note.id: SQLITE_CONSTRAINT")),
    ).toEqual({ kind: "unique", table: "note", columns: ["note.id"] });
    expect(classifyFailure("Network connection lost")).toEqual({ kind: "transient" });
    expect(classifyFailure(new Error("boom"))).toEqual({ kind: "other" });
  });

  it("treats the D1 timeout, memory and CPU reset messages as transient", () => {
    for (const message of [
      "D1 DB storage operation exceeded timeout which caused object to be reset",
      "isolate exceeded its memory limit and was reset",
      "isolate exceeded its CPU time limit and was reset",
      "exceeded its CPU time limit and was reset",
    ])
      expect(classifyFailure(new Error(message)), message).toEqual({ kind: "transient" });
  });

  it("does not treat an unrelated sentence that says something was reset as transient", () => {
    expect(classifyFailure(new Error("The customer password was reset."))).toEqual({
      kind: "other",
    });
    expect(
      classifyFailure(
        new Error("The CPU time limit was raised and the customer password was reset."),
      ),
    ).toEqual({ kind: "other" });
  });

  it("answers a command from its log when its batch committed before a storage reset", async () => {
    let resets = 1;
    const reset = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: Parameters<D1Database["batch"]>[0]) => {
        const results = await db.batch(statements);
        if (resets-- > 0)
          throw new Error(
            "D1 DB storage operation exceeded timeout which caused object to be reset",
          );
        return results;
      },
    } as unknown as D1Database;
    expect(await runCommand(reset, note("reset-after-commit", "kept", "cmd-reset"))).toBe(
      "added:reset-after-commit",
    );
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM note WHERE id = 'reset-after-commit'")
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });

  it("applies a command exactly once when a storage reset rejected its batch before it committed", async () => {
    const value = async () =>
      (await db.prepare("SELECT value FROM counter WHERE id = 'c'").first<{ value: number }>())
        ?.value;
    const before = (await value()) ?? 0;
    let resets = 1;
    const reset = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: Parameters<D1Database["batch"]>[0]) => {
        if (resets-- > 0)
          throw new Error(
            "D1 DB storage operation exceeded timeout which caused object to be reset",
          );
        return db.batch(statements);
      },
    } as unknown as D1Database;
    const bump: Command<null, number> = {
      name: "counter.bump",
      input: {},
      commandId: "cmd-reset-before-commit",
      now: 1,
      read: async () => null,
      decide: () => ({
        statements: [db.prepare("UPDATE counter SET value = value + 1 WHERE id = 'c'")],
        result: () => 1,
      }),
      fromLog: () => 1,
    };
    expect(await runCommand(reset, bump)).toBe(1);
    expect(await value()).toBe(before + 1);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM command_log WHERE command_id = 'cmd-reset-before-commit'",
        )
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
  });
});
