import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import { routeOrganization, rowsOf, ulid, type CatalogContext } from "../common.js";

const exactScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  deploymentId: ulid,
});
const deletionScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  cleanupRunId: ulid,
});
const retirementScope = exactScope.extend({ operationId: ulid, cleanupRunId: ulid });
const listInput = deletionScope.extend({
  cursor: ulid.optional(),
  limit: z.number().int().min(1).max(100),
});
export type NextCacheRegion = "us" | "eu";

// A deployment is eligible only while its own accepted provider mutation has the live claim. A rollback reuses the
// target deployment's cache rather than the rollback operation's new identity.
const REGISTRATION_AUTHORITY = `SELECT project.region FROM projects project
 JOIN organizations organization ON organization.organization_id=project.organization_id AND organization.state='active'
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 JOIN environments environment ON environment.organization_id=project.organization_id AND environment.project_id=project.project_id AND environment.environment_id=?3
 JOIN deployments deployment ON deployment.organization_id=environment.organization_id AND deployment.project_id=environment.project_id AND deployment.environment_id=environment.environment_id AND deployment.deployment_id=?4
 JOIN product_provider_mutation_claims claim ON claim.organization_id=project.organization_id AND claim.project_id=project.project_id AND claim.environment_id=environment.environment_id AND claim.billing_epoch_id=project.active_billing_epoch_id
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id AND operation.state IN('queued','running')
 JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id AND intent.environment_id=claim.environment_id AND intent.operation_id=claim.operation_id AND intent.event_type=claim.event_type
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND project.lifecycle_state='active' AND project.lifecycle_version=claim.accepted_lifecycle_version
 AND ((intent.event_type IN('DeploymentRequestedV1','DeploymentPromotionRequestedV1') AND intent.deployment_id=deployment.deployment_id)
   OR (intent.event_type='DeploymentRollbackRequestedV1' AND intent.target_deployment_id=deployment.deployment_id))`;

/** Before a candidate can run, record its exact cache scope and the original region in the same authorized batch. */
export async function registerNextCacheScope(
  context: CatalogContext,
  raw: unknown,
): Promise<{ readonly region: NextCacheRegion } | null> {
  const input = exactScope.parse(raw);
  const { db } = await routeOrganization(context, input.organizationId);
  const values = [input.organizationId, input.projectId, input.environmentId, input.deploymentId];
  const command: Command<
    { region: NextCacheRegion | null; registered: NextCacheRegion | null },
    { readonly region: NextCacheRegion } | null
  > = {
    name: "runtimeSecrets.registerNextCacheScope",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["next_cache_scopes"],
    read: async (reader) => {
      const [authority, stored] = await reader.batch([
        reader.prepare(REGISTRATION_AUTHORITY).bind(...values),
        reader
          .prepare(
            "SELECT region FROM next_cache_scopes WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND deployment_id=?4",
          )
          .bind(...values),
      ]);
      return {
        region: rowsOf<{ region: NextCacheRegion }>(authority)[0]?.region ?? null,
        registered: rowsOf<{ region: NextCacheRegion }>(stored)[0]?.region ?? null,
      };
    },
    decide: ({ region, registered }) => {
      if (region === null) return { replay: null };
      if (registered !== null) return { replay: { region: registered } };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM (${REGISTRATION_AUTHORITY}) authorized WHERE authorized.region=?5)`,
            [...values, region],
          ),
          db
            .prepare(
              "INSERT INTO next_cache_scopes(organization_id,project_id,environment_id,deployment_id,region,created_at) VALUES(?1,?2,?3,?4,?5,strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",
            )
            .bind(...values, region),
        ],
        result: () => ({ region }),
      };
    },
  };
  return runCommand(db, command);
}

// Deletion is irreversible in Core; this evidence is retained only after the gateway tombstone has been observed.
const DELETION_AUTHORITY = `SELECT 1 FROM projects project
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 JOIN product_command_intents intent ON intent.organization_id=project.organization_id AND intent.project_id=project.project_id AND intent.billing_epoch_id=epoch.billing_epoch_id AND intent.operation_id=?3 AND intent.event_type='ProjectDeletionRequestedV1' AND intent.cleanup_run_id=?4
 JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id AND operation.state='running'
 JOIN cleanup_runs cleanup ON cleanup.organization_id=intent.organization_id AND cleanup.project_id=intent.project_id AND cleanup.operation_id=intent.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id AND cleanup.state='running'
 JOIN product_workflow_runs run ON run.organization_id=intent.organization_id AND run.project_id=intent.project_id AND run.operation_id=intent.operation_id AND run.event_type=intent.event_type AND run.state='queued'
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND project.lifecycle_state='deleting'
 AND json_valid(run.intermediate_evidence) AND length(json_extract(run.intermediate_evidence,'$.tombstoneReceiptId'))>0`;

/** A project deletion may enumerate only its registered cache scopes after retaining the gateway tombstone. */
export async function listNextCacheRetirementScopes(context: CatalogContext, raw: unknown) {
  const input = listInput.parse(raw);
  const { db } = await routeOrganization(context, input.organizationId);
  const [authority, page] = await db.batch([
    db
      .prepare(DELETION_AUTHORITY)
      .bind(input.organizationId, input.projectId, input.operationId, input.cleanupRunId),
    db
      .prepare(
        `SELECT scope.environment_id,scope.deployment_id FROM next_cache_scopes scope
      WHERE scope.organization_id=?1 AND scope.project_id=?2 AND (?3 IS NULL OR scope.deployment_id>?3)
      AND NOT EXISTS(SELECT 1 FROM next_cache_retirements retired WHERE retired.organization_id=scope.organization_id AND retired.project_id=scope.project_id AND retired.environment_id=scope.environment_id AND retired.deployment_id=scope.deployment_id)
      ORDER BY scope.deployment_id LIMIT ?4`,
      )
      .bind(input.organizationId, input.projectId, input.cursor ?? null, input.limit + 1),
  ]);
  if (rowsOf(authority).length !== 1) return null;
  const rows = rowsOf<{ environment_id: string; deployment_id: string }>(page);
  const selected = rows.slice(0, input.limit);
  return {
    scopes: selected.map((row) => ({
      environmentId: row.environment_id,
      deploymentId: row.deployment_id,
    })),
    nextCursor: rows.length > input.limit ? (selected.at(-1)?.deployment_id ?? null) : null,
  };
}

/** Private retirement authority proves irreversible deletion and returns the region pinned at first registration. */
export async function authorizeNextCacheRetirement(
  context: CatalogContext,
  raw: unknown,
): Promise<{ readonly region: NextCacheRegion } | null> {
  const input = retirementScope.parse(raw);
  const { db } = await routeOrganization(context, input.organizationId);
  const values = [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.deploymentId,
    input.operationId,
    input.cleanupRunId,
  ];
  const authorized = `SELECT scope.region FROM next_cache_scopes scope WHERE scope.organization_id=?1 AND scope.project_id=?2 AND scope.environment_id=?3 AND scope.deployment_id=?4 AND EXISTS(${DELETION_AUTHORITY.replaceAll("?3", "?5").replaceAll("?4", "?6")})`;
  const command: Command<
    { region: NextCacheRegion | null; fenced: boolean },
    { readonly region: NextCacheRegion } | null
  > = {
    name: "runtimeSecrets.authorizeNextCacheRetirement",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["next_cache_deletion_fences"],
    read: async (reader) => {
      const [scope, fence] = await reader.batch([
        reader.prepare(authorized).bind(...values),
        reader
          .prepare(
            "SELECT 1 FROM next_cache_deletion_fences WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(input.organizationId, input.projectId),
      ]);
      return {
        region: rowsOf<{ region: NextCacheRegion }>(scope)[0]?.region ?? null,
        fenced: rowsOf(fence).length === 1,
      };
    },
    decide: ({ region, fenced }) => {
      if (region === null) return { replay: null };
      if (fenced) return { replay: { region } };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM (${authorized}) WHERE region=?7)`,
            [...values, region],
          ),
          db
            .prepare(
              "INSERT INTO next_cache_deletion_fences(organization_id,project_id,operation_id,cleanup_run_id,fenced_at) VALUES(?1,?2,?5,?6,strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",
            )
            .bind(...values),
        ],
        result: () => ({ region }),
      };
    },
  };
  return runCommand(db, command);
}

/** Record confirmed service retirement under the same irreversible deletion authority, making retries advance. */
export async function recordNextCacheRetired(
  context: CatalogContext,
  raw: unknown,
): Promise<"recorded" | "existing" | null> {
  const input = retirementScope.parse(raw);
  const { db } = await routeOrganization(context, input.organizationId);
  const values = [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.deploymentId,
    input.operationId,
    input.cleanupRunId,
  ];
  const authoritySql = `EXISTS(${DELETION_AUTHORITY.replaceAll("?3", "?5").replaceAll("?4", "?6")}) AND EXISTS(SELECT 1 FROM next_cache_scopes WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND deployment_id=?4) AND EXISTS(SELECT 1 FROM next_cache_deletion_fences WHERE organization_id=?1 AND project_id=?2)`;
  const command: Command<
    { authorized: boolean; existing: boolean },
    "recorded" | "existing" | null
  > = {
    name: "runtimeSecrets.recordNextCacheRetired",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["next_cache_retirements"],
    read: async (reader) => {
      const [authority, existing] = await reader.batch([
        reader.prepare(`SELECT 1 WHERE ${authoritySql}`).bind(...values),
        reader
          .prepare(
            "SELECT 1 FROM next_cache_retirements WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND deployment_id=?4",
          )
          .bind(...values.slice(0, 4)),
      ]);
      return {
        authorized: rowsOf(authority).length === 1,
        existing: rowsOf(existing).length === 1,
      };
    },
    decide: ({ authorized, existing }) => {
      if (!authorized) return { replay: null };
      if (existing) return { replay: "existing" };
      return {
        statements: [
          guard(db, "precondition_changed", `NOT (${authoritySql})`, values),
          db
            .prepare(
              "INSERT INTO next_cache_retirements(organization_id,project_id,environment_id,deployment_id,operation_id,cleanup_run_id,retired_at) VALUES(?1,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')",
            )
            .bind(...values),
        ],
        result: () => "recorded",
      };
    },
  };
  return runCommand(db, command);
}
