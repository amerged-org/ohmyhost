import { describe, expect, it } from "vitest";
import { createControlStore } from "../src/store.js";
import { readGrowthFactPage } from "../src/catalog/growth/facts.js";

describe("growth fact source", () => {
  it("bounds and isolates the fixed source reader", async () => {
    const sql: string[] = [];
    const db = {
      prepare(query: string) {
        sql.push(query);
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [], success: true, meta: { changes: 0 } };
          },
        };
      },
    };
    await expect(
      readGrowthFactPage(db as never, { source: "memberships", cursor: null, limit: 201 }),
    ).rejects.toThrow();
    const page = await readGrowthFactPage(db as never, {
      source: "memberships",
      cursor: null,
      limit: 2,
    });
    expect(page.facts).toEqual([]);
    expect(page.history_floor).toBeNull();
    expect(sql[0]).toContain("organization_memberships");
    await expect(
      readGrowthFactPage(db as never, { source: "billing", cursor: null, limit: 1 }),
    ).rejects.toThrow();
  });
});

it("reads original project ownership and deployment evidence from D1", async () => {
  const { Miniflare } = await import("miniflare");
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch(){ return new Response() } }",
    d1Databases: { DB: "db" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of [
      "CREATE TABLE user_signup(workos_user_id TEXT, origin_source TEXT, origin_present INTEGER, utm_parameters TEXT, recorded_at TEXT)",
      `INSERT INTO user_signup VALUES('user_one','newsletter',1,'{"utm_custom":"café"}','2026-11-15T00:00:00.000000Z')`,
      "CREATE TABLE stripe_billing_customers(organization_id TEXT, provider_id TEXT, provider_confirmed_at TEXT)",
      "INSERT INTO stripe_billing_customers VALUES('original','cus_one','2026-11-15T00:00:00.000000Z')",
      "CREATE TABLE project_identities(project_id TEXT, created_organization_id TEXT, created_event_id TEXT, created_at TEXT)",
      "CREATE TABLE billing_epochs(project_id TEXT, organization_id TEXT, created_by_principal_id TEXT, started_at TEXT)",
      "CREATE TABLE deployments(deployment_id TEXT, organization_id TEXT, project_id TEXT, operation_id TEXT, environment_id TEXT, kind TEXT, status TEXT, created_at TEXT, updated_at TEXT, active_revision_id TEXT)",
      "CREATE TABLE deployment_revisions(organization_id TEXT, project_id TEXT, deployment_id TEXT, revision_id TEXT, wfp_receipt_id TEXT)",
      "CREATE TABLE wfp_publish_receipts(organization_id TEXT, project_id TEXT, wfp_receipt_id TEXT, environment_id TEXT, product_deployment_id TEXT, candidate_receipt_id TEXT)",
      "INSERT INTO deployment_revisions VALUES('original','p1','d1','r1','w1')",
      "INSERT INTO wfp_publish_receipts VALUES('original','p1','w1','env1','d1','candidate1')",
      "CREATE TABLE environments(organization_id TEXT, environment_id TEXT, name TEXT)",
      "CREATE TABLE audit_events(organization_id TEXT, operation_id TEXT, actor_type TEXT, actor_id TEXT, occurred_at TEXT, audit_event_id TEXT)",
      "CREATE TABLE operation_events(organization_id TEXT, operation_id TEXT, event_type TEXT, revision INTEGER, occurred_at TEXT, event_id TEXT)",
      "CREATE TABLE deployment_diagnostics(deployment_id TEXT, organization_id TEXT, project_id TEXT, environment_id TEXT, source TEXT, diagnostic_event_id TEXT, code TEXT, occurred_at TEXT)",
      "INSERT INTO project_identities VALUES('p1','original','event1','2026-11-15T00:00:00.000000Z')",
      "INSERT INTO billing_epochs VALUES('p1','original','user:user_creator','2026-11-15T00:00:00.000000Z')",
      "INSERT INTO billing_epochs VALUES('p1','newowner','user_other','2026-11-16T00:00:00.000000Z')",
      "INSERT INTO environments VALUES('original','env1','prod')",
      "INSERT INTO deployments VALUES('d1','original','p1','op1','env1','deploy','succeeded','2026-11-15T00:01:00.000000Z','2026-11-15T00:02:00.000000Z','r1')",
      "INSERT INTO audit_events VALUES('original','op1','user','user:user_creator','2026-11-15T00:01:00.000000Z','a1')",
      "INSERT INTO operation_events VALUES('original','op1','OperationSucceeded',2,'2026-11-15T00:02:00.000000Z','ev1')",
    ])
      await db.prepare(sql).run();
    const facts = createControlStore({
      CONTROL_CORE: db as never,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
    }).growthFacts;
    expect(await facts.resolveGrowthStripeCustomer({ customer_id: "cus_one" })).toEqual({
      organization_id: "original",
    });
    expect(await facts.resolveGrowthStripeCustomer({ customer_id: "cus_missing" })).toBeNull();
    const attribution = await facts.readFactPage({
      source: "attribution",
      cursor: null,
      limit: 10,
    });
    expect(attribution.facts).toMatchObject([
      { account_id: "user_one", r: "newsletter", utm_parameters: '{"utm_custom":"café"}' },
    ]);
    const projects = await readGrowthFactPage(db as never, {
      source: "projects",
      cursor: null,
      limit: 10,
    });
    expect(projects.facts).toMatchObject([
      { organization_id: "original", account_id: "user_creator" },
    ]);
    const deployments = await readGrowthFactPage(db as never, {
      source: "deployments",
      cursor: null,
      limit: 10,
    });
    expect(deployments.facts).toMatchObject([
      {
        organization_id: "original",
        account_id: "user_creator",
        target_environment: "prod",
        terminal_at: "2026-11-15T00:02:00.000000Z",
        candidate_receipt_id: "candidate1",
        health_evidence_id: null,
      },
    ]);
  } finally {
    await mf.dispose();
  }
});
