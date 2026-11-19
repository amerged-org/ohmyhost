import { BARRIER_FREE_MEMBERSHIP_SQL } from "./membership-barrier-sql.js";
import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { assertOperationDelegationCurrent } from "./operation-delegations.js";
const project = z.strictObject({ projectId: ulid }),
  scope = project.extend({ organizationId: ulid });
/** Current account-wide connection fence and memberships, read from one Core snapshot. */
export async function readMcpAuthorizedMemberships(context: CatalogContext, raw: unknown) {
  const input = z
    .strictObject({
      userId: z.string().min(1),
      clientId: z.string().min(1),
      consentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .parse(raw);
  const { db } = await context.router.routeShard(0);
  const results = await db.batch([
    db
      .prepare(
        `SELECT 1 FROM mcp_connection_revocations WHERE user_id=?1 AND client_id=?2 AND consent_hash=?3
      UNION ALL SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1 LIMIT 1`,
      )
      .bind(input.userId, input.clientId, input.consentHash),
    db
      .prepare(
        `SELECT m.organization_id FROM organization_memberships m JOIN organizations o USING(organization_id)
      WHERE m.workos_user_id=?1 AND m.state='active' AND o.state='active' AND o.beta_admitted_at IS NOT NULL
      AND ${BARRIER_FREE_MEMBERSHIP_SQL}
      AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=m.organization_id AND r.user_id=?1 AND r.client_id=?2 AND r.consent_hash=?3)
      AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=?1 AND r.client_id=?2 AND r.consent_hash=?3)
      AND NOT EXISTS(SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=?1) ORDER BY m.organization_id`,
      )
      .bind(input.userId, input.clientId, input.consentHash),
  ]);
  return {
    disconnected: (results[0]?.results.length ?? 0) > 0,
    organizationIds: (results[1]?.results ?? []).map((row) =>
      String((row as { organization_id: string }).organization_id),
    ),
  };
}
export async function readMcpEnvironmentName(context: CatalogContext, raw: unknown) {
  const input = scope.extend({ environmentId: ulid }).parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  return (
    (
      await db
        .prepare(
          "SELECT name FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(input.organizationId, input.projectId, input.environmentId)
        .first<{ name: string }>()
    )?.name ?? null
  );
}
export async function readMcpProjectOrganization(context: CatalogContext, raw: unknown) {
  const input = project.extend({ activeOnly: z.boolean() }).parse(raw);
  await context.router.assertLayout();
  return (
    (
      await context.directory
        .prepare(
          `SELECT organization_id FROM projects WHERE project_id=?1${input.activeOnly ? " AND owner_state='active'" : ""}`,
        )
        .bind(input.projectId)
        .first<{ organization_id: string }>()
    )?.organization_id ?? null
  );
}
/** Resolve a verified token's exact mail domain before intersecting current memberships. */
export async function readMcpMailDomainOrganization(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ mailDomainId: ulid }).parse(raw);
  const { db } = await context.router.routeShard(0);
  return (
    (
      await db
        .prepare("SELECT organization_id FROM workspace_mail_domains WHERE domain_id=?1")
        .bind(input.mailDomainId)
        .first<{ organization_id: string }>()
    )?.organization_id ?? null
  );
}
export async function readMcpGrantRevision(context: CatalogContext, raw: unknown) {
  const input = z
    .strictObject({
      grantId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
    })
    .parse(raw);
  await context.router.assertLayout();
  return (
    (
      await context.directory
        .prepare("SELECT CAST(revision AS TEXT) revision FROM mcp_client_grants WHERE grant_id=?")
        .bind(input.grantId)
        .first<{ revision: string }>()
    )?.revision ?? null
  );
}
/** Original recovery dispatch evidence, including exact two-key PostgreSQL JSONB equality of hello fallback. */
export async function readMcpRecoveryContext(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ operationId: ulid, organizationIds: z.array(ulid) }).parse(raw);
  await context.router.assertLayout();
  return (
    await context.directory
      .prepare(
        `SELECT operation.organization_id,operation.project_id,operation.state,COALESCE(intent.event_type,event.event_type) event_type,environment.name environment_name
 FROM operations operation JOIN projects project ON project.organization_id=operation.organization_id AND project.project_id=operation.project_id AND project.owner_state='active' AND project.active_billing_epoch_id=operation.billing_epoch_id AND project.lifecycle_state='active'
 LEFT JOIN product_command_intents intent ON intent.organization_id=operation.organization_id AND intent.project_id=operation.project_id AND intent.operation_id=operation.operation_id AND intent.billing_epoch_id=operation.billing_epoch_id
 LEFT JOIN environments environment ON environment.organization_id=intent.organization_id AND environment.project_id=intent.project_id AND environment.environment_id=intent.environment_id
 LEFT JOIN outbox_events event ON intent.operation_id IS NULL AND NOT EXISTS(SELECT 1 FROM product_command_intents competing WHERE competing.operation_id=operation.operation_id) AND event.organization_id=operation.organization_id AND event.project_id=operation.project_id AND event.operation_id=operation.operation_id AND event.billing_epoch_id=operation.billing_epoch_id AND event.event_type='ProjectProvisioningRequested' AND json_type(event.payload)='object' AND (SELECT count(*) FROM json_each(event.payload))=2 AND json_type(event.payload,'$.projectId')='text' AND json_type(event.payload,'$.operationId')='text' AND json_extract(event.payload,'$.projectId')=operation.project_id AND json_extract(event.payload,'$.operationId')=operation.operation_id
 WHERE operation.operation_id=?1 AND operation.organization_id IN(SELECT value FROM json_each(?2))`,
      )
      .bind(input.operationId, JSON.stringify(input.organizationIds))
      .all<{
        organization_id: string;
        project_id: string;
        state: string;
        event_type: string | null;
        environment_name: string | null;
      }>()
  ).results;
}
export async function authorizeMcpExecution(context: CatalogContext, raw: unknown): Promise<void> {
  const input = scope.extend({ operationId: ulid }).parse(raw);
  await assertOperationDelegationCurrent(context, {
    organizationId: input.organizationId,
    operationId: input.operationId,
  });
}
export async function readMcpPlanEnvironmentName(context: CatalogContext, raw: unknown) {
  const input = project.extend({ planId: ulid }).parse(raw);
  await context.router.assertLayout();
  return (
    (
      await context.directory
        .prepare(
          `SELECT environment.name FROM deployment_plans plan JOIN environments environment ON environment.environment_id=plan.environment_id WHERE plan.plan_id=?1 AND plan.project_id=?2`,
        )
        .bind(input.planId, input.projectId)
        .first<{ name: string }>()
    )?.name ?? null
  );
}
