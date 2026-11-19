import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { resolveNativeAuthAdminAuthority } from "./native-auth-authority.js";
import { nativeAuthEffectGuards } from "./native-auth-resource-operations.js";

const input = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  claimId: ulid,
});

/** Read owner policy for a specific live deployment claim before or after its head is published. */
export async function readNativeAuthProvisioningPolicy(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const scope = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
  };
  await db.batch(await nativeAuthEffectGuards(context, db, i));
  const before = await resolveNativeAuthAdminAuthority(context, scope);
  await db.batch(await nativeAuthEffectGuards(context, db, i));
  const after = await resolveNativeAuthAdminAuthority(context, scope);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("auth_unavailable");
  return after;
}
