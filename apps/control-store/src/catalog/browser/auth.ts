import { z } from "zod";
import { BROWSER_KEY_NAME, type BrowserKeyScope } from "@ohmyhost/platform/shared";
import { type CatalogContext, ulid } from "../common.js";
import { browserInput } from "./common.js";
const inputSchema = z.strictObject({
  projectId: ulid,
  keySha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
/** A unique current project/environment key whose active deployment explicitly enables Browser. */
export async function authorizeBrowserKey(
  context: CatalogContext,
  raw: unknown,
): Promise<BrowserKeyScope | null> {
  const input = browserInput(inputSchema, raw);
  await context.router.assertLayout();
  const rows = (
    await context.directory
      .prepare(
        `SELECT s.organization_id,s.project_id,s.environment_id,CAST(s.revision AS INTEGER) key_revision,
 e.active_deployment_id,e.active_revision_id,CAST(p.ownership_version AS INTEGER) ownership_version,p.active_billing_epoch_id FROM environment_secrets s
 JOIN projects p ON p.organization_id=s.organization_id AND p.project_id=s.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
 JOIN environments e ON e.organization_id=s.organization_id AND e.project_id=s.project_id AND e.environment_id=s.environment_id
 JOIN deployment_revisions r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.deployment_id=e.active_deployment_id AND r.revision_id=e.active_revision_id
 JOIN deployment_plans plan ON plan.organization_id=r.organization_id AND plan.project_id=r.project_id AND plan.plan_id=r.plan_id
 WHERE s.project_id=?1 AND s.name=?2 AND s.value_sha256=unhex(?3) AND json_extract(plan.framework_plan,'$.browser.enabled')=1
 AND (SELECT COUNT(*) FROM environment_secrets other JOIN projects op ON op.organization_id=other.organization_id AND op.project_id=other.project_id AND op.owner_state<>'transferred'
 WHERE other.project_id=s.project_id AND other.name=s.name AND other.value_sha256=s.value_sha256)=1`,
      )
      .bind(input.projectId, BROWSER_KEY_NAME, input.keySha256)
      .all<{
        organization_id: string;
        project_id: string;
        environment_id: string;
        key_revision: number;
        active_deployment_id: string;
        active_revision_id: string;
        ownership_version: number;
        active_billing_epoch_id: string;
      }>()
  ).results;
  const row = rows[0];
  return rows.length === 1 && row
    ? {
        organizationId: row.organization_id,
        projectId: row.project_id,
        environmentId: row.environment_id,
        keySha256: input.keySha256,
        keyRevision: row.key_revision,
        deploymentId: row.active_deployment_id,
        revisionId: row.active_revision_id,
        ownershipVersion: row.ownership_version,
        billingEpochId: row.active_billing_epoch_id,
      }
    : null;
}
