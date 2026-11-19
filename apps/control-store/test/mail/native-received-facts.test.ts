import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  createTestControl,
  migrationFiles,
  activateTestCore,
  type TestControl,
} from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import type { D1Database } from "../../src/d1-types.js";
import { mailFixture } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import { shiftStored } from "../../src/timestamps.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
async function fixture(target = control) {
  const f = await mailFixture(target),
    now = storedTimestamp(f.now).replace(/000Z$/u, "789Z");
  return {
    ...f,
    row: {
      message_id: newUlid(),
      provider_message_id: `received_${newUlid()}`,
      domain_id: f.domainId,
      organization_id: f.scope.organizationId,
      project_id: f.scope.projectId,
      environment_id: f.scope.environmentId,
      received_at: now,
      expires_at: shiftStored(now, 72 * 3600000),
      state: "pending",
      attempts: 0,
      first_attempt_at: null,
      lease_until: null,
      next_attempt_at: now,
      last_http_status: null,
      billed_at: null,
    },
  };
}
function native(row: Record<string, unknown>, db = control.core) {
  const names = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO mail_received_messages(${names.join(",")})VALUES(${names.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(row))
    .run();
}
it("stores all 15 original fields and defaults, preserves the 72-hour microseconds and imposes no provider-reference cap", async () => {
  const f = await fixture(),
    row = { ...f.row, provider_message_id: "opaque historical ü reference " + "x".repeat(300) };
  await native(row);
  // Every field returns exactly as stored, with the microseconds of the receipt and its 72-hour deadline.
  expect(
    await control.core
      .prepare("SELECT * FROM mail_received_messages WHERE message_id=?")
      .bind(row.message_id)
      .first(),
  ).toEqual(row);
  expect(row.received_at.endsWith("789Z")).toBe(true);
  expect(row.expires_at.endsWith("789Z")).toBe(true);
  const defaults = { ...f.row, message_id: newUlid(), provider_message_id: newUlid() } as Partial<
    typeof f.row
  >;
  delete defaults.state;
  delete defaults.attempts;
  await native(defaults);
  expect(
    await control.core
      .prepare("SELECT state,attempts FROM mail_received_messages WHERE message_id=?")
      .bind(defaults.message_id)
      .first(),
  ).toEqual({ state: "pending", attempts: 0 });
}, 120000);
it("refuses an inexact deadline, premature attempt, invalid HTTP status, foreign receiver and mutable message identity/attempt/HTTP/static receiver FK and immutable message identity refusals", async () => {
  const f = await fixture();
  for (const bad of [
    { expires_at: shiftStored(f.row.received_at, 72 * 3600000 - 1) },
    { first_attempt_at: f.row.received_at },
    { attempts: 1 },
    { last_http_status: 600 },
    { organization_id: newUlid() },
    { message_id: f.row.message_id + "\0suffix" },
    { provider_message_id: f.row.provider_message_id + "\0suffix" },
    { received_at: f.row.received_at + "\0suffix" },
    { expires_at: f.row.expires_at + "\0suffix" },
  ])
    await expect(native({ ...f.row, ...bad })).rejects.toThrow();
  await native(f.row);
  for (const [field, value] of [
    ["lease_until", f.row.received_at + "\0suffix"],
    ["billed_at", f.row.received_at + "\0suffix"],
  ])
    await expect(
      control.core
        .prepare(`UPDATE mail_received_messages SET ${field}=?2 WHERE message_id=?1`)
        .bind(f.row.message_id, value)
        .run(),
    ).rejects.toThrow();
  for (const sql of [
    "UPDATE mail_received_messages SET attempts=attempts+2 WHERE message_id=?",
    "UPDATE mail_received_messages SET provider_message_id='changed' WHERE message_id=?",
  ])
    await expect(control.core.prepare(sql).bind(f.row.message_id).run()).rejects.toThrow();
}, 120000);
it("refuses a populated received prototype before any drop and preserves the entire schema and row bytes", async () => {
  const engine = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('local');}}",
    d1Databases: { CORE: "before-received" },
  });
  try {
    const db = (await engine.getD1Database("CORE")) as unknown as D1Database,
      files = migrationFiles("core"),
      migration = files.find((f) => f.name === "0470_mail_received_original_facts.sql");
    if (!migration) throw new Error("Received migration missing");
    for (const f of files.filter((f) => f.name !== migration.name))
      await db.batch(splitStatements(f.sql).map((sql) => db.prepare(sql)));
    await activateTestCore(db);
    const target: TestControl = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db },
        dispose: async () => {},
      },
      f = await fixture(target);
    await native(f.row, db);
    const snapshot = async () =>
        JSON.stringify({
          schema: (await db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all())
            .results,
          rows: (await db.prepare("SELECT * FROM mail_received_messages ORDER BY message_id").all())
            .results,
        }),
      before = await snapshot();
    await expect(
      db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql))),
    ).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  } finally {
    await engine.dispose();
  }
}, 120000);
