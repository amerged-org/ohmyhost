import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { activeGrantGuard } from "../identity/mcp-sql.js";
import {
  pinnedOperationSourceGuards,
  proofAction,
  restrictionAllows,
  parseProofRestriction,
} from "../identity/operation-delegations.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";

export interface WorkflowDelegationProof {
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
export async function readWorkflowDelegation(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string },
): Promise<WorkflowDelegationProof | null> {
  return db
    .prepare(
      `SELECT grant_id,client_id,consent_hash,principal_id,project_id,requires_publication,authorization_action,authorization_restriction,event_type FROM operation_mcp_delegations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
    )
    .bind(scope.organizationId, scope.projectId, scope.operationId)
    .first<WorkflowDelegationProof>();
}
/** Immutable acceptance consent, current grant/user authority and original source generation share the effect's commit. */
export function workflowExecutionGuards(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string },
  proof: WorkflowDelegationProof | null,
): D1PreparedStatement[] {
  const values = [scope.organizationId, scope.projectId, scope.operationId];
  const action =
    proof === null ? undefined : proofAction(proof.event_type, proof.authorization_action);
  const capAllowed =
    proof !== null &&
    action !== undefined &&
    restrictionAllows(parseProofRestriction(proof.authorization_restriction), {
      action,
      organizationId: scope.organizationId,
      ...(proof.event_type === "ProjectProvisioningRequested"
        ? {}
        : { projectId: scope.projectId }),
    });
  const statements =
    proof === null
      ? [
          guard(
            db,
            "consent_changed",
            `EXISTS(SELECT 1 FROM operation_mcp_delegations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3)`,
            values,
          ),
        ]
      : [
          guard(
            db,
            "consent_changed",
            `NOT EXISTS(SELECT 1 FROM operation_mcp_delegations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND grant_id=?4 AND client_id=?5 AND consent_hash=?6 AND principal_id=?7 AND requires_publication=?8 AND authorization_action IS ?9 AND authorization_restriction IS ?10 AND event_type=?11)`,
            [
              ...values,
              proof.grant_id,
              proof.client_id,
              proof.consent_hash,
              proof.principal_id,
              proof.requires_publication,
              proof.authorization_action,
              proof.authorization_restriction,
              proof.event_type,
            ],
          ),
          ...(capAllowed && action !== undefined
            ? [
                canonicalAuthorizationGuard(db, {
                  organizationId: scope.organizationId,
                  principalId: proof.principal_id,
                  ...(proof.event_type === "ProjectProvisioningRequested"
                    ? {}
                    : { projectId: scope.projectId }),
                  action,
                }),
              ]
            : [guard(db, "consent_changed", "1")]),
          activeGrantGuard(
            db,
            {
              organizationId: scope.organizationId,
              userId: proof.principal_id.slice(5),
              clientId: proof.client_id,
              consentHash: proof.consent_hash,
            },
            proof.event_type === "ProjectProvisioningRequested" ? null : scope.projectId,
            proof.requires_publication === 1,
            proof.grant_id,
          ),
          guard(
            db,
            "consent_changed",
            `EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1)`,
            [proof.principal_id.slice(5)],
          ),
        ];
  return [...statements, ...pinnedOperationSourceGuards(db, scope)];
}
