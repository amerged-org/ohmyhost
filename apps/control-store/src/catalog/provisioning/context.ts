import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import { type CatalogContext, routeOrganization, ulid } from "../common.js";
import { pgcfRegistration, type AnyRegistration } from "../database/contracts.js";

const targetScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  physicalEnvironmentId: ulid,
});
const legacyRegistration = z
  .strictObject({
    operationId: ulid,
    organizationId: ulid,
    projectId: ulid,
    physicalEnvironmentId: ulid,
    registrationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    region: z.enum(["us", "eu"]),
    providerProjectId: z.string().regex(/^[a-z0-9-]{1,60}$/u),
    branchId: z.string().regex(/^[a-z0-9-]{1,60}$/u),
    originHost: z
      .string()
      .regex(
        /^ep-[a-z0-9-]+-pooler\.(?:c-[0-9]+\.)?(?:us-east-[12]|eu-central-1)\.aws\.neon\.tech$/u,
      ),
    originDatabase: z.literal("neondb"),
    originUser: z.string(),
    authorizedEnvironmentIds: z.array(ulid).min(1).max(2),
    status: z.enum(["active", "revoked"]),
  })
  .refine(
    (value) => (value.region === "eu") === value.originHost.endsWith(".eu-central-1.aws.neon.tech"),
  );

export class ProductWorkflowContextConflictError extends Error {
  readonly code = "deployment_persistence_conflict";
  constructor(message: string) {
    super(message);
    this.name = "DeploymentPersistenceConflictError";
  }
}

export function parseWorkflowDatabaseRegistration(text: string): AnyRegistration {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProductWorkflowContextConflictError(
      "Workflow database registration target conflicts",
    );
  }
  const parsed = z.union([pgcfRegistration, legacyRegistration]).safeParse(raw);
  if (!parsed.success)
    throw new ProductWorkflowContextConflictError(
      "Workflow database registration target conflicts",
    );
  const value = parsed.data;
  if (
    ("provider" in value && value.originDatabase !== value.databaseId) ||
    value.originUser !== `ohmyho_rw_${value.physicalEnvironmentId.toLowerCase()}` ||
    new Set(value.authorizedEnvironmentIds).size !== value.authorizedEnvironmentIds.length
  )
    throw new ProductWorkflowContextConflictError(
      "Workflow database registration target conflicts",
    );
  return value;
}

export const WORKFLOW_TARGET = `SELECT revision.provider,revision.provider_project_id,revision.branch_id,revision.database_id,
 CAST(head.target_version AS TEXT) target_version,head.state
 FROM database_provider_target_heads head
 JOIN database_provider_target_revisions revision USING(organization_id,project_id,physical_environment_id,target_version)
 JOIN projects ownership ON ownership.organization_id=head.organization_id AND ownership.project_id=head.project_id AND ownership.owner_state='active'
 WHERE head.organization_id=?1 AND head.project_id=?2 AND head.physical_environment_id=?3`;
export const WORKFLOW_REGISTRATION = `SELECT metadata,claim_id,observed_at FROM(
 SELECT metadata,claim_id,observed_at,registration_version FROM project_database_registration_receipts
 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3
 UNION ALL
 SELECT metadata,claim_id,NULL,registration_version FROM project_database_registration_reservations
 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3
 ) registration ORDER BY registration_version DESC,observed_at DESC NULLS LAST LIMIT 1`;
export const WORKFLOW_PLACEMENT = `SELECT receipt.* FROM neon_project_placement_receipts receipt
 JOIN projects ownership ON ownership.organization_id=receipt.organization_id AND ownership.project_id=receipt.project_id AND ownership.owner_state='active'
 WHERE receipt.organization_id=?1 AND receipt.project_id=?2 AND receipt.environment_id=?3`;
interface TargetRow {
  provider: "neon" | "pgcf";
  provider_project_id: string;
  branch_id: string | null;
  database_id: string | null;
  target_version: string;
  state: "active" | "retired";
}
interface RegistrationRow {
  metadata: string;
  claim_id: string;
  observed_at: string | null;
}
interface PlacementRow {
  organization_id: string;
  project_id: string;
  environment_id: string;
  operation_id: string;
  claim_id: string;
  project_name: string;
  region_id: string;
  postgres_version: 14 | 15 | 16 | 17 | 18;
  provider_project_id: string;
  default_branch_id: string;
  operation_ids: string;
  state: "ready";
  observed_at: string;
}

/** Original readProductWorkflowDatabaseTarget: one snapshot, current ownership, exact retired head and latest receipt/reservation.
 * Historical Neon metadata is returned as evidence only; this reader has no provider/SQL transport capability. */
export async function readProductWorkflowDatabaseTarget(context: CatalogContext, raw: unknown) {
  const scope = targetScope.parse(raw),
    { db } = await routeOrganization(context, scope.organizationId);
  const parameters = [scope.organizationId, scope.projectId, scope.physicalEnvironmentId];
  const [targets, registrations, placements] = await db.batch([
    db.prepare(WORKFLOW_TARGET).bind(...parameters),
    db.prepare(WORKFLOW_REGISTRATION).bind(...parameters),
    db.prepare(WORKFLOW_PLACEMENT).bind(...parameters),
  ]);
  const row = targets?.results[0] as unknown as TargetRow | undefined;
  const recorded = registrations?.results[0] as unknown as RegistrationRow | undefined;
  return workflowDatabaseTargetFromRows(
    scope,
    row,
    recorded,
    placements?.results[0] as unknown as PlacementRow | undefined,
  );
}

/** Shared pure conversion for the single-target and full-context atomic readers. */
export function workflowDatabaseTargetFromRows(
  scope: { organizationId: string; projectId: string; physicalEnvironmentId: string },
  row: TargetRow | undefined,
  recorded: RegistrationRow | undefined,
  placement: PlacementRow | undefined,
) {
  const target =
    row === undefined
      ? null
      : {
          ...scope,
          providerProjectId: row.provider_project_id,
          targetVersion: Number(row.target_version),
          state: row.state,
          ...(row.provider === "pgcf"
            ? { provider: "pgcf" as const, databaseId: row.database_id ?? "" }
            : { provider: "neon" as const, branchId: row.branch_id ?? "" }),
        };
  if (
    target !== null &&
    (!Number.isSafeInteger(target.targetVersion) ||
      target.targetVersion < 1 ||
      (target.provider === "pgcf" ? !target.databaseId : !target.branchId))
  )
    throw new ProductWorkflowContextConflictError("Workflow database target is invalid");
  const registered =
    recorded === undefined ? null : parseWorkflowDatabaseRegistration(recorded.metadata);
  if (
    registered !== null &&
    (target === null ||
      registered.organizationId !== scope.organizationId ||
      registered.projectId !== scope.projectId ||
      registered.physicalEnvironmentId !== scope.physicalEnvironmentId ||
      registered.providerProjectId !== target.providerProjectId ||
      (target.provider === "pgcf"
        ? !("provider" in registered) ||
          registered.provider !== "pgcf" ||
          registered.databaseId !== target.databaseId
        : "provider" in registered || registered.branchId !== target.branchId))
  )
    throw new ProductWorkflowContextConflictError(
      "Workflow database registration target conflicts",
    );
  return {
    dataEnvironmentId: parseUlid(scope.physicalEnvironmentId),
    providerTarget: target,
    neonPlacement:
      target?.provider !== "neon" || placement === undefined
        ? null
        : Object.freeze({
            organizationId: parseUlid(placement.organization_id),
            projectId: parseUlid(placement.project_id),
            environmentId: parseUlid(placement.environment_id),
            operationId: parseUlid(placement.operation_id),
            claimId: parseUlid(placement.claim_id),
            projectName: placement.project_name,
            regionId: placement.region_id,
            postgresVersion: placement.postgres_version,
            providerProjectId: placement.provider_project_id,
            defaultBranchId: placement.default_branch_id,
            operationIds: Object.freeze(JSON.parse(placement.operation_ids) as string[]),
            state: placement.state,
            observedAt: new Date(placement.observed_at),
          }),
    databaseRegistration:
      registered === null || recorded === undefined
        ? null
        : {
            ...registered,
            claimId: recorded.claim_id,
            observedAt: recorded.observed_at === null ? null : new Date(recorded.observed_at),
            ...(recorded.observed_at === null ? { pending: true } : {}),
          },
  };
}

export { readProductWorkflowContext } from "./context-reader.js";
export type { ProductWorkflowWireContext } from "./context-reader.js";
