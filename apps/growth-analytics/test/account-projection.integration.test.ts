import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { createGrowthEventStore, type GrowthD1 } from "../src/event-store.js";
import {
  accountWindow,
  expireGrowthAccountData,
  readAccountProjection,
  readGrowthRollups,
  refreshGrowthRollups,
} from "../src/account-projection.js";
import type { GrowthEventV1 } from "../../../packages/contracts/src/growth-events.js";

it("retains bounded original creation evidence, suppresses sparse cohorts, and removes subjects", async () => {
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
          script: "export default { fetch(){ return new Response() } }",
          d1Databases: { DB: "db" },
        },
      ],
    }),
  );
  try {
    const db = (await mf.getD1Database("DB", "growth")) as GrowthD1;
    for (const file of ["0001_growth.sql", "0005_account_rollups.sql", "0007_usage_log.sql"])
      await db.batch(
        splitStatements(
          readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
        ).map((sql) => db.prepare(sql)),
      );
    const now = new Date("2026-11-15T00:00:00.000Z");
    const store = createGrowthEventStore(db, () => now);
    const event: GrowthEventV1 = {
      schema_version: 1,
      event_id: "evt_0",
      event_name: "account_created",
      outcome: "succeeded",
      occurred_at: "2026-10-01T00:00:00.000Z",
      received_at: now.toISOString(),
      platform_environment: "development",
      producer: "workos",
      evidence_kind: "snapshot",
      flow_id: null,
      account_id: "user_0",
      organization_id: null,
      project_id: null,
      operation_id: null,
      deployment_id: null,
      transport: "unknown",
      client_class: "unknown",
      client_class_trust: "unknown",
      error_class: null,
      campaign_key: null,
      request_country: null,
    };
    for (let i = 0; i < 5; i++)
      expect(
        await store.appendEvent({ ...event, event_id: `evt_${i}`, account_id: `user_${i}` }),
      ).toBe("expired");
    await store.replaceMembershipSnapshot({
      source_id: "membership_0",
      account_id: "user_0",
      organization_id: "org_0",
      active: true,
      observed_at: "2026-10-01T12:00:00.000Z",
      source_version: "v1",
      source_revision: 1,
    });
    await store.replaceMembershipSnapshot({
      source_id: "membership_0",
      account_id: "user_0",
      organization_id: "org_0",
      active: false,
      observed_at: now.toISOString(),
      source_version: "v2",
      source_revision: 2,
    });
    await store.replaceMembershipSnapshot({
      source_id: "membership_1",
      account_id: "user_1",
      organization_id: "org_0",
      active: true,
      observed_at: now.toISOString(),
      source_version: "v1",
      source_revision: 1,
    });
    const historical: GrowthEventV1 = {
      ...event,
      event_id: "old_workspace",
      event_name: "workspace_ready",
      producer: "core",
      evidence_kind: "event",
      account_id: "user_2",
      organization_id: "org_2",
      occurred_at: "2026-10-01T10:00:00.000Z",
    };
    await store.appendEvent(historical);
    expect(
      await db
        .prepare("SELECT event_id FROM growth_milestones WHERE event_id='old_workspace'")
        .first(),
    ).not.toBeNull();
    expect(
      await db.prepare("SELECT event_id FROM growth_events WHERE event_id='old_workspace'").first(),
    ).toBeNull();
    await store.appendEvent({
      ...historical,
      event_id: "old_snapshot",
      account_id: "user_3",
      evidence_kind: "snapshot",
    });
    expect(
      await db
        .prepare("SELECT event_id FROM growth_milestones WHERE event_id='old_snapshot'")
        .first(),
    ).toBeNull();
    await db
      .prepare(
        "INSERT INTO growth_replay_suppression VALUES('event','old_suppressed','2027-01-01T00:00:00.000Z')",
      )
      .run();
    await store.appendEvent({ ...historical, event_id: "old_suppressed", account_id: "user_4" });
    expect(
      await db
        .prepare("SELECT event_id FROM growth_milestones WHERE event_id='old_suppressed'")
        .first(),
    ).toBeNull();
    const accounts = await readAccountProjection(db, now);
    expect(accountWindow(accounts, now, 1)).toMatchObject({ mature: 5, numerator: 2, unknown: 3 });
    await refreshGrowthRollups(db, now);
    expect(
      await db
        .prepare(
          "SELECT positive,unknown,incomplete FROM growth_daily_account_rollups WHERE window_days=1",
        )
        .first(),
    ).toMatchObject({ positive: 2, unknown: 3, incomplete: 1 });
    await store.appendEvent({
      ...event,
      event_id: "evt_sparse",
      account_id: "user_sparse",
      occurred_at: "2026-10-02T00:00:00.000Z",
    });
    await refreshGrowthRollups(db, now);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM growth_daily_account_rollups WHERE cohort_day='2026-10-02'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await db
      .prepare("INSERT INTO growth_daily_account_rollups VALUES('2026-03-01',7,5,2,3,1,?)")
      .bind(now.toISOString())
      .run();
    await db
      .prepare("INSERT INTO growth_daily_account_rollups VALUES('2025-09-01',7,5,2,3,1,?)")
      .bind(now.toISOString())
      .run();
    await db
      .prepare("INSERT INTO growth_daily_account_rollups VALUES('2026-11-14',7,5,2,3,1,?)")
      .bind(now.toISOString())
      .run();
    const retained = await readGrowthRollups(db, now);
    expect(retained.some((row) => row.cohortDay === "2026-03-01" && row.incomplete)).toBe(true);
    expect(
      retained.some((row) => row.cohortDay === "2025-09-01" || row.cohortDay === "2026-11-14"),
    ).toBe(false);
    await store.deleteSubject("user_0");
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM growth_daily_account_rollups WHERE cohort_day='2026-10-01'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await refreshGrowthRollups(db, now);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM growth_daily_account_rollups WHERE cohort_day='2026-10-01'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await store.appendEvent(event);
    expect((await readAccountProjection(db, now)).some((x) => x.account_id === "user_0")).toBe(
      false,
    );
    await store.deleteSubject("user_2");
    await store.appendEvent(historical);
    expect(
      await db
        .prepare("SELECT event_id FROM growth_milestones WHERE event_id='old_workspace'")
        .first(),
    ).toBeNull();
    const laterStore = createGrowthEventStore(db, () => new Date("2027-05-01T00:00:00.000Z"));
    await laterStore.appendEvent({
      ...historical,
      account_id: "user_old",
      event_id: "too_old",
      received_at: "2027-05-01T00:00:00.000Z",
    });
    expect(
      await db.prepare("SELECT event_id FROM growth_milestones WHERE event_id='too_old'").first(),
    ).toBeNull();
    await expireGrowthAccountData(db, new Date("2027-12-15T00:00:00.000Z"));
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_account_projection")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_daily_account_rollups")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});
