import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CORE_BINDING, CORE_LAYOUT, CoreConfigurationError } from "../src/core.js";
import { BUCKET_COUNT, SharedCoreRouter, bucketOf } from "../src/router.js";
import { BucketFencedError } from "../src/fence.js";
import {
  createTestControl,
  organizationIdWithShard,
  type TestControl,
} from "./support/control-d1.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

describe("shared core routing", () => {
  it("hashes an organization id to the same bucket as an independent SHA-256 computation", async () => {
    for (const id of [
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
      "00000000000000000000000000",
    ]) {
      const expected = createHash("sha256").update(id).digest().readUInt32BE(0) % BUCKET_COUNT;
      expect(await bucketOf(id)).toBe(expected);
    }
  });

  it("routes every organization, whatever its bucket, to the one core with its own bucket fence", async () => {
    const router = new SharedCoreRouter(control.core);
    for (const [index, seed] of [100, 200, 300].entries()) {
      const id = await organizationIdWithShard(2, index % 2, seed);
      const route = await router.routeOrganization(id);
      expect(route).toMatchObject({
        layout: CORE_LAYOUT,
        shardId: 0,
        binding: CORE_BINDING,
        bucket: await bucketOf(id),
      });
    }
    const bucket = await bucketOf("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await control.core
      .prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moving', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '2026-10-28T12:00:00.000000Z')",
      )
      .bind(bucket)
      .run();
    try {
      const fenced = await router.routeBucket(bucket);
      await expect(
        fenced.db.prepare("INSERT INTO guard_fail(code) SELECT 'claim_lost' WHERE 0").run(),
      ).rejects.toBeInstanceOf(BucketFencedError);
    } finally {
      await control.core.prepare("DELETE FROM bucket_fences WHERE bucket = ?").bind(bucket).run();
    }
  });

  it("routes the one partition raw and refuses every other partition and bucket", async () => {
    const router = new SharedCoreRouter(control.core);
    expect(await router.routeShard(0)).toMatchObject({
      shardId: 0,
      binding: CORE_BINDING,
      bucket: null,
    });
    await expect(router.routeShard(1)).rejects.toThrow(/shard 1 does not exist/u);
    await expect(router.routeBucket(BUCKET_COUNT)).rejects.toThrow(/bucket 1024 has no shard/u);
    await expect(router.routeBucket(-1)).rejects.toThrow(/bucket -1 has no shard/u);
    await expect(router.routeBucket(1.5)).rejects.toThrow(/has no shard/u);
    expect(router.invalidate()).toBeUndefined();
  });

  it("proves the layout once, and refuses a database that is not shared-core-v1 without caching the refusal", async () => {
    let reads = 0;
    const counting = {
      prepare: (sql: string) => {
        if (sql.includes("core_layout")) reads += 1;
        return control.core.prepare(sql);
      },
      batch: control.core.batch.bind(control.core),
    };
    const router = new SharedCoreRouter(counting);
    await router.routeShard(0);
    await router.routeOrganization("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(reads).toBe(1);

    let healthy = false;
    const flaky = {
      prepare: (sql: string) => {
        if (sql.includes("core_layout") && !healthy) throw new Error("Network connection lost");
        return control.core.prepare(sql);
      },
      batch: control.core.batch.bind(control.core),
    };
    const retried = new SharedCoreRouter(flaky);
    await expect(retried.assertLayout()).rejects.toThrow(/Network connection lost/u);
    healthy = true;
    await expect(retried.assertLayout()).resolves.toBeUndefined();
    await expect(retried.assertLayout()).resolves.toBeUndefined();
    expect(new CoreConfigurationError("x").code).toBe("core_configuration");
  });
});
