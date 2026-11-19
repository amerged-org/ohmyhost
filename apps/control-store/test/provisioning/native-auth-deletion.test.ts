import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";
import { seedOperation } from "../support/accepted-operation.js";
import { newUlid } from "../../src/catalog/common.js";
import {
  readNativeRestorePinDeletionTarget,
  recordNativeRestorePinDeletionAbsent,
} from "../../src/catalog/recovery/native-restore-cleanup.js";
import { acceptDeletion, lifecycleContext } from "./lifecycle.fixture.js";
import { authorizeNativeAuthDeletion } from "../../src/catalog/provisioning/native-auth-deletion.js";
import {
  deletionInventoryStatements,
  readDeletionInventoryPlan,
} from "../../src/catalog/provisioning/lifecycle-inventory.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});

it("blocks unresolved restore pins and permits only the frozen exact verified pin cleanup", async () => {
  const p = await seedProject(control),
    exportOperation = await seedOperation(p),
    restoreId = newUlid();
  const db = control.core,
    bucket = "ohmyho-development-backups",
    key = `restore-pins/${p.organizationId}/${p.projectId}/${restoreId}.zip`;
  await db
    .prepare(
      "insert into project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket) values(?1,?2,?3,?4,'2026-01-01T01:00:00.000000Z','2026-01-01T00:00:00.000000Z',?5)",
    )
    .bind(p.organizationId, exportOperation, p.projectId, p.devEnvironmentId, bucket)
    .run();
  await db
    .prepare(
      "insert into native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_digest,created_at,input_expires_at,state) values(?1,?2,?3,?4,?5,'user:fixture',?5,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:01.000000Z','expired')",
    )
    .bind(p.organizationId, p.projectId, restoreId, exportOperation, new Uint8Array(32).fill(3))
    .run();
  await db
    .prepare(
      "insert into native_auth_restore_pins(organization_id,project_id,restore_id,export_operation_id,claim_id,bucket,object_key,archive_bytes,archive_sha256,manifest_sha256,state) values(?1,?2,?3,?4,?5,?6,?7,1,?8,?8,'reserved')",
    )
    .bind(
      p.organizationId,
      p.projectId,
      restoreId,
      exportOperation,
      crypto.randomUUID(),
      bucket,
      key,
      new Uint8Array(32).fill(3),
    )
    .run();
  const deletion = await acceptDeletion(p, { cleanup: "running" });
  const input = {
    organizationId: p.organizationId,
    projectId: p.projectId,
    operationId: deletion.operationId,
    recordedAt: "2026-10-28T12:00:00.000Z",
  };
  const pending = await readDeletionInventoryPlan(db, input);
  expect(pending.targets).toContainEqual({
    provider: "cloudflare",
    resource_kind: "native-auth-restore-pin",
    locator: `${bucket}/${key}`,
  });
  await expect(db.batch(deletionInventoryStatements(db, pending))).rejects.toThrow();
  await db
    .prepare(
      "update native_auth_restore_pins set state='verified' where organization_id=?1 and project_id=?2 and restore_id=?3",
    )
    .bind(p.organizationId, p.projectId, restoreId)
    .run();
  const verified = await readDeletionInventoryPlan(db, input);
  await db.batch(deletionInventoryStatements(db, verified));
  const scope = {
    organizationId: p.organizationId,
    projectId: p.projectId,
    operationId: deletion.operationId,
    restoreId,
  };
  const context = lifecycleContext(db);
  expect(await readNativeRestorePinDeletionTarget(context, scope)).toEqual({ restoreId, bucket });
  await expect(
    readNativeRestorePinDeletionTarget(context, { ...scope, restoreId: newUlid() }),
  ).rejects.toThrow("recovery_cleanup_scope_unavailable");
  expect(await recordNativeRestorePinDeletionAbsent(context, scope)).toBe("recorded");
  expect(await recordNativeRestorePinDeletionAbsent(context, scope)).toBe("replayed");
});
afterAll(() => control.dispose());

it("requires the exact frozen registry, disabled epoch and provider absence under the accepted project deletion", async () => {
  const p = await seedProject(control);
  const deletion = await acceptDeletion(p, { cleanup: "running" });
  const args = [p.organizationId, p.projectId, p.devEnvironmentId, deletion.operationId];
  const execute = async (sql: string, ...values: unknown[]) =>
    control.core
      .prepare(sql)
      .bind(...values)
      .run();
  await execute(
    `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,0,'open','App',1,2)`,
    ...args.slice(0, 3),
  );
  await execute(
    `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'provider','database','creation','eu-dev','r256-s500m',1,'2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')`,
    ...args.slice(0, 2),
  );
  const reference = `${p.projectId}:${p.devEnvironmentId}`;
  await execute(
    `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?4,'provider','database','eu-dev','example.com','schema','role',1,1,?5,'active')`,
    ...args,
    reference,
  );
  await execute(
    `INSERT INTO native_auth_deletion_operations(organization_id,project_id,operation_id,target_version,provider_project_id,database_id,idempotency_key,state) VALUES(?1,?2,?3,1,'provider','database','key','reserved')`,
    p.organizationId,
    p.projectId,
    deletion.operationId,
  );
  await execute(
    `INSERT INTO native_auth_deletion_realms(organization_id,project_id,operation_id,environment_id,registry_version,registry_reference,revocation_epoch) VALUES(?1,?2,?3,?4,1,?5,2)`,
    p.organizationId,
    p.projectId,
    deletion.operationId,
    p.devEnvironmentId,
    reference,
  );
  const plan = await readDeletionInventoryPlan(control.core, {
    organizationId: p.organizationId,
    projectId: p.projectId,
    operationId: deletion.operationId,
    recordedAt: "2026-10-28T12:00:00.000Z",
  });
  expect(plan.targets).toContainEqual({
    provider: "pgcf",
    resource_kind: "native-auth-database",
    locator: "database",
  });
  expect(plan.targets).toContainEqual({
    provider: "ohmyhost",
    resource_kind: "native-auth-registry",
    locator: reference,
  });
  await control.core.batch(deletionInventoryStatements(control.core, plan));
  const scope = {
    organizationId: p.organizationId,
    projectId: p.projectId,
    environmentId: p.devEnvironmentId,
    operationId: deletion.operationId,
    registryVersion: 1,
    registryReference: reference,
  };
  const auth = (input = scope) =>
    authorizeNativeAuthDeletion(lifecycleContext(control.core), input);
  expect(await auth()).toBe(false);
  await execute(
    `UPDATE native_auth_deletion_realms SET quiesced_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
    p.organizationId,
    p.projectId,
    deletion.operationId,
  );
  await execute(
    `UPDATE native_auth_deletion_operations SET state='dispatched' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
    p.organizationId,
    p.projectId,
    deletion.operationId,
  );
  await execute(
    `UPDATE native_auth_deletion_operations SET state='absent',absent_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
    p.organizationId,
    p.projectId,
    deletion.operationId,
  );
  expect(await auth()).toBe(true);
  expect(await auth({ ...scope, environmentId: p.prodEnvironmentId })).toBe(false);
  await execute(
    `UPDATE native_auth_realms SET enabled=1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3`,
    ...args.slice(0, 3),
  );
  expect(await auth()).toBe(false);
});
