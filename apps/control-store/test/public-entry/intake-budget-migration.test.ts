import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

import type { D1Database } from "../../src/d1-types.js";
import { migrationFiles } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";

const apply = (db: D1Database, select: (name: string) => boolean) =>
  migrationFiles("core")
    .filter(({ name }) => select(name))
    .reduce(
      (done, file) =>
        done.then(async () => {
          await db.batch(splitStatements(file.sql).map((statement) => db.prepare(statement)));
        }),
      Promise.resolve(),
    );

it("counts the rows that exist when migration 0632 is applied and keeps the budget equal to them afterwards", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CONTROL_CORE: "intake" },
  });
  try {
    const db = (await miniflare.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    await apply(db, (name) => name < "0632");
    // Rows of the schema before the migration: two contact requests on one day, one on another, and two votes.
    const at = (day: string) => `${day}T10:00:00.000000Z`;
    const contact = (n: number, day: string) =>
      db
        .prepare(
          "INSERT INTO contact_requests(request_id,payload_sha256,name,email,company,message,created_at,expires_at) VALUES(?,zeroblob(32),'Reader','reader@example.com','','Hello',?,?)",
        )
        .bind(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, at(day), at("2029-03-01"));
    const vote = (n: number, day: string) =>
      db
        .prepare(
          "INSERT INTO beta_feature_interests(idempotency_key,feature,created_at,voter_sha256,choice,position,expires_at) VALUES(?,'eu',?,zeroblob(32),'up',?,?)",
        )
        .bind(
          `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
          at(day),
          n,
          at("2029-03-01"),
        );
    await db.batch([
      contact(1, "2028-03-01"),
      contact(2, "2028-03-01"),
      contact(3, "2028-03-02"),
      vote(1, "2028-03-01"),
      vote(2, "2028-03-01"),
    ]);
    await apply(db, (name) => name === "0638_public_intake_budget.sql");
    const budget = async () =>
      (
        await db
          .prepare("SELECT kind,bucket,day,entries FROM public_intake_budget ORDER BY 1,2,3")
          .all()
      ).results;
    // Existing rows carry the -2 marker, not a real bucket: they count in the pool sums and in no bucket a visitor hashes into.
    expect(await budget()).toEqual([
      { kind: "contact", bucket: -2, day: "2028-03-01", entries: 2 },
      { kind: "contact", bucket: -2, day: "2028-03-02", entries: 1 },
      { kind: "contact", bucket: -2, day: "total", entries: 3 },
      { kind: "contact", bucket: -1, day: "2028-03-01", entries: 2 },
      { kind: "contact", bucket: -1, day: "2028-03-02", entries: 1 },
      { kind: "contact", bucket: -1, day: "total", entries: 3 },
      { kind: "vote", bucket: -2, day: "2028-03-01", entries: 2 },
      { kind: "vote", bucket: -2, day: "total", entries: 2 },
      { kind: "vote", bucket: -1, day: "2028-03-01", entries: 2 },
      { kind: "vote", bucket: -1, day: "total", entries: 2 },
    ]);
    // New rows and deleted rows move the same counters, of their own bucket and of all buckets.
    await db
      .prepare(
        "INSERT INTO contact_requests(request_id,payload_sha256,name,email,company,message,created_at,expires_at,source_bucket) VALUES('00000000-0000-4000-8000-000000000009',zeroblob(32),'Reader','reader@example.com','','Hello',?,?,5)",
      )
      .bind(at("2028-03-02"), at("2029-03-02"))
      .run();
    const counter = async (bucket: number, day: string) =>
      (
        await db
          .prepare(
            "SELECT entries FROM public_intake_budget WHERE kind='contact' AND bucket=? AND day=?",
          )
          .bind(bucket, day)
          .first<{ entries: number }>()
      )?.entries;
    expect([await counter(5, "total"), await counter(-1, "total")]).toEqual([1, 4]);
    expect([await counter(5, "2028-03-02"), await counter(-1, "2028-03-02")]).toEqual([1, 2]);
    // A Worker that predates the column still inserts during the rollout; its rows take the marker, not a real bucket.
    await db.batch([
      db
        .prepare(
          "INSERT INTO contact_requests(request_id,payload_sha256,name,email,company,message,created_at,expires_at) VALUES('00000000-0000-4000-8000-00000000000a',zeroblob(32),'Reader','reader@example.com','','Hello',?,?)",
        )
        .bind(at("2028-03-02"), at("2029-03-02")),
      db
        .prepare(
          "INSERT INTO beta_feature_interests(idempotency_key,feature,created_at,voter_sha256,choice,position,expires_at) VALUES('00000000-0000-4000-8000-00000000000b','eu',?,zeroblob(32),'up',9,?)",
        )
        .bind(at("2028-03-02"), at("2029-03-02")),
    ]);
    expect(
      (await db.prepare("SELECT source_bucket FROM contact_requests ORDER BY request_id").all())
        .results,
    ).toEqual([
      { source_bucket: -2 },
      { source_bucket: -2 },
      { source_bucket: -2 },
      { source_bucket: 5 },
      { source_bucket: -2 },
    ]);
    // Every counter still equals the rows: the pool sum, and the buckets and the marker together.
    for (const [kind, table] of [
      ["contact", "contact_requests"],
      ["vote", "beta_feature_interests"],
    ] as const) {
      const total = (where: string) =>
        `(SELECT sum(entries) FROM public_intake_budget WHERE kind='${kind}' AND day='total' AND ${where})`;
      expect(
        await db
          .prepare(
            `SELECT (SELECT count(*) FROM ${table}) AS rows, ${total("bucket=-1")} AS pool, ${total("bucket<>-1")} AS buckets`,
          )
          .first(),
      ).toEqual(
        kind === "contact" ? { rows: 5, pool: 5, buckets: 5 } : { rows: 3, pool: 3, buckets: 3 },
      );
    }
    expect([await counter(-2, "total"), await counter(5, "total")]).toEqual([4, 1]);
    await db.prepare("DELETE FROM contact_requests").run();
    await db.prepare("DELETE FROM beta_feature_interests").run();
    expect(await budget()).toEqual([]);
  } finally {
    await miniflare.dispose();
  }
}, 120_000);
