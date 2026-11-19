import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { ulid } from "../common.js";
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// SQLite parses `a AND b AND ...` as a left-deep tree whose height grows with every conjunct, and D1 refuses expression
// trees deeper than 100. Together with its joins and subselects the proof exceeded that, so every long conjunction is
// grouped as a balanced tree, which is the same condition at a logarithmic depth.
const all = (terms: readonly string[]): string =>
  terms.length === 1
    ? `(${terms.join("")})`
    : `(${all(terms.slice(0, terms.length >> 1))} AND ${all(terms.slice(terms.length >> 1))})`;
export const bindingRefreshSnapshotInput = z.strictObject({
  sourceDeploymentId: ulid,
  sourceRevisionId: ulid,
  sourceCandidateReceiptId: ulid,
  sourceArtifactId: ulid,
  sourcePlanId: ulid,
  sourceBuildExecutionId: ulid,
  sourceArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceNamespace: z.string().regex(/^[a-z0-9-]{1,64}$/u),
  sourceScriptName: z.string().regex(/^p-[0-9a-z]{26}-(dev|prod)-[0-9a-z]{26}$/u),
  sourceProviderTag: z.string().regex(/^[a-f0-9]{32}$/u),
  expectedHeadVersion: positive,
  expectedGatewayRevision: positive,
  dataEnvironmentId: ulid,
  assignmentVersion: positive,
  registrationVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const SOURCE = `SELECT deployment.deployment_id source_deployment_id,
    revision.revision_id source_revision_id,candidate.candidate_receipt_id source_candidate_receipt_id,
    artifact.artifact_id source_artifact_id,plan.plan_id source_plan_id,
    artifact.build_execution_id source_build_execution_id,lower(hex(artifact.artifact_sha256)) source_artifact_sha256,
    candidate.dispatch_namespace source_namespace,candidate.immutable_script_name source_script_name,
    candidate.provider_tag source_provider_tag,plan.source_connection_id,
    candidate.product_deployment_id source_candidate_deployment_id,
    COALESCE(json_extract(plan.framework_plan,'$.database.enabled'),0) requires_database
  FROM deployments deployment
  JOIN deployment_revisions revision ON revision.organization_id=deployment.organization_id
    AND revision.project_id=deployment.project_id AND revision.deployment_id=deployment.deployment_id
  JOIN wfp_publish_receipts published ON published.organization_id=revision.organization_id
    AND published.project_id=revision.project_id AND published.environment_id=deployment.environment_id
    AND published.wfp_receipt_id=revision.wfp_receipt_id AND published.artifact_id=revision.artifact_id
  JOIN wfp_candidate_receipts candidate ON candidate.organization_id=published.organization_id
    AND candidate.project_id=published.project_id AND candidate.environment_id=published.environment_id
    AND candidate.candidate_receipt_id=published.candidate_receipt_id
    AND candidate.product_deployment_id=published.product_deployment_id
    AND candidate.dispatch_namespace=published.dispatch_namespace
    AND candidate.immutable_script_name=published.script_name AND candidate.provider_tag=published.provider_version_id
  JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id
    AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
    AND artifact.build_execution_id=revision.build_execution_id
    AND artifact.artifact_id=candidate.artifact_id AND artifact.artifact_sha256=candidate.artifact_sha256
  JOIN build_executions build ON build.organization_id=artifact.organization_id AND build.project_id=artifact.project_id
    AND build.build_execution_id=artifact.build_execution_id AND build.state='succeeded'
  JOIN product_command_intents build_intent ON build_intent.organization_id=build.organization_id
    AND build_intent.project_id=build.project_id AND build_intent.operation_id=build.operation_id
    AND build_intent.event_type='DeploymentRequestedV1' AND build_intent.plan_id=revision.plan_id
  JOIN deployment_plans plan ON plan.organization_id=build_intent.organization_id
    AND plan.project_id=build_intent.project_id AND plan.plan_id=build_intent.plan_id
    AND plan.source_connection_id=build_intent.source_connection_id
  WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND deployment.environment_id=?3
    AND deployment.deployment_id=json_extract(?5,'$.sourceDeploymentId') AND revision.revision_id=json_extract(?5,'$.sourceRevisionId') AND deployment.status='succeeded'`;
const snap = (key: string) => `json_extract(?5,'$.${key}')`;
const oldHead = `environment.active_deployment_id=${snap("sourceDeploymentId")} AND environment.active_revision_id=${snap("sourceRevisionId")} AND environment.head_version=${snap("expectedHeadVersion")}`;
const ownHead = `environment.active_deployment_id=intent.deployment_id AND environment.active_revision_id IS NOT NULL AND environment.head_version=${snap("expectedHeadVersion")}+1`;
const assignment = `(SELECT data_environment_id FROM environment_data_assignments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 ORDER BY assignment_version DESC LIMIT 1)`;
const cutoverPending = `EXISTS(SELECT 1 FROM database_provider_cutover_authorizations a WHERE a.organization_id=?1 AND a.project_id=?2 AND NOT EXISTS(SELECT 1 FROM database_provider_cutover_releases released WHERE released.operation_id=a.operation_id))`;
const permitted = `EXISTS(SELECT 1 FROM database_provider_cutover_binding_refreshes permit JOIN database_provider_cutover_authorizations a ON a.operation_id=permit.cutover_operation_id JOIN operations op ON op.operation_id=a.operation_id JOIN database_provider_target_heads h ON h.organization_id=permit.organization_id AND h.project_id=permit.project_id AND h.physical_environment_id=permit.physical_environment_id AND h.target_version=permit.target_version JOIN database_provider_target_revisions r ON r.organization_id=h.organization_id AND r.project_id=h.project_id AND r.physical_environment_id=h.physical_environment_id AND r.target_version=h.target_version WHERE permit.organization_id=?1 AND permit.project_id=?2 AND permit.environment_id=?3 AND permit.refresh_operation_id=?4 AND a.organization_id=?1 AND a.project_id=?2 AND op.state='succeeded' AND h.state='active' AND r.provider='pgcf' AND ${assignment}=permit.physical_environment_id AND EXISTS(SELECT 1 FROM project_database_registration_receipts registration WHERE registration.organization_id=?1 AND registration.project_id=?2 AND registration.physical_environment_id=permit.physical_environment_id AND registration.registration_version=permit.target_registration_version AND registration.status='active' AND json_extract(registration.metadata,'$.databaseId')=r.database_id AND registration.registration_version=(SELECT max(latest.registration_version) FROM project_database_registration_receipts latest WHERE latest.organization_id=?1 AND latest.project_id=?2 AND latest.physical_environment_id=permit.physical_environment_id)))`;
/** Fixed original frozen refresh proof, evaluated inside the caller's publication/completion batch. No RPC or SQL input. */
export function bindingRefreshStatements(
  db: D1Database,
  input: { organizationId: string; projectId: string; environmentId: string; operationId: string },
  stored: unknown,
  allowPublished: boolean,
  expected?: unknown,
): D1PreparedStatement[] {
  if (typeof stored !== "string") throw new TypeError("Binding refresh snapshot is absent");
  const snapshot = bindingRefreshSnapshotInput.parse(JSON.parse(stored));
  if (expected !== undefined) {
    const wanted = bindingRefreshSnapshotInput.parse(expected);
    if (
      Object.keys(snapshot).some((key) => Reflect.get(snapshot, key) !== Reflect.get(wanted, key))
    )
      throw new TypeError("Binding refresh accepted snapshot changed");
  }
  const keys = Object.keys(snapshot);
  const auditSnapshot = keys
    .map(
      (key) =>
        `json_extract(audit.payload,'$.bindingRefreshSnapshot.${key}') IS json_extract(intent.binding_refresh_snapshot,'$.${key}')`,
    )
    .join(" AND ");
  const sourceFields: Record<string, string> = {
    source_candidate_receipt_id: "sourceCandidateReceiptId",
    source_artifact_id: "sourceArtifactId",
    source_build_execution_id: "sourceBuildExecutionId",
    source_plan_id: "sourcePlanId",
    source_artifact_sha256: "sourceArtifactSha256",
    source_namespace: "sourceNamespace",
    source_script_name: "sourceScriptName",
    source_provider_tag: "sourceProviderTag",
  };
  const sourceExact = Object.entries(sourceFields).map(
    ([column, key]) => `source.${column}=${snap(key)}`,
  );
  const ownCandidate = `candidate.operation_id=?4 AND candidate.product_deployment_id=intent.deployment_id AND candidate.artifact_id=${snap("sourceArtifactId")} AND lower(hex(candidate.artifact_sha256))=${snap("sourceArtifactSha256")} AND candidate.dispatch_namespace=${snap("sourceNamespace")} AND candidate.immutable_script_name='p-'||lower(?2)||'-'||environment.name||'-'||lower(intent.deployment_id)`;
  const ownPublished = `EXISTS(SELECT 1 FROM deployment_revisions revision JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.environment_id=?3 AND receipt.wfp_receipt_id=revision.wfp_receipt_id JOIN wfp_candidate_receipts published_candidate ON published_candidate.organization_id=receipt.organization_id AND published_candidate.project_id=receipt.project_id AND published_candidate.environment_id=receipt.environment_id AND published_candidate.candidate_receipt_id=receipt.candidate_receipt_id JOIN deployments deployment ON deployment.organization_id=revision.organization_id AND deployment.project_id=revision.project_id AND deployment.deployment_id=revision.deployment_id AND deployment.active_revision_id=revision.revision_id AND deployment.status='succeeded' WHERE ${all(
    [
      `revision.organization_id=?1`,
      `revision.project_id=?2`,
      `revision.revision_id=environment.active_revision_id`,
      `revision.operation_id=?4`,
      `revision.deployment_id=intent.deployment_id`,
      `revision.plan_id=${snap("sourcePlanId")}`,
      `revision.build_execution_id=${snap("sourceBuildExecutionId")}`,
      `revision.artifact_id=${snap("sourceArtifactId")}`,
      `receipt.artifact_id=${snap("sourceArtifactId")}`,
      `published_candidate.artifact_id=${snap("sourceArtifactId")}`,
      `lower(hex(published_candidate.artifact_sha256))=${snap("sourceArtifactSha256")}`,
      `receipt.product_deployment_id=intent.deployment_id`,
      `published_candidate.product_deployment_id=intent.deployment_id`,
      `published_candidate.operation_id=?4`,
      `receipt.candidate_receipt_id=route.candidate_receipt_id`,
      `published_candidate.dispatch_namespace=${snap("sourceNamespace")}`,
      `receipt.dispatch_namespace=published_candidate.dispatch_namespace`,
      `receipt.script_name=published_candidate.immutable_script_name`,
      `receipt.provider_version_id=published_candidate.provider_tag`,
      `receipt.shared_gateway_revision=route.revision`,
      `published_candidate.build_reused=1`,
    ],
  )})`;
  const registrationVersion = `max(coalesce((SELECT max(registration_version) FROM project_database_registration_receipts receipt WHERE receipt.organization_id=?1 AND receipt.project_id=?2 AND receipt.physical_environment_id=assignment.data_environment_id),0),coalesce((SELECT max(registration_version) FROM project_database_registration_reservations reservation WHERE reservation.organization_id=?1 AND reservation.project_id=?2 AND reservation.physical_environment_id=assignment.data_environment_id),0))`;
  const databaseReady = `source.requires_database=0 OR EXISTS(SELECT 1 FROM database_provider_target_heads head JOIN database_provider_target_revisions target ON target.organization_id=head.organization_id AND target.project_id=head.project_id AND target.physical_environment_id=head.physical_environment_id AND target.target_version=head.target_version JOIN project_database_registration_receipts registration ON registration.organization_id=head.organization_id AND registration.project_id=head.project_id AND registration.physical_environment_id=head.physical_environment_id WHERE ${all(
    [
      `head.organization_id=?1`,
      `head.project_id=?2`,
      `head.physical_environment_id=assignment.data_environment_id`,
      `head.state='active'`,
      `registration.registration_version=${registrationVersion}`,
      `registration.status='active'`,
      `json_type(registration.metadata,'$.pending') IS NULL`,
      `json_extract(registration.metadata,'$.providerProjectId')=target.provider_project_id`,
      `((target.provider='pgcf' AND json_extract(registration.metadata,'$.provider')='pgcf' AND json_extract(registration.metadata,'$.databaseId')=target.database_id)OR(target.provider='neon' AND json_type(registration.metadata,'$.provider') IS NULL AND json_extract(registration.metadata,'$.branchId')=target.branch_id))`,
      `EXISTS(SELECT 1 FROM json_each(registration.metadata,'$.authorizedEnvironmentIds') authorized WHERE authorized.value=?3)`,
    ],
  )})`;
  const lifecycleText =
      "trim(CAST(json_extract(audit.payload,'$.acceptedLifecycleVersion') AS TEXT),char(9)||char(10)||char(11)||char(12)||char(13)||' ')",
    lifecycleDigits = `CASE WHEN substr(${lifecycleText},1,1) IN('+','-') THEN substr(${lifecycleText},2) ELSE ${lifecycleText} END`;
  const proof = `SELECT 1 FROM projects project JOIN environments environment ON environment.organization_id=project.organization_id AND environment.project_id=project.project_id AND environment.environment_id=?3 JOIN environment_data_assignments assignment ON assignment.organization_id=environment.organization_id AND assignment.project_id=environment.project_id AND assignment.environment_id=environment.environment_id AND assignment.assignment_version=(SELECT max(current.assignment_version) FROM environment_data_assignments current WHERE current.organization_id=?1 AND current.project_id=?2 AND current.environment_id=?3) JOIN product_command_intents intent ON intent.organization_id=project.organization_id AND intent.project_id=project.project_id AND intent.environment_id=environment.environment_id AND intent.operation_id=?4 AND intent.event_type='DeploymentRequestedV1' AND intent.billing_epoch_id=project.active_billing_epoch_id AND intent.binding_refresh_snapshot=?5 JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id AND operation.billing_epoch_id=intent.billing_epoch_id JOIN audit_events audit ON audit.organization_id=intent.organization_id AND audit.project_id=intent.project_id AND audit.operation_id=intent.operation_id AND audit.event_type='DeploymentRequestedV1' AND audit.actor_type='service' AND json_type(audit.payload,'$.bindingRefreshSnapshot')='object' AND (SELECT count(*) FROM json_each(audit.payload,'$.bindingRefreshSnapshot'))=15 AND ${auditSnapshot} JOIN(${SOURCE}) source ON 1=1 JOIN shared_gateway_route_revisions route ON route.organization_id=environment.organization_id AND route.project_id=environment.project_id AND route.environment_id=environment.environment_id AND route.revision=(SELECT max(latest.revision) FROM shared_gateway_route_revisions latest WHERE latest.organization_id=?1 AND latest.project_id=?2 AND latest.environment_id=?3) JOIN wfp_candidate_receipts candidate ON candidate.organization_id=route.organization_id AND candidate.project_id=route.project_id AND candidate.environment_id=route.environment_id AND candidate.candidate_receipt_id=route.candidate_receipt_id WHERE ${all(
    [
      `project.organization_id=?1`,
      `project.project_id=?2`,
      `project.owner_state='active'`,
      `project.lifecycle_state='active'`,
      `environment.name IN('dev','prod')`,
      `length(${lifecycleDigits})>0`,
      `(${lifecycleDigits}) NOT GLOB '*[^0-9]*'`,
      `CAST(${lifecycleText} AS INTEGER) BETWEEN 1 AND 2147483647`,
      `CAST(${lifecycleText} AS INTEGER)=project.lifecycle_version`,
      `assignment.data_environment_id=${snap("dataEnvironmentId")}`,
      `assignment.assignment_version=${snap("assignmentVersion")}`,
      `${registrationVersion}=${snap("registrationVersion")}`,
      ...sourceExact,
      `source.source_script_name='p-'||lower(?2)||'-'||environment.name||'-'||lower(source.source_candidate_deployment_id)`,
      `(${databaseReady})`,
      `((${oldHead})${allowPublished ? `OR(${ownHead})` : ""})`,
      `(operation.state IN('queued','running')${allowPublished ? `OR((${ownHead})AND operation.state='succeeded')` : ""})`,
      `route.active=1`,
      `route.handle=project.handle`,
      `route.revision>=${snap("expectedGatewayRevision")}`,
      `((route.revision=${snap("expectedGatewayRevision")} AND(${oldHead})AND route.candidate_receipt_id=${snap("sourceCandidateReceiptId")})OR(route.revision>${snap("expectedGatewayRevision")} AND route.operation_id=?4 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions foreign_route WHERE foreign_route.organization_id=?1 AND foreign_route.project_id=?2 AND foreign_route.environment_id=?3 AND foreign_route.revision>${snap("expectedGatewayRevision")} AND foreign_route.operation_id<>?4) AND ((${ownCandidate})OR((${oldHead})AND route.candidate_receipt_id=${snap("sourceCandidateReceiptId")}))))`,
      `(${allowPublished ? `((${ownHead})AND ${ownPublished})OR` : ""}((${oldHead})AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_requests cleanup WHERE cleanup.candidate_receipt_id=${snap("sourceCandidateReceiptId")})AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=${snap("sourceCandidateReceiptId")})))`,
      `NOT EXISTS(SELECT 1 FROM operations competing WHERE competing.project_id=?2 AND competing.operation_id<>?4 AND competing.state='running')`,
      `NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims competing WHERE competing.project_id=?2 AND(competing.operation_id<>?4 OR competing.environment_id<>?3))`,
      `NOT EXISTS(SELECT 1 FROM project_database_writes competing WHERE competing.project_id=?2 AND competing.completed_at IS NULL)`,
      `NOT EXISTS(SELECT 1 FROM project_database_compute_changes competing WHERE competing.project_id=?2 AND competing.completed_at IS NULL)`,
      `NOT EXISTS(SELECT 1 FROM pgcf_database_compute_changes competing WHERE competing.project_id=?2 AND competing.completed_at IS NULL)`,
      `NOT EXISTS(SELECT 1 FROM pgcf_database_entitlement_actions competing WHERE competing.project_id=?2 AND competing.state IN('reserved','dispatched','pending'))`,
    ],
  )}`;
  const scope = [input.organizationId, input.projectId, input.environmentId, input.operationId];
  return [
    guard(db, "operation_conflict", `NOT EXISTS(${proof})`, [...scope, stored]),
    // A pending database cutover blocks the refresh unless it released this exact one; it depends on the scope only,
    // so it is a guard of its own and keeps the row proof shallow.
    guard(db, "operation_conflict", `${cutoverPending} AND NOT(${permitted})`, scope),
  ];
}
