import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { createControlStore } from "../../src/store.js";
import { seedOrganization, projectInput } from "../support/seed.js";
import { newUlid } from "../../src/catalog/common.js";
let control: TestControl, pg: TestPostgres;
const T = "2026-10-29T01:00:00.000001Z",
  tables = [
    "resend_event_receipts",
    "infrastructure_alert_receipts",
    "shared_mail_capabilities",
    "mail_send_outcomes",
    "workspace_mail_reputation_decisions",
  ];
beforeAll(async () => {
  [control, pg] = await Promise.all([createTestControl(), startTestPostgres()]);
}, 240000);
afterAll(async () => Promise.all([control?.dispose(), pg?.stop()]));
it("retains exact original native receipt/outcome/reputation columns and keeps missing capability configuration unseeded", async () => {
  for (const table of tables) {
    const source = await pg.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
      [table],
    );
    const target = (
      await control.core.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    ).results;
    expect(target.map((r) => r.name).sort()).toEqual(source.rows.map((r) => r.column_name).sort());
  }
  expect(await control.core.prepare("SELECT * FROM shared_mail_capabilities").all()).toMatchObject({
    results: [],
  });
  await expect(
    control.core
      .prepare("INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,NULL,NULL)")
      .run(),
  ).rejects.toThrow("CHECK");
  await expect(
    pg.pool.query(
      "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',true,NULL,NULL)",
    ),
  ).rejects.toThrow("shared_mail_capabilities_check");
});
it("preserves original global event replay identity, exact digest bytes and infrastructure acceptance shape", async () => {
  const event = "msg_original_receipt",
    digest = new Uint8Array(32).fill(0xab);
  await control.core
    .prepare("INSERT INTO resend_event_receipts VALUES(?,?,?,?,?)")
    .bind(event, "email.received", "provider_original", digest, T)
    .run();
  await pg.pool.query(
    "INSERT INTO resend_event_receipts VALUES($1,'email.received','provider_original',$2,$3)",
    [event, digest, T],
  );
  await expect(
    control.core
      .prepare("INSERT INTO resend_event_receipts VALUES(?,?,?,?,?)")
      .bind(event, "domain.deleted", null, digest, T)
      .run(),
  ).rejects.toThrow("UNIQUE");
  await expect(
    pg.pool.query("INSERT INTO resend_event_receipts VALUES($1,'domain.deleted',NULL,$2,$3)", [
      event,
      digest,
      T,
    ]),
  ).rejects.toThrow("resend_event_receipts_pkey");
  expect(
    await control.core
      .prepare(
        "SELECT lower(hex(payload_sha256)) digest,received_at FROM resend_event_receipts WHERE event_id=?",
      )
      .bind(event)
      .first(),
  ).toEqual({ digest: "ab".repeat(32), received_at: T });
  const id = "11111111-1111-4111-8111-111111111111";
  await expect(
    control.core
      .prepare("INSERT INTO infrastructure_alert_receipts VALUES(?,?,?,?,?,?)")
      .bind(id, "11".repeat(32), T, T, "provider_message", null)
      .run(),
  ).rejects.toThrow("CHECK");
  await expect(
    pg.pool.query(
      "INSERT INTO infrastructure_alert_receipts VALUES($1,$2,$3,$3,'provider_message',NULL)",
      [id, "11".repeat(32), T],
    ),
  ).rejects.toThrow("infrastructure_alert_receipts_check");
  await control.core
    .prepare("INSERT INTO infrastructure_alert_receipts VALUES(?,?,?,?,?,?)")
    .bind(id, "11".repeat(32), T, T, "provider_message", T)
    .run();
});
it("restores original globally unique mail identities across tenants and keeps original source FKs on separate outcomes", async () => {
  const store = createControlStore(control.bindings),
    org1 = await seedOrganization(store, 2, 0),
    org2 = await seedOrganization(store, 2, 1),
    request = newUlid();
  const projects = [org1, org2].map((org, index) =>
    projectInput(org, `mail-native-${index}-${newUlid().slice(-6).toLowerCase()}`),
  );
  for (const project of projects) await store.projects.createInitialProject(project);
  const insert = (org: string, projectId: string) =>
    control.core
      .prepare(
        "INSERT INTO mail_send_requests(organization_id,request_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,mail_provider,state,requested_at,updated_at)VALUES(?,?,?,'native',zeroblob(32),zeroblob(32),zeroblob(32),'resend','reserved',?,?)",
      )
      .bind(org, request, projectId, T, T)
      .run();
  const firstProject = projects[0],
    secondProject = projects[1];
  if (!firstProject || !secondProject) throw new Error("Synthetic project missing");
  await insert(org1, firstProject.projectId);
  await expect(insert(org2, secondProject.projectId)).rejects.toThrow("UNIQUE");
  await expect(
    control.core
      .prepare("INSERT INTO mail_send_outcomes VALUES(?,?,?,'accepted',?,?,1,?)")
      .bind(org1, newUlid(), request, "22222222-2222-4222-8222-222222222222", T, T)
      .run(),
  ).rejects.toThrow("FOREIGN KEY");
  const shared = newUlid();
  for (const [index, org] of [org1, org2].entries()) {
    const p = projects[index];
    if (!p) throw new Error("Synthetic project missing");
    const add = () =>
      control.core
        .prepare(
          "INSERT INTO resend_mail_domains(organization_id,domain_id,project_id,environment_id,domain,sending,receiving,receiving_suspended,configured_at)VALUES(?,?,?,?,?,1,0,0,?)",
        )
        .bind(org, shared, p.projectId, p.productionEnvironmentId, `mail${index}.example.test`, T)
        .run();
    if (index === 0) await add();
    else await expect(add()).rejects.toThrow("UNIQUE");
  }
});
