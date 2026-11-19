import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { DB_NOW } from "./shared.js";

const inputSchema = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  exportId: ulid,
});
const unavailable = (): never => {
  throw new Error("recovery_cleanup_scope_unavailable");
};

/** Original readProjectRecoveryCleanupTarget: a stored archive and its EXACT frozen deletion-inventory locator.
 * A transferred project's old organization may own the archive row; the new owner's accepted inventory must still
 * explicitly name it. No key, prefix, bucket or provider identity is accepted from the caller. */
export async function readRecoveryCleanupTarget(
  context: CatalogContext,
  raw: unknown,
): Promise<{
  exportId: string;
  bucket: string;
  key: string;
  nativeEffect?: {
    state: "reserved" | "dispatched" | "verified" | "tombstoned" | "absent";
    bytes: number;
    sha256: string;
  };
}> {
  const input = inputSchema.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  if (input.operationId === input.exportId) {
    const effect = await db
      .prepare(
        `SELECT bucket,object_key,state,archive_bytes,lower(hex(archive_sha256)) sha256 FROM native_export_effects
      WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND expires_at <= ${DB_NOW}`,
      )
      .bind(input.organizationId, input.projectId, input.operationId)
      .first<{
        bucket: string;
        object_key: string;
        state: "reserved" | "dispatched" | "verified" | "tombstoned" | "absent";
        archive_bytes: number;
        sha256: string;
      }>();
    if (
      !effect ||
      effect.object_key !==
        `native-exports/${input.organizationId}/${input.projectId}/${input.operationId}.zip` ||
      !/^ohmyho-(development|production)-backups$/u.test(effect.bucket)
    )
      return unavailable();
    return {
      exportId: input.exportId,
      bucket: effect.bucket,
      key: effect.object_key,
      nativeEffect: { state: effect.state, bytes: effect.archive_bytes, sha256: effect.sha256 },
    };
  }
  const params = [input.organizationId, input.projectId, input.operationId];
  const [targets, inventory] = await db.batch([
    db
      .prepare(
        `SELECT job.archive_bucket,COALESCE(effect.object_key,job.archive_key) AS archive_key,job.native_manifest AS job_native_manifest,effect.state AS effect_state,effect.archive_bytes AS effect_bytes,lower(hex(effect.archive_sha256)) AS effect_sha256 FROM product_command_intents intent
      JOIN projects project ON project.organization_id=intent.organization_id AND project.project_id=intent.project_id
        AND project.lifecycle_state='deleting' AND project.owner_state='active'
      JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id
        AND operation.operation_id=intent.operation_id AND operation.state IN ('queued','running')
      JOIN cleanup_runs cleanup ON cleanup.organization_id=intent.organization_id AND cleanup.project_id=intent.project_id
        AND cleanup.operation_id=intent.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id AND cleanup.state IN ('pending','running')
      JOIN project_recovery_jobs job ON job.project_id=project.project_id AND job.operation_id=?4 AND job.archive_bytes IS NOT NULL
      LEFT JOIN native_export_effects effect ON effect.organization_id=job.organization_id AND effect.project_id=job.project_id AND effect.operation_id=job.operation_id
      WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.operation_id=?3 AND intent.event_type='ProjectDeletionRequestedV1'
        AND (effect.operation_id IS NULL OR (intent.billing_epoch_id=project.active_billing_epoch_id AND cleanup.state='running'))`,
      )
      .bind(...params, input.exportId),
    db
      .prepare(
        "SELECT cleanup_locator FROM run_resource_inventory WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND provider='cloudflare' AND resource_kind='sql-export'",
      )
      .bind(...params),
  ]);
  const row = targets?.results[0];
  if (
    targets?.results.length !== 1 ||
    typeof row?.["archive_bucket"] !== "string" ||
    typeof row["archive_key"] !== "string"
  )
    return unavailable();
  const bucket = row["archive_bucket"],
    key = row["archive_key"];
  if (
    !/^ohmyho-(development|production)-backups$/u.test(bucket) ||
    key.length === 0 ||
    key.length > 1024
  )
    return unavailable();
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(`${bucket}/${key}`)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (
    inventory?.results.filter((item) => item["cleanup_locator"] === `encoded/${encoded}`).length !==
    1
  )
    return unavailable();
  const state = row["effect_state"];
  if (row["job_native_manifest"] != null && state == null) return unavailable();
  if (state !== null && state !== undefined) {
    if (
      (state !== "reserved" &&
        state !== "dispatched" &&
        state !== "verified" &&
        state !== "tombstoned" &&
        state !== "absent") ||
      typeof row["effect_bytes"] !== "number" ||
      typeof row["effect_sha256"] !== "string"
    )
      return unavailable();
    return {
      exportId: input.exportId,
      bucket,
      key,
      nativeEffect: { state, bytes: row["effect_bytes"], sha256: row["effect_sha256"] },
    };
  }
  return { exportId: input.exportId, bucket, key };
}

/** Record an exact Native retirement only under the frozen deletion authority. */
export async function recordNativeExportRetired(
  context: CatalogContext,
  raw: unknown,
): Promise<{ outcome: "recorded" | "replayed" }> {
  const input = inputSchema.extend({ outcome: z.enum(["tombstoned", "absent"]) }).parse(raw);
  const target = await readRecoveryCleanupTarget(context, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    operationId: input.operationId,
    exportId: input.exportId,
  });
  if (!target.nativeEffect) return unavailable();
  const { db } = await routeOrganization(context, input.organizationId);
  const locator = `encoded/${Buffer.from(`${target.bucket}/${target.key}`).toString("base64url")}`;
  const result = await db
    .prepare(
      `UPDATE native_export_effects SET state=?5 WHERE project_id=?2 AND operation_id=?4 AND bucket=?6 AND object_key=?7 AND state IN ('reserved','dispatched','verified')
    AND ((?3=?4 AND organization_id=?1 AND expires_at <= ${DB_NOW}) OR EXISTS(SELECT 1 FROM product_command_intents i JOIN projects p ON p.organization_id=i.organization_id AND p.project_id=i.project_id AND p.owner_state='active' AND p.lifecycle_state='deleting' AND p.active_billing_epoch_id=i.billing_epoch_id JOIN operations o ON o.organization_id=i.organization_id AND o.project_id=i.project_id AND o.operation_id=i.operation_id AND o.state IN('queued','running') JOIN cleanup_runs c ON c.organization_id=i.organization_id AND c.project_id=i.project_id AND c.operation_id=i.operation_id AND c.cleanup_run_id=i.cleanup_run_id AND c.state='running' JOIN run_resource_inventory inv ON inv.organization_id=i.organization_id AND inv.project_id=i.project_id AND inv.operation_id=i.operation_id AND inv.provider='cloudflare' AND inv.resource_kind='sql-export' AND inv.cleanup_locator=?8 WHERE i.organization_id=?1 AND i.project_id=?2 AND i.operation_id=?3 AND i.event_type='ProjectDeletionRequestedV1'))`,
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.operationId,
      input.exportId,
      input.outcome,
      target.bucket,
      target.key,
      locator,
    )
    .run();
  if (result.meta.changes === 1) return { outcome: "recorded" };
  if (target.nativeEffect.state === input.outcome) return { outcome: "replayed" };
  return unavailable();
}
