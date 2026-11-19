import { readdirSync, readFileSync } from "node:fs";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CORE_BINDING,
  CORE_LAYOUT,
  CoreConfigurationError,
  resolveCoreDatabase,
} from "../src/core.js";
import type { D1Database } from "../src/d1-types.js";
import { classifyFailure, GUARD_CODES } from "../src/guards.js";
import { IdempotencyConflictError, runCommand } from "../src/run-command.js";
import { createControlStore } from "../src/store.js";
import {
  createTestControl,
  migrate,
  migrationFiles,
  type TestControl,
} from "./support/control-d1.js";

let control: TestControl;
let miniflare: Miniflare;
let blank: D1Database;
let legacyDirectory: D1Database;
let legacyShard: D1Database;
beforeAll(async () => {
  control = await createTestControl();
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { BLANK: "blank", DIRECTORY: "directory", SHARD: "shard" },
  });
  blank = (await miniflare.getD1Database("BLANK")) as unknown as D1Database;
  legacyDirectory = (await miniflare.getD1Database("DIRECTORY")) as unknown as D1Database;
  legacyShard = (await miniflare.getD1Database("SHARD")) as unknown as D1Database;
  await migrate(legacyDirectory, "directory");
  await migrate(legacyShard, "shard");
}, 120_000);
afterAll(async () => {
  await Promise.all([control?.dispose(), miniflare?.dispose()]);
});

it("the legacy shard run table admits the skipped run state and still refuses an unknown one", async () => {
  const insert = (state: string) =>
    legacyShard
      .prepare(
        "INSERT INTO function_runs(organization_id,run_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,egress_allowed_origins,created_at,updated_at,finished_at) VALUES('01ARZ3NDEKTSV4RRFFQ69G5FAV',?1,'01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','script','0 3 * * *','2026-10-29T03:00:00.000000Z',?2,0,'[]','2026-10-29T03:00:00.000000Z','2026-10-29T03:00:00.000000Z','2026-10-29T03:00:00.000000Z')",
      )
      .bind(
        state === "skipped" ? "01ARZ3NDEKTSV4RRFFQ69G5FB0" : "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        state,
      )
      .run();
  await expect(insert("skipped")).resolves.toMatchObject({ success: true });
  await expect(insert("bogus")).rejects.toThrow();
});

describe("the production store requires exactly one shared-core authority", () => {
  it("refuses a missing, malformed or ambiguous authority binding before anything is read", () => {
    expect(() => resolveCoreDatabase({})).toThrow(CoreConfigurationError);
    expect(() => resolveCoreDatabase({ [CORE_BINDING]: "d1" })).toThrow(/not bound/u);
    expect(() => resolveCoreDatabase({ [CORE_BINDING]: null })).toThrow(/not bound/u);
    for (const legacy of ["CONTROL_GLOBAL", "CONTROL_SHARD_0000", "CONTROL_SHARD_0015"]) {
      expect(() =>
        resolveCoreDatabase({ [CORE_BINDING]: control.core, [legacy]: control.core }),
      ).toThrow(new RegExp(`ambiguous authority.*${legacy}`, "u"));
    }
    // a legacy-only Worker has no implicit fallback to one of its old databases
    expect(() => resolveCoreDatabase({ CONTROL_GLOBAL: legacyDirectory })).toThrow(/ambiguous/u);
    expect(resolveCoreDatabase({ [CORE_BINDING]: control.core, OTHER: 1 })).toBe(control.core);
    expect(() =>
      createControlStore({ CONTROL_CORE: control.core, CONTROL_SHARD_0001: control.core }),
    ).toThrow(CoreConfigurationError);
    expect(() => createControlStore({} as never)).toThrow(CoreConfigurationError);
  });

  it("refuses to serve a database that is not the shared-core-v1 layout, and writes nothing to it", async () => {
    for (const wrong of [blank, legacyDirectory, legacyShard]) {
      const store = createControlStore({ CONTROL_CORE: wrong });
      await expect(
        store.identity.applyOrganizationSnapshot({
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
      ).rejects.toThrow(/does not carry the shared-core-v1 schema/u);
      await expect(store.billing.admitPaidProjectDomain({})).rejects.toBeInstanceOf(
        CoreConfigurationError,
      );
    }
    expect(
      (
        await legacyDirectory
          .prepare("SELECT count(*) AS n FROM org_directory")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    // a row of another layout is as wrong as a missing table
    await control.core.prepare("UPDATE core_layout SET command_namespace_version = 1").run();
    const row = await control.core
      .prepare("SELECT layout, command_namespace_version FROM core_layout")
      .all();
    expect(row.results).toEqual([{ layout: CORE_LAYOUT, command_namespace_version: 1 }]);
    await expect(
      control.core.prepare("UPDATE core_layout SET layout = 'other'").run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });
});

describe("one guard catalog for the Directory and tenant commands", () => {
  it("names every guard code once and aborts the batch for an unregistered code too", async () => {
    const row = await control.core
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'guard_fail'")
      .first<{ sql: string }>();
    const declared = [...(row?.sql ?? "").matchAll(/CONSTRAINT guard_([a-z_]+) CHECK/gu)].map(
      (m) => m[1],
    );
    expect(declared).toEqual([...GUARD_CODES, "unregistered"]);
    for (const code of GUARD_CODES) {
      const failure = await control.core
        .batch([control.core.prepare(`INSERT INTO guard_fail(code) SELECT '${code}' WHERE 1`)])
        .catch((error: unknown) => classifyFailure(error));
      expect(failure).toEqual({ kind: "guard", code });
    }
    const unknown = await control.core
      .prepare("INSERT INTO guard_fail(code) SELECT 'never_registered' WHERE 1")
      .run()
      .catch((error: unknown) => classifyFailure(error));
    expect(unknown).toEqual({ kind: "guard", code: "unregistered" });
    expect(
      (await control.core.prepare("SELECT count(*) AS n FROM guard_fail").first<{ n: number }>())
        ?.n,
    ).toBe(0);
  });

  it("uses only registered codes in the store source", () => {
    const sources: string[] = [];
    const walk = (directory: URL) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".ts")) sources.push(readFileSync(child, "utf8"));
      }
    };
    walk(new URL("../src/", import.meta.url));
    const used = new Set<string>();
    for (const text of sources) {
      for (const match of text.matchAll(/guard\(\s*[\w.]+,\s*"([a-z_]+)"/gu))
        used.add(match[1] as string);
      for (const match of text.matchAll(/INSERT INTO guard_fail\(code\) SELECT '([a-z_]+)'/gu))
        used.add(match[1] as string);
      for (const match of text.matchAll(/code:\s*"(claim_lost|operation_conflict)"/gu))
        used.add(match[1] as string);
    }
    expect(used.size).toBeGreaterThan(5);
    for (const code of used) expect(GUARD_CODES, code).toContain(code);
  });

  it("shares one command namespace: a command id is one command, whichever lane first used it", async () => {
    const db = control.core;
    const run = (name: string, input: unknown) =>
      runCommand(db, {
        name,
        input,
        commandId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        read: async () => null,
        decide: () => ({
          statements: [],
          result: () => name,
          logResult: name,
        }),
        fromLog: (logged) => logged as string,
      });
    expect(await run("directory.claim", { a: 1 })).toBe("directory.claim");
    expect(await run("directory.claim", { a: 1 })).toBe("directory.claim");
    await expect(run("tenant.write", { a: 1 })).rejects.toMatchObject({
      reason: "command_name",
    });
    await expect(run("directory.claim", { a: 2 })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

/** Objects of the lineage that the shared core redefines on purpose, with the reason. */
const REPLACED_BY_CORE = new Set([
  "command_log",
  "guard_fail",
  "shards",
  "shard_buckets",
  "sqlite_autoindex_shards_1",
  "sqlite_autoindex_shards_2",
  "sqlite_autoindex_shards_3",
  "sqlite_autoindex_command_log_1",
]);

const normalize = (sql: string | null) => (sql ?? "").replace(/\s+/gu, " ").trim();

async function schemaOf(db: D1Database) {
  const rows = await db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY name")
    .all<{ type: string; name: string; sql: string | null }>();
  return new Map(rows.results.map((row) => [row.name, normalize(row.sql)]));
}

async function ownersOf(db: D1Database) {
  const rows = await db
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE name NOT LIKE '_cf_%'")
    .all<{ name: string; tbl_name: string }>();
  return new Map(rows.results.map((row) => [row.name, row.tbl_name]));
}

/** The objects migration 0601 (the W33 drop of the old credit schema) names, which the core no longer has. */
function droppedByCreditMigration(core: ReadonlyMap<string, string>): Set<string> {
  const file = migrationFiles("core").find((candidate) => candidate.name.startsWith("0601_"));
  const dropped = new Set<string>();
  for (const match of file?.sql.matchAll(/^DROP (?:TABLE|VIEW|TRIGGER) (\w+);/gmu) ?? [])
    if (!core.has(match[1] as string)) dropped.add(match[1] as string);
  return dropped;
}

describe("the core schema is the Directory and tenant schema lineage", () => {
  it("carries every Directory and tenant object with identical DDL, except the documented replacements and divergences", async () => {
    const core = await schemaOf(control.core);
    const lineage = new Map<string, string>();
    for (const db of [legacyDirectory, legacyShard]) {
      for (const [name, sql] of await schemaOf(db)) {
        if (REPLACED_BY_CORE.has(name)) continue;
        expect(lineage.has(name), `${name} exists in both Directory and tenant lineage`).toBe(
          false,
        );
        lineage.set(name, sql);
      }
    }
    expect(lineage.size).toBeGreaterThan(300);
    // The credit lineage is gone on purpose: a lineage object is expected missing when 0601 drops it or its table.
    const owners = new Map([
      ...(await ownersOf(legacyDirectory)),
      ...(await ownersOf(legacyShard)),
    ]);
    const dropped = droppedByCreditMigration(core);
    const different: string[] = [];
    const missing: string[] = [];
    for (const [name, sql] of lineage) {
      if (!core.has(name)) {
        if (!dropped.has(name) && !dropped.has(owners.get(name) as string)) missing.push(name);
      } else if (core.get(name) !== sql) different.push(name);
    }
    expect(dropped.size).toBeGreaterThan(80);
    expect(missing.filter((name) => !name.startsWith("sqlite_autoindex"))).toEqual(
      INTENTIONALLY_REPLACED_OBJECTS,
    );
    expect(different.sort()).toEqual([...INTENTIONALLY_CHANGED_OBJECTS].sort());
    // and nothing else exists in the core: every extra object is one of the reviewed additions
    const extra = [...core.keys()].filter(
      (name) => !lineage.has(name) && !name.startsWith("sqlite_autoindex"),
    );
    expect(extra.sort()).toEqual([...CORE_ADDITIONS].sort());
  });

  it("keeps the numbered lineage files in one ordered, collision-free sequence", () => {
    const files = readdirSync(new URL("../migrations/core/", import.meta.url)).filter((name) =>
      name.endsWith(".sql"),
    );
    expect(new Set(files.map((name) => name.slice(0, 4))).size).toBe(files.length);
    expect(files).toEqual([...files].sort());
    for (const file of files) {
      const text = readFileSync(new URL(`../migrations/core/${file}`, import.meta.url), "utf8");
      if (/^-- core-v1 source: migrations\//u.test(text)) {
        expect(text, file).not.toMatch(/CREATE TABLE (guard_fail|command_log)\b/u);
      }
    }
  });
});

/** Lineage objects whose DDL the core changes, each with a dedicated test of the new rule. */
const INTENTIONALLY_CHANGED_OBJECTS: string[] = [
  "mcp_portal_handoffs", //0608 retains immutable accepted handoff authority
  "paid_project_domains", //0480 exact original native domain constraints, no owner/price policy change; 0640 adds hostname_proven_at; 0642 rebuilds it with the displaced state
  "product_workflow_runs", //0450 original long Workflow ID/state and native static scope

  //0461 final original mail send/key/reputation types, keys, checks and transition guards.
  "mail_gateway_keys",
  "mail_reputation_decisions",
  "mail_reputation_decisions_append_only_delete",
  "mail_reputation_decisions_append_only_update",
  "mail_reputation_states",
  "mail_reputation_states_no_delete",
  "mail_reputation_states_version",
  "mail_send_events",
  "mail_send_events_append_only_update",
  "mail_send_events_by_request",
  "mail_send_events_reputation",
  "mail_send_requests",
  "mail_send_requests_by_message",
  "mail_send_requests_by_project",
  "mail_send_requests_guard",
  "mail_send_requests_no_delete",
  "mail_send_requests_sender_snapshot",
  "mail_received_messages", //0470 original order/defaults/global key/four-coordinate receiver and exact72h
  "mail_received_messages_identity",
  "database_provider_operations", // native physical/operation scope0353
  "database_provider_target_revisions", // native physical/operation scope0353
  "neon_project_placement_reservations", // native physical/operation scope0353
  "pgcf_database_migration_receipts", // native physical/operation scope0353
  "project_database_registration_receipts", // native physical/operation scope0353
  "project_database_registration_reservations", // native physical/operation scope0353
  "project_database_registration_reservations_delete_after_receipt", //0920 a failed operation's superseded reservation may leave (CORE-07)
  "user_api_key_requests", //0921 the failure code admits KEY_CREATION_NOT_SENT; rebuilt with its rows (CORE-46)
  "project_recovery_jobs_archive_final", //0604 a prepared archive is only cleared, never replaced, while the job holds its sealed input
  "project_recovery_jobs", //0615 retains the original rows/guards and adds exact Native archive manifest custody
  "runtime_secret_delivery_states", //0370 restores original final state/defaults/constraints/column order

  "deployment_plans",
  "deployment_revisions",
  "deployments",
  "repository_grants",
  "source_connections",

  "webhook_inbox", // original global source identity and 17 facts; organization is nullable routing metadata
  "github_push_deployments", // its original inbox FK is global, independent of nullable routing metadata; 0820 drops the commit-tuple UNIQUE
  "user_signup",

  "pgcf_database_serving_intervals", // exact native microsecond hour floor
  "pgcf_serving_interval_on_head_insert",
  "pgcf_serving_interval_on_head_update", // a database/activation episode survives target-version changes
  "billing_epochs_one_open_per_project",
  "projects",
  "environment_function_schedules",
  "environment_function_schedules_due",
  "environment_data_assignments",
  "evidence_exports",
  "operations_require_current_owner",
  "operation_mcp_delegations",

  "environment_secret_requests",

  "product_command_intents",

  // 0466 original142/150/199 physical fields, static domains and stable original identities.
  "resend_mail_domains",
  "resend_mail_commands",
  "workspace_mail_domains",
  "workspace_mail_commands",
  "project_application_domain_identities",
  "project_application_identity_commands",
  "project_application_identity_action_commands",
  "project_mail_domain_bindings",
  // The lineage objects later migrations rebuild (each rule has its own test beside its migration).
  "cloudflare_project_domain_receipts", //0498 original receipt fields
  "dev_share_link_rotations", //0506 original dev share link identity
  "dev_share_link_rotations_purge",
  "dev_share_links",
  "environments", //0201 original migration 013: removing the deployments keeps head_version and clears both pointers
  "environments_identity_immutable", //0627 permits the exact Paid Dev restoration identity boundary
  "cloudflare_project_domains", //0232 original migration 065: the PoC zone aixyte.com of the first Development domains is retained history
  "github_push_deployments_by_operation", //0495 original auto-deploy push identity
  "mail_received_messages_due", //0470 original received-message order and exact72h
  "mail_received_messages_purge",
  "mail_received_messages_unbilled",
  "neon_project_placement_receipts", //0458 placement children of the original claim identity
  "product_provider_mutation_claims", //0458 original claim identity, intent and Workflow run parents
  "product_provider_mutation_claims_neon_identity",
  "scoped_customer_dns_authorizations", //0467 original scoped DNS authority
  "scoped_customer_dns_authorizations_identity",
  "scoped_customer_dns_authorizations_purge",
  "scoped_customer_dns_authorizations_resource",
  "scoped_customer_dns_grants",
  "scoped_customer_dns_revocations",
  "scoped_customer_dns_revocations_purge",
  "usage_meter_activations", //0602 the key is (meter, starts_at): a meter's price can change by a later activation
];
/** Objects only the core has: the layout record, its replacements of the lineage objects and the history identities. */
const CORE_ADDITIONS: string[] = [
  // 0760: independent workspace-scoped lifecycle and imported references.
  "workspace_connection_handoffs",
  "workspace_connection_attempts",
  "workspace_connection_grants",
  "workspace_integration_portal_handoffs",
  "workspace_connection_orphan_grants",
  "workspace_connection_refresh_orphans",
  "workspace_connection_handoff_identity_immutable",
  "workspace_integration_portal_identity_immutable",
  "workspace_connection_attempt_identity_immutable",
  "workspace_connection_slots",
  "workspace_connection_imports",
  "workspace_connection_import_identity_immutable",
  // 0759: connection attempts, grants, orphan custody and portal handoffs.
  "connection_attempt_identity_immutable",
  "connection_attempts",
  "connection_grants",
  "connection_handoff_identity_immutable",
  "connection_handoffs",
  "connection_orphan_grants",
  "connection_refresh_orphans",
  "integration_portal_handoffs",
  "integration_portal_identity_immutable",
  // 0758: project previews, exact assignment scope, accepted sources, usage and Native preparation.
  "environment_data_assignments_preview_scope",
  "project_previews",
  "project_previews_active_environment",
  "project_previews_active_token",
  "project_previews_identity_immutable",
  "project_preview_source_events",
  "project_preview_source_heads",
  "project_preview_source_pending",
  "project_preview_receipts",
  "project_preview_runs",
  "project_preview_usage_intervals",
  "project_preview_one_open_interval",
  "project_preview_interval_identity",
  "project_preview_usage_due",
  "project_preview_backup_cleanup",
  "project_preview_usage_observations",
  "project_preview_usage_observations_immutable",
  "project_preview_usage_observations_no_delete",
  "project_preview_cleanup_receipts",
  "project_preview_native_preparations",
  "preview_native_one_running_project",
  "project_preview_usage_cursor",
  "project_preview_native_cursor",
  "project_preview_native_policy_receipts",
  "project_preview_native_policy_receipts_immutable",
  "project_preview_native_policy_receipts_no_delete",
  "project_preview_native_drains",
  // 0752: durable database webhook subscriptions and generation-bound activation receipts.
  "database_webhook_subscriptions",
  "database_webhook_subscriptions_capacity",
  "database_webhook_activation_receipts",
  "database_webhook_deactivation_keys",
  "database_webhook_activation_identity_immutable",
  // 0753: Browser PDF credit reservations and framework-plan admission.
  "browser_gateway_reservations",
  "browser_gateway_open_org",
  "browser_gateway_open_age",
  "browser_gateway_reservations_immutable",
  "browser_gateway_reservations_no_delete",
  "deployment_plans_browser_shape",
  // 0755: Next cache scopes, deletion fences, retirement receipts and explicit plan admission.
  "next_cache_scopes",
  "next_cache_scopes_no_update",
  "next_cache_scopes_no_delete",
  "next_cache_scopes_by_deployment",
  "next_cache_retirements",
  "next_cache_retirements_no_update",
  "next_cache_retirements_no_delete",
  "next_cache_deletion_fences",
  "next_cache_deletion_fences_by_project",
  "next_cache_deletion_fences_no_update",
  "next_cache_deletion_fences_no_delete",
  "projects_next_cache_deletion_irreversible",
  "projects_next_cache_deletion_no_active_copy",
  "deployment_plans_next_revalidate_path_shape",
  "paid_hostname_proofs", //0710 a Paid hostname's ownership proof, keyed by project and hostname, separate from the mail identity
  "paid_hostname_proofs_end_with_project", //0711 a project that changes owner or leaves its lifecycle ends its Paid proofs
  "storage_gateway_keys_next_version", //0700 a storage key version is only the next one of its environment (RTG-05 rotation)
  "scoped_customer_dns_displaced_tokens", //0645 refresh tokens a re-authorization displaced, until revoked upstream
  "scoped_customer_dns_displaced_tokens_by_org",
  "resend_mail_domains_suspended_name_hold", //0641 refuses a suspended sender name in every organization (the pinned mirror of 0466 is unchanged)
  "product_provider_mutation_claims_release_bucket_reservation", //0720 releases the reservation of an ended operation before its claim leaves
  "project_handle_releases", //0690 a released handle is held 30 days against other organizations
  //0636: gated signup-feedback dispatch and atomic first-origin capture.
  "signup_feedback_mail_settings",
  "signup_feedback_mail",
  "signup_feedback_mail_due",
  "signup_feedback_first_insert",
  "signup_feedback_first_origin",
  "project_r2_upload_sweep_attempts", //0730 the platform upload sweep stamps the claims it tried and did not erase
  "preview_provider_profile_immutable", //0630 additive immutable provider profile
  //0629: provider-neutral immutable two-phase preview lifecycle.
  "preview_public_uuid",
  "preview_lifecycle_immutable",
  "preview_lifecycle_valid_insert",
  "preview_lifecycle_valid_update",
  //0622–0628: preview sessions, resource preparation, Dev retirement and restoration.
  "preview_sessions",
  "preview_one_live_project",
  "preview_expiry",
  "preview_cleanup",
  "preview_identity_immutable",
  "preview_terminal_immutable",
  "preview_usage_intervals",
  "preview_one_open_hold",
  "preview_requests",
  "preview_request_immutable",
  "preview_unfunded_usage",
  "preview_unfunded_usage_immutable",
  "free_dev_retirements",
  "free_dev_retirements_one_active",
  "free_dev_retirement_resources",
  "free_dev_retirement_identity",
  "free_dev_retirement_resource_identity",
  "free_dev_retirement_dispatches",
  "free_dev_retirement_dispatch_identity",
  "preview_resource_preparations",
  "preview_preparation_one_physical",
  "preview_preparation_identity_immutable",
  "preview_r2_bucket_reservations",
  "preview_r2_bucket_reservations_immutable",
  "preview_r2_bucket_reservations_no_delete",
  "preview_r2_bucket_absence_observations",
  "preview_r2_bucket_absence_no_update",
  "preview_r2_bucket_absence_no_delete",
  "preview_source_inputs",
  "preview_source_input_cleanup",
  "preview_source_input_identity_immutable",
  "dev_environment_restorations",
  "dev_environment_restorations_no_update",
  "dev_environment_restorations_no_delete",
  "preview_migration_operations",
  "preview_migration_one_project",
  "preview_migration_files",
  "preview_migration_files_no_update",
  "preview_migration_files_no_delete",
  "preview_migration_identity_immutable",
  //0631: the postings the credit service could not book, kept with their lines and attempts.
  "usage_post_failure",
  "usage_post_failure_due",
  //0620: retained Native export-effect journal and retirement guards.
  "native_export_block_unretired_project",
  "native_export_effect_identity_immutable",
  "native_export_effect_no_delete",
  "native_export_effect_state_monotonic",
  "native_export_effects",
  "native_export_effects_due",
  // Additional Native restore job and domain recovery receipts (0618–0619).
  "native_auth_domain_recoveries",
  "native_auth_domain_recovery_no_delete",
  "native_auth_domain_recovery_transition",
  "native_auth_restore_import_realm_no_delete",
  "native_auth_restore_import_realm_no_update",
  "native_auth_restore_import_realm_offline",
  "native_auth_restore_import_realms",
  "native_auth_restore_job_no_delete",
  "native_auth_restore_job_transition",
  "native_auth_restore_jobs",
  "native_auth_restore_claims",
  "native_auth_restore_claim_no_update",
  "native_auth_restore_claim_no_delete",
  "native_auth_restore_pins",
  "native_auth_restore_pin_absences",
  "native_auth_restore_pin_tombstones",
  "native_auth_restore_tombstone_no_update",
  "native_auth_restore_tombstone_no_delete",
  "native_auth_restore_pin_absence_validate",
  "native_auth_restore_pin_absence_no_update",
  "native_auth_restore_pin_absence_no_delete",
  "native_auth_restore_pin_transition",
  "native_auth_restore_pin_no_delete",
  "native_auth_restore_requires_pin",
  // Native Auth Core metadata, policy fences, custody, recovery and lifecycle receipts (0611–0618).
  "native_auth_block_ownership_transfer",
  "native_auth_block_unfinished_deletion",
  "native_auth_block_uninventoried_deletion",
  "native_auth_block_unknown_create_claim_release",
  "native_auth_block_unknown_create_terminal",
  "native_auth_config_requests",
  "native_auth_custom_origin_deleted",
  "native_auth_custom_origin_lost",
  "native_auth_database_one_unresolved",
  "native_auth_database_operations",
  "native_auth_database_target_close_only",
  "native_auth_database_target_no_delete",
  "native_auth_database_target_open",
  "native_auth_deletion_operation_key",
  "native_auth_deletion_key_target",
  "native_auth_deletion_key_lookup",
  "native_auth_database_targets",
  "native_auth_deletion_operation_no_delete",
  "native_auth_deletion_operation_transition",
  "native_auth_deletion_operations",
  "native_auth_deletion_realm_no_delete",
  "native_auth_deletion_realm_transition",
  "native_auth_deletion_realms",
  "native_auth_domain_block_concurrent_head",
  "native_auth_domain_block_concurrent_realm_update",
  "native_auth_domain_block_registration_insert",
  "native_auth_domain_block_registration_update",
  "native_auth_domain_block_role_insert",
  "native_auth_domain_block_preparation_insert",
  "native_auth_domain_block_restore_realm_insert",
  "native_auth_domain_one_pending_realm",
  "native_auth_domain_one_recovery_pending",
  "native_auth_domain_operation_no_delete",
  "native_auth_domain_operation_requires_ack",
  "native_auth_domain_operation_transition",
  "native_auth_domain_operations",
  "native_auth_domain_policy_no_delete",
  "native_auth_domain_policy_syncs",
  "native_auth_domain_policy_transition",
  "native_auth_handoff_attempt_events",
  "native_auth_handoff_attempt_one_terminal",
  "native_auth_handoff_attempts",
  "native_auth_handoff_event_no_update",
  "native_auth_one_restore",
  "native_auth_policy_sync_no_delete",
  "native_auth_policy_sync_update",
  "native_auth_policy_syncs",
  "native_auth_preparation_no_delete",
  "native_auth_preparation_no_update",
  "native_auth_preparation_receipts",
  "native_auth_primary_origin_deleted",
  "native_auth_primary_origin_lost",
  "native_auth_providers",
  "native_auth_realms",
  "native_auth_registration_no_delete",
  "native_auth_registration_one_active",
  "native_auth_registration_revocation_no_delete",
  "native_auth_registration_revocation_no_update",
  "native_auth_registration_revocations",
  "native_auth_registration_transition",
  "native_auth_registrations",
  "native_auth_restore_ack_matches",
  "native_auth_restore_ack_no_delete",
  "native_auth_restore_ack_no_update",
  "native_auth_restore_acknowledgements",
  "native_auth_restore_block_realm_insert",
  "native_auth_restore_block_realm_update",
  "native_auth_restore_block_registration_insert",
  "native_auth_restore_block_registration_update",
  "native_auth_restore_block_target_update",
  "native_auth_restore_block_user_acceptance",
  "native_auth_restore_complete_requires_proofs",
  "native_auth_restore_identity_immutable",
  "native_auth_restore_import_no_delete",
  "native_auth_restore_import_no_update",
  "native_auth_restore_import_offline",
  "native_auth_restore_imports",
  "native_auth_restore_no_delete",
  "native_auth_restore_realm_no_delete",
  "native_auth_restore_realm_no_update",
  "native_auth_restore_realms",
  "native_auth_restore_sanitized_after_import",
  "native_auth_restore_verification_no_delete",
  "native_auth_restore_verification_no_update",
  "native_auth_restore_verifications",
  "native_auth_restores",
  "native_auth_role_operations",
  "native_auth_source_off_epoch",
  "native_auth_user_acceptance_no_delete",
  "native_auth_user_acceptance_no_update",
  "native_auth_user_mutation_acceptances",
  //0608–0610: connection proof, conversion, and bounded provider-use fencing.
  "compute_connection_provider_uses",
  "github_connection_provider_uses",
  "github_connection_provider_uses_consent",
  "managed_source_initializations_restriction_immutable",
  "managed_source_publications_restriction_immutable",
  "mcp_client_grants_consent_epoch",
  "mcp_connection_revocations",
  "mcp_dns_authority_conversion",
  "mcp_portal_handoff_authority_immutable",
  "mcp_workspace_revocations_active_recovery",
  "scoped_customer_dns_authorizations_current_insert",
  "scoped_customer_dns_grants_current_insert",
  "scoped_customer_dns_grants_authority_insert",
  "scoped_customer_dns_authorizations_current_update",
  "scoped_customer_dns_grants_current_update",
  "scoped_customer_dns_grants_authority_update",
  "scoped_dns_provider_uses",
  "scoped_dns_provider_uses_expiry",
  "scoped_dns_use_project_application_domain_identities_update",
  "scoped_dns_use_project_application_domain_identities_delete",
  "scoped_dns_use_projects_update",
  "scoped_dns_use_projects_delete",
  "scoped_dns_use_workspace_mail_domains_update",
  "scoped_dns_use_workspace_mail_domains_delete",
  "scoped_dns_use_organization_memberships_update",
  "scoped_dns_use_organization_memberships_delete",
  "scoped_dns_use_local_authorization_grants_update",
  "scoped_dns_use_local_authorization_grants_delete",
  "scoped_dns_use_mcp_client_grants_update",
  "scoped_dns_use_mcp_client_grants_delete",
  "scoped_dns_use_mcp_mail_domain_grants_update",
  "scoped_dns_use_mcp_mail_domain_grants_delete",
  "scoped_dns_use_scoped_customer_dns_authorizations_update",
  "scoped_dns_use_scoped_customer_dns_authorizations_delete",
  "scoped_dns_use_scoped_customer_dns_grants_update",
  "scoped_dns_use_scoped_customer_dns_grants_delete",
  "scoped_dns_use_scoped_customer_dns_authorizations_insert",
  "scoped_dns_use_scoped_customer_dns_grants_insert",
  "cloudflare_project_authorization_global_id",
  "cloudflare_general_grant_uses",
  "cloudflare_general_grant_use_update",
  "cloudflare_general_grant_use_delete",
  "cloudflare_general_project_use_update",

  "project_r2_bucket_reservations",
  "project_r2_bucket_reservations_once",
  "project_r2_bucket_reservations_delete", //0720 an unspent reservation of an ended operation may leave with its claim
  "project_r2_bucket_absences", //0665 append-only absence evidence of an unused reservation
  "project_r2_bucket_absences_no_update",
  "project_r2_bucket_absences_no_delete",
  "project_r2_upload_reservations",
  "project_r2_upload_object_key_v2",
  "project_r2_objects",
  "project_r2_delete_requests",
  "project_r2_delete_receipts",
  "provider_collection_r2_resource_idx",
  "project_r2_upload_reservations_no_update",
  "project_r2_upload_reservations_no_delete",
  "project_r2_upload_reservations_data_idx",
  "project_r2_objects_no_update",
  "project_r2_objects_no_delete",
  "project_r2_objects_data_idx",
  "project_r2_delete_requests_no_update",
  "project_r2_delete_requests_no_delete",
  "project_r2_delete_requests_data_idx",
  "project_r2_delete_receipts_no_update",
  "project_r2_delete_receipts_no_delete",
  "project_r2_delete_receipts_data_idx",

  "project_agent_notes",
  "project_agent_note_requests",
  "project_powered_by_flag_requests",
  "purge_deleted_project_agent_notes",
  "pgcf_database_entitlement_policies",
  "pgcf_database_entitlement_actions",
  "pgcf_entitlement_one_pending",
  "pgcf_entitlement_action_identity",
  "pgcf_entitlement_action_retained",
  "paid_project_domains_native_hostname_insert",
  "paid_project_domains_native_hostname_update",
  "paid_project_domains_live_hostname", //0640 unique over proven rows only (an unproven reservation never blocks a proven owner)
  "project_database_compute_operation_ids_insert",
  "project_database_compute_operation_ids_update",
  "project_database_compute_operation_array_insert",
  "project_database_compute_operation_array_update",
  "project_database_compute_operation_leaf_depth_insert",
  "project_database_compute_operation_leaf_depth_update",
  //0390..0396 the indexes of the kept tables; the discovery and projection objects went with 0601.
  "paid_project_domains_hostname_idx",
  "billing_epochs_project_started_idx",
  "product_command_intents_operation_idx",

  //0401 original product database identifier domains.
  "project_database_access_ulid_insert",
  "project_database_access_ulid_update",
  "project_database_writes_ulid_insert",
  "project_database_writes_ulid_update",
  "pgcf_database_compute_changes_ulid_insert",
  "pgcf_database_compute_changes_ulid_update",

  //0452 original GitHub authorization and raw source custody families.
  "github_connection_authorizations", //0459 original135/136 organization connection OAuth state and sealed PKCE verifier
  "github_organization_connections",
  "github_organization_one_active",
  "github_repository_link_consents",
  "github_repository_link_consents_no_delete",
  "github_repository_link_consents_no_update",
  "github_source_authorizations",
  "product_source_archive_objects",
  "product_source_archive_objects_no_delete",
  "product_source_archive_objects_no_update",

  //0400 exact original product SQL and PGCF compute facts.
  "pgcf_database_compute_changes",
  "pgcf_database_compute_changes_history",
  "pgcf_database_compute_changes_unfinished",
  "project_database_access",
  "project_database_access_active_idx",
  "project_database_access_environment_idx",
  "project_database_access_identity_guard",
  "project_database_access_undropped_idx",
  "project_database_write_delete_guard",
  "project_database_write_guard",
  "project_database_writes",
  "project_database_writes_pending",

  "product_command_intents_original_identity",
  "outbox_events_original_identity",

  //0337 restores the original raw provider facts/readers and their native metadata wakes.
  "project_database_compute_changes",
  "project_database_compute_changes_guard",
  "project_database_compute_changes_no_delete",
  "project_database_compute_changes_unfinished",
  "project_r2_bucket_receipts",
  "project_r2_bucket_receipts_no_delete",
  "project_r2_bucket_receipts_no_update",
  "database_provider_cutover_authorizations_global_operation",
  "database_provider_cutover_verifications",
  "database_provider_cutover_verifications_no_update",
  "database_provider_cutover_verifications_no_delete",
  "database_provider_cutover_receipts",
  "database_provider_cutover_receipts_no_update",
  "database_provider_cutover_receipts_no_delete",
  "database_provider_cutover_binding_refreshes",
  "database_provider_cutover_binding_refreshes_no_update",
  "database_provider_cutover_binding_refreshes_no_delete",
  "product_provider_mutation_claims_provider_scope",
  "runtime_secret_delivery_generations_monotonic",
  "runtime_secret_delivery_receipts",
  "runtime_secret_delivery_receipts_no_update",
  "runtime_secret_delivery_receipts_no_delete",

  "webhook_inbox_cross_identity_insert",
  "webhook_inbox_cross_identity_update",
  "inbox_unrouted_cross_identity_insert",
  "inbox_unrouted_cross_identity_update",
  "inbox_unrouted_delete_requires_canonical",
  "webhook_inbox_provider_claim",
  //0340: reviewed original Stripe metadata, immutable receipts and provider-identity fences.
  "stripe_billing_customers",
  "stripe_customer_identity",
  "stripe_customer_no_delete",
  //0901: the closure of a deleted organization's Stripe billing, one row per organization.
  "stripe_billing_closures",
  "stripe_recharge_policies",

  "environment_identities_project_environment",
  "build_source_uploads",
  "build_source_upload_parts",
  "build_source_upload_parts_no_update",
  "build_source_upload_parts_no_delete",
  "build_executions",
  "build_artifacts",
  "build_artifacts_no_update",
  "build_artifacts_no_delete",
  "run_cleanup_attempts",
  "run_cleanup_attempts_lifetime",
  "run_cleanup_attempts_no_update",
  "run_cleanup_attempts_no_delete",
  "wfp_candidate_receipts",
  "wfp_candidate_receipts_script_idx",
  "wfp_candidate_receipts_no_update",
  "wfp_candidate_receipts_no_delete",
  "wfp_candidate_receipts_exact_identity",
  "shared_gateway_route_revisions",
  "shared_gateway_routes_origin_idx",
  "shared_gateway_route_revisions_no_update",
  "shared_gateway_route_revisions_no_delete",
  "shared_gateway_route_browser_policy",
  "wfp_publish_receipts",
  "wfp_publish_receipts_no_update",
  "wfp_publish_receipts_no_delete",
  "wfp_publish_receipts_exact_identity",
  "wfp_publish_receipts_legacy_shape",
  "wfp_publish_receipts_legacy_v7_origin",
  "wfp_candidate_cleanup_receipts",
  "wfp_candidate_cleanup_receipts_no_update",
  "wfp_candidate_cleanup_receipts_no_delete",
  "wfp_candidate_cleanup_receipts_shape",
  "wfp_candidate_cleanup_receipts_exact_identity",
  "source_connections_no_update",
  "source_connections_no_delete",
  "repository_grants_no_update",
  "repository_grants_no_delete",
  "deployment_revisions_no_update",
  "deployment_revisions_no_delete",
  "github_grant_bind_source",
  "project_source_bindings_original_int4_insert",
  "project_source_bindings_original_int4_update",
  "deployment_plans_framework_shape",
  "deployment_plans_framework_kind",
  "deployment_plans_function_crons",
  "deployment_plans_ssg_cache",
  "deployment_plans_runtime_policy",
  "deployment_plans_browser_policy",

  "build_environment_scope",
  "build_operation_scope",
  "build_epoch_scope",
  "build_receipts",
  "build_receipts_no_update",
  "build_receipts_no_delete",
  "build_input_reservations",
  "build_input_reservations_no_delete",
  "build_input_reservations_renewal",
  "build_usage",
  "build_usage_no_update",
  "build_usage_no_delete",

  "core_historical_import",
  "core_authority_activation",
  "core_historical_import_open",
  "core_historical_import_close_only",
  "core_historical_import_no_delete",
  "core_authority_activation_qualified",
  "core_authority_activation_no_update",
  "core_authority_activation_no_delete",

  "sqlite_sequence", // original notice allocators: imported highwater, including purged history

  "pgcf_serving_interval_on_head_delete",
  "pgcf_platform_database_activations",
  "pgcf_platform_activations_no_update",
  "pgcf_platform_activations_no_delete",

  "published_credit_rate_cards_released_shape",
  "usage_meter_activations_released_shape",

  "signup_sources",
  "project_powered_by_flag_periods",
  "project_powered_by_flag_periods_one_open",
  "project_powered_by_flag_periods_project",
  "project_powered_by_flag_periods_close_only_update",
  "project_powered_by_flag_periods_close_only_delete",
  "onboarding_requests_shape_insert",
  "onboarding_requests_shape_update",
  "onboarding_requests_attributed_delete",
  "user_signup_shape_insert",
  "user_signup_shape_update",

  "api_key_metadata",
  "api_key_metadata_scope_insert",
  "api_key_metadata_scope_update",
  "webhook_inbox_global_id",

  "billing_epochs_creation_recipe_scope",
  "operations_creation_recipe_scope",
  "managed_source_repositories",
  "managed_source_repositories_no_update",
  "managed_source_repositories_no_delete",
  "managed_source_publications",
  "managed_source_initializations",
  "managed_source_initialization_identity",

  "recovery_jobs_global_project_requested",
  // Actual BuildRunner receipt port, core migration 0322; original build tables were not in the earlier lineage.
  "audit_events_global_id",
  "billing_epochs_chronological",
  "billing_epochs_global_id",
  "billing_epochs_history_delete",
  "billing_epochs_history_update",
  "command_log",
  "core_layout",
  "data_environment_identities",
  "environment_identities",
  "environments_global_identity",
  "guard_fail",
  "mcp_client_grants_global_id",
  "mcp_mail_domain_grants_global_id",
  "operation_events_global_id",
  "operations_global_id",
  "outbox_events_global_id",
  "project_data_environments_global_identity",
  "project_identities",
  "project_scope_history",
  "project_scope_history_append_only_delete",
  "project_scope_history_append_only_update",
  "projects_copy_follows_lifecycle",
  "projects_global_identity",
  "projects_one_current_owner",
  "projects_return_history",
  "projects_transfer_after_epoch_close",
  "projects_transferred_terminal",
  "shard_buckets",
  "shards",
  "runtime_probe_windows",
  "runtime_probe_window_lookup",
  "runtime_probe_windows_no_update",
  "runtime_probe_windows_no_delete",
  "function_runs_global_id",
  "environment_function_schedules_shape_insert",
  "environment_function_schedules_shape_update",
  "function_runs_shape_insert",
  "function_runs_shape_update",
  "wfp_rollback_activation_receipts",
  "wfp_rollback_activation_receipts_no_update",
  "wfp_rollback_activation_receipts_no_delete",
  "wfp_rollback_activation_current",
  "shared_gateway_address_receipts",
  "shared_gateway_address_receipts_no_update",
  "shared_gateway_address_receipts_no_delete",
  "effective_wfp_publish_receipts",
  "wfp_candidate_cleanup_requests",
  "wfp_candidate_cleanup_requests_no_update",
  "wfp_candidate_cleanup_requests_no_delete",
  "wfp_candidate_cleanup_claims",
  "wfp_candidate_cleanups_legacy_no_insert",
  "wfp_candidate_cleanups_legacy_no_update",
  "wfp_candidate_cleanups_legacy_no_delete",
  "runtime_secret_delivery_stages",
  "runtime_secret_delivery_stages_names",
  "runtime_secret_delivery_stages_no_update",
  "runtime_secret_delivery_stages_no_delete",
  "runtime_secret_delivery_stage_activations",
  "runtime_secret_delivery_stage_activations_no_update",
  "runtime_secret_delivery_stage_activations_no_delete",
  "runtime_secret_delivery_stage_compensations",
  "runtime_secret_delivery_stage_compensations_no_update",
  "runtime_secret_delivery_stage_compensations_no_delete",
  "runtime_secret_delivery_stage_activation_terminal_check",
  "runtime_secret_delivery_stage_compensation_terminal_check",
  "shared_gateway_stage_activation",
  "delivery_attempts",
  "organization_audit_events",
  "organization_audit_events_scope",
  "organization_audit_events_no_update",
  "organization_audit_events_no_delete",
  "audit_events_no_delete",
  "audit_events_original_scope",
  "operation_events_no_delete",
  "operation_events_original_scope",
  "operations_original_epoch_scope",
  "outbox_events_original_scope",
  "outbox_events_original_scope_update",
  "environment_data_assignments_require_current_scope",
  "principal_mappings",

  "storage_gateway_keys",
  "storage_gateway_keys_no_update",
  "storage_gateway_keys_no_delete",

  "wfp_candidate_cleanup_resource_expectations",
  "wfp_candidate_cleanup_resource_expectations_no_update",
  "wfp_candidate_cleanup_resource_expectations_no_delete",

  "control_source_migrations",
  "control_source_migrations_no_update",
  "control_source_migrations_no_delete",
  "control_source_migration_sequence",
  "control_source_migration_sequence_no_update",
  "control_source_migration_sequence_no_delete",

  "product_command_intents_no_update",
  "product_command_intents_no_delete",
  "product_command_intents_original_ulids",
  "product_command_intents_data_snapshot_shape",
  "product_binding_refresh_snapshot_original_shape",

  "deployment_diagnostics",
  "deployment_diagnostics_scope_order_idx",
  "product_provider_mutation_observations",
  "product_provider_reconciliation_attempts",
  "product_workflow_replay_attempts",
  "product_workflow_replay_failures",
  "product_provider_mutation_observations_no_update",
  "product_provider_mutation_observations_no_delete",
  "product_provider_reconciliation_attempts_no_update",
  "product_provider_reconciliation_attempts_no_delete",
  "product_workflow_replay_attempts_no_update",
  "product_workflow_replay_attempts_no_delete",
  "product_workflow_replay_failures_no_update",
  "product_workflow_replay_failures_no_delete",
  "product_provider_mutation_claims_update_forbidden",
  "product_provider_mutation_claims_delete_guard", //0720 no longer exempts a claim that still has a reservation; the release trigger decides
  "resend_mail_domains_global_domain_id",
  "resend_mail_domains_original_scope",
  "workspace_mail_domains_global_domain_id",
  "workspace_mail_domains_original_scope",
  "mail_received_messages_global_message_id",
  "project_mail_domain_bindings_global_project",
  "project_application_domain_identities_global_project",
  "resend_event_receipts",
  "infrastructure_alert_receipts",
  "shared_mail_capabilities",
  "mail_send_outcomes",
  "workspace_mail_reputation_decisions",

  "mail_gateway_keys_no_update",
  "mail_gateway_keys_no_delete",
  "mail_send_events_append_only_delete",

  "ses_tenant_receipts",
  "ses_tenant_receipts_append_only_update",
  "ses_tenant_receipts_append_only_delete",
  "ses_project_mail_resource_receipts",
  "ses_project_mail_resource_receipts_append_only_update",
  "ses_project_mail_resource_receipts_append_only_delete",
  "ses_event_destination_receipts",
  "ses_event_destination_receipts_append_only_update",
  "ses_event_destination_receipts_append_only_delete",
  "legacy_aws_mail_absence",
  "legacy_aws_mail_absence_append_only_update",
  "legacy_aws_mail_absence_append_only_delete",

  "route53_dkim_change_receipts",
  "route53_dkim_change_receipts_original_shape",
  "route53_dkim_change_receipts_append_only_update",
  "route53_dkim_change_receipts_append_only_delete",
  "route53_dkim_receipts",
  "route53_dkim_receipts_append_only_update",
  "route53_dkim_receipts_append_only_delete",

  "github_source_connections",
  "github_source_connections_no_update",
  "github_source_connections_no_delete",
  "source_archives",
  "source_archives_no_update",
  "source_archives_no_delete",
  // 0466/0491 exact original domain, binding, proof, lifecycle and final post0480 website callbacks.
  "resend_mail_domains_received_compat_scope",
  "resend_mail_domain_live_name",
  "resend_mail_domain_live_project",
  "workspace_mail_domain_live_name", //0643 unique over provider-verified or legacy senders only; an unverified one reserves for seven days in the command
  "project_mail_domain_active_refs",
  "application_mail_identity_revalidation_due",
  "resend_domain_identity",
  "resend_prod_environment",
  "guard_workspace_mail_identity",
  "guard_project_mail_binding_insert",
  "guard_project_mail_binding_update",
  "guard_application_mail_identity_update",
  "mirror_legacy_workspace_mail",
  "mark_mail_capabilities_dirty_insert",
  "mark_mail_capabilities_dirty_update",
  "detach_inactive_project_mail",
  "detach_transferred_project_mail",
  // 0456 original project source selection
  "project_source_bindings_original_generation_insert",
  "project_source_bindings_original_generation_update",
  "project_sources",
  // 0413 original placement operation ids
  "neon_project_placement_operation_ids_insert",
  "neon_project_placement_operation_ids_update",
  // 0495 original GitHub auto-deploy configuration
  "github_auto_deploy_configs",
  "github_push_deployments_cleanup_receipt_check",
  "github_push_deployments_latest_idx",
  // 0496 durable candidate cleanup receipts
  "wfp_candidate_operation_cleanup_receipts",
  "wfp_candidate_operation_cleanup_receipts_no_delete",
  "wfp_candidate_operation_cleanup_receipts_no_update",
  // 0497 project R2 erasure barriers
  "project_r2_erasure_barriers",
  "project_r2_erasure_barriers_no_delete",
  "project_r2_erasure_barriers_no_update",
  "project_r2_erasure_barriers_scope",
  // 0498 global receipt identities
  "cloudflare_project_authorization_states_global_id",
  "cloudflare_project_domain_receipts_global_id",
  // 0500 managed source blobs
  "managed_source_blob_reservation",
  "managed_source_blobs",
  "managed_source_blobs_no_delete",
  "managed_source_blobs_no_update",
  "managed_source_reservations",
  "managed_source_reservations_no_delete",
  "managed_source_reservations_no_update",
  // 0501 action confirmation global identity
  "action_confirmations_original_global_identity",
  // 0504 customer feedback, beta interests and contact requests
  "beta_feature_current",
  "beta_feature_expiry_index",
  "beta_feature_interests",
  "beta_feature_vote_allocator",
  "beta_interests",
  "beta_interests_expiry",
  "contact_requests",
  "contact_requests_expiry",
  "customer_feedback",
  "customer_feedback_append_only_delete",
  "customer_feedback_append_only_update",
  "customer_feedback_events",
  "customer_feedback_events_append_only_delete",
  "customer_feedback_events_append_only_update",
  "customer_feedback_events_history",
  // 0505 provider resource inventory
  "provider_resources",
  "provider_resources_external_idx",
  // 0506 dev share link global identity
  "dev_share_links_original_global_identity",
  "dev_share_links_original_static_parent_insert",
  "dev_share_links_original_static_parent_update",
  // 0600 simple credits
  "credit_account",
  "project_credit",
  "credit_reservation",
  "credit_grant",
  "usage_cursor",
  "credit_log",
  "credit_log_at",
  "credit_log_org",
  "credit_grant_org",
  // 0605 AI gateway: the reservations the sweep may release, marked when they are admitted
  "ai_gateway_reservations",
  // 0606 AI gateway: a stored plan may declare the optional ai key, judged by its own trigger
  "deployment_plans_ai_shape",
  // 0632 anonymous-intake budget: the live rows per table and day, kept by triggers
  "public_intake_budget",
  "contact_requests_budget_insert",
  "contact_requests_budget_delete",
  "beta_feature_interests_budget_insert",
  "beta_feature_interests_budget_delete",
  // 0800 AI gateway: the open-call guard's count of one organization's markers
  "ai_gateway_reservations_organization",
  // 0840: gateway key lookups by project, name and digest, served without a Core-wide scan of environment_secrets.
  "environment_secrets_key_lookup",
  "make_action_bindings",
  "make_action_binding_immutable",
  "make_action_executions",
  // 0950: storage gateway key lookups by project, environment and digest, served without a scan of storage_gateway_keys.
  "storage_gateway_keys_project_digest",
];
/** Lineage objects the core drops or replaces by another definition, each with a dedicated test. */
const INTENTIONALLY_REPLACED_OBJECTS: string[] = [
  // Explicit reviewed replacements;0466 restores original identities and removes prototype-only command indexes.
  "audit_events_delete_below_horizon",
  "mcp_client_grants_consent_scope", //0608 replaces consent/project uniqueness with immutable ownership-epoch proofs
  "operation_events_delete_below_horizon",
  "product_binding_refresh_snapshot_key",
  "project_application_domain_identities_revision",
  "project_application_identity_action_commands_purge",
  "project_application_identity_commands_purge",
  "project_mail_domain_bindings_by_domain",
  "resend_mail_commands_by_domain",
  "resend_mail_commands_purge",
  "resend_mail_domains_by_domain",
  "resend_mail_domains_identity",
  "resend_mail_domains_one_live_per_project",
  "resend_mail_domains_prod_environment",
  "workspace_mail_commands_by_domain",
  "workspace_mail_commands_purge",
  "workspace_mail_domains_by_domain",
  "workspace_mail_domains_identity",
];
