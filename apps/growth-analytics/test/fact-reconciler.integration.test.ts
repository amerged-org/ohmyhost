import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { createGrowthEventStore, type GrowthD1 } from "../src/event-store.js";
import { createFactReconciler } from "../src/fact-reconciler.js";

it("replays a failed page before advancing its durable cursor", async () => {
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
        readFileSync(new URL("../migrations/0003_source_status.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    await db.batch(
      splitStatements(
        readFileSync(new URL("../migrations/0005_account_rollups.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    const store = createGrowthEventStore(db);
    const started = new Date().toISOString();
    await store.beginSourceRead("race", "old", started);
    await store.beginSourceRead("race", "new", started);
    expect(
      await store.finishSourceRead({
        source: "race",
        generation: "old",
        finished_at: started,
        error_class: null,
        quality_flags: [],
        cursor: "old_cursor",
        completed: true,
      }),
    ).toBe(false);
    expect(
      await store.finishSourceRead({
        source: "race",
        generation: "new",
        finished_at: started,
        error_class: null,
        quality_flags: [],
        cursor: "new_cursor",
        completed: false,
      }),
    ).toBe(true);
    expect(await store.getCursor("race")).toBe("new_cursor");
    const quiet = createFactReconciler({
      core: {
        readFactPage: async () => ({
          facts: [],
          next_cursor: null,
          source_watermark: null,
          history_floor: null,
          evidence_kind: "snapshot",
        }),
      },
      store,
      platformEnvironment: "development",
    });
    await quiet.reconcileSource("attribution");
    expect(await store.readSourceStatus("attribution")).toMatchObject({
      error_class: null,
      source_watermark: null,
    });
    expect((await store.readSourceStatus("attribution"))?.completed_scan_at).not.toBeNull();
    const unavailable = createFactReconciler({
      core: {
        readFactPage: async () => {
          throw new Error("unavailable");
        },
      },
      store,
      platformEnvironment: "development",
    });
    await unavailable.reconcileSource("attribution");
    expect(await store.readSourceStatus("attribution")).toMatchObject({
      error_class: "source_unavailable",
    });
    let attributionUtm: string | null = null;
    const attribution = createFactReconciler({
      core: {
        readFactPage: async () => ({
          facts: [
            {
              source_id: "user_one",
              account_id: "user_one",
              r: "newsletter",
              utm_parameters: attributionUtm,
              recorded_at: "2020-01-01T00:00:00.000000Z",
            },
          ],
          next_cursor: null,
          source_watermark: null,
          history_floor: null,
          evidence_kind: "snapshot",
        }),
      },
      store,
      platformEnvironment: "development",
    });
    await attribution.reconcileSource("attribution");
    const firstCampaign = await db
      .prepare("SELECT body FROM growth_campaigns")
      .first<{ body: string }>();
    expect(JSON.parse(firstCampaign?.body ?? "")).toMatchObject({
      utm: null,
      utm_observed_at: null,
    });
    attributionUtm = '{"utm_custom":"café"}';
    await attribution.reconcileSource("attribution");
    const campaign = await db
      .prepare("SELECT body FROM growth_campaigns")
      .first<{ body: string }>();
    expect(JSON.parse(campaign?.body ?? "")).toMatchObject({
      account_id: "user_one",
      r: "newsletter",
      utm: { utm_custom: "café" },
    });
    expect(JSON.parse(campaign?.body ?? "").observed_at).toBe(
      JSON.parse(firstCampaign?.body ?? "").observed_at,
    );
    expect(JSON.parse(campaign?.body ?? "").utm_observed_at).not.toBeNull();
    expect(JSON.parse(campaign?.body ?? "").observed_at).not.toBe("2020-01-01T00:00:00.000000Z");
    const row = {
      source_id: "01A",
      deployment_id: "01A",
      organization_id: "01B",
      project_id: "01C",
      operation_id: "01D",
      environment_id: "01E",
      target_environment: "prod",
      kind: "deploy",
      status: "succeeded",
      created_at: "2026-11-15T00:00:00.000000Z",
      updated_at: "2026-11-15T00:01:00.000000Z",
      terminal_at: null,
      account_id: null,
      health_evidence_id: null,
      candidate_receipt_id: "candidate_1",
    };
    const source = {
      readFactPage: async () => ({
        facts: [row],
        next_cursor: "01A",
        source_watermark: null,
        history_floor: null,
        evidence_kind: "snapshot" as const,
      }),
    };
    let fail = true;
    const broken = {
      ...store,
      appendFact: async (...args: Parameters<typeof store.appendFact>) => {
        if (fail) {
          fail = false;
          throw new Error("unavailable");
        }
        return store.appendFact(...args);
      },
    };
    const reconcile = createFactReconciler({
      core: source,
      store: broken,
      platformEnvironment: "development",
    });
    await expect(reconcile.reconcileSource("deployments")).rejects.toThrow("unavailable");
    expect(await store.getCursor("deployments")).toBeNull();
    await reconcile.reconcileSource("deployments");
    expect(await store.getCursor("deployments")).toBe("01A");
    const saved = await db.prepare("SELECT body FROM growth_facts").first<{ body: string }>();
    expect(JSON.parse(saved?.body ?? "")).toMatchObject({
      account_id: null,
      organization_id: "01B",
      target_environment: "prod",
      succeeded_at: null,
      health_status: "unknown",
    });
    await store.setCursor("deployments", null, null, null);
    await reconcile.reconcileSource("deployments");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_facts").first<{ n: number }>())?.n,
    ).toBe(1);
    const withHealth = createFactReconciler({
      core: source,
      store,
      platformEnvironment: "development",
      health: {
        readDeploymentHealth: async (scope) => {
          expect(scope.candidate_receipt_id).toBe("candidate_1");
          return {
            observation_id: "obs_1",
            health_status: "passed",
            observed_at: "2026-11-15T00:03:00.000Z",
          };
        },
      },
    });
    await store.setCursor("deployments", null, null, null);
    await withHealth.reconcileSource("deployments");
    expect(
      JSON.parse(
        (await db.prepare("SELECT body FROM growth_facts").first<{ body: string }>())?.body ?? "",
      ),
    ).toMatchObject({ health_status: "passed", health_evidence_id: "obs_1" });
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_facts").first<{ n: number }>())?.n,
    ).toBe(1);
    let revision = 1;
    const membershipSource = {
      readFactPage: async () => ({
        facts: [
          {
            source_id: "01B:user_one",
            account_id: "user_one",
            organization_id: "01B",
            state: revision === 1 ? "active" : "revoked",
            mapping_revision: revision,
          },
        ],
        next_cursor: null,
        source_watermark: null,
        history_floor: null,
        evidence_kind: "snapshot" as const,
      }),
    };
    const members = createFactReconciler({
      core: membershipSource,
      store,
      platformEnvironment: "development",
    });
    await members.reconcileSource("memberships");
    revision = 2;
    await members.reconcileSource("memberships");
    expect(
      await db.prepare("SELECT active,source_revision FROM growth_membership_snapshots").first(),
    ).toMatchObject({ active: 0, source_revision: 2 });
    revision = 1;
    await members.reconcileSource("memberships");
    expect(
      await db.prepare("SELECT active,source_revision FROM growth_membership_snapshots").first(),
    ).toMatchObject({ active: 0, source_revision: 2 });
    await db.batch(
      splitStatements(
        readFileSync(new URL("../migrations/0007_usage_log.sql", import.meta.url), "utf8"),
      ).map((sql) => db.prepare(sql)),
    );
    const now = new Date().toISOString();
    let open = true;
    const dispute = {
      schema_version: 1 as const,
      fact_type: "payment" as const,
      fact_id: "dp_one",
      source_id: "dp_one",
      observed_at: now,
      source_version: "v_1",
      occurred_at: now,
      account_id: null,
      organization_id: "01B",
      project_id: null,
      operation_id: null,
      provider_fact_id: "dp_one",
      payment_id: null,
      amount_minor: 100,
      currency: "EUR",
      money_effect: "none" as const,
    };
    const billing = {
      readGrowthPaymentPage: async () => ({
        facts: [],
        next_cursor: null,
        source_watermark: null,
        history_floor: null,
      }),
      readGrowthOpenDisputePage: async () => ({
        facts: open ? [dispute] : [],
        next_cursor: null,
        source_watermark: null,
        history_floor: null,
      }),
    };
    const payments = createFactReconciler({
      core: source,
      store,
      billing,
      platformEnvironment: "development",
    });
    await payments.reconcileSource("billing_open_disputes");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_open_disputes").first<{ n: number }>())
        ?.n,
    ).toBe(1);
    open = false;
    await payments.reconcileSource("billing_open_disputes");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_open_disputes").first<{ n: number }>())
        ?.n,
    ).toBe(0);
    const fenceTime = new Date().toISOString();
    await store.beginSourceRead("billing_open_disputes", "stale_read", fenceTime);
    expect(await store.beginDisputeScan("stale_scan", fenceTime)).toBe(true);
    await store.stageOpenDisputes("stale_scan", [dispute]);
    await store.beginSourceRead("billing_open_disputes", "new_read", fenceTime);
    expect(await store.promoteOpenDisputes("stale_scan", "stale_read")).toBe(false);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_open_disputes").first<{ n: number }>())
        ?.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});
