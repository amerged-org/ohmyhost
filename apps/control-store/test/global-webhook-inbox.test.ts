import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";

import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";
import type { D1Database } from "../src/d1-types.js";
import { createTestControl, migrationFiles, type TestControl } from "./support/control-d1.js";
import { splitStatements } from "./support/sql.js";
import { seedProject, STORED_NOW, ulidOf } from "./support/platform-fixtures.js";
import { purgeUnroutedInbox } from "../src/catalog/operations/retention.js";
import { SharedCoreRouter } from "../src/router.js";

let control: TestControl;
let pg: TestPostgres;
beforeAll(async () => {
  control = await createTestControl();
  pg = await startTestPostgres();
}, 240_000);
afterAll(async () => {
  await Promise.all([control?.dispose(), pg?.stop()]);
});

const AT = "2026-01-02T03:04:05.123456Z";
const SIGNED = "2026-01-02T03:04:00.654321Z";
const fields = [
  "inbox_event_id",
  "provider",
  "external_event_id",
  "event_type",
  "payload",
  "body_sha256",
  "received_at",
  "signature_timestamp",
  "state",
  "attempt_count",
  "max_attempts",
  "available_at",
  "claim_id",
  "claimed_at",
  "lease_expires_at",
  "last_error_code",
  "acknowledged_at",
] as const;

const insert = `INSERT INTO webhook_inbox(${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`;
const pgInsert = `INSERT INTO webhook_inbox(${fields.join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})`;
const snapshotSql = `SELECT ${fields.map((f) => (f === "body_sha256" ? "lower(hex(body_sha256)) AS body_sha256" : f)).join(",")} FROM webhook_inbox ORDER BY inbox_event_id`;

/** Original 17 facts only: routing metadata can never become an imported source field. */
async function facts(db: D1Database) {
  return (await db.prepare(snapshotSql).all()).results.map((r) => ({
    ...r,
    payload: JSON.parse(String(r["payload"])) as unknown,
  }));
}

async function populatedPrefix() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CONTROL_CORE: "before-global-inbox" },
  });
  const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  try {
    for (const file of migrationFiles("core").filter((f) => f.name < "0326"))
      await db.batch(splitStatements(file.sql).map((s) => db.prepare(s)));
    const fixture: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db },
      dispose: () => mf.dispose(),
    };
    const project = await seedProject(fixture);
    const inboxId = ulidOf("old-global-inbox", 1),
      connection = ulidOf("inbox-source", 1),
      operation = ulidOf("inbox-operation", 1);
    await db.batch([
      db
        .prepare(
          "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?,?,?,?,'github','123456',?)",
        )
        .bind(
          project.organizationId,
          connection,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?,?,?,?,?,'github','12345','123456','fixture','fixture','read',?)",
        )
        .bind(
          project.organizationId,
          ulidOf("inbox-grant", 1),
          project.projectId,
          project.billingEpochId,
          connection,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)",
        )
        .bind(
          project.organizationId,
          operation,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
          STORED_NOW,
        ),
      db
        .prepare(
          "INSERT INTO webhook_inbox(organization_id,inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at) VALUES(?,?,'workos','old-schema-event','unknown.historical','{\"preserve\":true}',?,? ,?,'pending',0,10,?)",
        )
        .bind(project.organizationId, inboxId, new Uint8Array(32).fill(7), AT, SIGNED, AT),
      // The original FK does not encode provider or routing authority. This DB-valid child tests only byte/FK preservation.
      db
        .prepare(
          "INSERT INTO github_push_deployments(organization_id,push_deployment_id,inbox_event_id,project_id,source_connection_id,config_generation,delivery_guid,github_installation_id,external_repository_id,branch_ref,commit_sha,sequence,operation_id,state,cleanup_required,created_at,updated_at) VALUES(?,?,?,?,?,1,'fixture-guid','12345','123456','refs/heads/main',?,1,?,'queued',0,?,?)",
        )
        .bind(
          project.organizationId,
          ulidOf("inbox-push", 1),
          inboxId,
          project.projectId,
          connection,
          "ab".repeat(20),
          operation,
          STORED_NOW,
          STORED_NOW,
        ),
    ]);
    return { db, project, inboxId, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

it("retains the original global PostgreSQL inbox facts without an organization or fabricated signature time", async () => {
  const originalColumns = (
    await pg.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='webhook_inbox' ORDER BY ordinal_position",
    )
  ).rows.map((r: { column_name: string }) => r.column_name);
  expect(originalColumns).toEqual(fields);
  const coreColumns = (
    await control.core
      .prepare("PRAGMA table_info(webhook_inbox)")
      .all<{ name: string; pk: number; notnull: number }>()
  ).results;
  expect(coreColumns.slice(0, 17).map((r) => r.name)).toEqual(fields);
  expect(coreColumns.filter((r) => r.pk).map((r) => r.name)).toEqual(["inbox_event_id"]);
  // 0740 appends park_count after organization_id; the original facts and the nullable organization stay as they were.
  expect(coreColumns.at(-2)).toMatchObject({ name: "organization_id", pk: 0, notnull: 0 });
  expect(coreColumns.at(-1)).toMatchObject({ name: "park_count", pk: 0, notnull: 1 });
  for (const [index, provider] of ["workos", "github", "stripe"].entries()) {
    const id = String(index + 100).padStart(26, "0");
    const payload = { future: true, data: { id: "non_organization_event" } };
    const signature = provider === "workos" ? SIGNED : null;
    const digest = new Uint8Array(32).fill(index + 1);
    const values = [
      id,
      provider,
      `global-${provider}`,
      "unknown.historical",
      JSON.stringify(payload),
      digest,
      AT,
      signature,
      "pending",
      0,
      10,
      AT,
      null,
      null,
      null,
      null,
      null,
    ];
    await pg.pool.query(
      pgInsert,
      values.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v)),
    );
    await control.core
      .prepare(insert)
      .bind(...values)
      .run();
    const row = await control.core
      .prepare(
        "SELECT organization_id, signature_timestamp, received_at, event_type, payload, lower(hex(body_sha256)) digest FROM webhook_inbox WHERE inbox_event_id=?",
      )
      .bind(id)
      .first<{
        organization_id: string | null;
        signature_timestamp: string | null;
        received_at: string;
        event_type: string;
        payload: string;
        digest: string;
      }>();
    expect(row).toMatchObject({
      organization_id: null,
      signature_timestamp: signature,
      received_at: AT,
      event_type: "unknown.historical",
      digest: Buffer.from(digest).toString("hex"),
    });
    expect(JSON.parse(row?.payload ?? "")).toEqual(payload);
  }

  // All source states, including pre-poller auth acknowledgement (006), unknown JSON and final attempts.
  const stateCases = [
    {
      state: "processing",
      attempt: 1,
      max: 3,
      claim: ulidOf("global-claim", 1),
      claimed: AT,
      lease: "2026-01-02T03:06:05.123456Z",
      error: null,
      ack: null,
    },
    {
      state: "retry_wait",
      attempt: 2,
      max: 3,
      claim: null,
      claimed: SIGNED,
      lease: AT,
      error: "HISTORICAL_ERROR",
      ack: null,
    },
    {
      state: "acknowledged",
      attempt: 0,
      max: 1,
      claim: null,
      claimed: null,
      lease: null,
      error: null,
      ack: AT,
    },
    {
      state: "reconciliation_required",
      attempt: 2147483647,
      max: 2147483647,
      claim: null,
      claimed: SIGNED,
      lease: AT,
      error: "FINAL_CLAIM_EXPIRED",
      ack: null,
    },
  ];
  for (const [i, state] of stateCases.entries()) {
    const values = [
      ulidOf("source-state", i),
      "workos",
      `source-state-${i}`,
      "unknown.historical",
      "null",
      new Uint8Array(32).fill(4),
      AT,
      SIGNED,
      state.state,
      state.attempt,
      state.max,
      AT,
      state.claim,
      state.claimed,
      state.lease,
      state.error,
      state.ack,
    ];
    await pg.pool.query(
      pgInsert,
      values.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v)),
    );
    await control.core
      .prepare(insert)
      .bind(...values)
      .run();
  }
  const pgFacts = (
    await pg.pool.query(
      `SELECT ${fields
        .map((f) =>
          f === "body_sha256"
            ? "encode(body_sha256,'hex') AS body_sha256"
            : [
                  "received_at",
                  "signature_timestamp",
                  "available_at",
                  "claimed_at",
                  "lease_expires_at",
                  "acknowledged_at",
                ].includes(f)
              ? `to_char(${f} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${f}`
              : f,
        )
        .join(",")} FROM webhook_inbox ORDER BY inbox_event_id`,
    )
  ).rows;
  expect(await facts(control.core)).toEqual(pgFacts);

  const duplicateGlobal = [
    String(100).padStart(26, "0"),
    "github",
    "other-provider-id",
    "future",
    "{}",
    new Uint8Array(32),
    AT,
    null,
    "pending",
    0,
    10,
    AT,
    null,
    null,
    null,
    null,
    null,
  ];
  await expect(
    pg.pool.query(
      pgInsert,
      duplicateGlobal.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v)),
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    control.core
      .prepare(
        `INSERT INTO webhook_inbox(${[...fields, "organization_id"].join(",")}) VALUES (${Array(18).fill("?").join(",")})`,
      )
      .bind(...duplicateGlobal, ulidOf("routing-only", 1))
      .run(),
  ).rejects.toThrow(/UNIQUE constraint/u);

  for (const [i, invalid] of [
    { provider: "workos", signature: null, attempt: 0, max: 10, code: "23514" },
    { provider: "github", signature: SIGNED, attempt: 0, max: 10, code: "23514" },
    { provider: "resend", signature: null, attempt: 0, max: 10, code: "23514" },
    { provider: "stripe", signature: null, attempt: 0, max: 2147483648, code: "22003" },
  ].entries()) {
    const values = [
      ulidOf("invalid-source", i),
      invalid.provider,
      `invalid-${i}`,
      "future",
      "{}",
      new Uint8Array(32),
      AT,
      invalid.signature,
      "pending",
      invalid.attempt,
      invalid.max,
      AT,
      null,
      null,
      null,
      null,
      null,
    ];
    await expect(
      pg.pool.query(
        pgInsert,
        values.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v)),
      ),
    ).rejects.toMatchObject({ code: invalid.code });
    await expect(
      control.core
        .prepare(insert)
        .bind(...values)
        .run(),
    ).rejects.toThrow(/constraint/u);
  }

  const old = await populatedPrefix();
  try {
    const upgrade = migrationFiles("core").find((f) => f.name === "0326_global_webhook_inbox.sql");
    if (!upgrade) throw new Error("canonical migration missing");
    const apply = () => old.db.batch(splitStatements(upgrade.sql).map((s) => old.db.prepare(s)));
    const before = await facts(old.db),
      childBefore = (await old.db.prepare("SELECT * FROM github_push_deployments").all()).results;
    const ddlBefore = (
      await old.db
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY name",
        )
        .all()
    ).results;
    // An old prototype GitHub timestamp cannot be repaired into an original NULL fact by the migration.
    await old.db
      .prepare(
        "INSERT INTO webhook_inbox(organization_id,inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at) VALUES(?,?,'github','invalid-prototype','push','{}',?,?,?,'pending',0,10,?)",
      )
      .bind(
        old.project.organizationId,
        ulidOf("bad-prototype", 1),
        new Uint8Array(32),
        AT,
        SIGNED,
        AT,
      )
      .run();
    const invalidBefore = await facts(old.db);
    await expect(apply()).rejects.toThrow(/CHECK constraint/u);
    expect(await facts(old.db)).toEqual(invalidBefore);
    expect((await old.db.prepare("SELECT * FROM github_push_deployments").all()).results).toEqual(
      childBefore,
    );
    expect(
      (
        await old.db
          .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY name",
          )
          .all()
      ).results,
    ).toEqual(ddlBefore);
    await old.db
      .prepare("DELETE FROM webhook_inbox WHERE inbox_event_id=?")
      .bind(ulidOf("bad-prototype", 1))
      .run();
    await old.db
      .prepare(
        "INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,signature_timestamp) VALUES(?,'workos','old-schema-event','org_legacy','unknown.historical','{\"preserve\":true}',?,?,?,?)",
      )
      .bind(old.inboxId, new Uint8Array(32).fill(9), AT, AT, SIGNED)
      .run();
    await expect(apply()).rejects.toThrow(/guard_precondition_changed/u);
    expect(await facts(old.db)).toEqual(before);
    expect((await old.db.prepare("SELECT * FROM github_push_deployments").all()).results).toEqual(
      childBefore,
    );
    await old.db
      .prepare("DELETE FROM inbox_unrouted WHERE inbox_event_id=?")
      .bind(old.inboxId)
      .run();
    await apply();
    expect(await facts(old.db)).toEqual(before);
    expect((await old.db.prepare("SELECT * FROM github_push_deployments").all()).results).toEqual(
      childBefore,
    );
    expect(
      (await old.db.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>())?.foreign_keys,
    ).toBe(1);
    expect((await old.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const inboxFk = (
      await old.db
        .prepare("PRAGMA foreign_key_list(github_push_deployments)")
        .all<{ table: string; from: string; to: string }>()
    ).results.filter((r) => r.table === "webhook_inbox");
    expect(inboxFk.map((r) => [r.from, r.to])).toEqual([["inbox_event_id", "inbox_event_id"]]);
    await old.db
      .prepare("UPDATE webhook_inbox SET organization_id=NULL WHERE inbox_event_id=?")
      .bind(old.inboxId)
      .run();
    expect((await old.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await old.db.prepare("SELECT * FROM github_push_deployments").all()).results).toEqual(
      childBefore,
    );
  } finally {
    await old.dispose();
  }

  const firstGlobal = String(100).padStart(26, "0");
  const legacyInsert =
    'INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,signature_timestamp) VALUES(?,?,?,\'org_legacy\',\'unknown.historical\',\'{"future":true,"data":{"id":"non_organization_event"}}\',?,?,?,?)';
  await expect(
    control.core
      .prepare(legacyInsert)
      .bind(firstGlobal, "github", "foreign-event", new Uint8Array(32), AT, AT, null)
      .run(),
  ).rejects.toThrow(/cross-inbox identity/u);
  await expect(
    control.core
      .prepare(legacyInsert)
      .bind(
        ulidOf("conflicting-buffer", 1),
        "workos",
        "global-workos",
        new Uint8Array(32).fill(9),
        AT,
        AT,
        SIGNED,
      )
      .run(),
  ).rejects.toThrow(/cross-inbox identity/u);
  // The identical temporary copy of the old adoption protocol is valid, and can be consumed only with its proof.
  await control.core
    .prepare(legacyInsert)
    .bind(firstGlobal, "workos", "global-workos", new Uint8Array(32).fill(1), AT, AT, SIGNED)
    .run();
  await expect(
    control.core
      .prepare("UPDATE inbox_unrouted SET body_sha256=? WHERE inbox_event_id=?")
      .bind(new Uint8Array(32).fill(9), firstGlobal)
      .run(),
  ).rejects.toThrow(/cross-inbox identity/u);
  await expect(
    control.core
      .prepare("UPDATE webhook_inbox SET body_sha256=? WHERE inbox_event_id=?")
      .bind(new Uint8Array(32).fill(9), firstGlobal)
      .run(),
  ).rejects.toThrow(/cross-inbox identity/u);
  await control.core
    .prepare("DELETE FROM inbox_unrouted WHERE inbox_event_id=?")
    .bind(firstGlobal)
    .run();
  const legacyOnly = ulidOf("unadopted-buffer", 1);
  await control.core
    .prepare(legacyInsert)
    .bind(legacyOnly, "workos", "legacy-only", new Uint8Array(32).fill(6), AT, AT, SIGNED)
    .run();
  await expect(
    control.core
      .prepare(insert)
      .bind(
        legacyOnly,
        "workos",
        "wrong-canonical",
        "future",
        "{}",
        new Uint8Array(32),
        AT,
        SIGNED,
        "pending",
        0,
        10,
        AT,
        null,
        null,
        null,
        null,
        null,
      )
      .run(),
  ).rejects.toThrow(/cross-inbox identity/u);
  await expect(
    control.core
      .prepare("DELETE FROM inbox_unrouted WHERE inbox_event_id=?")
      .bind(legacyOnly)
      .run(),
  ).rejects.toThrow(/retained inbox buffer/u);
  await expect(
    purgeUnroutedInbox(
      { directory: control.core, router: new SharedCoreRouter(control.core) },
      { before: "2100-01-01T00:00:00.000Z", limit: 10 },
    ),
  ).rejects.toMatchObject({ code: "inbox_retention_unqualified" });
  expect(
    (
      await control.core
        .prepare("SELECT inbox_event_id FROM inbox_unrouted WHERE inbox_event_id=?")
        .bind(legacyOnly)
        .all()
    ).results,
  ).toEqual([{ inbox_event_id: legacyOnly }]);
});
