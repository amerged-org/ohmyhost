import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { subjectSuppressionKey, type GrowthD1 } from "../src/event-store.js";
import { appendUsageRecord, enqueueUsageErasure } from "../src/usage-store.js";
import {
  archiveUsage,
  cleanupErasedUsage,
  expireUsageArchives,
  type UsageArchiveBucket,
} from "../src/usage-archive.js";

async function setup() {
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    createRequire(manifest).resolve("wrangler/package.json"),
  )("miniflare");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "growth",
          modules: true,
          script: "export default { fetch(){return new Response()} }",
          d1Databases: { DB: "db" },
        },
      ],
    }),
  );
  const db = (await mf.getD1Database("DB", "growth")) as GrowthD1;
  for (const file of ["0001_growth.sql", "0007_usage_log.sql"])
    await db.batch(
      splitStatements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).map(
        (sql) => db.prepare(sql),
      ),
    );
  const objects = new Map<string, string>();
  const bucket: UsageArchiveBucket = {
    async put(key, value) {
      objects.set(key, value);
      return { size: new TextEncoder().encode(value).byteLength };
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
    async list({ prefix, limit }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return {
        objects: keys.slice(0, limit).map((key) => ({ key })),
        truncated: keys.length > limit,
      };
    },
  };
  return { mf, db, objects, bucket };
}
const now = new Date("2026-11-16T00:00:00.000Z");
function record(n: number) {
  return {
    schema_version: 1,
    record_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    invocation_id: "00000000-0000-4000-8000-000000000001",
    parent_invocation_id: null,
    phase: "started",
    occurred_at: now.toISOString(),
    started_at: now.toISOString(),
    platform_environment: "development",
    transport: "rest",
    operation: "createProject",
    account_id: "user_one",
    organization_id: null,
    project_id: null,
    operation_id: null,
    operation_status: null,
    outcome: "started",
    duration_ms: null,
    http_status: null,
    error_code: null,
    platform_version: null,
  };
}
it("validates minimized records and preserves replay receipts after archiving", async () => {
  const { mf, db, bucket, objects } = await setup();
  try {
    expect(await appendUsageRecord(db, record(1), now)).toBe("inserted");
    expect(await appendUsageRecord(db, record(1), now)).toBe("duplicate");
    expect(await appendUsageRecord(db, { ...record(1), operation: "otherOperation" }, now)).toBe(
      "conflict",
    );
    await expect(
      appendUsageRecord(db, { ...record(2), raw_body: "secret" }, now),
    ).rejects.toThrow();
    await expect(
      appendUsageRecord(
        db,
        {
          ...record(3),
          phase: "finished",
          outcome: "failed",
          duration_ms: 1,
          http_status: 403,
          error_code: "private@example.test",
        },
        now,
      ),
    ).rejects.toThrow();
    expect(
      await appendUsageRecord(
        db,
        {
          ...record(4),
          phase: "finished",
          outcome: "failed",
          duration_ms: 1,
          http_status: 403,
          error_code: "forbidden",
        },
        now,
      ),
    ).toBe("inserted");
    await archiveUsage(db, bucket, now);
    expect(objects.size).toBe(1);
    expect(await appendUsageRecord(db, record(1), now)).toBe("duplicate");
  } finally {
    await mf.dispose();
  }
});
it("retains failed puts and exports late arrivals in the next window", async () => {
  const { mf, db, bucket, objects } = await setup();
  try {
    await appendUsageRecord(db, record(1), now);
    await expect(
      archiveUsage(
        db,
        {
          ...bucket,
          put: async () => {
            throw new Error("outage");
          },
        },
        now,
      ),
    ).rejects.toThrow("outage");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_usage_records").first<{ n: number }>())
        ?.n,
    ).toBe(1);
    await expect(archiveUsage(db, { ...bucket, put: async () => null }, now)).rejects.toThrow(
      "usage_archive_unconfirmed",
    );
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_usage_records").first<{ n: number }>())
        ?.n,
    ).toBe(1);
    await appendUsageRecord(db, record(2), now);
    await archiveUsage(db, bucket, now);
    expect(objects.size).toBe(1);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_usage_records").first<{ n: number }>())
        ?.n,
    ).toBe(1);
    await archiveUsage(db, bucket, new Date(now.getTime() + 86400000));
    expect(objects.size).toBe(2);
    await expireUsageArchives(db, bucket, new Date(now.getTime() + 90 * 86400000));
    expect(objects.size).toBe(1);
    await expireUsageArchives(db, bucket, new Date(now.getTime() + 91 * 86400000));
    expect(objects.size).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_usage_archive_index")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});
it("erases archives when deletion races a put and prevents replay", async () => {
  const { mf, db, bucket, objects } = await setup();
  try {
    const subject = await subjectSuppressionKey("user_one");
    await appendUsageRecord(db, record(1), now);
    await archiveUsage(
      db,
      {
        ...bucket,
        put: async (key, value) => {
          await db.batch([
            db
              .prepare("INSERT INTO growth_subject_suppression VALUES(?,?)")
              .bind(subject, now.toISOString()),
            ...enqueueUsageErasure(db, subject, now),
          ]);
          objects.set(key, value);
          return { size: new TextEncoder().encode(value).byteLength };
        },
      },
      now,
    );
    expect(objects.size).toBe(0);
    expect(await appendUsageRecord(db, record(1), now)).toBe("suppressed");
    // A killed exporter can leave an unindexed object after the tombstone.
    objects.set(`usage/v1/subject=${subject}/orphan.ndjson`, JSON.stringify(record(1)));
    // Replayed deletion signals must not restart the one-hour privacy grace.
    await db.batch(enqueueUsageErasure(db, subject, new Date(now.getTime() + 3599000)));
    await cleanupErasedUsage(db, bucket, new Date(now.getTime() + 3599000));
    expect(objects.size).toBe(1);
    await cleanupErasedUsage(db, bucket, new Date(now.getTime() + 3600000));
    expect(objects.size).toBe(0);
    await cleanupErasedUsage(db, bucket, new Date(now.getTime() + 3900000));
    expect(
      (
        await db
          .prepare("SELECT completed_at FROM growth_usage_erasure WHERE subject_key=?")
          .bind(subject)
          .first<{ completed_at: string }>()
      )?.completed_at,
    ).toBeTruthy();
  } finally {
    await mf.dispose();
  }
});
