import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { createGrowthEventStore, type GrowthD1 } from "../src/event-store.js";
import { expireGrowthData } from "../src/retention.js";
import type { GrowthEventV1 } from "../../../packages/contracts/src/growth-events.js";

it("deduplicates delivery and preserves deletion during replay", async () => {
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
    await db.batch(
      splitStatements(
        readFileSync(new URL("../migrations/0001_growth.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    await db.batch(
      splitStatements(
        readFileSync(new URL("../migrations/0005_account_rollups.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    await db.batch(
      splitStatements(
        readFileSync(new URL("../migrations/0007_usage_log.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    let now = new Date("2026-11-15T01:00:00.000Z");
    const store = createGrowthEventStore(db, () => now);
    const event: GrowthEventV1 = {
      schema_version: 1,
      event_id: "evt_one",
      event_name: "workspace_ready",
      outcome: "succeeded",
      occurred_at: "2026-11-15T00:00:00.000Z",
      received_at: "2026-11-15T00:00:00.000Z",
      platform_environment: "development",
      producer: "core",
      evidence_kind: "event",
      flow_id: null,
      account_id: "user_one",
      organization_id: "org_one",
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
    expect(await store.appendEvent(event)).toBe("inserted");
    expect(await store.appendEvent(event)).toBe("duplicate");
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_events WHERE event_id='evt_anon'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(await store.appendEvent({ ...event, outcome: "failed" })).toBe("conflict");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_milestones").first<{ n: number }>())?.n,
    ).toBe(1);
    const expired = { ...event, event_id: "evt_expired", account_id: "user_two" };
    expect(await store.appendEvent(expired)).toBe("inserted");
    now = new Date("2027-01-01T00:00:00.000Z");
    await expireGrowthData(db, now);
    expect(await store.appendEvent(expired)).toBe("expired");
    now = new Date("2026-11-15T01:00:00.000Z");
    const anonymous = {
      ...event,
      event_id: "evt_anon",
      account_id: null,
      flow_id: "flow_one",
      producer: "control_api" as const,
      event_name: "login_started" as const,
    };
    expect(await store.appendEvent(anonymous)).toBe("inserted");
    expect(
      await store.appendEvent({
        ...anonymous,
        event_id: "evt_login",
        event_name: "portal_login_succeeded",
        outcome: "succeeded",
        account_id: "user_one",
      }),
    ).toBe("inserted");
    const deployment = {
      schema_version: 1 as const,
      fact_type: "deployment" as const,
      fact_id: "deployment_one",
      source_id: "source_one",
      occurred_at: event.occurred_at,
      observed_at: now.toISOString(),
      source_version: "v_001",
      account_id: "user_one",
      organization_id: "org_one",
      project_id: "project_one",
      operation_id: null,
      deployment_id: "deployment_one",
      environment_id: "env_one",
      target_environment: "prod" as const,
      kind: "deploy" as const,
      status: "succeeded" as const,
      succeeded_at: event.occurred_at,
      health_status: "unknown" as const,
      health_evidence_id: null,
    };
    expect(await store.appendFact(deployment)).toBe("inserted");
    expect(
      await store.appendFact({ ...deployment, source_version: "v_002", health_status: "passed" }),
    ).toBe("inserted");
    expect(await store.appendFact(deployment)).toBe("duplicate");
    const dispute = {
      schema_version: 1 as const,
      fact_type: "payment" as const,
      fact_id: "dp_one",
      source_id: "dp_one",
      occurred_at: event.occurred_at,
      observed_at: now.toISOString(),
      source_version: "v_1",
      account_id: null,
      organization_id: "org_one",
      project_id: null,
      operation_id: null,
      provider_fact_id: "dp_one",
      payment_id: null,
      amount_minor: 100,
      currency: "EUR",
      money_effect: "none" as const,
    };
    expect(await store.beginDisputeScan("scan_one", now.toISOString())).toBe(true);
    await store.stageOpenDisputes("scan_one", [dispute]);
    expect(await store.promoteOpenDisputes("scan_one")).toBe(true);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_open_disputes").first<{ n: number }>())
        ?.n,
    ).toBe(1);
    expect(await store.beginDisputeScan("scan_two", "2026-11-15T01:01:00.000Z")).toBe(true);
    expect(await store.promoteOpenDisputes("scan_two")).toBe(true);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_open_disputes").first<{ n: number }>())
        ?.n,
    ).toBe(0);
    const snapshot = {
      source_id: "membership_one",
      account_id: "user_one",
      organization_id: "org_one",
      active: true,
      observed_at: now.toISOString(),
      source_version: "v1",
      source_revision: 1,
    };
    expect(await store.replaceMembershipSnapshot(snapshot)).toBe("inserted");
    expect(
      await store.replaceMembershipSnapshot({
        ...snapshot,
        active: false,
        source_version: "v2",
        source_revision: 2,
        observed_at: "2026-11-15T01:01:00.000Z",
      }),
    ).toBe("inserted");
    expect(
      (
        await db
          .prepare("SELECT active FROM growth_membership_snapshots WHERE source_id=?")
          .bind("membership_one")
          .first<{ active: number }>()
      )?.active,
    ).toBe(0);
    await store.setCursor("core", "c1", "2026-11-15T00:00:00.000Z", null, "unavailable");
    expect((await store.readCursor("core"))?.error_class).toBe("unavailable");
    const campaign = {
      campaign_key: "campaign_one",
      account_id: "user_one",
      r: null,
      utm: { utm_source: "search", utm_unregistered_partner: "München 🚀" },
      utm_observed_at: now.toISOString(),
      observed_at: now.toISOString(),
      expires_at: "2026-12-01T00:00:00.000Z",
    };
    await store.upsertCampaign({ ...campaign, utm: null, utm_observed_at: null });
    await store.upsertCampaign(campaign);
    expect(await store.readCampaign("campaign_one")).toEqual(campaign);
    await store.upsertCampaign({ ...campaign, utm: { utm_source: "late-overwrite" } });
    expect((await store.readCampaign("campaign_one"))?.utm).toEqual(campaign.utm);
    now = new Date("2027-01-01T00:00:00.000Z");
    await expireGrowthData(db, now);
    await store.upsertCampaign({
      ...campaign,
      observed_at: now.toISOString(),
      utm_observed_at: now.toISOString(),
      expires_at: "2027-02-01T00:00:00.000Z",
    });
    expect(await store.readCampaign("campaign_one")).toBeNull();
    now = new Date("2026-11-15T01:00:00.000Z");
    const diagnostic = {
      ...event,
      event_id: "evt_diag",
      event_name: "product_call_failed" as const,
      outcome: "failed" as const,
    };
    expect(await store.appendEvent(diagnostic)).toBe("inserted");
    expect(await store.appendEvent({ ...diagnostic, event_id: "evt_diag_2" })).toBe("limited");
    await store.appendEvent({
      ...event,
      event_id: "evt_delete",
      event_name: "account_deleted",
      producer: "workos",
      received_at: now.toISOString(),
    });
    now = new Date("2027-07-01T00:00:00.000Z");
    await expireGrowthData(db, now);
    const tombstone = await db
      .prepare("SELECT * FROM growth_subject_suppression")
      .first<Record<string, unknown>>();
    expect(JSON.stringify(tombstone)).not.toContain("user_one");
    expect(
      await store.replaceMembershipSnapshot({
        ...snapshot,
        source_version: "v3",
        source_revision: 3,
        observed_at: now.toISOString(),
      }),
    ).toBe("duplicate");
    now = new Date("2026-11-15T01:00:00.000Z");
    expect(await store.appendEvent(event)).toBe("duplicate");
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_events WHERE event_id='evt_anon'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_events").first<{ n: number }>())?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM growth_milestones WHERE account_id=?")
          .bind("user_one")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});
