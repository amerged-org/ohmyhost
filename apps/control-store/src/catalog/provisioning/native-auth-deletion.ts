import { z } from "zod";
import { guard } from "../../guards.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { inventoryDigest } from "./lifecycle-inventory.js";

const deletionRealm = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  registryVersion: z.number().int().min(1).max(2_147_483_647),
  registryReference: z.string(),
});
const scope = z.strictObject({ organizationId: ulid, projectId: ulid, operationId: ulid });
const now = `(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`;
const authority = `SELECT 1 FROM product_command_intents i JOIN operations op USING(organization_id,project_id,operation_id) JOIN projects p USING(organization_id,project_id) JOIN cleanup_runs c ON c.organization_id=i.organization_id AND c.project_id=i.project_id AND c.operation_id=i.operation_id AND c.cleanup_run_id=i.cleanup_run_id WHERE i.organization_id=?1 AND i.project_id=?2 AND i.operation_id=?3 AND i.event_type='ProjectDeletionRequestedV1' AND op.state IN('queued','running') AND c.state='running' AND p.lifecycle_state='deleting' AND p.owner_state='active' AND p.active_billing_epoch_id=i.billing_epoch_id`;
const values = (i: z.output<typeof scope>) => [i.organizationId, i.projectId, i.operationId];

/** Resolves only the immutable deletion target and realm fences accepted in Core. */
export async function readNativeAuthProjectDeletion(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const result = await db.batch([
    guard(db, "precondition_changed", `NOT EXISTS(${authority})`, values(i)),
    db
      .prepare(
        `SELECT d.*,t.region_id,COALESCE(d.provider_operation_id,(SELECT prior.provider_operation_id FROM native_auth_deletion_operations prior JOIN operations op USING(organization_id,project_id,operation_id) WHERE prior.organization_id=d.organization_id AND prior.project_id=d.project_id AND prior.operation_id<>d.operation_id AND prior.target_version=d.target_version AND prior.provider_project_id=d.provider_project_id AND prior.database_id=d.database_id AND prior.idempotency_key=d.idempotency_key AND prior.provider_operation_id IS NOT NULL AND op.state NOT IN('queued','running') ORDER BY op.created_at DESC,op.operation_id DESC LIMIT 1)) observed_operation_id FROM native_auth_deletion_operations d JOIN native_auth_database_targets t USING(organization_id,project_id,target_version) WHERE d.organization_id=?1 AND d.project_id=?2 AND d.operation_id=?3`,
      )
      .bind(...values(i)),
    db
      .prepare(
        `SELECT r.environment_id,r.registry_version,r.registry_reference,r.revocation_epoch,r.quiesced_at,r.purged_at,realm.configuration_revision,reg.schema_name,reg.state registration_state,EXISTS(SELECT 1 FROM native_auth_preparation_receipts p WHERE p.organization_id=reg.organization_id AND p.project_id=reg.project_id AND p.environment_id=reg.environment_id AND p.target_version=reg.target_version) prepared FROM native_auth_deletion_realms r JOIN native_auth_realms realm USING(organization_id,project_id,environment_id) JOIN native_auth_registrations reg USING(organization_id,project_id,environment_id,registry_version) WHERE r.organization_id=?1 AND r.project_id=?2 AND r.operation_id=?3 ORDER BY r.environment_id`,
      )
      .bind(...values(i)),
  ]);
  const target = result[1]?.results[0];
  if (!target) return null;
  return {
    organizationId: i.organizationId,
    projectId: i.projectId,
    operationId: i.operationId,
    providerProjectId: String(target["provider_project_id"]),
    databaseId: String(target["database_id"]),
    targetVersion: Number(target["target_version"]),
    regionId: String(target["region_id"]),
    idempotencyKey: String(target["idempotency_key"]),
    state: String(target["state"]),
    providerOperationId: target["observed_operation_id"] as string | null,
    realms: (result[2]?.results ?? []).map((r) => ({
      environmentId: String(r["environment_id"]),
      registryVersion: Number(r["registry_version"]),
      registryReference: String(r["registry_reference"]),
      revocationEpoch: Number(r["revocation_epoch"]),
      configurationRevision: Number(r["configuration_revision"]),
      schema: String(r["schema_name"]),
      registrationState: String(r["registration_state"]),
      prepared: r["prepared"] === 1,
      quiesced: r["quiesced_at"] !== null,
      purged: r["purged_at"] !== null,
    })),
  };
}

const realmAck = scope.extend({
  environmentId: ulid,
  registryVersion: z.number().int().min(1).max(2147483647),
});
/** The private database manager acknowledges its completed row-lock policy fence. */
export async function recordNativeAuthDeletionQuiescence(context: CatalogContext, raw: unknown) {
  const i = realmAck.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = [...values(i), i.environmentId, i.registryVersion];
  await db.batch([
    guard(db, "precondition_changed", `NOT EXISTS(${authority})`, values(i)),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms r JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN native_auth_realms realm USING(organization_id,project_id,environment_id) WHERE r.organization_id=?1 AND r.project_id=?2 AND r.operation_id=?3 AND r.environment_id=?4 AND r.registry_version=?5 AND d.state='reserved' AND realm.enabled=0 AND realm.revocation_epoch=r.revocation_epoch)`,
      v,
    ),
    db
      .prepare(
        `UPDATE native_auth_deletion_realms SET quiesced_at=${now} WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND environment_id=?4 AND registry_version=?5 AND quiesced_at IS NULL`,
      )
      .bind(...v),
  ]);
  return { status: "recorded" as const };
}

/** Dispatch remains pinned to the frozen idempotency key and waits for every realm fence. */
export async function beginNativeAuthProjectDeletion(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  const result = await db.batch([
    guard(db, "precondition_changed", `NOT EXISTS(${authority})`, v),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_deletion_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3) OR EXISTS(SELECT 1 FROM native_auth_deletion_realms WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND quiesced_at IS NULL)`,
      v,
    ),
    db
      .prepare(
        `UPDATE native_auth_deletion_operations SET state='dispatched' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='reserved'`,
      )
      .bind(...v),
    db
      .prepare(
        `SELECT state FROM native_auth_deletion_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
      )
      .bind(...v),
  ]);
  return { state: String(result.at(-1)?.results[0]?.["state"]) };
}

const observation = scope.extend({
  providerOperationId: z
    .string()
    .regex(/^op_[a-z0-9]{20}$/u)
    .nullable(),
  absent: z.boolean(),
});
/** A provider observation is append-only; absence is recorded only by the private manager after GET. */
export async function recordNativeAuthProjectDeletionObservation(
  context: CatalogContext,
  raw: unknown,
) {
  const i = observation.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = [...values(i), i.providerOperationId];
  await db.batch([
    guard(db, "precondition_changed", `NOT EXISTS(${authority})`, values(i)),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_deletion_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('dispatched','observed','absent') AND (provider_operation_id IS NULL OR provider_operation_id IS ?4))`,
      v,
    ),
    ...(i.absent
      ? [
          db
            .prepare(
              `UPDATE native_auth_deletion_operations SET state='absent',provider_operation_id=COALESCE(provider_operation_id,?4),absent_at=${now} WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('dispatched','observed')`,
            )
            .bind(...v),
        ]
      : i.providerOperationId === null
        ? []
        : [
            db
              .prepare(
                `UPDATE native_auth_deletion_operations SET state='observed',provider_operation_id=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='dispatched'`,
              )
              .bind(...v),
          ]),
  ]);
  return { status: "recorded" as const };
}

/** Record the private DO's acknowledged erasure; finalization waits for every realm. */
export async function recordNativeAuthDeletionPurge(context: CatalogContext, raw: unknown) {
  const i = deletionRealm.parse(raw);
  if (!(await authorizeNativeAuthDeletion(context, i)))
    throw new Error("native_auth_deletion_unavailable");
  const { db } = await routeOrganization(context, i.organizationId),
    v = [
      i.organizationId,
      i.projectId,
      i.operationId,
      i.environmentId,
      i.registryVersion,
      i.registryReference,
    ];
  await db.batch([
    guard(db, "precondition_changed", `NOT EXISTS(${authority})`, values(i)),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_deletion_realms r JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) WHERE r.organization_id=?1 AND r.project_id=?2 AND r.operation_id=?3 AND r.environment_id=?4 AND r.registry_version=?5 AND r.registry_reference=?6 AND r.quiesced_at IS NOT NULL AND d.state='absent')`,
      v,
    ),
    db
      .prepare(
        `UPDATE native_auth_deletion_realms SET purged_at=${now} WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND environment_id=?4 AND registry_version=?5 AND purged_at IS NULL`,
      )
      .bind(...v.slice(0, 5)),
  ]);
  return { status: "recorded" as const };
}

/** Close the metered target only after provider absence and all private erasure receipts. */
export async function finishNativeAuthProjectDeletion(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    v = values(i);
  await db.batch([
    guard(db, "precondition_changed", `NOT EXISTS(${authority})`, v),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_deletion_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='absent') OR EXISTS(SELECT 1 FROM native_auth_deletion_realms WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND purged_at IS NULL)`,
      v,
    ),
    db
      .prepare(
        `UPDATE native_auth_database_targets SET ended_at=${now} WHERE organization_id=?1 AND project_id=?2 AND ended_at IS NULL AND target_version=(SELECT target_version FROM native_auth_deletion_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3)`,
      )
      .bind(...v),
    db
      .prepare(
        `UPDATE native_auth_providers SET ciphertext=NULL,nonce=NULL,value_sha256=NULL,key_version=NULL,enabled=0 WHERE organization_id=?1 AND project_id=?2 AND ciphertext IS NOT NULL`,
      )
      .bind(i.organizationId, i.projectId),
  ]);
  return { status: "closed" as const };
}

/** The private registry may erase its keys only for this accepted, frozen deletion and absent target. */
export async function authorizeNativeAuthDeletion(context: CatalogContext, raw: unknown) {
  const i = deletionRealm.parse(raw);
  if (i.registryReference !== `${i.projectId}:${i.environmentId}`) return false;
  const { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      `SELECT 1 FROM native_auth_deletion_realms r
       JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id)
       JOIN native_auth_realms realm USING(organization_id,project_id,environment_id)
       JOIN product_command_intents i USING(organization_id,project_id,operation_id)
       JOIN operations op USING(organization_id,project_id,operation_id)
       JOIN projects p USING(organization_id,project_id)
       JOIN cleanup_runs c ON c.organization_id=i.organization_id AND c.project_id=i.project_id AND c.cleanup_run_id=i.cleanup_run_id AND c.operation_id=i.operation_id
       JOIN run_resource_inventory inv ON inv.organization_id=r.organization_id AND inv.project_id=r.project_id AND inv.operation_id=r.operation_id AND inv.provider='ohmyhost' AND inv.resource_kind='native-auth-registry' AND inv.external_ref_hash=?7
       WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.operation_id=?4 AND r.registry_version=?5 AND r.registry_reference=?6
       AND d.state='absent' AND r.quiesced_at IS NOT NULL AND realm.enabled=0 AND realm.revocation_epoch>=r.revocation_epoch
       AND i.event_type='ProjectDeletionRequestedV1' AND op.state IN('queued','running') AND c.state='running'
       AND p.lifecycle_state='deleting' AND p.owner_state='active' AND p.active_billing_epoch_id=i.billing_epoch_id`,
    )
    .bind(
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
      i.registryVersion,
      i.registryReference,
      inventoryDigest("ohmyhost", "native-auth-registry", i.registryReference),
    )
    .first();
  return row !== null;
}

/** The DO may drain its pool only for the currently frozen deletion realm. */
export async function authorizeNativeAuthDeletionQuiescence(context: CatalogContext, raw: unknown) {
  const i = deletionRealm.parse(raw);
  if (i.registryReference !== `${i.projectId}:${i.environmentId}`) return false;
  const { db } = await routeOrganization(context, i.organizationId);
  const result = await db.batch([
    db.prepare(authority).bind(...values(i)),
    db
      .prepare(
        `SELECT 1 FROM native_auth_deletion_realms r JOIN native_auth_deletion_operations d USING(organization_id,project_id,operation_id) JOIN native_auth_realms realm USING(organization_id,project_id,environment_id) JOIN run_resource_inventory inv ON inv.organization_id=r.organization_id AND inv.project_id=r.project_id AND inv.operation_id=r.operation_id AND inv.provider='ohmyhost' AND inv.resource_kind='native-auth-registry' AND inv.external_ref_hash=?7 WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.operation_id=?4 AND r.registry_version=?5 AND r.registry_reference=?6 AND d.state='reserved' AND realm.enabled=0 AND realm.revocation_epoch=r.revocation_epoch`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.environmentId,
        i.operationId,
        i.registryVersion,
        i.registryReference,
        inventoryDigest("ohmyhost", "native-auth-registry", i.registryReference),
      ),
  ]);
  return result[0]?.results.length === 1 && result[1]?.results.length === 1;
}
