import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { createTestControl } from "./support/control-d1.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";
import { seedOperation } from "./support/accepted-operation.js";
import { SharedCoreRouter } from "../src/router.js";
import { newUlid } from "../src/catalog/common.js";
import {
  acknowledgeNativeRestore,
  beginNativeAuthRestore,
  readNativeRestore,
  readNativeRestoreForSanitization,
} from "../src/catalog/identity/native-auth-restore.js";
import {
  readNativeAuthRestorePreparation,
  recordNativeAuthRestoreVerification,
} from "../src/catalog/identity/native-auth-restore-preparation.js";
import {
  readNativeRestoreJobClaim,
  consumeNativeRestoreJobInput,
  claimNativeRestoreJob,
  reserveNativeRestorePin,
  recordNativeRestorePin,
  readNativeRestorePinReconciliation,
  completeNativeRestorePinReconciliation,
  acceptNativeRestoreJob,
  authorizeNativeRestoreAdmission,
  readNativeRestoreJobInput,
  beginNativeRestoreJob,
  assertNativeRestoreImportAllowed,
  isNativeRestoreRealmImported,
  markNativeRestoreRealmImported,
  isNativeRestoreAcknowledged,
  acknowledgeNativeRestoreJob,
  finishNativeRestoreJob,
  recordNativeRestorePinAbsent,
} from "../src/catalog/identity/native-auth-restore-job.js";
import { prepareRecoveryMaintenance } from "../src/catalog/recovery/maintenance.js";
import { readDeletionInventoryPlan } from "../src/catalog/provisioning/lifecycle-inventory.js";
import {
  acceptNativeAuthUserMutation,
  authorizeAcceptedNativeAuthUserMutation,
} from "../src/catalog/identity/native-auth-user-acceptance.js";

it("fences the exact verified archive and all realm operations in real Core D1", async () => {
  const control = await createTestControl();
  try {
    const { project, principalId } = await seedDevAccessProject(control);
    const {
      organizationId,
      projectId,
      devEnvironmentId: environmentId,
      prodEnvironmentId: secondEnvironmentId,
    } = project;
    const db = control.core,
      context = { directory: db, router: new SharedCoreRouter(db) };
    await db
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(organizationId)
      .run();
    const exportOperationId = await seedOperation(project),
      restoreId = newUlid(),
      jobClaimId = crypto.randomUUID(),
      databaseId = "a1234567890123456789";
    const schemaName = `omh_auth_${environmentId.toLowerCase()}`,
      secondSchemaName = `omh_auth_${secondEnvironmentId.toLowerCase()}`;
    const manifest = JSON.stringify({
      schemaVersion: "ohmyhost.native-auth-inventory/v1",
      organizationId,
      projectId,
      databaseId,
      migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
      realms: [
        {
          environmentId,
          schemaName,
          revocationEpoch: 10,
          configurationRevision: 12,
        },
        {
          environmentId: secondEnvironmentId,
          schemaName: secondSchemaName,
          revocationEpoch: 1,
          configurationRevision: 1,
        },
      ]
        .sort((a, b) => a.environmentId.localeCompare(b.environmentId))
        .map((realm, index) => ({
          ...realm,
          dumpOffset: index,
          dumpBytes: 1,
          dumpSha256: "a".repeat(64),
        })),
    });
    const archive = new Uint8Array(32).fill(7),
      manifestHash = createHash("sha256").update(manifest).digest();
    await db.batch([
      db
        .prepare(
          `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
        )
        .bind(organizationId, projectId, environmentId),
      db
        .prepare(
          `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
        )
        .bind(organizationId, projectId, secondEnvironmentId),
      db
        .prepare(
          `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'provider',?3,'operation','eu-dev','r256-s500m',1,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z')`,
        )
        .bind(organizationId, projectId, databaseId),
      db
        .prepare(
          `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,'claim','provider',?5,'eu-dev','pgcf.example',?6,'omh_ar_'||lower(?3),1,1,'reference','active')`,
        )
        .bind(organizationId, projectId, environmentId, exportOperationId, databaseId, schemaName),
      db
        .prepare(
          `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,'claim','provider',?5,'eu-dev','pgcf.example',?6,'omh_ar_'||lower(?3),1,1,'reference-second','active')`,
        )
        .bind(
          organizationId,
          projectId,
          secondEnvironmentId,
          exportOperationId,
          databaseId,
          secondSchemaName,
        ),
      db
        .prepare(
          `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,native_manifest,native_manifest_sha256,captured_at,archive_expires_at,verified_at,finished_at) VALUES(?1,?2,?3,?4,'2099-01-01T01:00:00.000000Z','2099-01-01T00:00:00.000000Z','ohmyho-development-backups',123,?5,'["auth.sql"]',?6,?7,'2099-01-01T00:00:00.000000Z','2099-01-08T00:00:00.000000Z','2099-01-01T00:00:00.000000Z','2099-01-01T00:00:00.000000Z')`,
        )
        .bind(
          organizationId,
          exportOperationId,
          projectId,
          environmentId,
          archive,
          manifest,
          manifestHash,
        ),
    ]);
    const expiredRestoreId = newUlid(),
      oldClaim = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,claim_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,'2000-01-01T00:00:00.000000Z','2000-01-01T01:00:00.000000Z',?10,'claimed')`,
      )
      .bind(
        organizationId,
        projectId,
        expiredRestoreId,
        exportOperationId,
        archive,
        principalId,
        new Uint8Array(17),
        new Uint8Array(12),
        new Uint8Array(32),
        oldClaim,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO native_auth_restore_claims(organization_id,project_id,restore_id,claim_id,input_generation) VALUES(?1,?2,?3,?4,1)",
      )
      .bind(organizationId, projectId, expiredRestoreId, oldClaim)
      .run();
    await db
      .prepare(
        `INSERT INTO native_auth_restore_pins(organization_id,project_id,restore_id,export_operation_id,claim_id,bucket,object_key,archive_bytes,archive_sha256,manifest_sha256,state) VALUES(?1,?2,?3,?4,?5,'ohmyho-development-backups','restore-pins/'||?1||'/'||?2||'/'||?3||'.zip',123,?6,?7,'verified')`,
      )
      .bind(
        organizationId,
        projectId,
        expiredRestoreId,
        exportOperationId,
        oldClaim,
        archive,
        manifestHash,
      )
      .run();
    await prepareRecoveryMaintenance(context, { auditEventId: newUlid() });
    expect(
      await db
        .prepare(
          `SELECT state,input_ciphertext,input_nonce,input_key_version FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3`,
        )
        .bind(organizationId, projectId, expiredRestoreId)
        .first(),
    ).toEqual({
      state: "expired",
      input_ciphertext: null,
      input_nonce: null,
      input_key_version: null,
    });
    const rearmInput = {
      organizationId,
      projectId,
      restoreId: expiredRestoreId,
      principalId,
      exportOperationId,
      archiveSha256: "07".repeat(32),
      inputDigest: new Uint8Array(32),
      sealedInput: { ciphertext: new Uint8Array(17), nonce: new Uint8Array(12), keyVersion: 1 },
    };
    await expect(acceptNativeRestoreJob(context, rearmInput)).rejects.toThrow();
    const renewedClaim = crypto.randomUUID();
    const validRearm = {
      ...rearmInput,
      rearm: { expectedPreviousClaimId: oldClaim, claimId: renewedClaim },
    };
    await expect(
      authorizeNativeRestoreAdmission(context, { ...rearmInput, proposedClaimId: renewedClaim }),
    ).rejects.toThrow();
    await expect(
      authorizeNativeRestoreAdmission(context, {
        ...validRearm,
        proposedClaimId: renewedClaim,
        principalId: "user:user_foreign",
      }),
    ).rejects.toThrow();
    await expect(
      authorizeNativeRestoreAdmission(context, {
        ...validRearm,
        proposedClaimId: renewedClaim,
        inputDigest: new Uint8Array(32).fill(1),
      }),
    ).rejects.toThrow();
    await expect(
      authorizeNativeRestoreAdmission(context, {
        ...rearmInput,
        proposedClaimId: renewedClaim,
        rearm: { expectedPreviousClaimId: crypto.randomUUID(), claimId: renewedClaim },
      }),
    ).rejects.toThrow();
    await expect(
      authorizeNativeRestoreAdmission(context, {
        ...validRearm,
        proposedClaimId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      authorizeNativeRestoreAdmission(context, { ...validRearm, proposedClaimId: renewedClaim }),
    ).resolves.toEqual({
      authorized: true,
    });
    await expect(
      acceptNativeRestoreJob(context, {
        ...rearmInput,
        rearm: { expectedPreviousClaimId: crypto.randomUUID(), claimId: renewedClaim },
      }),
    ).rejects.toThrow();
    await expect(
      acceptNativeRestoreJob(context, {
        ...rearmInput,
        rearm: { expectedPreviousClaimId: oldClaim, claimId: oldClaim },
      }),
    ).rejects.toThrow();
    await expect(
      acceptNativeRestoreJob(context, {
        ...rearmInput,
        rearm: { expectedPreviousClaimId: oldClaim, claimId: renewedClaim },
      }),
    ).resolves.toEqual({ status: "queued" });
    await expect(
      acceptNativeRestoreJob(context, {
        ...rearmInput,
        rearm: { expectedPreviousClaimId: oldClaim, claimId: renewedClaim },
      }),
    ).resolves.toEqual({ status: "queued" });
    const expiredScope = { organizationId, projectId, restoreId: expiredRestoreId };
    await expect(
      claimNativeRestoreJob(context, { ...expiredScope, claimId: oldClaim }),
    ).rejects.toThrow();
    await expect(
      claimNativeRestoreJob(context, { ...expiredScope, claimId: renewedClaim }),
    ).resolves.toEqual({ status: "claimed" });
    await expect(
      readNativeRestoreJobInput(context, { ...expiredScope, claimId: oldClaim }),
    ).rejects.toThrow();
    await db
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,claim_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,'2099-01-01T00:00:00.000000Z','2099-01-01T01:00:00.000000Z',?10,'claimed')`,
      )
      .bind(
        organizationId,
        projectId,
        restoreId,
        exportOperationId,
        archive,
        principalId,
        new Uint8Array(17),
        new Uint8Array(12),
        new Uint8Array(32),
        jobClaimId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO native_auth_restore_claims(organization_id,project_id,restore_id,claim_id,input_generation) VALUES(?1,?2,?3,?4,1)",
      )
      .bind(organizationId, projectId, restoreId, jobClaimId)
      .run();
    const mutation = {
      organizationId,
      projectId,
      environmentId,
      principalId,
      action: "suspend",
      resourceId: "c6b92630-44e3-4d0b-9fd7-45f81d407df2",
      idempotencyKey: "before",
      canonicalRequestDigest: "a".repeat(64),
    };
    await acceptNativeAuthUserMutation(context, mutation);
    const request = {
      organizationId,
      projectId,
      principalId,
      restoreId,
      jobClaimId,
      exportOperationId,
      archiveSha256: "07".repeat(32),
    };
    const jobScope = { organizationId, projectId, restoreId, claimId: jobClaimId };
    expect(await readNativeRestoreJobClaim(context, jobScope)).toMatchObject({
      completed: false,
      phase: "preflight",
      imported: false,
    });
    await expect(
      readNativeRestoreJobClaim(context, { ...jobScope, claimId: crypto.randomUUID() }),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT enabled FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(organizationId, projectId, environmentId)
        .first(),
    ).toEqual({ enabled: 1 });
    await expect(beginNativeAuthRestore(context, request)).rejects.toThrow("pin missing");
    await expect(beginNativeRestoreJob(context, jobScope)).rejects.toThrow();
    expect(await reserveNativeRestorePin(context, jobScope)).toMatchObject({
      created: true,
      state: "reserved",
    });
    expect(await reserveNativeRestorePin(context, jobScope)).toMatchObject({
      created: false,
      state: "reserved",
    });
    await expect(beginNativeAuthRestore(context, request)).rejects.toThrow("pin missing");
    const reconcileScope = { organizationId, projectId, restoreId, principalId };
    await expect(
      readNativeRestorePinReconciliation(context, {
        ...reconcileScope,
        principalId: "user:user_foreign",
      }),
    ).rejects.toThrow();
    expect(await readNativeRestorePinReconciliation(context, reconcileScope)).toMatchObject({
      state: "reserved",
      key: `restore-pins/${organizationId}/${projectId}/${restoreId}.zip`,
    });
    await expect(
      completeNativeRestorePinReconciliation(context, {
        ...reconcileScope,
        outcome: "verified",
      }),
    ).resolves.toEqual({ status: "verified" });
    expect(await recordNativeRestorePin(context, jobScope)).toEqual({ status: "recorded" });
    const absentRestoreId = newUlid(),
      absentClaim = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,claim_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,'2099-01-01T00:00:00.000000Z','2099-01-01T01:00:00.000000Z',?10,'claimed')`,
      )
      .bind(
        organizationId,
        projectId,
        absentRestoreId,
        exportOperationId,
        archive,
        principalId,
        new Uint8Array(17),
        new Uint8Array(12),
        new Uint8Array(32),
        absentClaim,
      )
      .run();
    await reserveNativeRestorePin(context, {
      organizationId,
      projectId,
      restoreId: absentRestoreId,
      claimId: absentClaim,
    });
    await expect(
      completeNativeRestorePinReconciliation(context, {
        organizationId,
        projectId,
        restoreId: absentRestoreId,
        principalId,
        outcome: "absent",
      }),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT state FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, absentRestoreId)
        .first(),
    ).toEqual({ state: "claimed" });
    expect(
      await db
        .prepare(
          "SELECT source FROM native_auth_restore_pin_absences WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, absentRestoreId)
        .first(),
    ).toBeNull();
    await expect(
      completeNativeRestorePinReconciliation(context, {
        organizationId,
        projectId,
        restoreId: absentRestoreId,
        principalId,
        outcome: "tombstoned",
      }),
    ).resolves.toEqual({ status: "tombstoned" });
    expect(
      await db
        .prepare(
          "SELECT state,input_ciphertext,input_nonce,input_key_version FROM native_auth_restore_jobs WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, absentRestoreId)
        .first(),
    ).toEqual({
      state: "failed",
      input_ciphertext: null,
      input_nonce: null,
      input_key_version: null,
    });
    expect(
      await db
        .prepare(
          "SELECT state FROM native_auth_restore_pins WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, absentRestoreId)
        .first(),
    ).toEqual({ state: "tombstoned" });
    expect(
      await db
        .prepare(
          "SELECT 1 FROM native_auth_restore_pin_tombstones WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, absentRestoreId)
        .first(),
    ).not.toBeNull();
    await expect(
      beginNativeAuthRestore(context, { ...request, archiveSha256: "08".repeat(32) }),
    ).rejects.toThrow();
    await expect(
      beginNativeAuthRestore(context, { ...request, principalId: "user:user_foreign" }),
    ).rejects.toThrow();
    await expect(beginNativeRestoreJob(context, jobScope)).resolves.toMatchObject({
      completed: false,
      phase: "restoring",
    });
    await expect(beginNativeRestoreJob(context, jobScope)).resolves.toMatchObject({
      completed: false,
      phase: "restoring",
    });
    await expect(readNativeRestorePinReconciliation(context, reconcileScope)).rejects.toThrow();
    await expect(beginNativeAuthRestore(context, request)).resolves.toEqual({
      restoreId,
      status: "restoring",
    });
    expect(
      await readNativeRestore(context, { organizationId, projectId, environmentId, restoreId }),
    ).toMatchObject({
      offline: true,
      revocationEpoch: 11,
      configurationRevision: 13,
      acceptedMutationEpoch: 11,
    });
    expect(
      await readNativeRestoreForSanitization(context, {
        organizationId,
        projectId,
        environmentId,
        restoreId,
        claimId: jobClaimId,
      }),
    ).toBeNull();
    expect(
      await readNativeAuthRestorePreparation(context, {
        organizationId,
        projectId,
        environmentId,
        restoreId,
        claimId: jobClaimId,
      }),
    ).toBeNull();
    const firstOffline = {
      ...jobScope,
      environmentId,
      kind: "offline",
      revocationEpoch: 11,
      configurationRevision: 13,
    };
    await expect(
      isNativeRestoreAcknowledged(context, { ...jobScope, environmentId, kind: "offline" }),
    ).resolves.toEqual({ acknowledged: false });
    await expect(
      acknowledgeNativeRestoreJob(context, { ...firstOffline, revocationEpoch: 12 }),
    ).rejects.toThrow();
    await expect(acknowledgeNativeRestoreJob(context, firstOffline)).resolves.toEqual({
      acknowledged: true,
    });
    await expect(assertNativeRestoreImportAllowed(context, jobScope)).rejects.toThrow();
    await expect(
      markNativeRestoreRealmImported(context, { ...jobScope, environmentId }),
    ).rejects.toThrow();
    expect(
      await readNativeRestore(context, {
        organizationId,
        projectId,
        environmentId: secondEnvironmentId,
        restoreId,
      }),
    ).toMatchObject({ offline: true, revocationEpoch: 2, configurationRevision: 2 });
    await expect(
      db
        .prepare(
          "INSERT INTO native_auth_restore_import_realms(organization_id,project_id,restore_id,environment_id,imported_at) VALUES(?1,?2,?3,?4,'2026-11-04T00:00:00.000000Z')",
        )
        .bind(organizationId, projectId, restoreId, environmentId)
        .run(),
    ).rejects.toThrow("not offline");
    await acknowledgeNativeRestore(context, {
      organizationId,
      projectId,
      environmentId: secondEnvironmentId,
      restoreId,
      kind: "offline",
      revocationEpoch: 2,
      configurationRevision: 2,
    });
    await expect(
      isNativeRestoreAcknowledged(context, { ...jobScope, environmentId, kind: "offline" }),
    ).resolves.toEqual({ acknowledged: true });
    await expect(
      assertNativeRestoreImportAllowed(context, { ...jobScope, claimId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(assertNativeRestoreImportAllowed(context, jobScope)).resolves.toEqual({
      allowed: true,
    });
    await expect(
      isNativeRestoreRealmImported(context, { ...jobScope, environmentId }),
    ).resolves.toEqual({ imported: false });
    await expect(
      markNativeRestoreRealmImported(context, { ...jobScope, environmentId: newUlid() }),
    ).rejects.toThrow();
    expect(
      await readNativeRestoreForSanitization(context, {
        organizationId,
        projectId,
        environmentId,
        restoreId,
        claimId: jobClaimId,
      }),
    ).toBeNull();
    await expect(
      markNativeRestoreRealmImported(context, { ...jobScope, environmentId }),
    ).resolves.toEqual({ imported: true });
    await expect(
      markNativeRestoreRealmImported(context, { ...jobScope, environmentId }),
    ).resolves.toEqual({ imported: true });
    await expect(
      isNativeRestoreRealmImported(context, { ...jobScope, environmentId }),
    ).resolves.toEqual({ imported: true });
    await expect(
      markNativeRestoreRealmImported(context, { ...jobScope, environmentId: secondEnvironmentId }),
    ).resolves.toEqual({ imported: true });
    await consumeNativeRestoreJobInput(context, jobScope);
    await expect(assertNativeRestoreImportAllowed(context, jobScope)).rejects.toThrow();
    expect(
      await readNativeRestoreForSanitization(context, {
        organizationId,
        projectId,
        environmentId,
        restoreId,
        claimId: jobClaimId,
      }),
    ).toMatchObject({ offline: true, claimId: jobClaimId, databaseId });
    expect(
      await readNativeRestoreForSanitization(context, {
        organizationId,
        projectId,
        environmentId,
        restoreId,
        claimId: crypto.randomUUID(),
      }),
    ).toBeNull();
    expect(
      await readNativeAuthRestorePreparation(context, {
        organizationId,
        projectId,
        environmentId,
        restoreId,
        claimId: crypto.randomUUID(),
      }),
    ).toBeNull();
    await expect(authorizeAcceptedNativeAuthUserMutation(context, mutation)).rejects.toThrow();
    await expect(
      acceptNativeAuthUserMutation(context, { ...mutation, idempotencyKey: "during" }),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `UPDATE native_auth_realms SET enabled=1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3`,
        )
        .bind(organizationId, projectId, environmentId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE native_auth_restores SET state='complete' WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, restoreId)
        .run(),
    ).rejects.toThrow("proof missing");
    await db
      .prepare("UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1")
      .bind(organizationId)
      .run();
    expect(
      await readNativeRestore(context, { organizationId, projectId, environmentId, restoreId }),
    ).toBeNull();
    await db
      .prepare("UPDATE organization_memberships SET state='active' WHERE organization_id=?1")
      .bind(organizationId)
      .run();
    await acknowledgeNativeRestore(context, {
      organizationId,
      projectId,
      environmentId,
      restoreId,
      kind: "sanitized",
      revocationEpoch: 11,
      configurationRevision: 13,
    });
    await acknowledgeNativeRestore(context, {
      organizationId,
      projectId,
      environmentId: secondEnvironmentId,
      restoreId,
      kind: "sanitized",
      revocationEpoch: 2,
      configurationRevision: 2,
    });
    const preparation = await readNativeAuthRestorePreparation(context, {
      organizationId,
      projectId,
      environmentId,
      restoreId,
      claimId: jobClaimId,
    });
    expect(preparation).toMatchObject({
      databaseId,
      targetVersion: 1,
      registryVersion: 1,
      schema: schemaName,
    });
    const proof = {
      organizationId,
      projectId,
      environmentId,
      restoreId,
      claimId: jobClaimId,
      targetVersion: 1,
      registryVersion: 1,
      schema: schemaName,
      runtimeRole: `omh_ar_${environmentId.toLowerCase()}`,
      migratorRole: `omh_am_${environmentId.toLowerCase()}`,
      backupRole: `omh_ab_${projectId.toLowerCase()}`,
      migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
      migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
    };
    await expect(
      recordNativeAuthRestoreVerification(context, { ...proof, registryVersion: 2 }),
    ).rejects.toThrow();
    await expect(
      recordNativeAuthRestoreVerification(context, { ...proof, schema: "foreign" }),
    ).rejects.toThrow();
    expect(await recordNativeAuthRestoreVerification(context, proof)).toEqual({
      status: "verified",
    });
    await recordNativeAuthRestoreVerification(context, {
      ...proof,
      environmentId: secondEnvironmentId,
      schema: secondSchemaName,
      runtimeRole: `omh_ar_${secondEnvironmentId.toLowerCase()}`,
      migratorRole: `omh_am_${secondEnvironmentId.toLowerCase()}`,
    });
    expect(await recordNativeAuthRestoreVerification(context, proof)).toEqual({
      status: "verified",
    });
    await expect(finishNativeRestoreJob(context, jobScope)).resolves.toEqual({
      status: "complete",
    });
    await expect(finishNativeRestoreJob(context, jobScope)).resolves.toEqual({
      status: "complete",
    });
    await expect(
      recordNativeRestorePinAbsent(context, { ...jobScope, claimId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(recordNativeRestorePinAbsent(context, jobScope)).resolves.toEqual({
      status: "recorded",
    });
    await expect(recordNativeRestorePinAbsent(context, jobScope)).resolves.toEqual({
      status: "recorded",
    });
    expect(
      await db
        .prepare(
          "SELECT source FROM native_auth_restore_pin_absences WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
        )
        .bind(organizationId, projectId, restoreId)
        .first(),
    ).toEqual({ source: "restore-complete" });
    await expect(claimNativeRestoreJob(context, jobScope)).resolves.toEqual({ status: "complete" });
    await expect(
      claimNativeRestoreJob(context, { ...jobScope, claimId: crypto.randomUUID() }),
    ).rejects.toThrow();
    const deletionPlan = await readDeletionInventoryPlan(db, {
      organizationId,
      projectId,
      operationId: newUlid(),
      recordedAt: "2026-11-04T00:00:00.000Z",
    });
    expect(deletionPlan.targets).toContainEqual({
      provider: "cloudflare",
      resource_kind: "native-auth-restore-pin",
      locator: `ohmyho-development-backups/restore-pins/${organizationId}/${projectId}/${restoreId}.zip`,
    });
    expect(
      deletionPlan.targets.some(
        (target) =>
          target.resource_kind === "native-auth-restore-pin" &&
          target.locator.includes(absentRestoreId),
      ),
    ).toBe(false);
    expect(
      await db
        .prepare(
          "SELECT enabled FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(organizationId, projectId, environmentId)
        .first(),
    ).toEqual({ enabled: 0 });
    expect(
      await db
        .prepare(
          "SELECT enabled FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(organizationId, projectId, secondEnvironmentId)
        .first(),
    ).toEqual({ enabled: 0 });
  } finally {
    await control.dispose();
  }
}, 120_000);
