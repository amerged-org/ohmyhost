import { z } from "zod";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { resolveNativeAuthAuthority } from "./native-auth-authority.js";

const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  deploymentId: ulid,
  provider: z.enum(["google", "github"]),
  configurationRevision: z.number().int().positive().max(2_147_483_647),
  revocationEpoch: z.number().int().positive().max(2_147_483_647),
});

/** Record only a completed verified provider flow on its exact current deployment and configuration. */
export async function recordNativeAuthProviderSuccess(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const scope = {
    projectId: i.projectId,
    environmentId: i.environmentId,
    deploymentId: i.deploymentId,
  };
  const before = await resolveNativeAuthAuthority(context, scope);
  if (
    before.organizationId !== i.organizationId ||
    !before.enabled ||
    !before.sourceCapable ||
    !before.paidAllowed ||
    !before.runtimeAllowed ||
    before.realm.configurationRevision !== i.configurationRevision ||
    before.revocationEpoch !== i.revocationEpoch
  )
    throw new Error("auth_unavailable");
  await db.batch([
    db
      .prepare(
        `UPDATE native_auth_providers SET last_success_at=CASE WHEN last_success_at IS NULL OR last_success_at<(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') ELSE last_success_at END
      WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider=?4 AND enabled=1
      AND EXISTS(SELECT 1 FROM native_auth_realms r JOIN projects p USING(organization_id,project_id)
        JOIN environments e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.environment_id=r.environment_id
        WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.enabled=1 AND r.configuration_revision=?5 AND r.revocation_epoch=?6
          AND p.owner_state='active' AND p.lifecycle_state='active' AND e.active_deployment_id=?7)`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.environmentId,
        i.provider,
        i.configurationRevision,
        i.revocationEpoch,
        i.deploymentId,
      ),
    guard(db, "precondition_changed", "changes()=0"),
  ]);
  const after = await resolveNativeAuthAuthority(context, scope);
  if (
    after.organizationId !== i.organizationId ||
    !after.enabled ||
    !after.sourceCapable ||
    !after.paidAllowed ||
    !after.runtimeAllowed ||
    after.realm.configurationRevision !== i.configurationRevision ||
    after.revocationEpoch !== before.revocationEpoch
  )
    throw new Error("auth_unavailable");
}
