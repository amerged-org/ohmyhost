import { z } from "zod";
import { ulid, type CatalogContext } from "../common.js";
import {
  runStorage,
  scopeInput,
  digestInput,
  hex,
  blocked,
  dataAt,
  StorageGatewayBindingChangedError,
  StorageGatewayDataChangeInProgressError,
  type Row,
} from "./common.js";
const input = z.strictObject({
  scope: scopeInput.nullable(),
  input: z.strictObject({
    projectId: ulid,
    environmentId: ulid,
    keySha256: digestInput,
    dataEnvironmentId: ulid.optional(),
  }),
});
const AUTH = `SELECT key.organization_id,key.project_id,key.environment_id,bucket.bucket_name,bucket.jurisdiction,${dataAt("key.organization_id", "key.project_id", "key.environment_id")} data_environment_id,${blocked("key.organization_id", "key.project_id", "key.environment_id")} data_change_blocked FROM storage_gateway_keys key JOIN project_r2_bucket_receipts bucket USING(organization_id,project_id,environment_id) JOIN projects p ON p.organization_id=key.organization_id AND p.project_id=key.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE key.project_id=?1 AND key.environment_id=?2 AND key.key_sha256=unhex(?3) AND key.key_version=(SELECT MAX(latest.key_version) FROM storage_gateway_keys latest WHERE latest.organization_id=key.organization_id AND latest.project_id=key.project_id AND latest.environment_id=key.environment_id) AND NOT EXISTS(SELECT 1 FROM storage_gateway_keys other WHERE other.project_id=key.project_id AND other.environment_id<>key.environment_id AND other.key_sha256=key.key_sha256)`;
function decode(r: Row | null, dataId: string | undefined) {
  if (r && dataId !== undefined && r["data_environment_id"] !== dataId)
    throw new StorageGatewayBindingChangedError();
  if (r?.["data_change_blocked"]) throw new StorageGatewayDataChangeInProgressError();
  return r
    ? {
        organizationId: String(r["organization_id"]),
        projectId: String(r["project_id"]),
        environmentId: String(r["environment_id"]),
        bucketName: String(r["bucket_name"]),
        jurisdiction: r["jurisdiction"] as "eu" | "us",
        quotaBytes: 1073741824,
        dataEnvironmentId: ulid.parse(r["data_environment_id"]),
      }
    : null;
}
export async function authenticateStorageGateway(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    params = [i.input.projectId, i.input.environmentId, hex(i.input.keySha256)];
  if (i.scope === null) {
    const { db } = await context.router.routeShard(0);
    return decode(
      await db
        .prepare(AUTH)
        .bind(...params)
        .first<Row>(),
      i.input.dataEnvironmentId,
    );
  }
  return runStorage(
    context,
    i.scope,
    "storage.authenticate",
    i,
    async () => null,
    (db) => ({
      statements: [db.prepare(AUTH).bind(...params)],
      result: (r) => {
        const identity = decode(r[0]?.results[0] ?? null, i.input.dataEnvironmentId);
        return identity &&
          identity.organizationId === i.scope?.organizationId &&
          identity.projectId === i.scope.projectId &&
          identity.environmentId === i.scope.environmentId &&
          identity.dataEnvironmentId === i.scope.dataEnvironmentId
          ? identity
          : null;
      },
    }),
  );
}
