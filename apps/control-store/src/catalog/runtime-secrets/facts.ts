import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import type { Scope, Row } from "./contracts.js";

export const params = (input: Scope) => [
  input.organizationId,
  input.projectId,
  input.environmentId,
];
export const STATE_FROM =
  "FROM runtime_secret_delivery_states state WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3";
// Native int8 is always SQL text at the JS boundary. This same scalar is the claim's final snapshot fence.
export const STATE_DOCUMENT = `SELECT json_object(
 'organization_id',state.organization_id,'project_id',state.project_id,'environment_id',state.environment_id,
 'desired_generation',CAST(state.desired_generation AS TEXT),'applied_generation',CAST(state.applied_generation AS TEXT),
 'active_lease_id',state.active_lease_id,'claimed_generation',CAST(state.claimed_generation AS TEXT),
 'claimed_trigger',state.claimed_trigger,'claimed_at',state.claimed_at,'lease_expires_at',state.lease_expires_at,
 'provider_tag',state.provider_tag,'applied_secret_names',state.applied_secret_names,'applied_manifest_sha256',CASE WHEN state.applied_manifest_sha256 IS NULL THEN NULL ELSE lower(hex(state.applied_manifest_sha256)) END,
 'applied_secret_count',state.applied_secret_count,'last_failure_code',state.last_failure_code,'last_failed_at',state.last_failed_at,
 'created_at',state.created_at,'updated_at',state.updated_at,'next_release_sequence',CAST(state.next_release_sequence AS TEXT),
 'claimed_release_sequence',CAST(state.claimed_release_sequence AS TEXT),'applied_release_sequence',CAST(state.applied_release_sequence AS TEXT)) value ${STATE_FROM}`;
export const ACTIVE_SCOPE = `SELECT 1 FROM projects project
 JOIN environments environment ON environment.organization_id=project.organization_id AND environment.project_id=project.project_id AND environment.environment_id=?3
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active'`;
export function stateFence(
  db: D1Database,
  input: Scope,
  document: string | null,
): D1PreparedStatement {
  return guard(db, "precondition_changed", `(${STATE_DOCUMENT}) IS NOT ?4`, [
    ...params(input),
    document,
  ]);
}
export function initializeState(db: D1Database, input: Scope, at: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO runtime_secret_delivery_states(organization_id,project_id,environment_id,created_at,updated_at)
 SELECT ?1,?2,?3,?4,?4 WHERE EXISTS(${ACTIVE_SCOPE}) ON CONFLICT DO NOTHING`,
    )
    .bind(...params(input), at);
}
export function parseState(document: string | null): Row | null {
  return document === null ? null : (JSON.parse(document) as Row);
}
export const CLEAR_LEASE =
  "active_lease_id=NULL,claimed_generation=NULL,claimed_trigger=NULL,claimed_release_sequence=NULL,claimed_at=NULL,lease_expires_at=NULL";
