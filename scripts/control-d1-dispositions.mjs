import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { canonical, fail, sha256 } from "./control-d1-codec.mjs";

// Original tables that have no Core table and are not imported. Each is accounted explicitly, never ignored.
//   empty     dead or legacy writer; the captured table must hold no row (a row is a gap, not a silent drop)
//   scaffold  migration scratch; its row count and proof are recorded
//   expired   short-lived OAuth state; every row must be past its expiry at capture time
//   consumed  read by an imported family as evidence; recorded once that family is mapped
//   archive   Neon-era history; exact typed rows go to a deterministic NDJSON.gz (R2) with a digest receipt
//   removed   credit, metering, usage and billing domains the Core no longer has; row count and source digest are
//             recorded, the rows are neither imported nor archived
export const DISPOSITION_PINS = Object.freeze({
  github_connection_authorizations:
    "authorization_id:text,organization_id:text,principal_id:text,session_id:text,user_api_key_id:text,workos_organization_id:text,token_expires_at:bigint,idempotency_key:text,state_sha256:bytea,ciphertext:bytea,nonce:bytea,value_sha256:bytea,key_version:integer,state:text,flow:text,installation_id:text,connection_id:text,last_failure:text,created_at:timestamp with time zone,expires_at:timestamp with time zone",
  github_push_target_denials:
    "inbox_event_id:text,organization_id:text,project_id:text,source_connection_id:text,github_installation_id:text,external_repository_id:text,branch_ref:text,error_code:text,denied_at:timestamp with time zone",
  neon_project_placement_local_failure_repairs:
    "organization_id:text,project_id:text,claim_id:text,previous_create_started_at:timestamp with time zone,fixed_worker_version:uuid,repaired_at:timestamp with time zone",
  neon_project_role_reservations:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,provider_project_id:text,branch_id:text,role_name:text,reserved_at:timestamp with time zone,create_started_at:timestamp with time zone",
  project_hyperdrive_reservations:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,provider_project_id:text,branch_id:text,config_name:text,origin_host:text,origin_database:text,origin_user:text,reserved_at:timestamp with time zone,create_started_at:timestamp with time zone",
  neon_project_placement_reservations:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,project_name:text,region_id:text,postgres_version:smallint,reserved_at:timestamp with time zone,create_started_at:timestamp with time zone,compute_profile:text",
  pgcf_node_cost_facts:
    "fact_id:text,node_id:text,period_start:timestamp with time zone,period_end:timestamp with time zone,cost_micros:bigint,currency:text,evidence_reference:text,recorded_at:timestamp with time zone",
  shared_gateway_receipt_migration_restore: "kind:text,name:text,definition:text",
  pgcf_registration_constraint_restore: "relation_name:text,constraint_name:text,definition:text",
  neon_project_migration_receipts:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,provider_project_id:text,branch_id:text,bundle_sha256:bytea,applied_paths:text[],replayed_paths:text[],completed_at:timestamp with time zone,created_at:timestamp with time zone",
  project_hyperdrive_origin_receipts:
    "organization_id:text,project_id:text,environment_id:text,hyperdrive_id:text,operation_id:text,claim_id:text,origin_user:text,observed_at:timestamp with time zone",
  project_hyperdrive_receipts:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,provider_project_id:text,branch_id:text,config_name:text,origin_host:text,origin_database:text,origin_user:text,hyperdrive_id:text,observed_at:timestamp with time zone,created_at:timestamp with time zone",
  pgcf_project_region_cutovers:
    "cutover_id:text,one_time:boolean,manifest_sha256:bytea,writer_freeze_sha256:bytea,project_manifest:jsonb,expected_active_count:integer,changed_eu_count:integer,executed_by:name,executed_at:timestamp with time zone",
  project_transfer_intents:
    "transfer_id:text,project_id:text,source_organization_id:text,target_organization_id:text,state:text,expected_ownership_version:integer,initiated_by_principal_id:text,created_at:timestamp with time zone,completed_at:timestamp with time zone,cancelled_at:timestamp with time zone,failure_code:text",
  route53_dkim_change_receipts:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,accepted_lifecycle_version:integer,domain:text,caller_reference:text,hosted_zone_id:text,name_servers:text[],records:jsonb,change_id:text,submitted_at:timestamp with time zone,observed_at:timestamp with time zone,created_at:timestamp with time zone",
  route53_dkim_receipts:
    "organization_id:text,project_id:text,change_id:text,insync_at:timestamp with time zone,identity_verified_at:timestamp with time zone,observed_at:timestamp with time zone,created_at:timestamp with time zone",
  ses_tenant_receipts:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,accepted_lifecycle_version:integer,provider:text,region:text,tenant_name:text,tenant_id:text,tenant_arn:text,sending_status:text,reputation_policy_arn:text,aws_managed_status:text,customer_managed_status:text,aggregate_sending_status:text,provider_created_at:timestamp with time zone,reputation_observed_at:timestamp with time zone,observed_at:timestamp with time zone,created_at:timestamp with time zone",
  ses_project_mail_resource_receipts:
    "organization_id:text,project_id:text,environment_id:text,operation_id:text,claim_id:text,accepted_lifecycle_version:integer,region:text,configuration_set_name:text,configuration_set_arn:text,tenant_name:text,tenant_id:text,associated_at:timestamp with time zone,observed_at:timestamp with time zone,created_at:timestamp with time zone",
  ses_event_destination_receipts:
    "organization_id:text,project_id:text,configuration_set_name:text,event_destination_name:text,event_bus_arn:text,matching_event_types:jsonb,observed_at:timestamp with time zone",
  legacy_aws_mail_absence:
    "organization_id:text,project_id:text,resource_kind:text,locator:text,observed_at:timestamp with time zone,evidence_sha256:bytea,recorded_by:text,recorded_at:timestamp with time zone",
});

// W33 simple credits: the Core holds only credit amounts (migration 0601 drops the old credit, metering, usage and
// billing schema), so the history of these original tables is not converted. Each one is still accounted explicitly.
export const REMOVED_SOURCE_TABLES = Object.freeze([
  // wallets, grants, holds, corrections, paid access, budgets and valuations
  "organization_credit_wallets",
  "organization_credit_grants",
  "organization_credit_reservations",
  "organization_credit_resolutions",
  "organization_credit_movements",
  "organization_credit_grant_adjustments",
  "organization_credit_grant_expirations",
  "organization_paid_access",
  "organization_paid_access_events",
  "project_credit_budgets",
  "usage_credit_valuations",
  "stripe_subscription_ends",
  "billing_environment_scopes",
  // Stripe payments, refunds, disputes, tax issues and recharge attempts
  "stripe_checkout_requests",
  "stripe_credit_payments",
  "stripe_refund_observations",
  "stripe_dispute_movements",
  "stripe_billing_tax_issues",
  "stripe_recharge_consents",
  "stripe_recharge_attempts",
  "stripe_recharge_reversal_observations",
  // provider consumption observations, metering work, hints and discovery
  "neon_consumption_observations",
  "r2_consumption_observations",
  "metering_lane_owner",
  "metering_owner_activation_receipts",
  "organization_metering_work",
  "metering_cohort_work",
  "lifetime_day_hints",
  "neon_metering_source_hints",
  "r2_metering_source_hints",
  "wfp_usage_batches",
  "wfp_usage_events",
  "wfp_batch_discovery",
  "wfp_discovery_cohort_plan",
  "metering_discovery_backfills",
  "lifetime_resource_work",
  "lifetime_resource_sources",
  "lifetime_dirty_notices",
  "lifetime_discovery_bootstrap",
  "provider_hint_bootstrap",
  "provider_collection_cursors",
  "pgcf_collection_cursors",
  "pgcf_usage_hours",
  "metering_projection_cursors",
  // credit projections, expiry builds, usage reporting, source custody and maintenance
  "credit_projection_state",
  "credit_projection_builds",
  "credit_projection_build_applied",
  "credit_lot_totals",
  "credit_org_exposure",
  "credit_project_outstanding",
  "credit_project_period_totals",
  "credit_expiry_state",
  "credit_expiry_builds",
  "credit_expiry_lots",
  "credit_usage_reporting_state",
  "credit_usage_reporting_builds",
  "credit_usage_reporting_build_applied",
  "credit_usage_dimensions",
  "credit_usage_project_months",
  "credit_usage_project_holds",
  "credit_usage_visibility_hot",
  "credit_source_custody",
  "credit_source_builds",
  "credit_source_heads",
  "credit_source_grant_allocations",
  "credit_source_build_applied",
  "credit_maintenance_due",
  "credit_maintenance_notices",
  "credit_maintenance_bootstrap",
  // mail credit history, warnings and referral observations
  "mail_credit_accounts",
  "mail_credit_ledger",
  "organization_credit_grace_periods",
  "organization_credit_warnings",
  "referral_observations",
]);
/** Original views and allocators that only served the removed tables; nothing replaces them in the Core. */
export const REMOVED_SOURCE_VIEWS = Object.freeze([
  "attributed_wfp_usage",
  "latest_neon_consumption",
  "latest_r2_consumption",
]);
export const REMOVED_SOURCE_SEQUENCES = Object.freeze([
  "credit_maintenance_notices_notice_id_seq",
  "credit_usage_dimensions_dimension_id_seq",
  "lifetime_dirty_notices_notice_id_seq",
]);

export const DISPOSITIONS = Object.freeze({
  github_connection_authorizations: { kind: "expired", column: "expires_at" },
  github_push_target_denials: { kind: "empty" },
  neon_project_placement_local_failure_repairs: { kind: "empty" },
  neon_project_role_reservations: { kind: "empty" },
  project_hyperdrive_reservations: { kind: "empty" },
  neon_project_placement_reservations: { kind: "archive" },
  pgcf_node_cost_facts: { kind: "empty" },
  shared_gateway_receipt_migration_restore: { kind: "scaffold" },
  pgcf_registration_constraint_restore: { kind: "scaffold" },
  project_transfer_intents: { kind: "consumed", by: "projects" },
  neon_project_migration_receipts: { kind: "archive" },
  project_hyperdrive_origin_receipts: { kind: "archive" },
  project_hyperdrive_receipts: { kind: "archive" },
  pgcf_project_region_cutovers: { kind: "archive" },
  // Owner decision 30 October: AWS (Route 53, SES) is no longer used; Resend is. The history is kept as digest-receipted
  // archive, not imported (one Production Route 53 receipt cannot even pass D1's 50-byte GLOB pattern limit).
  route53_dkim_change_receipts: { kind: "archive" },
  route53_dkim_receipts: { kind: "archive" },
  ses_tenant_receipts: { kind: "archive" },
  ses_project_mail_resource_receipts: { kind: "archive" },
  ses_event_destination_receipts: { kind: "archive" },
  legacy_aws_mail_absence: { kind: "archive" },
  ...Object.fromEntries(REMOVED_SOURCE_TABLES.map((name) => [name, { kind: "removed" }])),
});
export const AWS_ARCHIVED_TABLES = Object.freeze(
  Object.entries(DISPOSITIONS)
    .filter(([name]) => /^(route53_|ses_|legacy_aws_)/u.test(name))
    .map(([name]) => name),
);

/** Deterministic archive bytes: header line, then one JSON array of the typed source texts per row, sorted. */
export function archiveNdjson(table, definition, rows) {
  const columns = definition.columns.map((column) => ({
    name: column.name,
    pgType: column.pgType,
  }));
  const lines = rows.map((row) => canonical(columns.map((column) => row[column.name]))).sort();
  return Buffer.from(
    [canonical({ table, columns, rows: String(rows.length) }), ...lines].join("\n") + "\n",
  );
}
export const archiveGzip = (ndjson) => gzipSync(ndjson, { level: 9, mtime: 0 });

/** Key and digests of the deterministic archive of one table; the importer records only this receipt. */
function archiveReceipt(capture, definition, rows) {
  const ndjson = archiveNdjson(definition.name, definition, rows);
  return {
    archiveKey: `archive/${capture.manifest.source.expected.environment}/${definition.name}/${capture.manifest.captureId}.ndjson.gz`,
    ndjsonSha256: sha256(ndjson),
    gzipSha256: sha256(archiveGzip(ndjson)),
  };
}

// Tables the owner keeps whole: user relations. A configured archive refuses them; they are fixed properly instead.
export const PROTECTED_SOURCE_TABLES = Object.freeze(
  new Set([
    "workos_organization_mappings",
    "organization_memberships",
    "local_authorization_grants",
    "workos_terminal_revocations",
    "projects",
    "project_ownerships",
    "billing_epochs",
    "environments",
    "project_data_environments",
    "environment_data_assignments",
    "environment_secrets",
    "deployments",
    "deployment_plans",
    "deployment_revisions",
    "cloudflare_project_domains",
    "paid_project_domains",
    "project_mail_domains",
    "project_mail_domain_bindings",
    "resend_mail_domains",
    "workspace_mail_domains",
    "mail_gateway_keys",
    "source_connections",
    "repository_grants",
    "github_organization_connections",
    "github_source_connections",
    "managed_source_repositories",
    "project_sources",
    "project_source_bindings",
    "stripe_billing_customers",
    "database_provider_target_heads",
    "database_provider_target_revisions",
    "project_database_registration_receipts",
    "project_database_access",
    "pgcf_database_entitlement_policies",
    "project_r2_bucket_receipts",
    "storage_gateway_keys",
    "operations",
    "api_key_metadata",
    "user_api_key_requests",
  ]),
);

/**
 * Operator-chosen drops for the Production import: each named non-user-relation table whose target has the same name
 * is kept as a digest-receipted archive and not imported. Private configuration, never a silent omission.
 */
export function configuredArchives(capture, tables) {
  if (!Array.isArray(tables) || tables.some((table) => typeof table !== "string"))
    fail("ARCHIVE_CONFIG");
  const entries = [],
    gaps = [];
  for (const table of [...new Set(tables)].sort()) {
    const definition = capture.manifest.tables.find((entry) => entry.name === table);
    const code = !definition
      ? "ARCHIVE_TABLE_UNKNOWN"
      : PROTECTED_SOURCE_TABLES.has(table)
        ? "ARCHIVE_TABLE_PROTECTED"
        : Object.hasOwn(DISPOSITIONS, table)
          ? "ARCHIVE_TABLE_ACCOUNTED"
          : null;
    if (code !== null) {
      gaps.push({ group: "configured-archive", code: `CONTROL_D1_${code}`, tables: [table] });
      continue;
    }
    entries.push({
      table,
      kind: "archive",
      configured: true,
      rows: definition.rows,
      sourceSha256: definition.sha256,
      ...archiveReceipt(capture, definition, capture.rows.get(table)),
    });
  }
  return { entries, gaps };
}

/** Accounts every disposition table of this capture; returns plan entries, the set of accounted tables and gaps. */
export function qualifyDispositions(capture, mapped) {
  const entries = [],
    gaps = [];
  for (const [table, rule] of Object.entries(DISPOSITIONS)) {
    const definition = capture.manifest.tables.find((entry) => entry.name === table);
    // A capture without the table has nothing to account, like every other optional family.
    if (!definition) continue;
    try {
      // A consumed table is read by its consumer's own column checks, a removed one is not read at all; every
      // other kind pins the original shape.
      if (
        rule.kind !== "consumed" &&
        rule.kind !== "removed" &&
        definition.columns.map((column) => `${column.name}:${column.pgType}`).join(",") !==
          DISPOSITION_PINS[table]
      )
        fail("DISPOSITION_SOURCE_COLUMNS");
      const rows = capture.rows.get(table);
      if (rule.kind === "empty" && rows.length !== 0) fail("DISPOSITION_ROWS_PRESENT");
      if (rule.kind === "consumed" && !mapped.has(rule.by)) fail("DISPOSITION_CONSUMER_UNMAPPED");
      if (
        rule.kind === "expired" &&
        rows.some(
          (row) =>
            !(Date.parse(row[rule.column]) <= Date.parse(capture.manifest.capturedAt)) ||
            row[rule.column] === null,
        )
      )
        fail("DISPOSITION_NOT_EXPIRED");
      const entry = {
        table,
        kind: rule.kind,
        rows: definition.rows,
        sourceSha256: definition.sha256,
      };
      if (rule.kind === "archive") Object.assign(entry, archiveReceipt(capture, definition, rows));
      entries.push(entry);
    } catch (error) {
      if (!/^CONTROL_D1_/u.test(error.message)) throw error;
      gaps.push({ group: "dispositions", code: error.message, tables: [table] });
    }
  }
  return { entries, gaps };
}
