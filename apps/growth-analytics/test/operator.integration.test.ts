import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { splitStatements } from "../../control-store/test/support/sql.js";
import { createGrowthEventStore, type GrowthD1 } from "../src/event-store.js";
import { createOperatorData, auditIdentityRead } from "../src/operator-data.js";
import { observeDeliveredExperiment, createExperimentStore } from "../src/experiments.js";
import { expect, it, vi } from "vitest";
import { verifyOperatorAccess } from "../src/operator-auth.js";
import { handleGrowthOperatorRequest } from "../src/operator-routes.js";
it("denies tenant admins and renders honest cohort state", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const head = encode({ alg: "RS256", kid: "key" });
  const claims = encode({
    iss: "https://team.cloudflareaccess.com",
    aud: ["ops-dev"],
    sub: "operator",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const signed = `${head}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(signed),
    ),
  );
  const token = `${signed}.${btoa(String.fromCharCode(...signature))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
  const config = {
    issuer: "https://team.cloudflareaccess.com",
    audience: "ops-dev",
    environment: "development" as const,
    permissions: { operator: ["growth.read_aggregate"] },
    fetcher: async () => Response.json({ keys: [{ ...jwk, kid: "key", alg: "RS256" }] }),
  };
  const accessRequest = new Request("https://ops.example/growth", {
    headers: { "cf-access-jwt-assertion": token },
  });
  expect((await verifyOperatorAccess(accessRequest, config))?.subject).toBe("operator");
  expect(await verifyOperatorAccess(accessRequest, { ...config, audience: "ops-prod" })).toBeNull();
  expect(
    await verifyOperatorAccess(
      new Request("https://ops.example/growth", {
        headers: { "cf-access-jwt-assertion": `${token.slice(0, -2)}aa` },
      }),
      config,
    ),
  ).toBeNull();
  const emailPayload = encode({
    iss: "https://team.cloudflareaccess.com",
    aud: "ops-dev",
    sub: "another_operator",
    email: "OWNER@EXAMPLE.COM",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const emailSigned = `${head}.${emailPayload}`;
  const emailSignature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(emailSigned),
    ),
  );
  const emailToken = `${emailSigned}.${btoa(String.fromCharCode(...emailSignature))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
  const emailRequest = new Request("https://ops.example/growth", {
    headers: { "cf-access-jwt-assertion": emailToken },
  });
  const fetchKeys = vi.fn(async () =>
    Response.json({ keys: [{ ...jwk, kid: "key", alg: "RS256" }] }),
  );
  vi.stubGlobal("fetch", fetchKeys);
  try {
    const cachedConfig = {
      issuer: config.issuer,
      audience: config.audience,
      environment: config.environment,
      permissions: {
        "email:owner@example.com": ["growth.read_aggregate", "growth.manage_segments"],
      },
    };
    expect((await verifyOperatorAccess(emailRequest, cachedConfig))?.permissions).toContain(
      "growth.manage_segments",
    );
    expect((await verifyOperatorAccess(emailRequest, cachedConfig))?.subject).toBe(
      "another_operator",
    );
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
  const brokenKeys = {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          throw new Error("read failed");
        },
        cancel: async () => {
          throw new Error("cancel failed");
        },
      }),
    },
  } as unknown as Response;
  expect(
    await verifyOperatorAccess(emailRequest, { ...config, fetcher: async () => brokenKeys }),
  ).toBeNull();
  const deps = {
    environment: "development" as const,
    authorize: async () => null,
    readDashboard: async () => ({ cohorts: [], sources: [] }),
  };
  expect(
    (await handleGrowthOperatorRequest(new Request("https://ops.example/growth"), deps)).status,
  ).toBe(403);
  const response = await handleGrowthOperatorRequest(new Request("https://ops.example/growth"), {
    ...deps,
    authorize: async () => ({ subject: "operator", permissions: ["growth.read_aggregate"] }),
  });
  expect(await response.text()).toContain("Pending");
  const aggregate = {
    ...deps,
    authorize: async () => ({ subject: "operator", permissions: ["growth.read_aggregate"] }),
    readTimeline: async () => ({
      items: [
        {
          at: "now",
          stage: "started",
          error: null,
          actor: null,
          client: null,
          clientTrust: null,
          transport: "remote_mcp",
          campaign: "<script>alert(1)</script>",
          environment: null,
          kind: null,
          health: null,
        },
      ],
      nextCursor: null,
      nextMissingStage: null,
      lastActivity: null,
      elapsed: null,
    }),
  };
  const timeline = await handleGrowthOperatorRequest(
    new Request("https://ops.example/growth/timeline?subject=a&scope=b"),
    {
      ...aggregate,
      authorize: async () => ({
        subject: "operator",
        permissions: ["growth.read_aggregate", "growth.read_identity"],
      }),
    },
  );
  const html = await timeline.text();
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("remote_mcp");
  expect(html).not.toContain("<script>");
  expect(
    (
      await handleGrowthOperatorRequest(
        new Request("https://ops.example/growth/timeline?subject=a&scope=b&identity=1"),
        aggregate,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await handleGrowthOperatorRequest(
        new Request("https://ops.example/growth", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "content-type": "application/json",
            "x-growth-csrf": "1",
          },
          body: "{}",
        }),
        {
          ...aggregate,
          authorize: async () => ({
            subject: "operator",
            permissions: ["growth.read_aggregate", "growth.manage_experiments"],
          }),
        },
      )
    ).status,
  ).toBe(403);
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
    for (const migration of [
      "0001_growth.sql",
      "0002_deployment_health.sql",
      "0003_source_status.sql",
      "0005_account_rollups.sql",
    ]) {
      await db.batch(
        splitStatements(
          readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
        ).map((sql) => db.prepare(sql)),
      );
    }
    const data = createOperatorData(db, () => new Date("2026-11-15T00:00:00.000Z"));
    const experimentStore = createExperimentStore(db);
    const manager = {
      ...data,
      environment: "development" as const,
      authorize: async () => ({
        subject: "operator",
        permissions: ["growth.read_aggregate", "growth.manage_experiments"],
      }),
      registerExperiment: experimentStore.registerExperiment,
    };
    const page = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth"),
      manager,
    );
    const cookie = page.headers.get("set-cookie") ?? "";
    const csrf = /__Host-growth-csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect(await page.text()).toContain("Register experiment");
    const form = new URLSearchParams({
      csrf,
      action: "register",
      hypothesis: "Improve setup",
      evidence_basis: "hypothesis",
      evidence_reference: "",
      segment: "all",
      primary_metric: "workspace_ready_7d",
      guardrails: "login, errors",
      horizon_start: "2026-11-01T00:00",
      horizon_end: "2099-01-01T00:00",
      baseline_version: "version-a",
      variant_version: "version-b",
      exposure_mode: "before_after",
    });
    const posted = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth", {
        method: "POST",
        headers: {
          origin: "https://ops.example",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: form,
      }),
      manager,
    );
    expect(posted.status).toBe(303);
    const dashboard = await data.readDashboard({ limit: 50, cursor: null });
    expect(dashboard.experiments?.[0]).toMatchObject({
      hypothesis: "Improve setup",
      sampleSize: 0,
      mature: false,
      comparison: "descriptive before / after",
    });
    expect(dashboard.sources.every((x) => x.status === "unavailable")).toBe(true);
    expect(dashboard.cohorts).toEqual([]);
    const event = {
      schema_version: 1,
      event_id: "account_event",
      event_name: "account_created",
      outcome: "succeeded",
      occurred_at: "2026-11-01T00:00:00Z",
      received_at: "2026-11-01T00:00:00Z",
      platform_environment: "development",
      producer: "workos",
      evidence_kind: "event",
      flow_id: null,
      account_id: "user_one",
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
    } as const;
    await db
      .prepare(
        "INSERT INTO growth_events(event_id,account_id,organization_id,event_name,occurred_at,received_at,body) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        event.event_id,
        event.account_id,
        null,
        event.event_name,
        event.occurred_at,
        event.received_at,
        JSON.stringify(event),
      )
      .run();
    const store = createGrowthEventStore(db, () => new Date("2026-11-15T00:00:00.000Z"));
    const delivered = {
      ...event,
      event_id: "delivered",
      event_name: "product_call_succeeded",
      producer: "control_api",
      occurred_at: "2026-11-02T00:00:00.000Z",
      received_at: "2026-11-02T00:00:00.000Z",
      platform_version: "version-a",
      transport: "remote_mcp",
    } as const;
    await store.appendEvent(delivered);
    await observeDeliveredExperiment(db, delivered);
    expect(
      (await db.prepare("SELECT count(*) n FROM growth_exposures").first<{ n: number }>())?.n,
    ).toBe(0);
    // This fixture registered a real past candidate; production observations cannot predate registration.
    await db
      .prepare("UPDATE growth_experiments SET created_at=?")
      .bind("2026-11-01T00:00:00.000Z")
      .run();
    await observeDeliveredExperiment(db, delivered);
    await observeDeliveredExperiment(db, delivered);
    const withVersion = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth"),
      manager,
    );
    expect(await withVersion.text()).toContain(
      "Observed authorized response versions (up to 20 from retained events): version-a",
    );
    const ready = {
      ...event,
      event_id: "ready",
      event_name: "workspace_ready",
      producer: "core",
      occurred_at: "2026-11-03T00:00:00.000Z",
      received_at: "2026-11-03T00:00:00.000Z",
    } as const;
    await store.appendEvent(ready);
    const measured = await createOperatorData(
      db,
      () => new Date("2026-11-10T00:00:00.000Z"),
    ).readDashboard({ limit: 50, cursor: null });
    expect(measured.experiments?.[0]?.conclusion).toContain(
      "baseline: 1 exposed, 1 mature, 0 pending, 1 converted, 0 unknown",
    );
    const variantDelivered = {
      ...delivered,
      event_id: "delivered_variant",
      platform_version: "version-b",
    };
    await store.appendEvent(variantDelivered);
    await observeDeliveredExperiment(db, variantDelivered);
    const contaminated = await createOperatorData(
      db,
      () => new Date("2026-11-10T00:00:00.000Z"),
    ).readDashboard({ limit: 50, cursor: null });
    expect(contaminated.experiments?.[0]?.limitations).toContain(
      "1 cross-exposed accounts excluded",
    );
    expect(
      (
        await data.readTimeline({ subject: "user_one", scope: "account", limit: 50, cursor: null })
      ).items.some((item) => item.stage === "account_created"),
    ).toBe(true);
    expect((await data.readAccounts({ limit: 50, cursor: null })).accounts[0]?.subject).toBe(
      "user_one",
    );
    await db
      .prepare(
        "INSERT INTO growth_source_status(source,generation,last_attempt_at,last_success_at,completed_scan_at,quality_flags) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "identity",
        "g",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "[]",
      )
      .run();
    const quiet = await createOperatorData(
      db,
      () => new Date("2026-11-15T00:05:00Z"),
    ).readDashboard({ limit: 50, cursor: null });
    expect(quiet.sources.find((x) => x.source === "identity")).toMatchObject({
      status: "available",
      watermark: null,
    });
    const payment = {
      fact_type: "payment",
      fact_id: "f",
      provider_fact_id: "provider_f",
      organization_id: null,
      amount_minor: 500,
      currency: "USD",
      money_effect: "received",
    };
    await db
      .prepare(
        "INSERT INTO growth_facts(fact_id,account_id,organization_id,occurred_at,body) VALUES(?,?,?,?,?)",
      )
      .bind("f", null, null, "2026-11-01T00:00:00Z", JSON.stringify(payment))
      .run();
    const withUnassigned = await data.readDashboard({ limit: 50, cursor: null });
    expect(withUnassigned.money).toEqual([]);
    expect(withUnassigned.limitations?.join(" ")).toContain("scope is unassigned");
    await db
      .prepare(
        "INSERT OR REPLACE INTO growth_account_projection(account_id,created_at,observed_at,source_kind) VALUES(?,?,?,?)",
      )
      .bind("user_one", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "identity")
      .run();
    await db
      .prepare(
        "INSERT INTO growth_source_status(source,generation,last_attempt_at,last_success_at,completed_scan_at,quality_flags) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "memberships",
        "g",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "[]",
      )
      .run();
    const segmentManager = {
      ...manager,
      authorize: async () => ({
        subject: "operator",
        permissions: ["growth.read_aggregate", "growth.read_identity", "growth.manage_segments"],
      }),
    };
    const segmentPage = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth"),
      segmentManager,
    );
    const segmentCookie = segmentPage.headers.get("set-cookie") ?? "";
    const segmentCsrf = /__Host-growth-csrf=([^;]+)/.exec(segmentCookie)?.[1] ?? "";
    expect(await segmentPage.text()).toContain("Set segment");
    const segmentBody = new URLSearchParams({
      action: "segment",
      csrf: segmentCsrf,
      entity_type: "account",
      entity_id: "user_one",
      segment: "test",
    });
    const segmentRequest = () =>
      new Request("https://ops.example/growth", {
        method: "POST",
        headers: {
          origin: "https://ops.example",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
          cookie: segmentCookie,
        },
        body: segmentBody,
      });
    expect((await handleGrowthOperatorRequest(segmentRequest(), manager)).status).toBe(403);
    expect((await handleGrowthOperatorRequest(segmentRequest(), segmentManager)).status).toBe(303);
    const audit = await db
      .prepare("SELECT subject_digest,segment FROM growth_segment_audit")
      .first<{ subject_digest: string; segment: string }>();
    expect(audit?.segment).toBe("test");
    expect(audit?.subject_digest).not.toContain("user_one");
    const segmentData = createOperatorData(db, () => new Date("2026-11-15T00:05:00Z"));
    expect(
      (await segmentData.readDashboard({ limit: 50, cursor: null, segment: "test" })).cohorts[0]
        ?.mature,
    ).toBe(1);
    expect(
      (await segmentData.readDashboard({ limit: 50, cursor: null, segment: "non_test" })).cohorts[0]
        ?.mature,
    ).toBe(0);
    expect(
      (await segmentData.readDashboard({ limit: 50, cursor: null, segment: "all" })).cohorts[0]
        ?.mature,
    ).toBe(1);
    await db
      .prepare(
        "INSERT INTO growth_source_status(source,generation,last_attempt_at,last_success_at,completed_scan_at,quality_flags) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "billing",
        "g",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "[]",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO growth_facts(fact_id,account_id,organization_id,occurred_at,body) VALUES(?,?,?,?,?)",
      )
      .bind(
        "org_payment",
        "user_one",
        "org_one",
        "2026-11-01T00:00:00Z",
        JSON.stringify({
          ...payment,
          fact_id: "org_payment",
          provider_fact_id: "org_provider",
          organization_id: "org_one",
        }),
      )
      .run();
    expect(
      (await segmentData.readDashboard({ limit: 50, cursor: null, segment: "test" })).money,
    ).toEqual([]);
    expect(
      (await segmentData.readDashboard({ limit: 50, cursor: null, segment: "unknown" })).money?.[0]
        ?.gross,
    ).toBe(500);
    await data.setSegment({
      entityType: "organization",
      entityId: "org_one",
      segment: "non_test",
      operator: "operator",
    });
    expect(
      (await segmentData.readDashboard({ limit: 50, cursor: null, segment: "non_test" })).money?.[0]
        ?.gross,
    ).toBe(500);
    const resolve = auditIdentityRead(db, async () => {
      expect(
        (await db.prepare("SELECT count(*) AS n FROM growth_identity_audit").first<{ n: number }>())
          ?.n,
      ).toBe(1);
      return { name: null, email: null };
    });
    await resolve({ subject: "user", operator: "operator" });
    await db
      .prepare("INSERT INTO growth_campaigns(campaign_key,body,expires_at) VALUES(?,?,?)")
      .bind(
        "campaign_one",
        JSON.stringify({
          campaign_key: "campaign_one",
          account_id: "user_one",
          r: "ref",
          utm: { utm_source: "<unsafe>" },
          observed_at: "2026-11-01T00:00:00Z",
          expires_at: "2099-01-01T00:00:00Z",
        }),
        "2099-01-01T00:00:00Z",
      )
      .run();
    const identityDeps = {
      ...segmentManager,
      resolveIdentityForOperator: auditIdentityRead(db, async () => ({
        name: "Ada",
        email: "ada@example.test",
      })),
    };
    const attributed = await handleGrowthOperatorRequest(
      new Request(
        "https://ops.example/growth/timeline?subject=user_one&scope=account&attribution=1",
      ),
      identityDeps,
    );
    const attributedHtml = await attributed.text();
    expect(attributedHtml).toContain("&lt;unsafe&gt;");
    expect(attributedHtml).not.toContain("<unsafe>");
    const identity = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth/timeline?subject=user_one&scope=account&identity=1"),
      identityDeps,
    );
    expect(await identity.text()).toContain("ada@example.test");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM growth_identity_audit").first<{ n: number }>())
        ?.n,
    ).toBe(3);
    await db
      .prepare(
        "INSERT INTO growth_source_status(source,generation,last_attempt_at,last_success_at,completed_scan_at,quality_flags) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "deployments",
        "g",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "2026-11-15T00:00:00Z",
        "[]",
      )
      .run();
    const deployment = {
      fact_type: "deployment",
      fact_id: "deploy_fact",
      deployment_id: "dep_one",
      organization_id: "org_one",
      status: "succeeded",
      health_status: "passed",
      succeeded_at: "2026-11-01T00:00:00Z",
      target_environment: "prod",
      kind: "deploy",
    };
    await db
      .prepare(
        "INSERT INTO growth_facts(fact_id,account_id,organization_id,occurred_at,body) VALUES(?,?,?,?,?)",
      )
      .bind(
        "deploy_fact",
        "user_one",
        "org_one",
        "2026-11-01T00:00:00Z",
        JSON.stringify(deployment),
      )
      .run();
    await db
      .prepare(
        "INSERT INTO growth_activity(event_id,account_id,organization_id,occurred_at) VALUES(?,?,?,?)",
      )
      .bind("activity", "user_one", "org_one", "2026-11-08T00:00:00Z")
      .run();
    await db
      .prepare(
        "INSERT INTO growth_daily_account_rollups(cohort_day,window_days,mature,positive,unknown,incomplete,refreshed_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind("2026-11-01", 7, 5, 3, 2, 1, "2026-11-15T00:00:00Z")
      .run();
    const errEvent = {
      ...event,
      event_id: "failure",
      event_name: "login_failed",
      error_class: "provider_denied",
    };
    await db
      .prepare(
        "INSERT INTO growth_events(event_id,account_id,organization_id,event_name,occurred_at,received_at,body) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        errEvent.event_id,
        errEvent.account_id,
        null,
        errEvent.event_name,
        errEvent.occurred_at,
        errEvent.received_at,
        JSON.stringify(errEvent),
      )
      .run();
    const accountsView = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth?accounts=1"),
      identityDeps,
    );
    expect(await accountsView.text()).toContain("user_one");
    const allView = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth"),
      identityDeps,
    );
    const allHtml = await allView.text();
    expect(allHtml).toContain("provider_denied: 1");
    expect(allHtml).toContain("D7:");
    expect(allHtml).toContain("3 / 5");
    const rendered = await handleGrowthOperatorRequest(
      new Request("https://ops.example/growth?segment=non_test"),
      identityDeps,
    );
    const renderedHtml = await rendered.text();
    expect(renderedHtml).toContain("gross 500");
    expect(renderedHtml).toContain("Account → workspace");
    expect(renderedHtml).toContain("Source health");
  } finally {
    await mf.dispose();
  }
});
