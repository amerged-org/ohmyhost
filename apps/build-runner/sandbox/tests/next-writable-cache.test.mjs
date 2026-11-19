import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { createWritableNextCaches } from "../next-writable-cache.mjs";

function setup() {
  const als = new AsyncLocalStorage();
  const prior = globalThis.__openNextAls;
  globalThis.__openNextAls = als;
  let generation = 0;
  let timestamp = 100;
  const values = new Map();
  const tags = new Map();
  const binding = {
    async get({ key, cacheType }) {
      const item = values.get(`${cacheType}:${key}`);
      return item === undefined ? { kind: "missing", generation } : { ...item, generation };
    },
    async put({ key, cacheType, valueJson, expectedGeneration }) {
      if (expectedGeneration !== generation) throw new Error("stale generation");
      const lastModified = ++timestamp;
      values.set(`${cacheType}:${key}`, {
        kind: "value",
        entryGeneration: generation,
        lastModified,
        valueJson,
      });
      return { kind: "stored", generation, lastModified };
    },
    async delete({ key, expectedGeneration }) {
      if (expectedGeneration !== generation) throw new Error("stale generation");
      generation++;
      values.set(`cache:${key}`, { kind: "tombstone" });
      return { kind: "deleted", generation };
    },
    async readTags({ tags: names }) {
      return { tags: names.map((name) => tags.get(name) ?? null), generation };
    },
    async writeTags({ tags: input }) {
      generation++;
      for (const item of input)
        tags.set(item.tag, {
          tag: item.tag,
          revalidatedAt: 500,
          stale: item.stale ?? null,
          expire: item.expire ?? null,
          generation,
        });
      return { generation, revalidatedAt: 500 };
    },
  };
  const staticAssets = { getAssetUrl: (key) => `https://assets.invalid/${key}` };
  const context = {
    env: {
      OHMYHOST_NEXT_CACHE: binding,
      ASSETS: {
        async fetch() {
          return globalThis.Response.json({ type: "app", html: "build" });
        },
      },
    },
  };
  const caches = createWritableNextCaches({ getContext: () => context, staticAssets });
  const run = (work) =>
    als.run(
      {
        requestCache: {
          maps: new Map(),
          getOrCreate(name) {
            if (!this.maps.has(name)) this.maps.set(name, new Map());
            return this.maps.get(name);
          },
        },
      },
      work,
    );
  return {
    ...caches,
    run,
    binding,
    context,
    restore: () => {
      globalThis.__openNextAls = prior;
    },
  };
}

test("private cache falls back only on missing build assets and fences writes across invalidation", async () => {
  const f = setup();
  try {
    await f.run(async () => {
      assert.deepEqual(await f.incrementalCache.get("/page", "cache"), {
        value: { type: "app", html: "build" },
        lastModified: 1,
      });
      assert.equal(await f.tagCache.hasBeenRevalidated(["_N_T_/page"], 1), false);
      await f.tagCache.writeTags([{ tag: "_N_T_/page", expire: 0 }]);
      assert.equal(await f.tagCache.hasBeenRevalidated(["_N_T_/page"], 1), true);
      await assert.rejects(
        f.incrementalCache.set("/page", { type: "app", html: "stale" }, "cache"),
        /stale generation/u,
      );
    });
    await f.run(async () => {
      await f.incrementalCache.get("/page", "cache");
      await f.incrementalCache.set("/page", { type: "app", html: "new" }, "cache");
      const entry = await f.incrementalCache.get("/page", "cache");
      assert.equal(entry.value.html, "new");
      assert.equal(await f.tagCache.hasBeenRevalidated(["_N_T_/page"], entry.lastModified), false);
      await f.incrementalCache.delete("/page");
      assert.equal(await f.incrementalCache.get("/page", "cache"), null);
    });
  } finally {
    f.restore();
  }
});

test("cache failures and missing request generation fail closed", async () => {
  const f = setup();
  try {
    await f.run(async () => {
      assert.equal(await f.incrementalCache.get("private-value", "composable"), null);
      await assert.doesNotReject(
        f.incrementalCache.set("private-value", { value: "private" }, "composable"),
      );
      await assert.rejects(
        f.incrementalCache.set("/unread", { type: "app", html: "x" }, "cache"),
        /generation/u,
      );
      await assert.rejects(f.incrementalCache.delete("/unread"), /generation/u);
      await assert.rejects(f.tagCache.hasBeenRevalidated(["_N_T_/x"], 123), /generation/u);
      f.context.env.ASSETS.fetch = async () =>
        new globalThis.Response("unavailable", { status: 503 });
      await assert.rejects(f.incrementalCache.get("/x", "cache"), /asset/u);
      f.binding.readTags = async () => {
        throw new Error("backend unavailable");
      };
      await assert.rejects(f.tagCache.getLastRevalidated(["_N_T_/x"]), /backend unavailable/u);
    });
    f.context.env.ASSETS.fetch = async () =>
      globalThis.Response.json({ type: "app", html: "seed" });
    for (const operation of ["put", "delete"]) {
      await f.run(async () => {
        await f.incrementalCache.get("/failing", "cache");
        f.binding[operation] = async () => {
          throw new Error(`cache ${operation} unavailable`);
        };
        const attempt =
          operation === "put"
            ? f.incrementalCache.set("/failing", { type: "app", html: "fresh" }, "cache")
            : f.incrementalCache.delete("/failing");
        await assert.rejects(attempt, /unavailable/u);
        const tracked = globalThis.__openNextAls
          .getStore()
          .requestCache.getOrCreate("ohmyhost-next-cache:pending-invalidations");
        assert.equal(tracked.size, 1);
        await assert.rejects([...tracked.values()][0], /unavailable/u);
      });
    }
  } finally {
    f.restore();
  }
});
