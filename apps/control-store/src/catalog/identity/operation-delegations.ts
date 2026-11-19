import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";

import { conflict, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { activeGrantSelect, isUserRevoked } from "./mcp-sql.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "./authorization-restriction.js";
import { authorizeOrganizationAction } from "../projects/customer-projects-access.js";
import type { AuthorizationAction } from "@ohmyhost/platform";

export const assertOperationDelegationCurrentInput = z.strictObject({
  organizationId: ulid,
  operationId: ulid,
});

interface DelegationRow {
  readonly grant_id: string;
  readonly client_id: string;
  readonly consent_hash: string;
  readonly principal_id: string;
  readonly project_id: string;
  readonly requires_publication: number;
  readonly authorization_action: string | null;
  readonly authorization_restriction: string | null;
  readonly event_type: string;
}

const eventActions: Record<string, AuthorizationAction> = {
  ProjectProvisioningRequested: "projects:create",
  ProjectRecoveryRequestedV1: "projects:write",
  ProjectDatabaseComputeChangeRequestedV1: "projects:write",
  DeploymentRequestedV1: "deployments:create",
  DeploymentPromotionRequestedV1: "projects:promote",
  DeploymentRollbackRequestedV1: "projects:rollback",
  SourceLinkRequestedV1: "sources:link",
  ProjectHandleChangeRequestedV1: "projects:write",
  ProjectDataChangeRequestedV1: "projects:delete",
  ProjectDeletionRequestedV1: "projects:delete",
};
export function operationAction(eventType: string): AuthorizationAction | undefined {
  return eventActions[eventType];
}
export function restrictionAllows(
  raw: unknown,
  scope: {
    action: AuthorizationAction;
    organizationId: string;
    projectId?: string;
    mailDomainId?: string;
  },
): boolean {
  if (raw === undefined || raw === null) return true;
  const parsed = authorizationRestrictionInput.safeParse(raw);
  if (!parsed.success) return false;
  const cap = parsed.data;
  const projectBound =
    scope.projectId !== undefined
      ? cap.projectIds === undefined || cap.projectIds.includes(scope.projectId)
      : !(
          cap.projectIds !== undefined &&
          (scope.action === "projects:create" ||
            scope.action === "sources:link" ||
            scope.action === "integrations:read" ||
            scope.action === "integrations:manage")
        );
  const mailBound =
    scope.mailDomainId !== undefined
      ? cap.mailDomainIds === undefined || cap.mailDomainIds.includes(scope.mailDomainId)
      : !(cap.mailDomainIds !== undefined && scope.action === "mail-domains:admin");
  return (
    (cap.actions === undefined || cap.actions.includes(scope.action)) &&
    (cap.organizationIds === undefined || cap.organizationIds.includes(scope.organizationId)) &&
    projectBound &&
    mailBound
  );
}
export function proofAction(
  eventType: string,
  action: string | null,
): AuthorizationAction | undefined {
  const expected = operationAction(eventType);
  if (action === null) return expected;
  const parsed = delegationActionInput.safeParse(action);
  return parsed.success && parsed.data === expected ? parsed.data : undefined;
}
export function parseProofRestriction(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
}

/**
 * A plain deployment pinned to the source selection it was planned against (no binding refresh snapshot): the
 * project's binding must still be the pinned connection at the pinned generation, and that connection must still
 * hold an unrevoked repository grant of the operation's billing epoch. A replaced, relinked, revoked or
 * re-owned source makes the queued operation stale.
 */
const STALE_PINNED_SOURCE = `SELECT 1 AS stale FROM product_command_intents intent
  LEFT JOIN project_source_bindings binding ON binding.organization_id = intent.organization_id AND binding.project_id = intent.project_id
  WHERE intent.organization_id = ?1 AND intent.operation_id = ?2 AND intent.event_type = 'DeploymentRequestedV1'
    AND intent.binding_refresh_snapshot IS NULL
    AND (binding.source_connection_id IS NOT intent.source_connection_id
      OR binding.generation IS NOT intent.source_generation
      OR NOT EXISTS (SELECT 1 FROM repository_grants grant_record
        WHERE grant_record.organization_id = intent.organization_id AND grant_record.project_id = intent.project_id
          AND grant_record.source_connection_id = intent.source_connection_id
          AND grant_record.billing_epoch_id = intent.billing_epoch_id
          AND NOT EXISTS (SELECT 1 FROM repository_grant_revocations revoked
            WHERE revoked.organization_id = grant_record.organization_id AND revoked.grant_id = grant_record.grant_id)))`;

/**
 * Promotions, rollbacks and refresh-snapshot deployments pin only the source generation (0 when the project has
 * no binding): any later source change invalidates them.
 */
const STALE_PINNED_GENERATION = `SELECT 1 AS stale FROM product_command_intents intent
  WHERE intent.organization_id = ?1 AND intent.operation_id = ?2
    AND (intent.event_type IN ('DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1')
      OR (intent.event_type = 'DeploymentRequestedV1' AND intent.binding_refresh_snapshot IS NOT NULL))
    AND intent.source_generation IS NOT COALESCE((SELECT generation FROM project_source_bindings binding
      WHERE binding.organization_id = intent.organization_id AND binding.project_id = intent.project_id), 0)`;

/**
 * `assertOperationExecutionAuthorized`: every provider write and activation rechecks the consent an operation was
 * queued under (the delegation evidence row must still match an effective grant; an operation without delegation
 * passes that part) and the pinned source selection (see the two stale predicates). The source part applies to
 * every operation, delegated or not, exactly as in PostgreSQL. All reads come from one consistent snapshot.
 */
export async function assertOperationDelegationCurrent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<void> {
  const input = assertOperationDelegationCurrentInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const bound = (sql: string) =>
    shard.db.prepare(sql).bind(input.organizationId, input.operationId);
  const [delegationRows, pinnedSource, pinnedGeneration] = await shard.db.batch([
    bound(
      "SELECT grant_id, client_id, consent_hash, principal_id, project_id, requires_publication, authorization_action, authorization_restriction, event_type FROM operation_mcp_delegations WHERE organization_id = ?1 AND operation_id = ?2",
    ),
    bound(STALE_PINNED_SOURCE),
    bound(STALE_PINNED_GENERATION),
  ]);
  const changed = () => {
    const error = conflict(
      "operation_authorization_changed",
      "Queued operation authorization or source generation changed",
    );
    error.name = "OperationAuthorizationConflictError";
    return error;
  };
  const delegation = (delegationRows?.results ?? [])[0] as DelegationRow | undefined;
  if (delegation !== undefined) {
    const userId = delegation.principal_id.slice(5);
    const grant = await activeGrantSelect(
      shard.db,
      {
        organizationId: input.organizationId,
        userId,
        clientId: delegation.client_id,
        consentHash: delegation.consent_hash,
      },
      delegation.event_type === "ProjectProvisioningRequested" ? null : delegation.project_id,
      delegation.requires_publication === 1,
    ).first<{ grant_id: string }>();
    const action = proofAction(delegation.event_type, delegation.authorization_action);
    if (
      action === undefined ||
      !restrictionAllows(parseProofRestriction(delegation.authorization_restriction), {
        action,
        organizationId: input.organizationId,
        ...(delegation.event_type === "ProjectProvisioningRequested"
          ? {}
          : { projectId: delegation.project_id }),
      }) ||
      (await authorizeOrganizationAction(context, {
        organizationId: input.organizationId,
        principalId: delegation.principal_id,
        ...(delegation.event_type === "ProjectProvisioningRequested"
          ? {}
          : { projectId: delegation.project_id }),
        action,
      })) !== "allow"
    )
      throw changed();
    if (
      grant?.grant_id !== delegation.grant_id ||
      (await isUserRevoked(context.directory, userId))
    ) {
      throw changed();
    }
  }
  if ((pinnedSource?.results ?? []).length > 0 || (pinnedGeneration?.results ?? []).length > 0) {
    throw changed();
  }
}

/** The same original source-selection predicates, rechecked inside a mutating command's batch. */
export function pinnedOperationSourceGuards(
  db: D1Database,
  input: { organizationId: string; operationId: string },
) {
  return [
    guard(db, "source_head_conflict", `EXISTS (${STALE_PINNED_SOURCE})`, [
      input.organizationId,
      input.operationId,
    ]),
    guard(db, "source_head_conflict", `EXISTS (${STALE_PINNED_GENERATION})`, [
      input.organizationId,
      input.operationId,
    ]),
  ];
}
