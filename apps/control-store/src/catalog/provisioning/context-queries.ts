import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { ROUTE_ROW } from "../gateway/facts.js";
import { deletionEnvironmentRowsSql } from "./deletion-environments.js";

export interface ContextRead {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}
export type ContextRows = Record<string, unknown>[];
const PAGE_ROWS = 128;

/** Counts plan the pages; every returned row and the verifying counts share ONE atomic D1 batch.
 * A concurrent insert between planning and that snapshot causes a retry, never truncation. Rows are
 * not packed into a json_group_array cell (D1's per-value bound also applies to JSON cells). */
export async function readContextSnapshot(
  db: D1Database,
  reads: readonly ContextRead[],
): Promise<ContextRows[] | null> {
  const counted = await db.batch(
    reads.map(({ sql, parameters }) =>
      db.prepare(`SELECT CAST(count(*) AS TEXT) count FROM (${sql})`).bind(...parameters),
    ),
  );
  const counts = counted.map((result) => {
    const count = Number(result.results[0]?.["count"]);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new TypeError("Context row count is invalid");
    return count;
  });
  const statements: D1PreparedStatement[] = [];
  const pages: number[] = [];
  for (const [index, { sql, parameters }] of reads.entries()) {
    const count = counts[index];
    if (count === undefined) throw new TypeError("Context count result is missing");
    const pageCount = Math.ceil(count / PAGE_ROWS);
    pages.push(pageCount);
    for (let page = 0; page < pageCount; page++)
      statements.push(
        db
          .prepare(`SELECT * FROM (${sql}) LIMIT ${PAGE_ROWS} OFFSET ${page * PAGE_ROWS}`)
          .bind(...parameters),
      );
  }
  statements.push(
    ...reads.map(({ sql, parameters }) =>
      db.prepare(`SELECT CAST(count(*) AS TEXT) count FROM (${sql})`).bind(...parameters),
    ),
  );
  const results = await db.batch(statements);
  const rowResults = results.length - reads.length;
  for (let index = 0; index < reads.length; index++)
    if (String(results[rowResults + index]?.results[0]?.["count"]) !== String(counts[index]))
      return null;
  let offset = 0;
  return pages.map((count) => {
    const rows = results.slice(offset, offset + count).flatMap((result) => result.results);
    offset += count;
    return rows;
  });
}

export const INTENT = `SELECT intent.*,plan.commit_sha,plan.source_sha256,plan.build_plan_sha256,
 receipt.provider_version_id
 FROM product_command_intents intent
 LEFT JOIN deployment_plans plan ON plan.organization_id=intent.organization_id AND plan.project_id=intent.project_id AND plan.plan_id=intent.plan_id
 LEFT JOIN deployment_revisions target_revision ON target_revision.organization_id=intent.organization_id AND target_revision.project_id=intent.project_id
 AND target_revision.deployment_id=intent.target_deployment_id AND target_revision.revision_id=intent.target_revision_id
 LEFT JOIN wfp_publish_receipts receipt ON receipt.organization_id=target_revision.organization_id AND receipt.project_id=target_revision.project_id AND receipt.wfp_receipt_id=target_revision.wfp_receipt_id
 WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?4`;
export const BASE = `SELECT project.handle,project.data_mode,project.region,environment.name environment_name,
 environment.head_version,environment.active_deployment_id,environment.active_revision_id,
 project.lifecycle_state,project.lifecycle_version,project.owner_state ownership_state,
 run.created_at accepted_at,run.state workflow_state,operation.state operation_state
 FROM environments environment JOIN projects project USING(organization_id,project_id)
 JOIN product_workflow_runs run ON run.organization_id=environment.organization_id AND run.project_id=environment.project_id
 AND run.environment_id=environment.environment_id AND run.operation_id=?4
 JOIN operations operation ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id
 WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3`;
export const ENVIRONMENTS = `SELECT environment_id,name,head_version,active_deployment_id,active_revision_id
 FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod') ORDER BY name`;
export const WORKFLOW_ENVIRONMENTS = deletionEnvironmentRowsSql(
  "EXISTS(SELECT 1 FROM product_command_intents deletion WHERE deletion.organization_id=?1 AND deletion.project_id=?2 AND deletion.environment_id=?3 AND deletion.operation_id=?4 AND deletion.event_type='ProjectDeletionRequestedV1')",
);
export const GRANT = `SELECT grant_record.*,binding.generation source_generation
 FROM repository_grants grant_record JOIN projects ownership USING(organization_id,project_id)
 JOIN project_source_bindings binding ON binding.organization_id=grant_record.organization_id AND binding.project_id=grant_record.project_id AND binding.source_connection_id=grant_record.source_connection_id
 WHERE grant_record.organization_id=?1 AND grant_record.project_id=?2 AND grant_record.source_connection_id=?3 AND ownership.owner_state='active'
 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id)`;
export const KNOWN = `SELECT known.* FROM (
 SELECT revision.deployment_id,receipt.dispatch_namespace,receipt.script_name,receipt.provider_version_id,
 artifact.artifact_sha256,candidate.binding_set_digest,candidate.build_reused,receipt.published_at
 FROM wfp_publish_receipts receipt JOIN deployment_revisions revision ON revision.organization_id=receipt.organization_id AND revision.project_id=receipt.project_id AND revision.wfp_receipt_id=receipt.wfp_receipt_id
 JOIN build_artifacts artifact ON artifact.organization_id=receipt.organization_id AND artifact.project_id=receipt.project_id AND artifact.artifact_id=receipt.artifact_id
 JOIN wfp_candidate_receipts candidate ON candidate.candidate_receipt_id=receipt.candidate_receipt_id
 WHERE receipt.organization_id=?1 AND receipt.project_id=?2 AND receipt.environment_id=?3
 UNION ALL
 SELECT candidate.product_deployment_id,candidate.dispatch_namespace,candidate.immutable_script_name,candidate.provider_tag,
 candidate.artifact_sha256,candidate.binding_set_digest,candidate.build_reused,candidate.staged_at
 FROM wfp_candidate_receipts candidate WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3
 AND NOT EXISTS(SELECT 1 FROM wfp_publish_receipts published WHERE published.candidate_receipt_id=candidate.candidate_receipt_id)
 AND NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
 ) known ORDER BY known.published_at,known.provider_version_id,known.deployment_id,known.script_name`;
export const RUNTIME_SECRET = `SELECT revision.deployment_id,receipt.dispatch_namespace,receipt.script_name,
 secret.provider_tag provider_version_id,artifact.artifact_sha256,candidate.binding_set_digest,receipt.published_at,0 build_reused
 FROM runtime_secret_delivery_states secret
 JOIN environments environment ON environment.organization_id=secret.organization_id AND environment.project_id=secret.project_id AND environment.environment_id=secret.environment_id
 JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id AND revision.project_id=environment.project_id AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
 LEFT JOIN wfp_candidate_receipts candidate ON candidate.organization_id=receipt.organization_id AND candidate.project_id=receipt.project_id AND candidate.environment_id=receipt.environment_id AND candidate.candidate_receipt_id=receipt.candidate_receipt_id
 WHERE secret.organization_id=?1 AND secret.project_id=?2 AND secret.environment_id=?3
 AND secret.desired_generation=secret.applied_generation AND secret.provider_tag IS NOT NULL`;
export const RECEIPT = `SELECT receipt.dispatch_namespace,receipt.script_name,receipt.provider_version_id,
 artifact.artifact_sha256,candidate.binding_set_digest,receipt.published_at,CAST(receipt.shared_gateway_revision AS TEXT) shared_gateway_revision,
 ${ROUTE_ROW} route_value
 FROM deployment_revisions revision
 JOIN effective_wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id AND receipt.environment_id=?3
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
 JOIN shared_gateway_route_revisions route ON route.organization_id=receipt.organization_id AND route.project_id=receipt.project_id AND route.environment_id=receipt.environment_id AND route.revision=receipt.shared_gateway_revision
 JOIN environments environment ON environment.organization_id=route.organization_id AND environment.project_id=route.project_id AND environment.environment_id=route.environment_id
 JOIN wfp_candidate_receipts candidate ON candidate.organization_id=route.organization_id AND candidate.project_id=route.project_id AND candidate.environment_id=route.environment_id AND candidate.candidate_receipt_id=route.candidate_receipt_id
 WHERE revision.organization_id=?1 AND revision.project_id=?2 AND revision.deployment_id=?4 AND revision.revision_id=?5`;
export const ARTIFACTS = `SELECT DISTINCT build.provider_build_id,build.build_project_name,build.operation_id,
 intent.deployment_id,plan.commit_sha,plan.source_sha256,plan.build_plan_sha256,plan.framework_plan,artifact.object_version_ref
 FROM build_executions build JOIN build_artifacts artifact ON artifact.organization_id=build.organization_id AND artifact.project_id=build.project_id AND artifact.build_execution_id=build.build_execution_id
 JOIN product_command_intents intent ON intent.organization_id=build.organization_id AND intent.project_id=build.project_id AND intent.operation_id=build.operation_id AND intent.environment_id=?3
 AND intent.event_type='DeploymentRequestedV1' AND intent.deployment_id IS NOT NULL AND intent.plan_id IS NOT NULL
 JOIN deployment_plans plan ON plan.organization_id=intent.organization_id AND plan.project_id=intent.project_id AND plan.plan_id=intent.plan_id
 WHERE build.organization_id=?1 AND build.project_id=?2 ORDER BY intent.deployment_id,build.provider_build_id,artifact.object_version_ref`;
export const ARTIFACT = `SELECT build.provider_build_id,build.build_project_name,build.operation_id,
 build_intent.environment_id build_environment_id,build_intent.deployment_id build_deployment_id,plan.commit_sha,
 plan.source_sha256,plan.build_plan_sha256,plan.framework_plan,artifact.object_version_ref
 FROM deployment_revisions revision
 JOIN build_executions build ON build.organization_id=revision.organization_id AND build.project_id=revision.project_id AND build.build_execution_id=revision.build_execution_id
 JOIN product_command_intents build_intent ON build_intent.organization_id=build.organization_id AND build_intent.project_id=build.project_id AND build_intent.operation_id=build.operation_id AND build_intent.event_type='DeploymentRequestedV1'
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
 JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id AND receipt.environment_id=?3
 WHERE revision.organization_id=?1 AND revision.project_id=?2 AND revision.deployment_id=?4 AND revision.revision_id=?5`;
export const ARCHIVES = `SELECT bucket_name,object_key,object_version_id,object_etag,CAST(byte_length AS TEXT) byte_length,operation_id,source_sha256 sha256
 FROM product_source_archive_objects WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3
 ORDER BY operation_id,bucket_name,object_key,object_version_id`;
export const INVENTORY = `SELECT inventory.resource_record_id,inventory.provider,inventory.resource_kind,inventory.external_ref_hash,inventory.cleanup_locator,
 (SELECT attempt.outcome FROM run_cleanup_attempts attempt WHERE attempt.organization_id=inventory.organization_id AND attempt.project_id=inventory.project_id AND attempt.operation_id=inventory.operation_id
 AND attempt.provider=inventory.provider AND attempt.resource_kind=inventory.resource_kind AND attempt.external_ref_hash=inventory.external_ref_hash
 ORDER BY attempt.attempted_at DESC,attempt.cleanup_attempt_id DESC LIMIT 1) cleanup_outcome
 FROM run_resource_inventory inventory WHERE inventory.organization_id=?1 AND inventory.project_id=?2 AND inventory.operation_id=?3
 ORDER BY inventory.provider,inventory.resource_kind,inventory.external_ref_hash`;
export const DELETION_ARTIFACTS = `SELECT artifact.artifact_id,artifact.build_execution_id,build.operation_id,artifact.artifact_sha256,artifact.object_version_ref
 FROM build_artifacts artifact JOIN build_executions build ON build.organization_id=artifact.organization_id AND build.project_id=artifact.project_id AND build.build_execution_id=artifact.build_execution_id
 JOIN product_command_intents intent ON intent.organization_id=build.organization_id AND intent.project_id=build.project_id AND intent.operation_id=build.operation_id AND intent.environment_id=?3 AND intent.event_type='DeploymentRequestedV1'
 WHERE artifact.organization_id=?1 AND artifact.project_id=?2 ORDER BY build.operation_id,artifact.artifact_id`;
export const SECRETS = `SELECT CAST(count(*) AS TEXT) count FROM environment_secrets secret
 JOIN projects ownership ON ownership.organization_id=secret.organization_id AND ownership.project_id=secret.project_id AND ownership.owner_state='active'
 JOIN billing_epochs epoch ON epoch.billing_epoch_id=ownership.active_billing_epoch_id AND epoch.project_id=ownership.project_id AND epoch.organization_id=ownership.organization_id AND epoch.ended_at IS NULL
 WHERE secret.organization_id=?1 AND secret.project_id=?2 AND secret.environment_id=?3`;
export const PLAN = `SELECT framework_plan FROM deployment_plans WHERE organization_id=?1 AND project_id=?2 AND plan_id=?3`;
export const POLICY = `SELECT plan.framework_plan FROM deployment_revisions revision JOIN deployment_plans plan
 ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
 WHERE revision.organization_id=?1 AND revision.project_id=?2 AND revision.deployment_id=?3 AND revision.revision_id=?4`;
export const R2 = `SELECT receipt.* FROM project_r2_bucket_receipts receipt JOIN projects ownership USING(organization_id,project_id)
 WHERE receipt.organization_id=?1 AND receipt.project_id=?2 AND receipt.environment_id=?3 AND ownership.owner_state='active'`;
export const DATA_ENVIRONMENTS = `SELECT data.data_environment_id FROM project_data_environments data WHERE data.organization_id=?1 AND data.project_id=?2
 AND NOT EXISTS(SELECT 1 FROM database_provider_target_heads head JOIN database_provider_target_revisions target USING(organization_id,project_id,physical_environment_id,target_version)
 WHERE head.organization_id=data.organization_id AND head.project_id=data.project_id AND head.physical_environment_id=data.data_environment_id AND head.state='retired' AND target.provider='neon') ORDER BY data.data_environment_id`;
export const SOURCE_HEAD = `SELECT 1 present FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='dev' AND active_deployment_id=?4 AND active_revision_id=?5 AND head_version=?6`;
export const PROMOTION_FENCE = `SELECT 1 present FROM environments source
 JOIN deployments deployment ON deployment.organization_id=source.organization_id AND deployment.project_id=source.project_id AND deployment.environment_id=source.environment_id AND deployment.deployment_id=?4 AND deployment.active_revision_id=?5 AND deployment.status='succeeded'
 JOIN deployment_revisions revision ON revision.organization_id=source.organization_id AND revision.project_id=source.project_id AND revision.deployment_id=?4 AND revision.revision_id=?5 AND revision.artifact_id=?6
 JOIN build_artifacts artifact ON artifact.organization_id=revision.organization_id AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id AND artifact.artifact_sha256=?7
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.environment_id=source.environment_id AND receipt.artifact_id=revision.artifact_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
 WHERE source.organization_id=?1 AND source.project_id=?2 AND source.environment_id=?3 AND source.name='dev' AND source.active_deployment_id=?4 AND source.active_revision_id=?5 AND source.head_version=?8`;

export const MAIL = `SELECT configured.domain FROM (
     SELECT sender.domain,0 AS priority FROM project_mail_domain_bindings domain
     INNER JOIN workspace_mail_domains sender ON sender.domain_id=domain.mail_domain_id AND sender.organization_id=domain.organization_id
     LEFT JOIN project_application_domain_identities identity ON identity.project_id=domain.project_id AND identity.organization_id=domain.organization_id
     INNER JOIN projects ownership
       ON ownership.organization_id=domain.organization_id
      AND ownership.project_id=domain.project_id AND ownership.owner_state='active'
     WHERE domain.organization_id=?1 AND domain.project_id=?2 AND domain.sending AND domain.state='active' AND sender.status='active'
       AND(domain.legacy OR(identity.state='verified' AND identity.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND identity.revision=domain.application_identity_revision AND identity.registrable_domain=sender.registrable_domain))
       AND EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3)
     UNION ALL
     SELECT receiver.domain,1 AS priority FROM resend_mail_domains receiver
     JOIN workspace_mail_domains sender ON sender.legacy_domain_id=receiver.domain_id AND sender.organization_id=receiver.organization_id AND sender.status='active'
     JOIN projects ownership ON ownership.organization_id=receiver.organization_id AND ownership.project_id=receiver.project_id AND ownership.owner_state='active'
     JOIN projects project ON project.project_id=receiver.project_id AND project.lifecycle_state='active'
     JOIN environments production ON production.organization_id=receiver.organization_id AND production.project_id=receiver.project_id AND production.environment_id=receiver.environment_id AND production.name='prod'
     WHERE receiver.organization_id=?1 AND receiver.project_id=?2 AND receiver.deleted_at IS NULL AND receiver.receiving AND receiver.webhook_verified_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3)
     ) configured ORDER BY configured.priority LIMIT 1`;

export const ABANDONED = `SELECT candidate.candidate_receipt_id,candidate.operation_id,
            candidate.product_deployment_id,candidate.dispatch_namespace,
            candidate.immutable_script_name,candidate.artifact_sha256,candidate.binding_set_digest,candidate.provider_tag,
            candidate.build_reused,candidate.staged_at,plan.framework_plan,
            old_run.intermediate_evidence -> '$.providerReconciliationHint.activationRuntimePolicy' runtime_policy
     FROM wfp_candidate_receipts candidate
     JOIN environments environment ON environment.organization_id=candidate.organization_id
       AND environment.project_id=candidate.project_id AND environment.environment_id=candidate.environment_id
     JOIN product_provider_mutation_claims claim ON claim.organization_id=candidate.organization_id
       AND claim.project_id=candidate.project_id AND claim.environment_id=candidate.environment_id
       AND claim.operation_id=?4 AND claim.event_type IN ('DeploymentRequestedV1','DeploymentPromotionRequestedV1')
     JOIN operations current_operation ON current_operation.organization_id=claim.organization_id
       AND current_operation.project_id=claim.project_id AND current_operation.operation_id=claim.operation_id
       AND current_operation.billing_epoch_id=claim.billing_epoch_id AND current_operation.state IN ('queued','running')
     JOIN product_workflow_runs current_run ON current_run.workflow_id=claim.logical_workflow_id
       AND current_run.organization_id=claim.organization_id AND current_run.project_id=claim.project_id
       AND current_run.environment_id=claim.environment_id AND current_run.operation_id=claim.operation_id
       AND current_run.billing_epoch_id=claim.billing_epoch_id AND current_run.event_id=claim.event_id
       AND current_run.event_type=claim.event_type AND current_run.state IN ('queued','reconciliation_required')
     JOIN projects ownership ON ownership.organization_id=claim.organization_id
       AND ownership.project_id=claim.project_id AND ownership.active_billing_epoch_id=claim.billing_epoch_id
       AND ownership.owner_state='active'
     JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id AND project.lifecycle_state='active'
       AND project.lifecycle_version=claim.accepted_lifecycle_version
     JOIN operations old_operation ON old_operation.organization_id=candidate.organization_id
       AND old_operation.project_id=candidate.project_id AND old_operation.operation_id=candidate.operation_id
       AND old_operation.billing_epoch_id=claim.billing_epoch_id AND old_operation.state='failed'
       AND json_extract(old_operation.failure,'$.code')='OPERATION_ABANDONED'
     JOIN product_workflow_runs old_run ON old_run.organization_id=candidate.organization_id
       AND old_run.project_id=candidate.project_id AND old_run.environment_id=candidate.environment_id
       AND old_run.operation_id=candidate.operation_id AND old_run.billing_epoch_id=claim.billing_epoch_id
       AND old_run.event_type IN ('DeploymentRequestedV1','DeploymentPromotionRequestedV1') AND old_run.state='completed'
     JOIN deployments deployment ON deployment.organization_id=candidate.organization_id
       AND deployment.project_id=candidate.project_id AND deployment.operation_id=candidate.operation_id
       AND deployment.deployment_id=candidate.product_deployment_id AND deployment.status='failed'
     JOIN build_artifacts artifact ON artifact.organization_id=candidate.organization_id
       AND artifact.project_id=candidate.project_id AND artifact.artifact_id=candidate.artifact_id
       AND artifact.artifact_sha256=candidate.artifact_sha256
     JOIN build_executions build ON build.organization_id=artifact.organization_id
       AND build.project_id=artifact.project_id AND build.build_execution_id=artifact.build_execution_id
     JOIN product_command_intents build_intent ON build_intent.organization_id=build.organization_id
       AND build_intent.project_id=build.project_id AND build_intent.operation_id=build.operation_id
       AND build_intent.event_type='DeploymentRequestedV1'
     JOIN deployment_plans plan ON plan.organization_id=build_intent.organization_id
       AND plan.project_id=build_intent.project_id AND plan.plan_id=build_intent.plan_id
     WHERE candidate.organization_id=?1 AND candidate.project_id=?2 AND candidate.environment_id=?3
       AND candidate.operation_id<>?4 AND environment.active_deployment_id IS NULL
       AND environment.active_revision_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM wfp_publish_receipts published
         WHERE published.candidate_receipt_id=candidate.candidate_receipt_id)
       AND NOT EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup
         WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
       AND NOT EXISTS (SELECT 1 FROM wfp_candidate_cleanup_requests cleanup
         WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)
     ORDER BY candidate.staged_at DESC,candidate.candidate_receipt_id DESC LIMIT 10
`;

export const CONSENT = `SELECT repository_id FROM github_repository_link_consents
 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND billing_epoch_id=?5 AND installation_id=?6 AND repository_owner=?7 AND repository_name=?8
 UNION ALL SELECT repository_id FROM github_source_authorizations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND billing_epoch_id=?5 AND state='authorized' AND installation_id=?6 AND repository_owner=?7 AND repository_name=?8`;
