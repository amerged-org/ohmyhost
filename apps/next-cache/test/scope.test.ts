import { expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public readonly ctx: unknown,
      public readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      public readonly ctx: unknown,
      public readonly env: unknown,
    ) {}
  },
}));
import {
  NextCacheRuntime,
  NextCacheRetirementRuntime,
  NextCacheObject,
} from "../src/worker-main.js";

it("uses the exact platform scope's restricted jurisdiction and location for customer and retirement RPC", async () => {
  const calls: unknown[] = [];
  const stub = {
    get: (input: unknown) => {
      calls.push(["get", input]);
      return Promise.resolve({ kind: "missing", generation: 0 });
    },
    put: (input: unknown) => {
      calls.push(["put", input]);
      return Promise.resolve({ kind: "stored", generation: 0, lastModified: 1 });
    },
    delete: (input: unknown) => {
      calls.push(["delete", input]);
      return Promise.resolve({ kind: "deleted", generation: 1 });
    },
    readTags: (input: unknown) => {
      calls.push(["readTags", input]);
      return Promise.resolve({ tags: [], generation: 0 });
    },
    writeTags: (input: unknown) => {
      calls.push(["writeTags", input]);
      return Promise.resolve({ generation: 1, revalidatedAt: 2 });
    },
    retire: () => {
      calls.push(["retire"]);
      return Promise.resolve({ kind: "retired" });
    },
  };
  const bindings = {
    NEXT_CACHE_OBJECT: {
      jurisdiction: (region: string) => {
        calls.push(["jurisdiction", region]);
        return {
          getByName: (name: string, options: unknown) => {
            calls.push(["name", name, options]);
            return stub;
          },
        };
      },
    },
    NEXT_CACHE_RETIREMENT_AUTHORITY: {
      authorizeRetirement: (input: unknown) => {
        calls.push(["authorize", input]);
        return Promise.resolve({ region: "us" });
      },
    },
  };
  const props = {
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    region: "eu",
  };
  const eu = new NextCacheRuntime({ props } as never, bindings as never);
  expect(await eu.get({ key: "/", cacheType: "cache" })).toEqual({
    kind: "missing",
    generation: 0,
  });
  expect(calls).toEqual([
    ["jurisdiction", "eu"],
    [
      "name",
      `eu:${props.organizationId}:${props.projectId}:${props.environmentId}:${props.deploymentId}`,
      { locationHint: "weur" },
    ],
    ["get", { key: "/", cacheType: "cache" }],
  ]);
  calls.length = 0;
  await eu.put({ marker: 1 });
  await eu.delete({ marker: 2 });
  await eu.readTags({ marker: 3 });
  await eu.writeTags({ marker: 4 });
  expect(
    calls.filter(
      (call) =>
        Array.isArray(call) && ["put", "delete", "readTags", "writeTags"].includes(String(call[0])),
    ),
  ).toEqual([
    ["put", { marker: 1 }],
    ["delete", { marker: 2 }],
    ["readTags", { marker: 3 }],
    ["writeTags", { marker: 4 }],
  ]);
  calls.length = 0;
  const us = new NextCacheRetirementRuntime({ props: {} } as never, bindings as never);
  const input = {
    organizationId: props.organizationId,
    projectId: props.projectId,
    environmentId: props.environmentId,
    deploymentId: props.deploymentId,
    operationId: props.deploymentId,
    cleanupRunId: props.projectId,
  };
  expect(await us.retire(input)).toEqual({ kind: "retired" });
  expect(calls).toEqual([
    ["authorize", input],
    ["jurisdiction", "us"],
    [
      "name",
      `us:${props.organizationId}:${props.projectId}:${props.environmentId}:${props.deploymentId}`,
      { locationHint: "enam" },
    ],
    ["retire"],
  ]);
  calls.length = 0;
  const unavailable = new NextCacheRetirementRuntime(
    { props: {} } as never,
    { NEXT_CACHE_OBJECT: bindings.NEXT_CACHE_OBJECT } as never,
  );
  await expect(unavailable.retire(input)).rejects.toThrow();
  expect(calls).toEqual([]);
  const invalid = new NextCacheRuntime(
    { props: { ...props, region: "global" } } as never,
    bindings as never,
  );
  expect(() => invalid.get({ key: "/", cacheType: "cache" })).toThrow("NEXT_CACHE_INVALID");
});

it("rolls back a failed multi-chunk replacement and permanently fences a retired scope", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const storage = {
      sql: {
        exec: (query: string, ...raw: unknown[]) => {
          if (query.startsWith("CREATE TABLE IF NOT EXISTS cache_meta")) {
            db.exec(query);
            return { toArray: () => [] };
          }
          const statement = db.prepare(query);
          const params = raw.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ) as SQLInputValue[];
          if (/^SELECT\b/u.test(query)) return { toArray: () => statement.all(...params) };
          statement.run(...params);
          return { toArray: () => [] };
        },
      },
      transactionSync: <T>(callback: () => T): T => {
        db.exec("BEGIN");
        try {
          const result = callback();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const object = new NextCacheObject({ storage } as never, {} as never);
    const key = "/article",
      cacheType = "cache";
    expect(object.get({ key, cacheType })).toEqual({ kind: "missing", generation: 0 });
    const first = JSON.stringify({ html: "original" });
    object.put({ key, cacheType, valueJson: first, expectedGeneration: 0 });
    db.exec(
      "CREATE TRIGGER fail_chunk BEFORE INSERT ON cache_chunks WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'fixture_chunk_failure'); END",
    );
    const large = JSON.stringify({ html: "x".repeat(1_100_000) });
    expect(() => object.put({ key, cacheType, valueJson: large, expectedGeneration: 0 })).toThrow(
      "fixture_chunk_failure",
    );
    expect(object.get({ key, cacheType })).toMatchObject({
      kind: "value",
      valueJson: first,
      entryGeneration: 0,
    });
    db.exec("DROP TRIGGER fail_chunk");
    object.put({ key, cacheType, valueJson: large, expectedGeneration: 0 });
    expect(object.get({ key, cacheType })).toMatchObject({ kind: "value", valueJson: large });
    expect(object.writeTags({ tags: [{ tag: "_N_T_/article", expire: 10 }] })).toMatchObject({
      generation: 1,
    });
    expect(object.readTags({ tags: ["_N_T_/article"] })).toMatchObject({
      generation: 1,
      tags: [{ generation: 1, expire: 10 }],
    });
    expect(() => object.put({ key, cacheType, valueJson: first, expectedGeneration: 0 })).toThrow(
      "NEXT_CACHE_STALE_WRITE",
    );
    expect(object.delete({ key, expectedGeneration: 1 })).toEqual({
      kind: "deleted",
      generation: 2,
    });
    expect(object.get({ key, cacheType })).toEqual({ kind: "tombstone", generation: 2 });
    expect(object.retire()).toEqual({ kind: "retired" });
    expect(object.retire()).toEqual({ kind: "retired" });
    expect(() => object.readTags({ tags: [] })).toThrow("NEXT_CACHE_RETIRED");
    expect(() => object.get({ key, cacheType })).toThrow("NEXT_CACHE_RETIRED");
  } finally {
    db.close();
  }
});
