import { z } from "zod";
import { AI_KEY_NAME, type AiKeyScope } from "@ohmyhost/platform/shared";
import { type CatalogContext, ulid } from "../common.js";
import { aiInput, aiJurisdiction } from "./common.js";

const authorizeKeyInput = z.strictObject({
  projectId: ulid,
  keySha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

/**
 * The gateway key of a project: an `OHMYHOST_AI_KEY` environment secret whose SHA-256 is the digest. The digest must be
 * unique among the project's rows of that name (Dev and Prod cannot share a key), the project must be active under active
 * ownership and the environment's active revision must declare `ai` in its plan. The jurisdiction is the one that plan
 * declares, so a later head or a rollback to an older revision decides it. Null for an unknown, retired, ambiguous or
 * not-AI key. The digest is counted among the current owner's rows only: a former owner's retained copy is no ambiguity.
 * No plaintext key crosses this call.
 */
export async function authorizeAiKey(
  context: CatalogContext,
  raw: unknown,
): Promise<AiKeyScope | null> {
  const input = aiInput(authorizeKeyInput, raw);
  await context.router.assertLayout();
  const rows = (
    await context.directory
      .prepare(
        `SELECT s.organization_id, s.project_id, s.environment_id, json_extract(plan.framework_plan, '$.ai.jurisdiction') AS jurisdiction FROM environment_secrets s
 JOIN projects p ON p.organization_id = s.organization_id AND p.project_id = s.project_id AND p.owner_state = 'active' AND p.lifecycle_state = 'active'
 JOIN environments e ON e.organization_id = s.organization_id AND e.project_id = s.project_id AND e.environment_id = s.environment_id
 JOIN deployment_revisions r ON r.organization_id = e.organization_id AND r.project_id = e.project_id AND r.deployment_id = e.active_deployment_id AND r.revision_id = e.active_revision_id
 JOIN deployment_plans plan ON plan.organization_id = r.organization_id AND plan.project_id = r.project_id AND plan.plan_id = r.plan_id
 WHERE s.project_id = ?1 AND s.name = ?2 AND s.value_sha256 = unhex(?3) AND json_extract(plan.framework_plan, '$.ai.enabled') = 1
 AND (SELECT COUNT(*) FROM environment_secrets other JOIN projects op ON op.organization_id = other.organization_id AND op.project_id = other.project_id AND op.owner_state <> 'transferred'
   WHERE other.project_id = s.project_id AND other.name = s.name AND other.value_sha256 = s.value_sha256) = 1`,
      )
      .bind(input.projectId, AI_KEY_NAME, input.keySha256)
      .all<{
        organization_id: string;
        project_id: string;
        environment_id: string;
        jurisdiction: string | null;
      }>()
  ).results;
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  const jurisdiction = aiJurisdiction.safeParse(row.jurisdiction);
  if (!jurisdiction.success) return null;
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    jurisdiction: jurisdiction.data,
  };
}
