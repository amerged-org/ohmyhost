import { z } from "zod";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";

const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  restoreId: ulid,
});
const unavailable = (): never => {
  throw new Error("recovery_cleanup_scope_unavailable");
};

/** Resolve only the exact restore pin frozen by the current accepted project deletion. */
export async function readNativeRestorePinDeletionTarget(
  context: CatalogContext,
  raw: unknown,
): Promise<{ restoreId: string; bucket: string }> {
  const input = scope.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const rows = await db
    .prepare(
      `select pin.bucket,pin.object_key from native_auth_restore_pins pin
    join projects p on p.organization_id=pin.organization_id and p.project_id=pin.project_id and p.owner_state='active' and p.lifecycle_state='deleting'
    join product_command_intents i on i.organization_id=p.organization_id and i.project_id=p.project_id and i.operation_id=?3 and i.event_type='ProjectDeletionRequestedV1' and i.billing_epoch_id=p.active_billing_epoch_id
    join operations o on o.organization_id=i.organization_id and o.project_id=i.project_id and o.operation_id=i.operation_id and o.state in ('queued','running')
    join cleanup_runs c on c.organization_id=i.organization_id and c.project_id=i.project_id and c.operation_id=i.operation_id and c.cleanup_run_id=i.cleanup_run_id and c.state='running'
    where pin.organization_id=?1 and pin.project_id=?2 and pin.restore_id=?4 and pin.state='verified'`,
    )
    .bind(input.organizationId, input.projectId, input.operationId, input.restoreId)
    .all<{ bucket: string; object_key: string }>();
  const row = rows.results[0];
  if (
    rows.results.length !== 1 ||
    !row ||
    !/^ohmyho-(development|production)-backups$/u.test(row.bucket) ||
    row.object_key !==
      `restore-pins/${input.organizationId}/${input.projectId}/${input.restoreId}.zip`
  )
    return unavailable();
  const locator = `encoded/${Buffer.from(`${row.bucket}/${row.object_key}`).toString("base64url")}`;
  const inventory = await db
    .prepare(
      "select count(*) as n from run_resource_inventory where organization_id=?1 and project_id=?2 and operation_id=?3 and provider='cloudflare' and resource_kind='native-auth-restore-pin' and cleanup_locator=?4",
    )
    .bind(input.organizationId, input.projectId, input.operationId, locator)
    .first<{ n: number }>();
  if (inventory?.n !== 1) return unavailable();
  return { restoreId: input.restoreId, bucket: row.bucket };
}

/** Called only by the scoped private deletion executor after DELETE and a successful absence read. */
export async function recordNativeRestorePinDeletionAbsent(
  context: CatalogContext,
  raw: unknown,
): Promise<"recorded" | "replayed"> {
  const input = scope.parse(raw);
  const target = await readNativeRestorePinDeletionTarget(context, input);
  const { db } = await routeOrganization(context, input.organizationId);
  const key = `restore-pins/${input.organizationId}/${input.projectId}/${input.restoreId}.zip`;
  const locator = `encoded/${Buffer.from(`${target.bucket}/${key}`).toString("base64url")}`;
  const values = [
    input.organizationId,
    input.projectId,
    input.operationId,
    input.restoreId,
    target.bucket,
    key,
    locator,
  ];
  const proof = `select 1 from native_auth_restore_pins pin join projects p on p.organization_id=pin.organization_id and p.project_id=pin.project_id and p.owner_state='active' and p.lifecycle_state='deleting' join product_command_intents i on i.organization_id=p.organization_id and i.project_id=p.project_id and i.operation_id=?3 and i.event_type='ProjectDeletionRequestedV1' and i.billing_epoch_id=p.active_billing_epoch_id join operations o on o.organization_id=i.organization_id and o.project_id=i.project_id and o.operation_id=i.operation_id and o.state in('queued','running') join cleanup_runs c on c.organization_id=i.organization_id and c.project_id=i.project_id and c.operation_id=i.operation_id and c.cleanup_run_id=i.cleanup_run_id and c.state='running' join run_resource_inventory inv on inv.organization_id=i.organization_id and inv.project_id=i.project_id and inv.operation_id=i.operation_id and inv.provider='cloudflare' and inv.resource_kind='native-auth-restore-pin' and inv.cleanup_locator=?7 where pin.organization_id=?1 and pin.project_id=?2 and pin.restore_id=?4 and pin.bucket=?5 and pin.object_key=?6 and pin.state='verified'`;
  const existing = await db
    .prepare(
      "select bucket,object_key from native_auth_restore_pin_absences where organization_id=?1 and project_id=?2 and restore_id=?3",
    )
    .bind(input.organizationId, input.projectId, input.restoreId)
    .first<{ bucket: string; object_key: string }>();
  if (existing && (existing.bucket !== target.bucket || existing.object_key !== key))
    return unavailable();
  await db.batch([
    guard(db, "precondition_changed", `not exists(${proof})`, values),
    db
      .prepare(
        "insert into native_auth_restore_pin_absences(organization_id,project_id,restore_id,bucket,object_key,absent_at,source) values(?1,?2,?4,?5,?6,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'),'project-delete') on conflict(organization_id,project_id,restore_id) do nothing",
      )
      .bind(...values.slice(0, 6)),
    guard(
      db,
      "precondition_changed",
      "not exists(select 1 from native_auth_restore_pin_absences where organization_id=?1 and project_id=?2 and restore_id=?4 and bucket=?5 and object_key=?6)",
      values.slice(0, 6),
    ),
  ]);
  return existing ? "replayed" : "recorded";
}
