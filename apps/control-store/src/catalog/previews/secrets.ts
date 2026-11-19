import { z } from "zod";
import { isUserSecretName } from "@ohmyhost/contracts/secret-names";
import type { CatalogContext } from "../common.js";
import { instant } from "../common.js";
import { bytesOf } from "../platform-support.js";
import { previewAuthorityFingerprint, runtimeFence } from "./common.js";
import { authorizePreviewRuntime } from "./runtime.js";

const platformKeys = new Set(["OHMYHOST_MAIL_KEY", "OHMYHOST_STORAGE_KEY", "OHMYHOST_AI_KEY"]);
const fence = runtimeFence.omit({ now: true, clock: true });
const input = z.strictObject({
  fence,
  names: z
    .array(z.string().max(128))
    .max(100)
    .refine(
      (names) =>
        new Set(names).size === names.length &&
        names.every((name) => platformKeys.has(name) || isUserSecretName(name)),
    ),
  now: instant.optional(),
  clock: z.literal("execution").optional(),
});
/** One private delivery service receives scoped ciphertext only; no arbitrary project or SQL is accepted. */
export async function readPreviewSecretEnvelopes(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    scope = {
      ...i.fence,
      ...(i.now ? { now: i.now } : {}),
      ...(i.clock ? { clock: i.clock } : {}),
    };
  const before = await authorizePreviewRuntime(context, scope);
  if (!before) throw new Error("preview_scope_unavailable");
  const rows = await context.directory
    .prepare(
      `SELECT name,ciphertext,nonce,value_sha256,key_version,revision FROM environment_secrets
 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name IN (SELECT value FROM json_each(?4)) ORDER BY name`,
    )
    .bind(before.organizationId, before.projectId, before.environmentId, JSON.stringify(i.names))
    .all<Record<string, unknown>>();
  const after = await authorizePreviewRuntime(context, scope);
  if (!after || previewAuthorityFingerprint(after) !== previewAuthorityFingerprint(before))
    throw new Error("preview_scope_unavailable");
  return {
    preview: after,
    envelopes: rows.results.map((r) => ({
      organizationId: after.organizationId,
      projectId: after.projectId,
      environmentId: after.environmentId,
      name: String(r["name"]),
      ciphertext: bytesOf(r["ciphertext"]),
      nonce: bytesOf(r["nonce"]),
      valueSha256: bytesOf(r["value_sha256"]),
      keyVersion: Number(r["key_version"]),
      revision: Number(r["revision"]),
    })),
  };
}

/** Customer-managed names only; reserved platform names never appear in this list. */
export async function listPreviewCustomerSecretNames(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({ fence, now: instant.optional(), clock: z.literal("execution").optional() })
    .parse(raw);
  const scope = {
    ...i.fence,
    ...(i.now ? { now: i.now } : {}),
    ...(i.clock ? { clock: i.clock } : {}),
  };
  const before = await authorizePreviewRuntime(context, scope);
  if (!before) throw new Error("preview_scope_unavailable");
  const rows = await context.directory
    .prepare(
      "SELECT name FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 ORDER BY name",
    )
    .bind(before.organizationId, before.projectId, before.environmentId)
    .all<{ name: string }>();
  const after = await authorizePreviewRuntime(context, scope);
  if (!after || previewAuthorityFingerprint(after) !== previewAuthorityFingerprint(before))
    throw new Error("preview_scope_unavailable");
  return rows.results.map((r) => r.name).filter((name) => isUserSecretName(name));
}
