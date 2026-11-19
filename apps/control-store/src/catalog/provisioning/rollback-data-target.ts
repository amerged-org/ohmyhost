import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import { hexBytes, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { currentDataEnvironment } from "../database/authority.js";
const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  deploymentId: ulid,
  revisionId: ulid.optional(),
});
const SQL = `SELECT revision.revision_id,revision.artifact_id,lower(hex(artifact.artifact_sha256)) artifact_digest,environment.head_version,
 assignment.data_environment_id,CAST(assignment.assignment_version AS TEXT) assignment_version,
 CAST(max(COALESCE((SELECT max(registration_version) FROM project_database_registration_receipts registered WHERE registered.organization_id=assignment.organization_id AND registered.project_id=assignment.project_id AND registered.physical_environment_id=assignment.data_environment_id),0),COALESCE((SELECT max(registration_version) FROM project_database_registration_reservations pending WHERE pending.organization_id=assignment.organization_id AND pending.project_id=assignment.project_id AND pending.physical_environment_id=assignment.data_environment_id),0)) AS TEXT) registration_version,
 CASE WHEN EXISTS(SELECT 1 FROM environment_data_assignments ambiguous WHERE ambiguous.organization_id=candidate.organization_id AND ambiguous.project_id=candidate.project_id AND ambiguous.environment_id=candidate.environment_id AND ambiguous.assignment_version>1 AND ambiguous.assigned_at=candidate.staged_at) THEN NULL ELSE
 (SELECT historic.data_environment_id FROM environment_data_assignments historic WHERE historic.organization_id=candidate.organization_id AND historic.project_id=candidate.project_id AND historic.environment_id=candidate.environment_id AND historic.assigned_at<=candidate.staged_at ORDER BY historic.assigned_at DESC,historic.assignment_version DESC LIMIT 1) END target_data_environment_id,
 (COALESCE(json_extract(plan.framework_plan,'$.database.enabled'),0) IN(1,'true') OR COALESCE(json_extract(plan.framework_plan,'$.storage.enabled'),0) IN(1,'true')) data_enabled,
 (COALESCE(json_extract(plan.framework_plan,'$.database.enabled'),0) NOT IN(1,'true') OR NOT EXISTS(SELECT 1 FROM database_provider_target_heads head JOIN database_provider_target_revisions target USING(organization_id,project_id,physical_environment_id,target_version) WHERE head.organization_id=deployment.organization_id AND head.project_id=deployment.project_id AND head.physical_environment_id=${currentDataEnvironment("deployment.organization_id", "deployment.project_id", "environment.environment_id")} AND head.state='active' AND target.provider='pgcf' AND(candidate.staged_at IS NULL OR candidate.staged_at<=(SELECT min(bound.created_at) FROM database_provider_target_revisions bound WHERE bound.organization_id=target.organization_id AND bound.project_id=target.project_id AND bound.physical_environment_id=target.physical_environment_id AND bound.provider='pgcf' AND bound.provider_project_id=target.provider_project_id AND bound.database_id=target.database_id)))) provider_binding_current,
 EXISTS(SELECT 1 FROM product_command_intents changing JOIN operations changing_operation USING(organization_id,project_id,operation_id) WHERE changing.organization_id=deployment.organization_id AND changing.project_id=deployment.project_id AND changing.event_type='ProjectDataChangeRequestedV1' AND changing_operation.state IN('queued','running')) data_change_in_progress,
 candidate.dispatch_namespace,candidate.immutable_script_name,
 (SELECT json_group_array(json_object('hash',lower(hex(inventory.external_ref_hash)),'outcome',(SELECT outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash ORDER BY attempted_at DESC,cleanup_attempt_id DESC LIMIT 1))) FROM product_command_intents maintenance JOIN run_resource_inventory inventory ON inventory.organization_id=maintenance.organization_id AND inventory.project_id=maintenance.project_id AND inventory.operation_id=maintenance.operation_id WHERE maintenance.organization_id=deployment.organization_id AND maintenance.project_id=deployment.project_id AND inventory.provider='cloudflare' AND inventory.resource_kind='wfp-script') cleanup
 FROM deployments deployment JOIN deployment_revisions revision ON revision.organization_id=deployment.organization_id AND revision.project_id=deployment.project_id AND revision.deployment_id=deployment.deployment_id AND revision.revision_id=COALESCE(?5,deployment.active_revision_id)
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
 JOIN environments environment ON environment.organization_id=deployment.organization_id AND environment.project_id=deployment.project_id AND environment.environment_id=?3
 JOIN environment_data_assignments assignment ON assignment.organization_id=environment.organization_id AND assignment.project_id=environment.project_id AND assignment.environment_id=environment.environment_id AND assignment.assignment_version=(SELECT max(latest.assignment_version) FROM environment_data_assignments latest WHERE latest.organization_id=assignment.organization_id AND latest.project_id=assignment.project_id AND latest.environment_id=assignment.environment_id)
 JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
 LEFT JOIN wfp_publish_receipts published ON published.organization_id=revision.organization_id AND published.project_id=revision.project_id AND published.environment_id=environment.environment_id AND published.wfp_receipt_id=revision.wfp_receipt_id
 LEFT JOIN wfp_candidate_receipts candidate ON candidate.organization_id=published.organization_id AND candidate.project_id=published.project_id AND candidate.environment_id=published.environment_id AND candidate.candidate_receipt_id=published.candidate_receipt_id
 JOIN projects ownership ON ownership.organization_id=deployment.organization_id AND ownership.project_id=deployment.project_id AND ownership.owner_state='active'
 WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND deployment.deployment_id=?4 AND deployment.environment_id=?3 AND(?5 IS NOT NULL OR deployment.status='succeeded')`;
/** Original rollback data-identity history, provider-binding epoch and completed cleanup read in one snapshot. */
export async function readProductRollbackDataTarget(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(SQL)
    .bind(i.organizationId, i.projectId, i.environmentId, i.deploymentId, i.revisionId ?? null)
    .first<Record<string, unknown>>();
  if (!row) return null;
  if (row["dispatch_namespace"] !== null && row["immutable_script_name"] !== null) {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `cloudflare\0wfp-script\0${String(row["dispatch_namespace"])}/${String(row["immutable_script_name"])}`,
        ),
      ),
    );
    const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    const cleanup = JSON.parse(String(row["cleanup"] ?? "[]")) as Array<{
      hash: string;
      outcome: string | null;
    }>;
    if (
      cleanup.some((r) => r.hash === hash && (r.outcome === "removed" || r.outcome === "not_found"))
    )
      return null;
  }
  const assignmentVersion = Number(row["assignment_version"]),
    registrationVersion = Number(row["registration_version"]);
  if (
    !Number.isSafeInteger(assignmentVersion) ||
    assignmentVersion < 1 ||
    !Number.isSafeInteger(registrationVersion) ||
    registrationVersion < 0 ||
    ![0, 1].includes(Number(row["data_enabled"])) ||
    ![0, 1].includes(Number(row["data_change_in_progress"]))
  )
    throw new TypeError("Rollback data assignment is invalid");
  return {
    deploymentId: parseUlid(i.deploymentId),
    environmentId: parseUlid(i.environmentId),
    revisionId: parseUlid(String(row["revision_id"])),
    artifactId: parseUlid(String(row["artifact_id"])),
    artifactDigest: hexBytes(String(row["artifact_digest"])),
    expectedHeadVersion: Number(row["head_version"]),
    dataEnvironmentId: parseUlid(String(row["data_environment_id"])),
    assignmentVersion,
    registrationVersion,
    dataChanged:
      row["provider_binding_current"] === 0 ||
      (row["data_enabled"] === 1 &&
        row["data_environment_id"] !== row["target_data_environment_id"]),
    dataChangeInProgress: row["data_change_in_progress"] === 1,
  };
}
