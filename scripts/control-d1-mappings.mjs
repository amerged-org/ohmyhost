import {
  API_METADATA_COLUMNS,
  API_METADATA_TARGETS,
  mapApiMetadata,
} from "./control-d1-api-metadata-mappings.mjs";
import { createHash } from "node:crypto";
import { canonical, fail } from "./control-d1-codec.mjs";
import {
  RATE_CARD_COLUMNS,
  RATE_CARD_TARGETS,
  mapRateCards,
} from "./control-d1-rate-card-mappings.mjs";
import { MAIL_COLUMNS, MAIL_TARGETS, mapMail } from "./control-d1-mail-mappings.mjs";
import {
  R2_STORAGE_COLUMNS,
  R2_STORAGE_TARGETS,
  R2_STORAGE_PARENTS,
  mapR2Storage,
} from "./control-d1-r2-storage-mappings.mjs";
import {
  CLOUDFLARE_COLUMNS,
  CLOUDFLARE_TARGETS,
  mapCloudflareFacts,
} from "./control-d1-cloudflare-mappings.mjs";
import {
  CLOUDFLARE_CONTEXT_PIN,
  CLOUDFLARE_CONTEXT_TABLES,
} from "./control-d1-cloudflare-import-context.mjs";
import {
  ONBOARDING_COLUMNS,
  ONBOARDING_TARGETS,
  mapOnboarding,
} from "./control-d1-onboarding-mappings.mjs";
import { IDENTITY_KEY_COLUMNS, mapIdentityKeys } from "./control-d1-identity-mappings.mjs";
import { MCP_COLUMNS, MCP_TARGETS, mapMcp } from "./control-d1-mcp-mappings.mjs";
import {
  SPINE_COLUMNS,
  mapOperations,
  mapApiReceipts,
  mapAuditFacts,
  mapOutboxFacts,
} from "./control-d1-spine-mappings.mjs";
import {
  BACKBONE_COLUMNS,
  BACKBONE_TARGETS,
  mapPrincipalMappings,
  mapGlobalInbox,
  mapOperationDelegations,
} from "./control-d1-backbone-mappings.mjs";
import { BILLING_COLUMNS, BILLING_TARGETS, mapBilling } from "./control-d1-billing-mappings.mjs";
import { BUILD_COLUMNS, mapBuild } from "./control-d1-build-mappings.mjs";
import {
  PROVIDER_PARENT_COLUMNS,
  PROVIDER_PARENT_TARGETS,
  mapProviderParents,
} from "./control-d1-provider-parent-mappings.mjs";
import {
  PRODUCT_DATABASE_COLUMNS,
  PRODUCT_DATABASE_TARGETS,
  mapProductDatabase,
} from "./control-d1-product-database-mappings.mjs";
import {
  METERING_COLUMNS,
  METERING_TARGETS,
  mapMetering,
} from "./control-d1-metering-mappings.mjs";
import {
  FUNCTION_COLUMNS,
  FUNCTION_TARGETS,
  mapFunctionSchedules,
} from "./control-d1-functions-mappings.mjs";
import { qualifySourceViews } from "./control-d1-view-readers.mjs";
import {
  GENERIC_BEFORE_WFP,
  GENERIC_AFTER_WFP,
  GENERIC_AFTER_CLOUDFLARE,
  GENERIC_TARGETS,
  GENERIC_COLUMNS,
  mapGeneric,
} from "./control-d1-generic-mappings.mjs";
import {
  qualifyDispositions,
  configuredArchives,
  AWS_ARCHIVED_TABLES,
  REMOVED_SOURCE_SEQUENCES,
  REMOVED_SOURCE_VIEWS,
} from "./control-d1-dispositions.mjs";
import { WFP_COLUMNS, WFP_TARGETS, mapWfp } from "./control-d1-wfp-mappings.mjs";
import { SECRET_COLUMNS, SECRET_TARGETS, mapSecret } from "./control-d1-secret-mappings.mjs";
import { STORAGE_COLUMNS, STORAGE_TARGETS, mapStorage } from "./control-d1-storage-mappings.mjs";
import {
  ENTITLEMENT_COLUMNS,
  ENTITLEMENT_TARGETS,
  mapProductEntitlements,
} from "./control-d1-product-entitlement-mappings.mjs";
import {
  PUBLIC_ENTRY_COLUMNS,
  PUBLIC_ENTRY_TARGETS,
  PUBLIC_ENTRY_PARENTS,
  mapPublicEntryFacts,
} from "./control-d1-public-entry-mappings.mjs";
import { publicEntrySequences } from "./control-d1-public-entry-sequence.mjs";
import {
  MIGRATION_HISTORY_COLUMNS,
  MIGRATION_HISTORY_TARGETS,
  mapMigrationHistory,
  migrationHistorySequences,
} from "./control-d1-source-history.mjs";

// A closed registry of reviewed source families. Adding a source name here without a complete mapper is not allowed.
export const IDENTITY_SOURCES = Object.freeze([
  "workos_organization_mappings",
  "organization_memberships",
  "local_authorization_grants",
  "workos_terminal_revocations",
  "workos_membership_sync_barriers",
]);
export const PROJECT_SOURCES = Object.freeze([
  "projects",
  "project_ownerships",
  "billing_epochs",
  "environments",
  "project_data_environments",
]);
const ALLOWED_TARGETS = new Set([
  ...RATE_CARD_TARGETS,
  ...ONBOARDING_TARGETS,
  ...Object.keys(IDENTITY_KEY_COLUMNS),
  ...MCP_TARGETS,
  ...Object.keys(SPINE_COLUMNS),
  ...BACKBONE_TARGETS,
  ...BILLING_TARGETS,
  ...Object.keys(BUILD_COLUMNS),
  ...METERING_TARGETS,
  ...PROVIDER_PARENT_TARGETS,
  ...PRODUCT_DATABASE_TARGETS,
  ...FUNCTION_TARGETS,
  ...API_METADATA_TARGETS,
  ...CLOUDFLARE_TARGETS,
  ...MAIL_TARGETS,
  ...R2_STORAGE_TARGETS,
  ...MIGRATION_HISTORY_TARGETS,
  ...GENERIC_TARGETS,
  ...WFP_TARGETS,
  ...SECRET_TARGETS,
  ...STORAGE_TARGETS,
  ...ENTITLEMENT_TARGETS,
  ...PUBLIC_ENTRY_TARGETS,
  "org_directory",
  "organizations",
  "organization_memberships",
  "local_authorization_grants",
  "revocations",
  "pending_membership_barriers",
  "workos_membership_sync_barriers",
  "project_directory",
  "projects",
  "billing_epochs",
  "project_scope_history",
  "environments",
  "project_data_environments",
  "environment_data_assignments",
  "environment_secrets",
]);
const SOURCE_COLUMNS = Object.freeze({
  ...RATE_CARD_COLUMNS,
  ...ONBOARDING_COLUMNS,
  ...IDENTITY_KEY_COLUMNS,
  ...MCP_COLUMNS,
  ...SPINE_COLUMNS,
  ...BACKBONE_COLUMNS,
  ...BILLING_COLUMNS,
  ...BUILD_COLUMNS,
  ...METERING_COLUMNS,
  ...PROVIDER_PARENT_COLUMNS,
  ...PRODUCT_DATABASE_COLUMNS,
  ...FUNCTION_COLUMNS,
  ...API_METADATA_COLUMNS,
  ...CLOUDFLARE_COLUMNS,
  ...MAIL_COLUMNS,
  ...R2_STORAGE_COLUMNS,
  ...MIGRATION_HISTORY_COLUMNS,
  ...GENERIC_COLUMNS,
  ...WFP_COLUMNS,
  ...SECRET_COLUMNS,
  ...STORAGE_COLUMNS,
  ...ENTITLEMENT_COLUMNS,
  ...PUBLIC_ENTRY_COLUMNS,
  workos_organization_mappings:
    "organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at,beta_admitted_at",
  organization_memberships:
    "organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,revoked_at,trigger_event_id",
  local_authorization_grants:
    "organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,ownership_version,billing_epoch_id,created_at,revoked_at",
  workos_terminal_revocations:
    "kind,resource_id,workos_user_id,workos_organization_id,source_event_id,effective_at",
  workos_membership_sync_barriers:
    "workos_organization_id,workos_user_id,source_event_id,event_created_at,reconciled_at",
  projects:
    "project_id,created_organization_id,name,created_event_id,created_at,lifecycle_state,lifecycle_version,handle,handle_version,handle_attempt,data_mode,region,dev_access_mode",
  project_ownerships:
    "project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at",
  billing_epochs:
    "organization_id,billing_epoch_id,project_id,started_at,ended_at,created_by_principal_id",
  environments:
    "organization_id,environment_id,project_id,name,desired_state,active_deployment_id,active_revision_id,head_version,dev_access_epoch,created_at,updated_at",
  project_data_environments: "organization_id,project_id,data_environment_id,created_at",
  environment_data_assignments:
    "organization_id,environment_id,assignment_version,project_id,data_environment_id,assigned_at,operation_id",
  environment_secrets:
    "organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at",
});

const pick = (row, keys) =>
  Object.fromEntries(
    keys.map((key) => {
      if (!(key in row)) fail("SOURCE_COLUMN");
      return [key, row[key]];
    }),
  );
const bucket = (id) => createHash("sha256").update(id).digest().readUInt32BE(0) % 1024;

function identity(rows) {
  const records = [];
  const organizations = new Map(
    rows
      .get("workos_organization_mappings")
      .map((row) => [row.workos_organization_id, row.organization_id]),
  );
  for (const row of rows.get("workos_organization_mappings")) {
    records.push({
      table: "org_directory",
      row: {
        ...pick(row, ["organization_id", "workos_organization_id", "state", "updated_at"]),
        bucket: String(bucket(row.organization_id)),
        created_at: row.synchronized_at,
      },
    });
    records.push({
      table: "organizations",
      row: {
        ...row,
        bucket: String(bucket(row.organization_id)),
        created_at: row.synchronized_at,
        signup_source: null,
      },
    });
  }
  for (const table of ["organization_memberships", "local_authorization_grants"]) {
    for (const row of rows.get(table)) records.push({ table, row });
  }
  for (const row of rows.get("workos_terminal_revocations"))
    records.push({ table: "revocations", row: { ...row, purge_after: null } });
  for (const row of rows.get("workos_membership_sync_barriers")) {
    const organizationId = organizations.get(row.workos_organization_id);
    if (organizationId === undefined) {
      if (row.reconciled_at !== null) fail("BARRIER_ORPHAN");
      records.push({
        table: "pending_membership_barriers",
        row: pick(row, [
          "workos_organization_id",
          "workos_user_id",
          "source_event_id",
          "event_created_at",
        ]),
      });
    } else
      records.push({
        table: "workos_membership_sync_barriers",
        row: {
          ...pick(row, ["workos_user_id", "source_event_id", "event_created_at", "reconciled_at"]),
          organization_id: organizationId,
        },
      });
  }
  return records;
}

function projects(rows) {
  const records = [];
  const owners = new Map(rows.get("project_ownerships").map((row) => [row.project_id, row]));
  const transfers = rows.get("project_transfer_intents") ?? [];
  for (const project of rows.get("projects")) {
    const owner = owners.get(project.project_id);
    if (owner === undefined) fail("OWNER_MISSING");
    const retained = rows
      .get("billing_epochs")
      .filter((row) => row.project_id === project.project_id);
    const completed = transfers
      .filter((row) => row.project_id === project.project_id && row.state === "completed")
      .sort((a, b) =>
        BigInt(a.expected_ownership_version) < BigInt(b.expected_ownership_version)
          ? -1
          : BigInt(a.expected_ownership_version) > BigInt(b.expected_ownership_version)
            ? 1
            : 0,
      );
    const ordered = [];
    const exitByEpoch = new Map();
    for (const transfer of completed) {
      const evidence = (rows.get("audit_events") ?? [])
        .filter(
          (row) =>
            row.organization_id === transfer.source_organization_id &&
            row.project_id === project.project_id &&
            row.event_type === "ProjectOwnershipTransferred",
        )
        .filter((row) => JSON.parse(row.payload).transferId === transfer.transfer_id);
      const candidates = retained.filter(
        (epoch) =>
          epoch.organization_id === transfer.source_organization_id &&
          epoch.ended_at === transfer.completed_at &&
          !exitByEpoch.has(epoch.billing_epoch_id) &&
          (evidence.length === 0 ||
            evidence.some((row) => row.billing_epoch_id === epoch.billing_epoch_id)),
      );
      if (candidates.length !== 1) fail("HISTORY_EVIDENCE_REQUIRED");
      if (
        ordered.length > 0 &&
        completed[ordered.length - 1].target_organization_id !== transfer.source_organization_id
      )
        fail("HISTORY_EVIDENCE_REQUIRED");
      if (
        ordered.length > 0 &&
        BigInt(completed[ordered.length - 1].expected_ownership_version) >=
          BigInt(transfer.expected_ownership_version)
      )
        fail("HISTORY_EVIDENCE_REQUIRED");
      ordered.push(candidates[0]);
      exitByEpoch.set(candidates[0].billing_epoch_id, transfer);
    }
    const final = retained.find((row) => row.billing_epoch_id === owner.active_billing_epoch_id);
    if (
      final === undefined ||
      ordered.length + 1 !== retained.length ||
      exitByEpoch.has(final.billing_epoch_id)
    )
      fail("HISTORY_EVIDENCE_REQUIRED");
    const epochs = [...ordered, final];
    const current = epochs.find(
      (epoch) => epoch.billing_epoch_id === owner.active_billing_epoch_id,
    );
    if (
      current === undefined ||
      current.organization_id !== owner.organization_id ||
      current.ended_at !== null ||
      epochs.filter((epoch) => epoch.ended_at === null).length !== 1
    )
      fail("OWNERSHIP_INVARIANT");
    const scopes = new Map();
    const retired = [];
    for (const epoch of epochs) {
      let fact;
      if (epoch.ended_at === null)
        fact = { version: owner.ownership_version, at: owner.updated_at };
      else {
        const transfer = exitByEpoch.get(epoch.billing_epoch_id);
        if (transfer === undefined) fail("HISTORY_EVIDENCE_REQUIRED");
        const next = epochs[epochs.indexOf(epoch) + 1];
        if (
          next === undefined ||
          next.started_at !== epoch.ended_at ||
          next.organization_id !== transfer.target_organization_id
        )
          fail("HISTORY_EVIDENCE_REQUIRED");
        fact = { version: transfer.expected_ownership_version, at: transfer.completed_at };
      }
      const previous = scopes.get(epoch.organization_id);
      if (previous !== undefined)
        retired.push({
          ...previous,
          returned_at: epoch.started_at,
          returned_to_billing_epoch_id: epoch.billing_epoch_id,
        });
      scopes.set(epoch.organization_id, {
        organization_id: epoch.organization_id,
        project_id: project.project_id,
        ownership_version: fact.version,
        owner_state: epoch.ended_at === null ? owner.state : "transferred",
        active_billing_epoch_id: epoch.billing_epoch_id,
        lifecycle_state: project.lifecycle_state,
        lifecycle_version: project.lifecycle_version,
        scope_updated_at: fact.at,
      });
    }
    const scopeRows = [...scopes.values()].sort(
      (a, b) =>
        (a.owner_state === "transferred" ? 0 : 1) - (b.owner_state === "transferred" ? 0 : 1),
    );
    for (const scope of scopeRows) {
      const { scope_updated_at, ...storedScope } = scope;
      records.push({
        table: "projects",
        row: { ...project, ...storedScope, updated_at: scope_updated_at },
      });
    }
    // A final image is imported, not a reenactment of historic customer operations. The FK parents are inserted first.
    for (const epoch of epochs) records.push({ table: "billing_epochs", row: epoch });
    for (const history of retired) records.push({ table: "project_scope_history", row: history });
    records.push({
      table: "project_directory",
      row: {
        project_id: project.project_id,
        organization_id: owner.organization_id,
        handle: project.handle,
        state: project.lifecycle_state,
        reserved_until: null,
        created_at: project.created_at,
      },
    });
  }
  for (const table of ["environments", "project_data_environments"]) {
    const values =
      table === "project_data_environments"
        ? [...rows.get(table)].sort(
            (a, b) =>
              a.created_at.localeCompare(b.created_at) ||
              a.organization_id.localeCompare(b.organization_id),
          )
        : rows.get(table);
    for (const row of values) records.push({ table, row });
  }
  return records;
}

/** Byte-identical to sha256(canonical(plan)), streamed because a complete Control plan exceeds one string. */
function planDigest(plan) {
  const hash = createHash("sha256").update("{");
  Object.keys(plan)
    .sort()
    .forEach((key, index) => {
      hash.update(`${index === 0 ? "" : ","}${JSON.stringify(key)}:`);
      if (key !== "records") return hash.update(canonical(plan[key]));
      hash.update("[");
      plan.records.forEach((record, position) =>
        hash.update(`${position === 0 ? "" : ","}${canonical(record)}`),
      );
      return hash.update("]");
    });
  return hash.update("}").digest("hex");
}

/** A plan contains exact target records and source accounting; unsupported tables always remain blocking. */
export function buildPlan(capture, targetPin, expectedSource, options = {}) {
  if (canonical(capture.manifest.targetPin) !== canonical(targetPin)) fail("TARGET_PIN");
  if (
    expectedSource === undefined ||
    canonical(capture.manifest.source.expected) !== canonical(expectedSource)
  )
    fail("SOURCE_PIN");
  let records = [];
  const mapped = new Set();
  const gaps = [];
  const groups = [
    { name: "identity-v1", sources: IDENTITY_SOURCES, map: identity },
    { name: "projects-v1", sources: PROJECT_SOURCES, map: projects },
    {
      name: "original-migration-history-v1",
      sources: Object.keys(MIGRATION_HISTORY_COLUMNS),
      map: mapMigrationHistory,
      ifPresent: true,
    },
    {
      name: "original-principal-observations-v1",
      sources: ["principal_mappings"],
      map: mapPrincipalMappings,
      ifPresent: true,
    },
    {
      name: "original-global-inbox-v1",
      sources: ["webhook_inbox"],
      map: mapGlobalInbox,
      ifPresent: true,
    },
    {
      name: "secrets-v1",
      sources: ["environment_secrets"],
      map: (rows) =>
        rows.get("environment_secrets").map((row) => ({ table: "environment_secrets", row })),
    },
    {
      name: "canonical-rate-cards-v1",
      sources: Object.keys(RATE_CARD_COLUMNS),
      map: mapRateCards,
      ifPresent: true,
    },
    {
      name: "original-billing-facts-v1",
      sources: Object.keys(BILLING_COLUMNS),
      map: mapBilling,
      ifPresent: true,
      requires: ["workos_organization_mappings"],
    },
    {
      name: "canonical-onboarding-v1",
      sources: Object.keys(ONBOARDING_COLUMNS),
      map: mapOnboarding,
      ifPresent: true,
    },
    {
      name: "identity-key-metadata-v1",
      sources: Object.keys(IDENTITY_KEY_COLUMNS),
      map: mapIdentityKeys,
      ifPresent: true,
    },
    {
      name: "mcp-consent-facts-v1",
      sources: Object.keys(MCP_COLUMNS),
      map: mapMcp,
      ifPresent: true,
    },
    {
      name: "original-operation-spine-v1",
      sources: ["operations", "operation_events"],
      map: mapOperations,
      ifPresent: true,
    },
    {
      name: "original-api-metadata-v1",
      sources: API_METADATA_TARGETS,
      map: mapApiMetadata,
      ifPresent: true,
      requires: ["projects"],
    },
    {
      name: "original-build-facts-v1",
      sources: Object.keys(BUILD_COLUMNS),
      map: mapBuild,
      ifPresent: true,
      requires: ["operations", "environments", "billing_epochs"],
    },
    {
      name: "original-operation-delegations-v1",
      sources: ["operation_mcp_delegations"],
      map: mapOperationDelegations,
      ifPresent: true,
      requires: ["operations", "mcp_client_grants"],
    },
    {
      name: "completed-http-receipts-v1",
      sources: ["api_idempotency_records"],
      map: mapApiReceipts,
      ifPresent: true,
    },
    {
      name: "independent-audit-facts-v1",
      sources: ["audit_events", "organization_audit_events"],
      map: mapAuditFacts,
      ifPresent: true,
      requires: ["operations"],
    },
    {
      name: "original-assignment-history-v1",
      sources: ["environment_data_assignments"],
      ifPresent: true,
      map: (rows, manifest) => {
        if (
          !manifest.targetPin.migrations.some(
            (entry) =>
              entry.name === "0384_original_assignment_history.sql" &&
              entry.sha256 === "7920f81c829f8c94270d069d14953e6caed6cda9a3b297d14916982dc2df8d8c",
          )
        )
          fail("ASSIGNMENT_SCHEMA_PREREQUISITE");
        if (
          rows.get("environment_data_assignments").some((row) => row.operation_id !== null) &&
          !mapped.has("operations")
        )
          fail("ASSIGNMENT_OPERATION_PARENT_REQUIRED");
        return rows
          .get("environment_data_assignments")
          .map((row) => ({ table: "environment_data_assignments", row }));
      },
    },
    {
      name: "original-outbox-history-v1",
      sources: ["outbox_events", "delivery_attempts"],
      map: mapOutboxFacts,
      ifPresent: true,
      requires: ["operations"],
    },
    {
      name: "original-provider-parents-v1",
      sources: Object.keys(PROVIDER_PARENT_COLUMNS),
      map: mapProviderParents,
      ifPresent: true,
      requires: [
        "projects",
        "project_data_environments",
        "environments",
        "operations",
        "billing_epochs",
      ],
    },
    {
      name: "original-product-database-facts-v1",
      sources: Object.keys(PRODUCT_DATABASE_COLUMNS),
      map: mapProductDatabase,
      ifPresent: true,
      requires: [
        "projects",
        "environments",
        "operations",
        "billing_epochs",
        "database_provider_target_revisions",
      ],
    },
    {
      name: "original-source-build-facts-v1",
      sources: GENERIC_BEFORE_WFP,
      map: (rows, manifest) => mapGeneric(rows, manifest, GENERIC_BEFORE_WFP),
      ifPresent: true,
      requires: [
        "projects",
        "environments",
        "operations",
        "billing_epochs",
        "workos_organization_mappings",
        "webhook_inbox",
        "mcp_client_grants",
        "database_provider_target_revisions",
        "neon_project_placement_receipts",
      ],
    },
    {
      name: "original-wfp-facts-v1",
      sources: WFP_TARGETS,
      map: mapWfp,
      ifPresent: true,
      requires: ["projects", "environments", "operations", "build_artifacts", "deployment_plans"],
    },
    {
      name: "original-product-workflow-facts-v1",
      sources: GENERIC_AFTER_WFP,
      map: (rows, manifest) => mapGeneric(rows, manifest, GENERIC_AFTER_WFP),
      ifPresent: true,
      requires: [
        "projects",
        "environments",
        "operations",
        "billing_epochs",
        "outbox_events",
        "build_artifacts",
        "deployment_plans",
        "cleanup_runs",
        "repository_grants",
        "product_workflow_replay_attempts",
        "product_provider_reconciliation_attempts",
        "deployments",
        "deployment_revisions",
        "wfp_candidate_receipts",
        "wfp_candidate_cleanup_resource_expectations",
      ],
    },
    {
      name: "original-functions-schedules-v1",
      sources: FUNCTION_TARGETS,
      map: mapFunctionSchedules,
      ifPresent: true,
      requires: ["environments", "wfp_candidate_receipts"],
    },
    {
      name: "original-runtime-secret-facts-v1",
      // environment_secrets stays with the sealed secrets-v1 group above: one emission, never two.
      sources: SECRET_TARGETS.filter((name) => name !== "environment_secrets"),
      map: (rows, manifest) =>
        mapSecret(rows, manifest).filter((record) => record.table !== "environment_secrets"),
      ifPresent: true,
      requires: ["projects", "environments", "wfp_candidate_receipts"],
    },
    {
      name: "original-pgcf-entitlements-v1",
      sources: ENTITLEMENT_TARGETS,
      map: mapProductEntitlements,
      ifPresent: true,
      requires: ["projects", "operations", "billing_epochs"],
    },
    {
      name: "original-public-entry-facts-v1",
      sources: PUBLIC_ENTRY_TARGETS,
      map: mapPublicEntryFacts,
      ifPresent: true,
      requires: [...new Set(Object.values(PUBLIC_ENTRY_PARENTS).flat())].filter(
        (name) => !PUBLIC_ENTRY_TARGETS.includes(name),
      ),
    },
    {
      name: "original-metering-facts-v1",
      sources: Object.keys(METERING_COLUMNS),
      map: mapMetering,
      ifPresent: true,
      nonemptyParents: [
        { source: "project_database_compute_changes", parent: "neon_project_placement_receipts" },
      ],
      requires: [
        "workos_organization_mappings",
        "projects",
        "environments",
        "operations",
        "billing_epochs",
      ],
    },
    {
      name: "original-cloudflare-facts-v1",
      sources: Object.keys(CLOUDFLARE_COLUMNS),
      map: mapCloudflareFacts,
      ifPresent: true,
      requires: ["projects", "project_ownerships", "environments", "operations"],
    },
    {
      name: "original-dev-access-tickets-v1",
      sources: GENERIC_AFTER_CLOUDFLARE,
      map: (rows, manifest) => mapGeneric(rows, manifest, GENERIC_AFTER_CLOUDFLARE),
      ifPresent: true,
      requires: ["projects", "environments", "cloudflare_project_domains"],
    },
    {
      name: "original-mail-facts-v1",
      // AWS (Route 53, SES) history is an archive disposition, not a Core import.
      sources: Object.keys(MAIL_COLUMNS).filter((name) => !AWS_ARCHIVED_TABLES.includes(name)),
      map: (rows, manifest, capture) =>
        mapMail(rows, manifest, capture).filter(
          (record) => !AWS_ARCHIVED_TABLES.includes(record.table),
        ),
      ifPresent: true,
      requires: ["projects", "environments", "operations", "billing_epochs"],
    },
    {
      name: "original-r2-storage-facts-v1",
      sources: Object.keys(R2_STORAGE_COLUMNS),
      map: mapR2Storage,
      ifPresent: true,
      nonemptyParents: Object.entries(R2_STORAGE_PARENTS).flatMap(([source, parents]) =>
        parents
          .filter((parent) => !Object.hasOwn(R2_STORAGE_COLUMNS, parent))
          .map((parent) => ({ source, parent })),
      ),
    },
    {
      name: "original-storage-gateway-keys-v1",
      sources: STORAGE_TARGETS,
      map: mapStorage,
      ifPresent: true,
      requires: ["project_r2_bucket_receipts"],
    },
  ];
  for (const group of groups) {
    if (group.ifPresent && !group.sources.some((name) => capture.rows.has(name))) continue;
    if ((group.requires ?? []).some((name) => !mapped.has(name))) {
      gaps.push({ group: group.name, code: "PARENT_MAPPER_UNQUALIFIED" });
      continue;
    }
    const blockedParents = (group.nonemptyParents ?? []).filter(
      (entry) => (capture.rows.get(entry.source)?.length ?? 0) > 0 && !mapped.has(entry.parent),
    );
    if (blockedParents.length > 0) {
      gaps.push({
        group: group.name,
        code: "PARENT_MAPPER_UNQUALIFIED",
        tables: blockedParents.map((entry) => entry.parent),
      });
      continue;
    }
    const missing = group.sources.filter((name) => !capture.rows.has(name));
    if (missing.length > 0) {
      gaps.push({ group: group.name, code: "SOURCE_TABLE_REQUIRED", tables: missing });
      continue;
    }
    try {
      for (const name of group.sources) {
        const definition = capture.manifest.tables.find((table) => table.name === name);
        if (
          !definition ||
          canonical(definition.columns.map((column) => column.name).sort()) !==
            canonical(SOURCE_COLUMNS[name].split(",").sort())
        )
          fail("SOURCE_SCHEMA_UNMAPPED");
      }
      const converted = group.map(capture.rows, capture.manifest, capture);
      for (const record of converted) {
        if (!ALLOWED_TARGETS.has(record.table)) fail("MAPPER_TARGET");
        records.push(record);
      }
      for (const table of group.sources) mapped.add(table);
    } catch (error) {
      if (!/^CONTROL_D1_/u.test(error.message)) throw error;
      gaps.push({ group: group.name, code: error.message });
    }
  }
  const scopedHistory = CLOUDFLARE_CONTEXT_TABLES.filter(
    (name) => mapped.has(name) && (capture.rows.get(name)?.length ?? 0) > 0,
  );
  if (
    scopedHistory.length > 0 &&
    !targetPin.migrations.some(
      (entry) =>
        entry.name === CLOUDFLARE_CONTEXT_PIN.name &&
        entry.sha256 === CLOUDFLARE_CONTEXT_PIN.sha256,
    )
  ) {
    for (const name of scopedHistory) mapped.delete(name);
    gaps.push({
      group: "cloudflare-scoped-history",
      code: "CONTEXT_VERSION_UNQUALIFIED",
      tables: scopedHistory,
    });
  }
  const archived = configuredArchives(capture, options.archiveTables ?? []),
    droppedTables = new Set(archived.entries.map((entry) => entry.table));
  records = records.filter((record) => !droppedTables.has(record.table));
  for (const table of droppedTables) mapped.delete(table);
  gaps.push(...archived.gaps);
  const disposed = qualifyDispositions(capture, mapped);
  disposed.entries.push(...archived.entries);
  gaps.push(...disposed.gaps);
  const accounted = new Set(disposed.entries.map((entry) => entry.table));
  const unhandled = capture.manifest.tables
    .map((table) => table.name)
    .filter((name) => !mapped.has(name) && !accounted.has(name))
    .sort();
  // A source view is not a second copy of its rows; exact replacement readers qualify independently.
  const { readers: qualifiedViews, gaps: viewGaps } = qualifySourceViews(capture, mapped);
  gaps.push(...viewGaps);
  const unhandledViews = capture.manifest.views
    .filter(
      (view) =>
        !qualifiedViews.some((reader) => reader.sourceName === view.name) &&
        !REMOVED_SOURCE_VIEWS.includes(view.name),
    )
    .map((view) => view.name)
    .sort();
  const { restores: historyRestores, gaps: historySequenceGaps } = migrationHistorySequences(
    capture,
    [...mapped],
  );
  gaps.push(...historySequenceGaps);
  const { restores: publicEntryRestores, gaps: publicEntryGaps } = publicEntrySequences(capture, [
    ...mapped,
  ]);
  gaps.push(...publicEntryGaps);
  const sequenceRestores = [...historyRestores, ...publicEntryRestores];
  const unhandledSequences = capture.manifest.sequences
    .filter(
      (sequence) =>
        !sequenceRestores.some((restore) => restore.sourceName === sequence.name) &&
        !REMOVED_SOURCE_SEQUENCES.includes(sequence.name),
    )
    .map((sequence) => sequence.name)
    .sort();
  // A dropped table cannot own a restored allocator or feed a replacement view reader.
  for (const restore of sequenceRestores)
    if (droppedTables.has(restore.targetName) || droppedTables.has(restore.sourceName))
      gaps.push({
        group: "configured-archive",
        code: "CONTROL_D1_ARCHIVE_TABLE_OWNS_STATE",
        tables: [restore.sourceName],
      });
  for (const reader of qualifiedViews)
    if (reader.parents?.some((parent) => droppedTables.has(parent)))
      gaps.push({
        group: "configured-archive",
        code: "CONTROL_D1_ARCHIVE_TABLE_FEEDS_VIEW",
        tables: [reader.sourceName],
      });
  const runtimeGates = [];
  const plan = {
    format: "omh.control-d1.plan/v3",
    atomicProtocol: "contiguous-units-v1",
    captureId: capture.manifest.captureId,
    source: capture.manifest.source,
    manifestSha256: capture.manifestSha256,
    targetPin,
    qualificationOnly: true,
    mapped: [...mapped].sort(),
    unhandled,
    unhandledViews,
    qualifiedViews,
    unhandledSequences,
    dispositions: disposed.entries,
    runtimeGates,
    requiredTemporalTables: [
      ...(mapped.has("operations") ? ["operations"] : []),
      ...(mapped.has("environment_data_assignments") ? ["environment_data_assignments"] : []),
      // Historical publications, activations and cleanups predate today's live route/domain predicates (0334/0336).
      ...[
        "wfp_candidate_receipts",
        "wfp_candidate_cleanup_receipts",
        "wfp_publish_receipts",
        "wfp_rollback_activation_receipts",
        "runtime_secret_delivery_stage_activations",
      ].filter((name) => mapped.has(name)),
      ...scopedHistory,
      ...(mapped.has("project_mail_domain_bindings") ? ["project_mail_domain_bindings"] : []),
    ],
    sequenceRestores,
    gaps,
    records,
    provenance: {
      "organizations.created_at":
        "source workos_organization_mappings.synchronized_at; new storage metadata, not a claim of original signup time",
      "organizations.signup_source":
        "null; new optional metadata has no original field; original request/user attribution remains authority",
      "user_signup.attributionOnlyRecordedAt":
        "original attributed_at as required new envelope timestamp; origin_present0 means original origin remains absent",
      "mcp_handoff_routes.expires_at":
        "original handoff expires_at; new routing metadata introduces no retention cutoff",
      "operations.archive_key":
        "null; original source has no such field, no inferred archive or purge authorization",
      "outbox_events.last_attempt_status":
        "actual referenced original delivery attempt status, otherwise unknown/null; full historical attempts retained separately",
      "webhook_inbox.organization_id":
        "null; original inbox is global and has no organization column; runtime resolves provider subject under its existing authority",
      "control_source_migrations.run_on":
        "original timestamp WITHOUT time zone wall-clock components; Z is codec transport decoration only, with no UTC conversion or D1 allocator use",
      "projects.lifecycle":
        "original global projects row, shared by every retained scope; no invented old lifecycle",
      "projects.historicalOwnershipVersion":
        "completed project_transfer_intents.expected_ownership_version at exact closed-epoch boundary; refuse absent/ambiguous evidence",
      "revocations.purge_after": "null; no inferred or shortened retention",
    },
    verdict:
      unhandled.length === 0 &&
      unhandledViews.length === 0 &&
      gaps.length === 0 &&
      runtimeGates.length === 0 &&
      unhandledSequences.length === 0
        ? "MAPPED_QUALIFICATION_ONLY"
        : "INCOMPLETE",
  };
  return { ...plan, digest: planDigest(plan) };
}
