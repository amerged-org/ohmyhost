import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { createControlStore } from "../../src/store.js";
import { seedOrganization, projectInput } from "../support/seed.js";
import { newUlid } from "../../src/catalog/common.js";
let control: TestControl, pg: TestPostgres;
const T = "2026-10-29T01:00:00.000001Z";
beforeAll(async () => {
  [control, pg] = await Promise.all([createTestControl(), startTestPostgres()]);
}, 240000);
afterAll(async () => Promise.all([control?.dispose(), pg?.stop()]));
async function project() {
  const store = createControlStore(control.bindings),
    org = await seedOrganization(store, 2, 0),
    p = projectInput(org, `send-native-${newUlid().slice(-8).toLowerCase()}`);
  await store.projects.createInitialProject(p);
  await pg.pool.query(
    "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at)VALUES($1,$2,'active',1,decode(repeat('00',32),'hex'),$3,$3,$3)",
    [org, `org_native_${org}`, T],
  );
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at)VALUES($1,$2,'Native send',$3,'customer-chosen-v1',0,$4,$5)",
      [p.projectId, org, p.projectHandle, p.createdEventId, p.createdAt],
    );
    await client.query(
      "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)VALUES($1,$2,$3,$4,'user:fixture')",
      [p.billingEpochId, p.projectId, org, p.createdAt],
    );
    await client.query(
      "INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)VALUES($1,$2,'active',1,$3,$4)",
      [p.projectId, org, p.billingEpochId, p.createdAt],
    );
    for (const [environment, name] of [
      [p.developmentEnvironmentId, "dev"],
      [p.productionEnvironmentId, "prod"],
    ]) {
      await client.query(
        "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,created_at,updated_at,dev_access_epoch)VALUES($1,$2,$3,$4,'{}',$5,$5,$6)",
        [org, environment, p.projectId, name, p.createdAt, name === "dev" ? 1 : 0],
      );
      await client.query(
        "INSERT INTO billing_environment_scopes(organization_id,project_id,environment_id)VALUES($1,$2,$3)ON CONFLICT DO NOTHING",
        [org, p.projectId, environment],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { org, p };
}
// The Core keeps credit in its credit account and log: a send request carries no charge, reservation, card or meter.
const CORE_WITHOUT = [
  "credit_charge_micros",
  "credit_reservation_id",
  "credit_rate_card_id",
  "credit_meter",
  "credit_provider_cost_micros",
];
it("retains the original six physical shapes, except the credit columns of a send request that the credit account replaces", async () => {
  for (const table of [
    "mail_gateway_keys",
    "mail_send_requests",
    "mail_send_events",
    "mail_reputation_states",
    "mail_reputation_decisions",
    "mail_send_outcomes",
  ]) {
    const source = await pg.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
        [table],
      ),
      target = (
        await control.core
          .prepare(`PRAGMA table_info(${table})`)
          .all<{ name: string; type: string }>()
      ).results;
    expect(target.map((r) => r.name).sort()).toEqual(
      source.rows
        .map((r) => r.column_name)
        .filter((name) => table !== "mail_send_requests" || !CORE_WITHOUT.includes(name))
        .sort(),
    );
  }
});
it("preserves global immutable key identity, original version and full signed source shapes with native integrity active", async () => {
  const { org, p } = await project(),
    key = new Uint8Array(32).fill(0x77);
  await expect(
    control.core
      .prepare("INSERT INTO mail_gateway_keys VALUES(?,?,2,?,?)")
      .bind(org, p.projectId, key, T)
      .run(),
  ).rejects.toThrow("CHECK");
  await expect(
    pg.pool.query("INSERT INTO mail_gateway_keys VALUES($1,$2,2,$3,$4)", [
      org,
      p.projectId,
      key,
      T,
    ]),
  ).rejects.toThrow("mail_gateway_keys_shape");
  await control.core
    .prepare("INSERT INTO mail_gateway_keys VALUES(?,?,1,?,?)")
    .bind(org, p.projectId, key, T)
    .run();
  await pg.pool.query("INSERT INTO mail_gateway_keys VALUES($1,$2,1,$3,$4)", [
    org,
    p.projectId,
    key,
    T,
  ]);
  await expect(
    control.core
      .prepare("UPDATE mail_gateway_keys SET created_at=? WHERE project_id=?")
      .bind(T, p.projectId)
      .run(),
  ).rejects.toThrow("append-only");
  await expect(
    pg.pool.query("UPDATE mail_gateway_keys SET created_at=$1 WHERE project_id=$2", [
      T,
      p.projectId,
    ]),
  ).rejects.toThrow();
  const request = newUlid(),
    value = "9007199254740993";
  await control.core
    .prepare(
      "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,requested_at,updated_at)VALUES(?,?,?,'native',zeroblob(32),zeroblob(32),zeroblob(32),?,?)",
    )
    .bind(request, org, p.projectId, T, T)
    .run();
  await pg.pool.query(
    "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,credit_charge_micros,requested_at,updated_at)VALUES($1,$2,$3,'native',decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),$4,$5,$5)",
    [request, org, p.projectId, value, T],
  );
  expect(
    await control.core
      .prepare("SELECT mail_provider,state FROM mail_send_requests WHERE request_id=?")
      .bind(request)
      .first(),
  ).toEqual({ mail_provider: "aws-ses-v2", state: "reserved" });
  await expect(
    control.core
      .prepare(
        "INSERT INTO mail_send_events VALUES(?,?,?,?,'provider','Delivery','delivered',zeroblob(32),?,?,?,'complaint')",
      )
      .bind("11111111-1111-4111-8111-111111111111", org, p.projectId, request, T, T, T)
      .run(),
  ).rejects.toThrow("CHECK");
  await expect(
    pg.pool.query(
      "INSERT INTO mail_send_events VALUES('11111111-1111-4111-8111-111111111111',$1,$2,$3,'provider','Delivery','delivered',decode(repeat('00',32),'hex'),$4,$4,$4,'complaint')",
      [org, p.projectId, request, T],
    ),
  ).rejects.toThrow("mail_send_events_reputation_shape");
});
it("refuses a populated-target schema replacement before any drop or row rewrite", async () => {
  const before = (
      await control.core.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()
    ).results,
    sql = readFileSync(
      new URL("../../migrations/core/0461_mail_send_original_facts.sql", import.meta.url),
      "utf8",
    );
  await expect(
    control.core.batch(splitStatements(sql).map((s) => control.core.prepare(s))),
  ).rejects.toThrow("CHECK");
  expect(
    (await control.core.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all())
      .results,
  ).toEqual(before);
  expect(
    await control.core
      .prepare("SELECT name FROM sqlite_master WHERE name='mail_send_empty_guard_0461'")
      .first(),
  ).toBeNull();
  expect(await control.core.prepare("SELECT COUNT(*) n FROM mail_gateway_keys").first()).toEqual({
    n: 1,
  });
});
