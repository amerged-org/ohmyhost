import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../src/catalog/common.js";
import type { D1Database } from "../src/d1-types.js";
import { createControlStore } from "../src/store.js";
import { activateTestCore, migrationFiles } from "./support/control-d1.js";
import { projectInput, seedOrganization, type Store } from "./support/seed.js";
import { ensureCreditTables } from "./support/credit-tables.js";
import { splitStatements } from "./support/sql.js";

/**
 * Migration 0601 removes the old credit, metering, usage and billing schema from a Core that carries 0001..0600 and
 * keeps everything login, project creation, deploys and serving stand on. The kept set is spelled out here, not derived
 * from the migration, so a table that appears or disappears is a reviewed change of this list.
 */
const KEPT_TABLES = [
  // identity, organizations, projects, environments, operations, audit
  "action_confirmations",
  "api_idempotency_records",
  "api_key_metadata",
  "audit_events",
  "billing_epochs",
  "bucket_fences",
  "command_log",
  "core_authority_activation",
  "core_historical_import",
  "core_layout",
  "control_source_migration_sequence",
  "control_source_migrations",
  "data_environment_identities",
  "domain_directory",
  "environment_data_assignments",
  "environment_identities",
  "environments",
  "evidence_exports",
  "external_route",
  "guard_fail",
  "inbox_unrouted",
  "local_authorization_grants",
  "m2m_organization_bindings",
  "mcp_client_grants",
  "mcp_client_revocations",
  "mcp_handoff_routes",
  "mcp_mail_domain_grants",
  "mcp_portal_handoffs",
  "onboarding_requests",
  "operation_events",
  "operation_mcp_delegations",
  "operations",
  "org_directory",
  "organization_audit_events",
  "organization_memberships",
  "organizations",
  "outbox_events",
  "pending_membership_barriers",
  "platform_settings",
  "principal_mappings",
  "project_agent_note_requests",
  "project_agent_notes",
  "project_creation_aborts",
  "project_data_environments",
  "project_directory",
  "project_handle_releases", //0690, applied by beforeAll because project admission reads it
  "project_identities",
  "project_scope_history",
  "projects",
  "public_intake",
  "retention_horizon",
  "revocations",
  "shard_buckets",
  "shards",
  "user_api_key_requests",
  "work_due",
  "workos_membership_sync_barriers",
  // user relations and configuration that outlive the credit model
  "project_powered_by_flag_periods",
  "project_powered_by_flag_requests",
  "pgcf_database_entitlement_actions",
  "pgcf_database_entitlement_policies",
  "published_credit_rate_cards",
  "signup_sources",
  "stripe_billing_customers",
  "stripe_recharge_policies",
  "usage_meter_activations",
  "user_signup",
  "webhook_inbox",
  // public entry
  "beta_feature_interests",
  "beta_feature_vote_allocator",
  "beta_interests",
  "contact_requests",
  "customer_feedback",
  "customer_feedback_events",
  // builds, sources, deployments, Workers for Platforms, gateway
  "build_artifacts",
  "build_executions",
  "build_input_reservations",
  "build_receipts",
  "build_source_upload_parts",
  "build_source_uploads",
  "build_usage",
  "cleanup_runs",
  "delivery_attempts",
  "deployment_diagnostics",
  "deployment_plans",
  "deployment_revisions",
  "deployments",
  "environment_function_schedules",
  "function_runs",
  "github_auto_deploy_configs",
  "github_connection_authorizations",
  "github_organization_connections",
  "github_push_deployments",
  "github_repository_link_consents",
  "github_source_authorizations",
  "github_source_connections",
  "managed_source_blobs",
  "managed_source_initializations",
  "managed_source_publications",
  "managed_source_repositories",
  "managed_source_reservations",
  "product_command_intents",
  "product_provider_mutation_claims",
  "product_provider_mutation_observations",
  "product_provider_reconciliation_attempts",
  "product_source_archive_objects",
  "product_workflow_replay_attempts",
  "product_workflow_replay_failures",
  "product_workflow_runs",
  "project_recovery_fences",
  "project_recovery_jobs",
  "project_source_bindings",
  "project_sources",
  "provider_resources",
  "repository_grant_revocations",
  "repository_grants",
  "run_cleanup_attempts",
  "run_resource_inventory",
  "runtime_probe_windows",
  "shared_gateway_address_receipts",
  "shared_gateway_route_revisions",
  "source_archives",
  "source_connections",
  "wfp_candidate_cleanup_claims",
  "wfp_candidate_cleanup_receipts",
  "wfp_candidate_cleanup_requests",
  "wfp_candidate_cleanup_resource_expectations",
  "wfp_candidate_cleanups",
  "wfp_candidate_operation_cleanup_receipts",
  "wfp_candidate_receipts",
  "wfp_publish_receipts",
  "wfp_rollback_activation_receipts",
  // secrets, access, domains, DNS
  "cloudflare_general_grant_uses",
  "cloudflare_project_authorization_states",
  "cloudflare_project_dns_grants",
  "cloudflare_project_domain_receipts",
  "cloudflare_project_domains",
  "cloudflare_project_oauth_revocations",
  "dev_access_tickets",
  "dev_share_link_rotations",
  "dev_share_links",
  "domain_claim_aborts",
  "environment_secret_requests",
  "environment_secrets",
  "paid_project_domains",
  "project_dev_access_requests",
  "runtime_secret_delivery_receipts",
  "runtime_secret_delivery_stage_activations",
  "runtime_secret_delivery_stage_compensations",
  "runtime_secret_delivery_stages",
  "runtime_secret_delivery_states",
  "scoped_customer_dns_authorizations",
  "scoped_customer_dns_grants",
  "scoped_customer_dns_revocations",
  "scoped_dns_provider_uses",
  "storage_gateway_keys",
  // databases, PGCF, storage
  "database_provider_cutover_authorizations",
  "database_provider_cutover_binding_refreshes",
  "database_provider_cutover_receipts",
  "database_provider_cutover_releases",
  "database_provider_cutover_verifications",
  "database_provider_legacy_retirements",
  "database_provider_operations",
  "database_provider_target_heads",
  "database_provider_target_revisions",
  "neon_project_placement_receipts",
  "neon_project_placement_reservations",
  "neon_project_role_receipts",
  "pgcf_database_claim_aborts",
  "pgcf_database_claims",
  "pgcf_database_compute_changes",
  "pgcf_database_migration_receipts",
  "pgcf_database_serving_intervals",
  "pgcf_platform_database_activations",
  "project_database_access",
  "project_database_compute_changes",
  "project_database_registration_receipts",
  "project_database_registration_reservations",
  "project_database_writes",
  "project_r2_bucket_receipts",
  "project_r2_bucket_reservations",
  "project_r2_delete_receipts",
  "project_r2_delete_requests",
  "project_r2_erasure_barriers",
  "project_r2_objects",
  "project_r2_upload_reservations",
  // mail
  "infrastructure_alert_receipts",
  "legacy_aws_mail_absence",
  "legacy_aws_mail_receipts",
  "mail_gateway_keys",
  "mail_received_messages",
  "mail_reputation_decisions",
  "mail_reputation_states",
  "mail_send_events",
  "mail_send_outcomes",
  "mail_send_requests",
  "project_application_domain_identities",
  "project_application_identity_action_commands",
  "project_application_identity_commands",
  "project_mail_domain_bindings",
  "project_mail_domain_requests",
  "project_mail_domains",
  "resend_event_receipts",
  "resend_mail_commands",
  "resend_mail_domains",
  "route53_dkim_change_receipts",
  "route53_dkim_receipts",
  "ses_event_destination_receipts",
  "ses_project_mail_resource_receipts",
  "ses_tenant_receipts",
  "shared_mail_capabilities",
  "workspace_mail_commands",
  "workspace_mail_domains",
  "workspace_mail_reputation_decisions",
];

/** The tables of migration 0600; the credit_log key is AUTOINCREMENT, so the engine adds sqlite_sequence. */
const W33_TABLES = [
  "credit_account",
  "credit_grant",
  "credit_log",
  "credit_reservation",
  "project_credit",
  "usage_cursor",
];

const DROP_MIGRATION = "0601_credit_drop_old.sql";
const STAMP = "2026-10-30T12:00:00.000000Z";
const MAIL_CREDIT_COLUMNS = [
  "credit_charge_micros",
  "credit_reservation_id",
  "credit_rate_card_id",
  "credit_meter",
  "credit_provider_cost_micros",
];
/** Tables rebuilt by 0601 whose rows, indexes and guards must come through unchanged. */
const MAIL_TABLES = [
  "mail_send_requests",
  "mail_send_events",
  "mail_send_outcomes",
  "mail_reputation_states",
  "mail_reputation_decisions",
] as const;
/** Tables whose rows are user relations or configuration and must come through 0601 unchanged. */
const SURVIVING_DATA = [
  "published_credit_rate_cards",
  "usage_meter_activations",
  "signup_sources",
  "onboarding_requests",
  "user_signup",
  "stripe_billing_customers",
  "stripe_recharge_policies",
  "mail_gateway_keys",
  ...MAIL_TABLES,
  "organizations",
  "organization_memberships",
  "projects",
  "billing_epochs",
  "environments",
] as const;

type Row = Record<string, unknown>;

let miniflare: Miniflare;
let db: D1Database;
let store: Store;
let migration = "";
const before: Record<string, Row[]> = {};
let mailColumnsBefore: string[] = [];
let mailSchemaBefore: Row[] = [];

async function apply(sql: string): Promise<void> {
  await db.batch(splitStatements(sql).map((statement) => db.prepare(statement)));
}

async function rows(sql: string, ...binds: unknown[]): Promise<Row[]> {
  return (
    await db
      .prepare(sql)
      .bind(...binds)
      .all<Row>()
  ).results;
}

/** Every row of a table in a fixed order, so a before/after comparison does not depend on storage order. */
async function snapshot(table: string): Promise<Row[]> {
  const all = await rows(`SELECT * FROM ${table}`);
  return all.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function schemaObjects(): Promise<
  { type: string; name: string; tbl_name: string; sql: string }[]
> {
  return (await rows(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY type, name",
  )) as never;
}

const hex = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32);

/** The user relations and mail history of one organization, in the shapes the code writes them. */
async function seedSurvivors(organizationId: string, projectId: string): Promise<void> {
  const userId = "user_before_drop";
  const requestId = newUlid();
  const messageRequestId = newUlid();
  const eventId = "11111111-2222-4333-8444-555555555555";
  const decisionId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  await db.batch([
    db.prepare(
      "INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros) VALUES ('web',1,1,0)",
    ),
    db
      .prepare(
        "INSERT INTO onboarding_requests(request_id,workos_user_id,idempotency_sha256,request_sha256,name,organization_attempted,membership_attempted,signup_source,created_at) VALUES (?1,?2,unhex(?3),unhex(?4),'First',0,0,'web',?5)",
      )
      .bind(requestId, userId, hex(1), hex(2), STAMP),
    db
      .prepare(
        "INSERT INTO user_signup(workos_user_id,origin_source,recorded_at,origin_present) VALUES (?1,'web',?2,1)",
      )
      .bind(userId, STAMP),
    db
      .prepare(
        "UPDATE user_signup SET attributed_source='web',first_request_id=?2,bonus_micros='0',attributed_at=?3 WHERE workos_user_id=?1 AND attributed_source IS NULL",
      )
      .bind(userId, requestId, STAMP),
    db
      .prepare(
        "INSERT INTO stripe_billing_customers(organization_id,request_id,account_id,mode,created_by,created_at) VALUES (?1,?2,'acct_test','test','operator:test',?3)",
      )
      .bind(organizationId, newUlid(), STAMP),
    db
      .prepare(
        "INSERT INTO stripe_recharge_policies(organization_id,account_id,mode,enabled,revision,monthly_limit_minor,status,setup_id,updated_at) VALUES (?1,'acct_test','test',0,1,1000,'off',?2,?3)",
      )
      .bind(organizationId, newUlid(), STAMP),
    db
      .prepare(
        "INSERT INTO mail_gateway_keys(organization_id,project_id,key_version,key_sha256,created_at) VALUES (?1,?2,1,unhex(?3),?4)",
      )
      .bind(organizationId, projectId, hex(3), STAMP),
    // a send request in the shape before 0601, with its credit columns
    db
      .prepare(
        "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,credit_charge_micros,state,provider_started_at,provider_message_id,requested_at,updated_at,mail_provider) VALUES (?1,?2,?3,'idem-1',unhex(?4),unhex(?5),unhex(?6),1000,'accepted',?7,'msg-1',?7,?7,'resend')",
      )
      .bind(messageRequestId, organizationId, projectId, hex(4), hex(5), hex(6), STAMP),
    db
      .prepare(
        "INSERT INTO mail_send_events(provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,detail_sha256,occurred_at,sent_at,received_at,reputation_kind) VALUES (?1,?2,?3,?4,'msg-1','Bounce','bounced',unhex(?5),?6,?6,?6,'hard_bounce')",
      )
      .bind(eventId, organizationId, projectId, messageRequestId, hex(7), STAMP),
    db
      .prepare(
        "INSERT INTO mail_send_outcomes(organization_id,project_id,request_id,outcome,provider_event_id,occurred_at,version,updated_at) VALUES (?1,?2,?3,'bounced',?4,?5,1,?5)",
      )
      .bind(organizationId, projectId, messageRequestId, eventId, STAMP),
    db
      .prepare(
        "INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at) VALUES (?1,?2,'active',?3,1,?3)",
      )
      .bind(organizationId, projectId, STAMP),
    db
      .prepare(
        "INSERT INTO mail_reputation_decisions(decision_id,organization_id,project_id,action,reason,triggering_event_id,eligible_send_count,hard_bounce_count,complaint_count,actor_id,evidence_sha256,occurred_at) VALUES (?1,?2,?3,'retain','manual_review',NULL,1,1,0,'operator:test',unhex(?4),?5)",
      )
      .bind(decisionId, organizationId, projectId, hex(8), STAMP),
  ]);
}

/** Rows in the tables that go: a funded lot, an open build hold with its lot movement, the effects that recorded them. */
async function seedMoney(
  organizationId: string,
  project: ReturnType<typeof projectInput>,
): Promise<void> {
  const grantId = newUlid();
  const holdId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO credit_wallets(organization_id, version, created_at, updated_at) VALUES (?1, 0, ?2, ?2)",
      )
      .bind(organizationId, STAMP),
    db
      .prepare(
        "INSERT INTO credit_lots(organization_id, grant_id, kind, source_reference, amount_micros, granted_at, expires_at, is_topup, held_micros, spent_micros) VALUES (?1, ?2, 'free_monthly', 'm-1', 200000000, ?3, '2026-11-30T00:00:00.000000Z', 0, 5000000, 0)",
      )
      .bind(organizationId, grantId, STAMP),
    db
      .prepare(
        "INSERT INTO credit_holds(organization_id, hold_id, project_id, environment_id, billing_epoch_id, kind, source_reference, amount_micros, state, created_at, refunded_micros, restored_micros) VALUES (?1, ?2, ?3, ?4, ?5, 'build', 'build-1', 5000000, 'open', ?6, 0, 0)",
      )
      .bind(
        organizationId,
        holdId,
        project.projectId,
        project.developmentEnvironmentId,
        project.billingEpochId,
        STAMP,
      ),
    db
      .prepare(
        "INSERT INTO credit_hold_lots(organization_id, hold_id, grant_id, held_micros, spent_micros, restored_micros) VALUES (?1, ?2, ?3, 5000000, 0, 0)",
      )
      .bind(organizationId, holdId, grantId),
    db
      .prepare(
        "INSERT INTO credit_effects(organization_id, effect_id, effect_kind, occurred_at, payload) VALUES (?1, ?2, 'reserve', ?3, '{}')",
      )
      .bind(organizationId, `reserve:${holdId}`, STAMP),
    db.prepare(
      "INSERT INTO published_credit_rate_cards(rate_card_id,published_at,effective_from,rates) VALUES ('rc1','2026-10-01T00:00:00.000000Z','2026-10-02T00:00:00.000000Z','[{\"meter\":\"build_minutes\"}]')",
    ),
    db.prepare(
      "INSERT INTO usage_meter_activations(meter,rate_card_id,starts_at,activated_at) VALUES ('build_minutes','rc1','2026-10-02T00:00:00.000000Z','2026-10-01T00:00:00.000000Z')",
    ),
  ]);
  for (const table of ["credit_lots", "credit_holds", "credit_hold_lots", "credit_effects"])
    expect((await rows(`SELECT count(*) AS n FROM ${table}`))[0]?.["n"], table).toBeGreaterThan(0);
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CORE: "credit-drop" },
  });
  db = (await miniflare.getD1Database("CORE")) as unknown as D1Database;
  const files = migrationFiles("core");
  for (const file of files.filter((candidate) => candidate.name < "0600")) await apply(file.sql);
  const w33 = files.find((file) => file.name.startsWith("0600_"));
  if (w33 !== undefined) await apply(w33.sql);
  else await ensureCreditTables(db);
  // The catalog admits a project handle against the table 0690 adds; nothing in it touches the credit tables.
  const handleReleases = files.find((file) => file.name === "0690_project_handle_releases.sql");
  if (handleReleases === undefined) throw new Error("0690_project_handle_releases.sql is missing");
  await apply(handleReleases.sql);
  const drop = files.find((file) => file.name === DROP_MIGRATION);
  if (drop === undefined) throw new Error(`${DROP_MIGRATION} is missing`);
  migration = drop.sql;
  await activateTestCore(db);
  store = createControlStore({ CONTROL_CORE: db });

  // The state of a live Core before the drop, built through the real catalog commands where they do not touch money.
  const organizationId = await seedOrganization(store, 2, 1);
  const project = projectInput(organizationId, "survives-the-drop", false);
  await store.projects.createInitialProject(project);
  await seedSurvivors(organizationId, project.projectId);
  await seedMoney(organizationId, project);
  mailColumnsBefore = (
    await rows("SELECT name FROM pragma_table_info('mail_send_requests') ORDER BY cid")
  ).map((row) => String(row["name"]));
  mailSchemaBefore = await rows(
    "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('mail_send_events','mail_send_outcomes','mail_reputation_states','mail_reputation_decisions') ORDER BY name",
  );
  for (const table of SURVIVING_DATA) before[table] = await snapshot(table);

  await apply(migration);
}, 120_000);

afterAll(async () => miniflare?.dispose());

describe("migration 0601 on a Core that carries 0001..0600", () => {
  it("leaves exactly the kept tables and the six W33 tables", async () => {
    const tables = (
      await rows(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
      )
    ).map((row) => String(row["name"]));
    expect(tables).toEqual([...KEPT_TABLES, ...W33_TABLES].sort());
    expect(new Set(KEPT_TABLES).size).toBe(KEPT_TABLES.length);
  });

  it("keeps no view over the removed tables", async () => {
    const views = (await schemaObjects()).filter((object) => object.type === "view");
    expect(views.map((view) => view.name)).toEqual(["effective_wfp_publish_receipts"]);
    for (const view of views)
      await expect(db.prepare(`SELECT * FROM ${view.name} LIMIT 0`).all()).resolves.toBeDefined();
  });

  it("leaves no trigger, view, index or foreign key that names a table that is gone", async () => {
    expect((await rows("PRAGMA foreign_keys"))[0]).toEqual({ foreign_keys: 1 });
    const objects = await schemaObjects();
    const tables = new Set(
      objects.filter((object) => object.type === "table").map((object) => object.name),
    );
    // the removed tables are the ones the migration drops and the schema no longer has
    const removed = [...migration.matchAll(/^DROP TABLE (\w+);/gmu)]
      .map((match) => match[1] as string)
      .filter((name) => !tables.has(name));
    expect(removed.length).toBeGreaterThan(80);
    const mention = new RegExp(`\\b(?:${removed.join("|")})\\b`, "iu");
    const stripped = (sql: string) =>
      sql.replace(/'(?:[^']|'')*'/gu, "''").replace(/--[^\n]*/gu, "");
    for (const object of objects) {
      expect(
        mention.exec(stripped(object.sql))?.[0],
        `${object.type} ${object.name}`,
      ).toBeUndefined();
      if (object.type === "trigger" || object.type === "index")
        expect(tables.has(object.tbl_name), `${object.name} target`).toBe(true);
    }
    for (const table of tables) {
      for (const key of await rows(
        'SELECT "table" AS parent FROM pragma_foreign_key_list(?)',
        table,
      ))
        expect(tables.has(String(key["parent"])), `${table} -> ${String(key["parent"])}`).toBe(
          true,
        );
    }
    expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
  }, 120_000);

  it("passes the engine's own schema check, which fails on a trigger that names a missing table", async () => {
    // ALTER TABLE ... RENAME re-resolves every trigger and view of the database.
    await db.prepare("CREATE TABLE schema_probe (x INTEGER)").run();
    await db.prepare("ALTER TABLE schema_probe RENAME TO schema_probe_renamed").run();
    // positive control: the same check does fail on a dangling trigger
    await db
      .prepare(
        "CREATE TRIGGER schema_probe_broken AFTER INSERT ON schema_probe_renamed BEGIN INSERT INTO table_that_does_not_exist(x) VALUES (1); END",
      )
      .run();
    await expect(
      db.prepare("ALTER TABLE schema_probe_renamed RENAME TO schema_probe_again").run(),
    ).rejects.toThrow(/no such table/iu);
    await db.prepare("DROP TRIGGER schema_probe_broken").run();
    await db.prepare("ALTER TABLE schema_probe_renamed RENAME TO schema_probe_again").run();
    await db.prepare("DROP TABLE schema_probe_again").run();
  });

  it("keeps the user relations and the mail history row for row", async () => {
    for (const table of SURVIVING_DATA) {
      let expected = before[table] as Row[];
      if (table === "mail_send_requests")
        expected = expected.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([name]) => !MAIL_CREDIT_COLUMNS.includes(name)),
          ),
        );
      expect(await snapshot(table), table).toEqual(expected);
    }
    expect((before["mail_send_requests"] as Row[])[0]).toHaveProperty("credit_charge_micros");
    expect((before["user_signup"] as Row[]).length).toBe(1);
    expect((before["stripe_billing_customers"] as Row[]).length).toBe(1);
    expect((before["mail_send_events"] as Row[]).length).toBe(1);
  });

  it("rebuilds mail_send_requests without its credit columns and keeps every other column, index and guard", async () => {
    const columns = (
      await rows("SELECT name FROM pragma_table_info('mail_send_requests') ORDER BY cid")
    ).map((row) => String(row["name"]));
    expect(columns).toEqual(
      mailColumnsBefore.filter((name) => !MAIL_CREDIT_COLUMNS.includes(name)),
    );
    expect(columns).toContain("mail_domain_id");
    const objects = (
      await rows(
        "SELECT type, name FROM sqlite_master WHERE tbl_name = 'mail_send_requests' AND type <> 'table' ORDER BY name",
      )
    ).map((row) => `${String(row["type"])} ${String(row["name"])}`);
    expect(objects).toEqual(
      expect.arrayContaining([
        "index mail_send_requests_by_message",
        "index mail_send_requests_by_project",
        "trigger mail_send_requests_guard",
        "trigger mail_send_requests_no_delete",
        "trigger mail_send_requests_sender_snapshot",
      ]),
    );
    // the children keep their own DDL byte for byte
    expect(
      await rows(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('mail_send_events','mail_send_outcomes','mail_reputation_states','mail_reputation_decisions') ORDER BY name",
      ),
    ).toEqual(mailSchemaBefore);
    await expect(
      db.prepare("SELECT credit_charge_micros FROM mail_send_requests").all(),
    ).rejects.toThrow(/no such column/iu);
  });
});

describe("login and project creation on the migrated Core", () => {
  it("creates an organization, a project with its environments and billing epoch, and a mail send without a trigger error", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    expect(
      await rows(
        "SELECT organization_id FROM organizations WHERE organization_id = ?",
        organizationId,
      ),
    ).toHaveLength(1);

    const project = projectInput(organizationId, "after-the-drop", false);
    await expect(store.projects.createInitialProject(project)).resolves.toMatchObject({
      outcome: "created",
    });
    const count = async (table: string) =>
      (
        await rows(
          `SELECT count(*) AS n FROM ${table} WHERE organization_id = ? AND project_id = ?`,
          organizationId,
          project.projectId,
        )
      )[0]?.["n"];
    expect(await count("projects")).toBe(1);
    expect(await count("billing_epochs")).toBe(1);
    expect(await count("environments")).toBe(2);
    expect(await count("environment_data_assignments")).toBe(2);
    expect(
      await rows(
        "SELECT project_id FROM project_identities WHERE project_id = ?",
        project.projectId,
      ),
    ).toHaveLength(1);

    const requestId = newUlid();
    await db
      .prepare(
        "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,requested_at,updated_at) VALUES (?1,?2,?3,'idem-after',unhex(?4),unhex(?5),unhex(?6),?7,?7)",
      )
      .bind(requestId, organizationId, project.projectId, hex(9), hex(10), hex(11), STAMP)
      .run();
    await db
      .prepare(
        "UPDATE mail_send_requests SET state = 'accepted', provider_started_at = ?2, provider_message_id = 'msg-after' WHERE request_id = ?1",
      )
      .bind(requestId, STAMP)
      .run();
    // the guards of the rebuilt table are alive
    await expect(
      db
        .prepare("UPDATE mail_send_requests SET request_sha256 = unhex(?2) WHERE request_id = ?1")
        .bind(requestId, hex(12))
        .run(),
    ).rejects.toThrow(/immutable/iu);
    await expect(
      db.prepare("DELETE FROM mail_send_requests WHERE request_id = ?1").bind(requestId).run(),
    ).rejects.toThrow(/append-preserving/iu);
  });

  it("takes a signup attribution and still refuses an unknown source or request through the rewritten shape guard", async () => {
    const userId = "user_after_drop";
    await db
      .prepare(
        "INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros) VALUES ('partner',1,1,0)",
      )
      .run();
    const requestId = newUlid();
    await db
      .prepare(
        "INSERT INTO onboarding_requests(request_id,workos_user_id,idempotency_sha256,request_sha256,name,organization_attempted,membership_attempted,signup_source,created_at) VALUES (?1,?2,unhex(?3),unhex(?4),'Second',0,0,'partner',?5)",
      )
      .bind(requestId, userId, hex(20), hex(21), STAMP)
      .run();
    await db
      .prepare(
        "INSERT INTO user_signup(workos_user_id,origin_source,recorded_at,origin_present) VALUES (?1,'partner',?2,1)",
      )
      .bind(userId, STAMP)
      .run();
    const attribute = (source: string, request: string) =>
      db
        .prepare(
          "UPDATE user_signup SET attributed_source=?2,first_request_id=?3,bonus_micros='0',attributed_at=?4 WHERE workos_user_id=?1 AND attributed_source IS NULL",
        )
        .bind(userId, source, request, STAMP)
        .run();
    await expect(attribute("unknown-source", requestId)).rejects.toThrow(
      /Invalid signup attribution shape/u,
    );
    await expect(attribute("partner", newUlid())).rejects.toThrow(
      /Invalid signup attribution shape/u,
    );
    await attribute("partner", requestId);
    expect(
      (
        await rows(
          "SELECT attributed_source, first_request_id FROM user_signup WHERE workos_user_id = ?",
          userId,
        )
      )[0],
    ).toEqual({ attributed_source: "partner", first_request_id: requestId });
    // a new user without any attribution is still accepted
    await db
      .prepare(
        "INSERT INTO user_signup(workos_user_id,origin_source,recorded_at,origin_present) VALUES ('user_plain','partner',?1,1)",
      )
      .bind(STAMP)
      .run();
  });
});
