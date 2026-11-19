import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../src/d1-types.js";
import { activateTestCore, migrationFiles, type TestControl } from "./support/control-d1.js";
import { splitStatements } from "./support/sql.js";
import { mailFixture } from "./mail/mail-fixture.js";
import { newUlid } from "../src/catalog/common.js";

it("preserves populated reputation history and project boundaries when removing the mail-key dependency", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CONTROL_CORE: "core" },
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    const files = migrationFiles("core");
    for (const file of files.filter((f) => f.name <= "0620_native_export_effects.sql")) {
      await db.batch(splitStatements(file.sql).map((statement) => db.prepare(statement)));
    }
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: {
        CONTROL_CORE: db,
        CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
      },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: async () => {},
    };
    const migration = files.find((f) => f.name.startsWith("0621_native_mail_"));
    if (!migration) throw new Error("missing migration");
    const fixture = await mailFixture(control, false);
    const { organizationId, projectId } = fixture.scope;
    await db
      .prepare(
        "INSERT INTO mail_reputation_decisions(decision_id,organization_id,project_id,action,reason,eligible_send_count,hard_bounce_count,complaint_count,actor_id,evidence_sha256,occurred_at) VALUES(?1,?2,?3,'retain','manual_review',3,1,0,'operator:fixture',zeroblob(32),'2026-10-28T10:00:00.000000Z')",
      )
      .bind(crypto.randomUUID(), organizationId, projectId)
      .run();
    const suspendedFixture = await mailFixture(control, false);
    const suspendedScope = suspendedFixture.scope;
    const requestId = newUlid();
    const eventId = crypto.randomUUID();
    const at = "2099-01-01T00:00:00.000000Z";
    await db.batch([
      db
        .prepare(
          "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,requested_at,updated_at) VALUES(?1,?2,?3,'fixture',zeroblob(32),zeroblob(32),zeroblob(32),?4,?4)",
        )
        .bind(requestId, suspendedScope.organizationId, suspendedScope.projectId, at),
      db
        .prepare(
          "INSERT INTO mail_send_events(provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,detail_sha256,occurred_at,sent_at,received_at,reputation_kind) VALUES(?1,?2,?3,?4,'message','Bounce','bounced',zeroblob(32),?5,?5,?5,'hard_bounce')",
        )
        .bind(eventId, suspendedScope.organizationId, suspendedScope.projectId, requestId, at),
      db
        .prepare(
          "UPDATE mail_reputation_states SET state='suspended',suspended_at=?3,suspension_reason='bounce_rate',triggering_event_id=?4,version=version+1,updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(suspendedScope.organizationId, suspendedScope.projectId, at, eventId),
      db
        .prepare(
          "INSERT INTO mail_gateway_keys(organization_id,project_id,key_version,key_sha256,created_at) VALUES(?1,?2,1,?3,?4)",
        )
        .bind(suspendedScope.organizationId, projectId, new Uint8Array(32).fill(231), at),
      db
        .prepare(
          "INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at) VALUES(?1,?2,'active',?3,1,?3)",
        )
        .bind(suspendedScope.organizationId, projectId, at),
    ]);
    const preservedTables = [
      "mail_reputation_states",
      "mail_reputation_decisions",
      "mail_send_requests",
      "mail_send_events",
      "mail_gateway_keys",
    ];
    const before = await Promise.all(
      preservedTables.map((table) =>
        db
          .prepare(`SELECT * FROM ${table} ORDER BY 1,2`)
          .all()
          .then((v) => v.results),
      ),
    );
    expect(before[0]).toHaveLength(3);
    expect(before[0]?.map((row) => row["state"]).sort()).toEqual(["active", "active", "suspended"]);
    const statesBefore = await db
      .prepare("SELECT * FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2")
      .bind(organizationId, projectId)
      .all();
    const decisionsBefore = await db
      .prepare("SELECT * FROM mail_reputation_decisions WHERE organization_id=?1 AND project_id=?2")
      .bind(organizationId, projectId)
      .all();
    expect(statesBefore.results).toHaveLength(1);
    expect(decisionsBefore.results).toHaveLength(1);
    await db.batch(splitStatements(migration.sql).map((s) => db.prepare(s)));
    expect(
      await Promise.all(
        preservedTables.map((table) =>
          db
            .prepare(`SELECT * FROM ${table} ORDER BY 1,2`)
            .all()
            .then((v) => v.results),
        ),
      ),
    ).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_keys").first())?.["foreign_keys"]).toBe(1);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('mail_reputation_states_no_delete','mail_reputation_states_version','mail_reputation_decisions_append_only_delete','mail_reputation_decisions_append_only_update')",
          )
          .first()
      )?.["n"],
    ).toBe(4);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(organizationId, projectId)
          .all()
      ).results,
    ).toEqual(statesBefore.results);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM mail_reputation_decisions WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(organizationId, projectId)
          .all()
      ).results,
    ).toEqual(decisionsBefore.results);
    await expect(
      db
        .prepare("DELETE FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2")
        .bind(organizationId, projectId)
        .run(),
    ).rejects.toThrow();
    const insertState = (org: string) =>
      db
        .prepare(
          "INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at) VALUES(?1,?2,'active','2026-10-28T10:00:00.000000Z',1,'2026-10-28T10:00:00.000000Z')",
        )
        .bind(org, projectId)
        .run();
    for (const org of [
      "short",
      "80000000000000000000000000",
      "0000000000000000000000000a",
      "0000000000000000000000000I",
    ]) {
      await expect(insertState(org)).rejects.toThrow();
    }
    expect(
      await db
        .prepare(
          "SELECT state FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(suspendedScope.organizationId, projectId)
        .first(),
    ).toEqual({ state: "active" });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(
      db
        .prepare("DELETE FROM mail_reputation_decisions WHERE organization_id=?1 AND project_id=?2")
        .bind(organizationId, projectId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at) VALUES(?1,'00000000000000000000000001','active','2026-10-28T10:00:00.000000Z',1,'2026-10-28T10:00:00.000000Z')",
        )
        .bind(organizationId)
        .run(),
    ).rejects.toThrow();
  } finally {
    await mf.dispose();
  }
}, 120000);
