import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readContextSnapshot } from "../provisioning/context-queries.js";
import { bytes, hex, integer, text, type Row } from "../provisioning/context-values.js";
import { API_PRODUCT_DEPLOYMENT_SQL } from "./reads.js";
const targetInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid.optional(),
  deploymentId: ulid,
  revisionId: ulid.optional(),
});
type Input = z.output<typeof targetInput>;
const API_ROLLBACK_TARGET_SQL = `SELECT revision.revision_id,revision.artifact_id,artifact.artifact_sha256,environment.environment_id,environment.head_version,
 assignment.data_environment_id,assignment.assignment_version,
 max(COALESCE((SELECT max(registration_version) FROM project_database_registration_receipts registered WHERE registered.organization_id=assignment.organization_id AND registered.project_id=assignment.project_id AND registered.physical_environment_id=assignment.data_environment_id),0),COALESCE((SELECT max(registration_version) FROM project_database_registration_reservations pending WHERE pending.organization_id=assignment.organization_id AND pending.project_id=assignment.project_id AND pending.physical_environment_id=assignment.data_environment_id),0)) registration_version,
 CASE WHEN EXISTS(SELECT 1 FROM environment_data_assignments ambiguous WHERE ambiguous.organization_id=candidate.organization_id AND ambiguous.project_id=candidate.project_id AND ambiguous.environment_id=candidate.environment_id AND ambiguous.assignment_version>1 AND ambiguous.assigned_at=candidate.staged_at) THEN NULL
 ELSE(SELECT history.data_environment_id FROM environment_data_assignments history WHERE history.organization_id=candidate.organization_id AND history.project_id=candidate.project_id AND history.environment_id=candidate.environment_id AND history.assigned_at<=candidate.staged_at ORDER BY history.assigned_at DESC,history.assignment_version DESC LIMIT 1) END target_data_environment_id,
 (COALESCE(json_extract(plan.framework_plan,'$.database.enabled'),0) OR COALESCE(json_extract(plan.framework_plan,'$.storage.enabled'),0)) data_enabled,
 (NOT COALESCE(json_extract(plan.framework_plan,'$.database.enabled'),0) OR NOT EXISTS(SELECT 1 FROM database_provider_target_heads head JOIN database_provider_target_revisions target USING(organization_id,project_id,physical_environment_id,target_version)
 WHERE head.organization_id=deployment.organization_id AND head.project_id=deployment.project_id AND head.physical_environment_id=assignment.data_environment_id AND head.state='active' AND target.provider='pgcf'
 AND(candidate.staged_at IS NULL OR candidate.staged_at<=(SELECT min(bound.created_at) FROM database_provider_target_revisions bound WHERE bound.organization_id=target.organization_id AND bound.project_id=target.project_id AND bound.physical_environment_id=target.physical_environment_id AND bound.provider='pgcf' AND bound.provider_project_id=target.provider_project_id AND bound.database_id=target.database_id)))) provider_binding_current,
 EXISTS(SELECT 1 FROM product_command_intents changing JOIN operations changing_operation USING(organization_id,project_id,operation_id) WHERE changing.organization_id=deployment.organization_id AND changing.project_id=deployment.project_id AND changing.event_type='ProjectDataChangeRequestedV1' AND changing_operation.state IN('queued','running')) data_change_in_progress,
 candidate.candidate_receipt_id,candidate.dispatch_namespace,candidate.immutable_script_name
 FROM deployments deployment JOIN deployment_revisions revision ON revision.organization_id=deployment.organization_id AND revision.project_id=deployment.project_id AND revision.deployment_id=deployment.deployment_id AND revision.revision_id=COALESCE(?5,deployment.active_revision_id)
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
 JOIN environments environment ON environment.organization_id=deployment.organization_id AND environment.project_id=deployment.project_id AND environment.environment_id=COALESCE(?3,deployment.environment_id)
 JOIN environment_data_assignments assignment ON assignment.organization_id=environment.organization_id AND assignment.project_id=environment.project_id AND assignment.environment_id=environment.environment_id AND assignment.assignment_version=(SELECT max(current.assignment_version) FROM environment_data_assignments current WHERE current.organization_id=environment.organization_id AND current.project_id=environment.project_id AND current.environment_id=environment.environment_id)
 JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
 LEFT JOIN wfp_publish_receipts published ON published.organization_id=revision.organization_id AND published.project_id=revision.project_id AND published.environment_id=environment.environment_id AND published.wfp_receipt_id=revision.wfp_receipt_id
 LEFT JOIN wfp_candidate_receipts candidate ON candidate.organization_id=published.organization_id AND candidate.project_id=published.project_id AND candidate.environment_id=published.environment_id AND candidate.candidate_receipt_id=published.candidate_receipt_id
 JOIN projects ownership ON ownership.organization_id=deployment.organization_id AND ownership.project_id=deployment.project_id AND ownership.owner_state='active'
 WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND deployment.deployment_id=?4 AND deployment.environment_id=environment.environment_id
 AND(?5 IS NOT NULL OR deployment.status='succeeded')
 AND(?3 IS NOT NULL OR EXISTS(SELECT 1 FROM (${API_PRODUCT_DEPLOYMENT_SQL} AND deployment.deployment_id=?4)))`;
// A script is removed by its own hash, whichever intent recorded the removal: a Dev reset removes candidate scripts
// under its data-change operation, which carries no binding refresh snapshot naming the candidate.
const CLEANUP = `SELECT inventory.external_ref_hash,
 (SELECT attempt.outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1) outcome
 FROM product_command_intents maintenance JOIN run_resource_inventory inventory ON inventory.organization_id=maintenance.organization_id AND inventory.project_id=maintenance.project_id AND inventory.operation_id=maintenance.operation_id
 WHERE maintenance.organization_id=?1 AND maintenance.project_id=?2 AND inventory.provider='cloudflare' AND inventory.resource_kind='wfp-script'`;
const REMOVED = `EXISTS(SELECT 1 FROM (${CLEANUP}) removed WHERE external_ref_hash=?3 AND outcome IN('removed','not_found'))`;
function parameters(i: Input) {
  return [
    i.organizationId,
    i.projectId,
    i.environmentId ?? null,
    i.deploymentId,
    i.revisionId ?? null,
  ];
}
async function candidateHash(row: Row): Promise<Uint8Array | null> {
  if (row["candidate_receipt_id"] == null) return null;
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `cloudflare\0wfp-script\0${text(row, "dispatch_namespace")}/${text(row, "immutable_script_name")}`,
      ),
    ),
  );
}
export interface ApiRollbackSnapshot {
  readonly input: Input;
  readonly row: Row | null;
  readonly cleanupHash: Uint8Array | null;
  readonly removed: boolean;
}
/** The target and every matching maintenance cleanup result share one bounded, paged native snapshot. */
export async function readApiRollbackSnapshot(
  db: D1Database,
  raw: unknown,
): Promise<ApiRollbackSnapshot> {
  const i = targetInput.parse(raw);
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await readContextSnapshot(db, [
      { sql: API_ROLLBACK_TARGET_SQL, parameters: parameters(i) },
      { sql: CLEANUP, parameters: [i.organizationId, i.projectId] },
    ]);
    if (rows === null) continue;
    if ((rows[0]?.length ?? 0) > 1) throw new TypeError("Rollback target is ambiguous");
    const row = rows[0]?.[0] ?? null,
      cleanupHash = row === null ? null : await candidateHash(row);
    const removed =
      row !== null &&
      cleanupHash !== null &&
      (rows[1] ?? []).some(
        (r) =>
          hex(r["external_ref_hash"]) === hex(cleanupHash) &&
          ["removed", "not_found"].includes(String(r["outcome"])),
      );
    return { input: i, row, cleanupHash, removed };
  }
  throw new Error("Rollback snapshot changed repeatedly");
}
export function apiRollbackTargetOf(snapshot: ApiRollbackSnapshot) {
  const { input: i, row: r, removed } = snapshot;
  if (r === null || removed) return null;
  return {
    deploymentId: parseUlid(i.deploymentId),
    environmentId: parseUlid(text(r, "environment_id")),
    revisionId: parseUlid(text(r, "revision_id")),
    artifactId: parseUlid(text(r, "artifact_id")),
    artifactDigest: bytes(r["artifact_sha256"]),
    expectedHeadVersion: integer(r["head_version"]),
    dataEnvironmentId: parseUlid(text(r, "data_environment_id")),
    assignmentVersion: integer(r["assignment_version"], 1),
    registrationVersion: integer(r["registration_version"]),
    dataChanged:
      r["provider_binding_current"] === 0 ||
      (r["data_enabled"] === 1 && r["data_environment_id"] !== r["target_data_environment_id"]),
    dataChangeInProgress: r["data_change_in_progress"] === 1,
  };
}
/** Exact original rollback revalidation for an accepting batch, including the historical cleanup observation. */
export function apiRollbackGuardStatements(
  db: D1Database,
  snapshot: ApiRollbackSnapshot,
): D1PreparedStatement[] {
  const r = snapshot.row;
  if (r === null || snapshot.removed) throw new Error("rollback_target_data_changed");
  const keys = [
    "revision_id",
    "artifact_id",
    "artifact_sha256",
    "environment_id",
    "head_version",
    "data_environment_id",
    "assignment_version",
    "registration_version",
    "target_data_environment_id",
    "data_enabled",
    "provider_binding_current",
    "data_change_in_progress",
    "candidate_receipt_id",
  ];
  return [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM (${API_ROLLBACK_TARGET_SQL}) current WHERE ${keys.map((k, n) => `${k} IS ?${n + 6}`).join(" AND ")})`,
      [
        ...parameters(snapshot.input),
        ...keys.map((k) =>
          k === "artifact_sha256" && r[k] != null ? bytes(r[k]) : (r[k] ?? null),
        ),
      ],
    ),
    ...(snapshot.cleanupHash === null
      ? []
      : [
          guard(db, "precondition_changed", REMOVED, [
            snapshot.input.organizationId,
            snapshot.input.projectId,
            snapshot.cleanupHash,
          ]),
        ]),
  ];
}
export async function readApiRollbackTarget(context: CatalogContext, raw: unknown) {
  const i = targetInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return apiRollbackTargetOf(await readApiRollbackSnapshot(db, i));
}
