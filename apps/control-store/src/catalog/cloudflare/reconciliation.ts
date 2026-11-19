import { z } from "zod";
import { instant, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readCloudflareProjectDomains } from "../domains-mail/cloudflare-project-domains.js";
import { generalCloudflareGrantDto } from "./authorization.js";
const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  deploymentId: ulid,
  environmentName: z.enum(["dev", "prod"]),
  gatewayScriptName: z.string(),
  healthCheckPath: z.string(),
});
const AUTHORIZED = `SELECT 1 FROM product_command_intents intent
     INNER JOIN operations operation
       ON operation.organization_id=intent.organization_id
      AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
     INNER JOIN projects project ON project.project_id=intent.project_id
     INNER JOIN environments environment
      ON environment.organization_id=intent.organization_id
      AND environment.project_id=intent.project_id AND environment.environment_id=intent.environment_id
     INNER JOIN deployments deployment
       ON deployment.organization_id=intent.organization_id
      AND deployment.project_id=intent.project_id AND deployment.deployment_id=intent.deployment_id
     LEFT JOIN deployment_revisions promotion_revision
       ON intent.event_type='DeploymentPromotionRequestedV1'
      AND promotion_revision.organization_id=intent.organization_id
      AND promotion_revision.project_id=intent.project_id
      AND promotion_revision.deployment_id=intent.source_deployment_id
      AND promotion_revision.revision_id=intent.source_revision_id
      AND promotion_revision.artifact_id=intent.source_artifact_id
     LEFT JOIN deployment_revisions rollback_revision
       ON intent.event_type='DeploymentRollbackRequestedV1'
      AND rollback_revision.organization_id=intent.organization_id
      AND rollback_revision.project_id=intent.project_id
      AND rollback_revision.deployment_id=intent.target_deployment_id
      AND rollback_revision.revision_id=intent.target_revision_id
      AND rollback_revision.artifact_id=intent.target_artifact_id
     LEFT JOIN wfp_publish_receipts rollback_published
       ON intent.event_type='DeploymentRollbackRequestedV1'
      AND rollback_published.organization_id=rollback_revision.organization_id
      AND rollback_published.project_id=rollback_revision.project_id
      AND rollback_published.wfp_receipt_id=rollback_revision.wfp_receipt_id
     INNER JOIN deployment_plans plan
       ON plan.organization_id=intent.organization_id AND plan.project_id=intent.project_id
      AND plan.plan_id=CASE intent.event_type
        WHEN 'DeploymentRequestedV1' THEN intent.plan_id
        WHEN 'DeploymentPromotionRequestedV1' THEN promotion_revision.plan_id
        WHEN 'DeploymentRollbackRequestedV1' THEN rollback_revision.plan_id END
     INNER JOIN product_provider_mutation_claims claim
       ON claim.organization_id=intent.organization_id AND claim.project_id=intent.project_id
      AND claim.environment_id=intent.environment_id AND claim.operation_id=intent.operation_id
      AND claim.event_type=intent.event_type
     INNER JOIN wfp_candidate_receipts candidate
       ON candidate.organization_id=intent.organization_id
      AND candidate.project_id=intent.project_id AND candidate.environment_id=intent.environment_id
      AND ((intent.event_type='DeploymentRollbackRequestedV1'
            AND candidate.candidate_receipt_id=rollback_published.candidate_receipt_id)
        OR (intent.event_type<>'DeploymentRollbackRequestedV1'
            AND candidate.operation_id=intent.operation_id
            AND candidate.product_deployment_id=intent.deployment_id))
     INNER JOIN cloudflare_project_domains domain
       ON domain.organization_id=intent.organization_id AND domain.project_id=intent.project_id
      AND domain.deleted_at IS NULL
     WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3
       AND intent.operation_id=?4
       AND ?5=CASE intent.event_type WHEN 'DeploymentRollbackRequestedV1'
         THEN intent.target_deployment_id ELSE intent.deployment_id END
       AND intent.event_type IN ('DeploymentRequestedV1','DeploymentPromotionRequestedV1','DeploymentRollbackRequestedV1')
       AND operation.state IN ('queued','running') AND project.lifecycle_state='active'
       AND project.owner_state='active' AND project.organization_id=intent.organization_id AND deployment.status IN ('running','reconciliation_required')
       AND plan.framework_plan->'runtimePolicy'->>'healthCheckPath'=?6
       AND environment.name=?7
       AND ?8=CASE WHEN domain.production_domain=domain.handle||'.check.omh.st' THEN 'ohmyho-gateway-production' WHEN domain.production_domain IN(domain.handle||'.dev.check.omh.st',domain.handle||'.poc.aixyte.com') THEN 'ohmyho-gateway-poc-private-fullstack' END
       AND (intent.event_type='DeploymentRequestedV1'
         OR (intent.event_type='DeploymentPromotionRequestedV1'
           AND candidate.artifact_id=intent.source_artifact_id)
         OR (intent.event_type='DeploymentRollbackRequestedV1'
           AND candidate.artifact_id=intent.target_artifact_id))
       AND NOT EXISTS (SELECT 1 FROM wfp_candidate_cleanup_receipts cleanup
         WHERE cleanup.candidate_receipt_id=candidate.candidate_receipt_id)`;

/** Original accepted candidate/framework-health/gateway tuple; provider work remains in the management Worker. */
export async function readGeneralCloudflareReconciliation(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const authorized = await db
    .prepare(AUTHORIZED)
    .bind(
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
      i.deploymentId,
      i.healthCheckPath,
      i.environmentName,
      i.gatewayScriptName,
    )
    .first();
  if (!authorized) return null;
  const domains = await readCloudflareProjectDomains(context, {
    organizationId: i.organizationId,
    projectId: i.projectId,
  });
  return domains ? { domains } : null;
}
export async function rotateGeneralCloudflareGrant(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        organizationId: ulid,
        projectId: ulid,
        authorizationId: ulid,
        expectedUpdatedAt: instant,
        accessCiphertext: z.instanceof(Uint8Array),
        accessNonce: z.instanceof(Uint8Array),
        refreshCiphertext: z.instanceof(Uint8Array),
        refreshNonce: z.instanceof(Uint8Array),
        keyVersion: z.number().int().min(1),
        accessExpiresAt: instant,
        rotatedAt: instant,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    db
      .prepare(
        "UPDATE cloudflare_project_dns_grants SET access_ciphertext=?5,access_nonce=?6,refresh_ciphertext=?7,refresh_nonce=?8,key_version=?9,access_expires_at=?10,updated_at=?11 WHERE organization_id=?1 AND project_id=?2 AND authorization_id=?3 AND updated_at=?4 AND status='active' AND scopes='[\"dns.write\",\"zone.read\"]' AND EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active') RETURNING *",
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.authorizationId,
        i.expectedUpdatedAt,
        i.accessCiphertext,
        i.accessNonce,
        i.refreshCiphertext,
        i.refreshNonce,
        i.keyVersion,
        i.accessExpiresAt,
        i.rotatedAt,
      ),
  ]);
  return generalCloudflareGrantDto(rows[0]?.results[0] ?? null);
}
