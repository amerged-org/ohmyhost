import { z } from "zod";

import { instant, type CatalogContext } from "../common.js";

const removedIds = z.array(z.number().int().positive().safe()).max(1000);
const input = z
  .strictObject({
    installationId: z.number().int().positive().safe(),
    action: z.enum(["deleted", "suspended", "repositories_removed"]),
    removedRepositoryIds: removedIds,
    now: instant,
  })
  .refine((value) =>
    value.action === "repositories_removed"
      ? value.removedRepositoryIds.length > 0
      : value.removedRepositoryIds.length === 0,
  );

const REASON = {
  deleted: "installation_uninstalled",
  suspended: "permission_revoked",
  repositories_removed: "repository_removed",
} as const;

/**
 * Applies one withdrawing GitHub installation event. An uninstall or suspension disconnects the installation's
 * workspace connections and revokes every grant of the installation; removed repositories revoke only their own
 * grants. Each grant gets one revocation row (revocation_id = grant_id), so a repeated event changes nothing.
 * Installations are global: the rows live on the one shared Core partition, as the push ledger does.
 */
export async function revokeGithubInstallationAccess(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw);
  await context.router.assertLayout();
  const { db } = await context.router.routeShard(0),
    installation = String(i.installationId),
    removed = JSON.stringify(i.removedRepositoryIds.map(String));
  const statements = [];
  if (i.action !== "repositories_removed") {
    statements.push(
      db
        .prepare(
          "UPDATE github_organization_connections SET revoked_at=?2 WHERE installation_id=?1 AND revoked_at IS NULL",
        )
        .bind(installation, i.now),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO repository_grant_revocations(organization_id,revocation_id,grant_id,project_id,reason,revoked_at)
         SELECT g.organization_id,g.grant_id,g.grant_id,g.project_id,?2,?3 FROM repository_grants g
         WHERE g.provider='github' AND g.github_installation_id=?1
           AND (?4 = '[]' OR g.external_repository_id IN (SELECT value FROM json_each(?4)))
         ON CONFLICT DO NOTHING`,
      )
      .bind(installation, REASON[i.action], i.now, removed),
  );
  await db.batch(statements);
  return { status: "applied" as const };
}
