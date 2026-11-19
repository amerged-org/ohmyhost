import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";

const scope = z.strictObject({ organizationId: ulid, projectId: ulid });
const target = scope.extend({
  providerProjectId: z.string().min(1),
  databaseId: z.string().min(1),
  providerOperationId: z.string().min(1),
  regionId: z.enum(["us-dev", "eu-dev"]),
  sizeClassId: z.literal("r256-s500m"),
  targetVersion: z.number().int().positive(),
});
export type NativeAuthTarget = z.output<typeof target>;

/** One current-owner Auth database identity. This read grants no provider, credential, or mutation authority. */
export async function readNativeAuthTarget(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      `SELECT t.provider_project_id,t.database_id,t.provider_operation_id,t.region_id,t.size_class_id,t.target_version
    FROM native_auth_database_targets t JOIN projects p ON p.project_id=t.project_id AND p.organization_id=?1
    JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
    JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id
      AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
    WHERE t.project_id=?2 AND t.ended_at IS NULL AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')`,
    )
    .bind(i.organizationId, i.projectId)
    .first();
  return row === null
    ? null
    : target.parse({
        organizationId: i.organizationId,
        projectId: i.projectId,
        providerProjectId: String(row["provider_project_id"]),
        databaseId: String(row["database_id"]),
        providerOperationId: String(row["provider_operation_id"]),
        regionId: String(row["region_id"]),
        sizeClassId: String(row["size_class_id"]),
        targetVersion: Number(row["target_version"]),
      });
}
