import { z } from "zod";
import type { CatalogContext } from "../common.js";
import { instant, ulid } from "../common.js";
import { CLAIM_SQL, currentDataEnvironment, claimParams } from "./authority.js";
import {
  DatabaseProviderConflictError,
  parseRegistration,
  isPgcf,
  claimInput,
} from "./contracts.js";
import { resolveScopeInput } from "./provider-contracts.js";
import { readAccount } from "../credit/index.js";

const resolveClaimInput = resolveScopeInput.extend({ operationId: ulid, claimId: ulid });
/** One primary snapshot resolves the physical scope, current owner/open epoch, accepted claim and actual region. */
export async function resolveDatabaseManagementClaim(context: CatalogContext, raw: unknown) {
  const input = resolveClaimInput.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const row = await db
    .prepare(
      `SELECT scope.physical_environment_id,scope.region FROM(
 SELECT ${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")} physical_environment_id,p.region FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
 WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3 AND e.name IN('dev','prod') AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')) scope
 WHERE EXISTS(${CLAIM_SQL.replaceAll("?3", "scope.physical_environment_id")})`,
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.operationId,
      input.claimId,
    )
    .first<{ physical_environment_id: string; region: string }>();
  if (row === null || (row.region !== "us" && row.region !== "eu"))
    throw new DatabaseProviderConflictError();
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    physicalEnvironmentId: row.physical_environment_id,
    operationId: input.operationId,
    claimId: input.claimId,
    regionId: row.region === "us" ? ("us-dev" as const) : ("eu-dev" as const),
  };
}
const placementPaidInput = z.strictObject({ ...claimInput, now: instant });
/** The Paid coverage of the organization under the current accepted mutation authority; no money is changed. */
export async function readDatabasePlacementPaidAccess(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = placementPaidInput.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const claim = await db
    .prepare(CLAIM_SQL)
    .bind(...claimParams(input))
    .all();
  if (claim.results.length !== 1) throw new DatabaseProviderConflictError();
  return (await readAccount(db, input.organizationId, input.now)).paid;
}
/** The original runtime-binding read transaction: actual current mapping, active PGCF target and matching latest receipt. */
export async function readDatabaseManagementRuntimeBinding(context: CatalogContext, raw: unknown) {
  const input = resolveScopeInput.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const physical = currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id");
  const row = await db
    .prepare(
      `SELECT target.provider,target.provider_project_id,target.database_id,target.runtime_role,
   (SELECT metadata FROM project_database_registration_receipts registration WHERE registration.organization_id=e.organization_id AND registration.project_id=e.project_id AND registration.physical_environment_id=${physical} ORDER BY registration_version DESC LIMIT 1) metadata
   FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
   LEFT JOIN database_provider_target_heads head ON head.organization_id=e.organization_id AND head.project_id=e.project_id AND head.physical_environment_id=${physical} AND head.state='active'
   LEFT JOIN database_provider_target_revisions target ON target.organization_id=head.organization_id AND target.project_id=head.project_id AND target.physical_environment_id=head.physical_environment_id AND target.target_version=head.target_version
   WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3 AND e.name IN('dev','prod') AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')`,
    )
    .bind(input.organizationId, input.projectId, input.environmentId)
    .first<{
      provider: string | null;
      provider_project_id: string | null;
      database_id: string | null;
      runtime_role: string | null;
      metadata: string | null;
    }>();
  if (row === null) throw new DatabaseProviderConflictError();
  if (row.provider !== "pgcf" || row.metadata === null) return null;
  const registered = parseRegistration(row.metadata);
  return isPgcf(registered) &&
    registered.providerProjectId === row.provider_project_id &&
    registered.databaseId === row.database_id &&
    registered.originUser === row.runtime_role
    ? registered
    : null;
}
