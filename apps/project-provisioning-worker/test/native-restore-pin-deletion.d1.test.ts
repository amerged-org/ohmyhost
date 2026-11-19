import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  }
  return { WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});
import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
} from "@ohmyhost/orchestrator";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { completeNativeRestorePinReconciliation } from "../../control-store/src/catalog/identity/native-auth-restore-job.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import {
  acceptance,
  issueConfirmation,
  productRig,
} from "../../control-store/test/support/product-api-fixture.js";
import { seedOperation } from "../../control-store/test/support/accepted-operation.js";
import { createRecoveryArchiveStore } from "../../project-recovery-worker/src/r2-archives.js";
import { createRecoveryRuntime } from "../../project-recovery-worker/src/recovery-runtime.js";
import { createRecoveryControlClient } from "../../project-recovery-worker/src/control-client.js";
import {
  createRecoveryControlHandler,
  sha256Hex,
  type RecoveryStorePort,
} from "../../recovery-container/src/control-mediator.js";
import { coreWorkflowBindings } from "./support/chain-workflows.js";
import { runCoreDeploymentWorkflow } from "../src/core-deployment-workflow.js";
import { domainDeletion, sesMailDeletion } from "./support/deployment-chain-providers.js";

it("blocks uncertain pins, retains a conditional tombstone, and retires only verified pin through accepted deletion", async () => {
  const control = await createTestControl();
  try {
    const rig = await productRig(control),
      db = control.core,
      context = { directory: db, router: new SharedCoreRouter(db) };
    await db.batch([
      db
        .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
        .bind(rig.organizationId),
      db
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_seed','admin','active',1,?2,'2026-01-01T00:00:00.000000Z','evt_fixture')",
        )
        .bind(rig.organizationId, new Uint8Array(32).fill(1)),
      db
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner','2026-01-01T00:00:00.000000Z')",
        )
        .bind(rig.organizationId, newUlid(), rig.principalId),
    ]);
    const exportOperation = await seedOperation(rig),
      uncertainId = newUlid(),
      verifiedId = newUlid(),
      claimId = crypto.randomUUID();
    const bytes = Buffer.from("synthetic encrypted archive"),
      digest = createHash("sha256").update(bytes).digest(),
      bucket = "ohmyho-development-backups";
    const manifest = JSON.stringify({
      schemaVersion: "ohmyhost.native-auth-inventory/v1",
      organizationId: rig.organizationId,
      projectId: rig.projectId,
      databaseId: "a1234567890123456789",
      migrationVersion: 3,
      migrationDigest: "a".repeat(64),
      realms: [{ environmentId: rig.devEnvironmentId }],
    });
    await db
      .prepare(
        "update operations set state='succeeded' where organization_id=?1 and operation_id=?2",
      )
      .bind(rig.organizationId, exportOperation)
      .run();
    await db
      .prepare(
        `insert into project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,native_manifest,native_manifest_sha256,captured_at,archive_expires_at,verified_at,finished_at) values(?1,?2,?3,?4,'2099-01-01T01:00:00.000000Z','2099-01-01T00:00:00.000000Z',?5,?6,?7,'["auth.sql"]',?8,?9,'2099-01-01T00:00:00.000000Z','2099-01-08T00:00:00.000000Z','2099-01-01T00:00:00.000000Z','2099-01-01T00:00:00.000000Z')`,
      )
      .bind(
        rig.organizationId,
        exportOperation,
        rig.projectId,
        rig.devEnvironmentId,
        bucket,
        bytes.length,
        digest,
        manifest,
        createHash("sha256").update(manifest).digest(),
      )
      .run();
    // A pre-existing verified Native export retains its upload journal and protected key.
    await db
      .prepare(
        `insert into native_export_effects(organization_id,project_id,operation_id,bucket,object_key,archive_bytes,archive_sha256,native_manifest,native_manifest_sha256,expires_at,state) select organization_id,project_id,operation_id,archive_bucket,'native-exports/'||organization_id||'/'||project_id||'/'||operation_id||'.zip',archive_bytes,archive_sha256,native_manifest,native_manifest_sha256,archive_expires_at,'verified' from project_recovery_jobs where organization_id=?1 and operation_id=?2`,
      )
      .bind(rig.organizationId, exportOperation)
      .run();
    for (const [restoreId, state, pinState] of [
      [uncertainId, "expired", "reserved"],
      [verifiedId, "complete", "verified"],
    ] as const) {
      const idClaim = state === "complete" ? claimId : null;
      await db
        .prepare(
          `insert into native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_digest,created_at,input_expires_at,claim_id,state) values(?1,?2,?3,?4,?5,?6,?5,'2026-01-01T00:00:00.000000Z','2026-01-01T01:00:00.000000Z',?7,?8)`,
        )
        .bind(
          rig.organizationId,
          rig.projectId,
          restoreId,
          exportOperation,
          digest,
          rig.principalId,
          idClaim,
          state,
        )
        .run();
      await db
        .prepare(
          `insert into native_auth_restore_pins(organization_id,project_id,restore_id,export_operation_id,claim_id,bucket,object_key,archive_bytes,archive_sha256,manifest_sha256,state) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)`,
        )
        .bind(
          rig.organizationId,
          rig.projectId,
          restoreId,
          exportOperation,
          claimId,
          bucket,
          `restore-pins/${rig.organizationId}/${rig.projectId}/${restoreId}.zip`,
          bytes.length,
          digest,
          pinState,
        )
        .run();
    }
    const scope = { organizationId: rig.organizationId, projectId: rig.projectId };
    const target = await rig.store.productApi.readApiDeletePlanTarget(scope);
    if (!target) throw new Error("delete target missing");
    const request = acceptance(rig, rig.devEnvironmentId, {
      eventType: "ProjectDeletionRequestedV1",
      httpMethod: "DELETE",
      routeTemplate: "/v1/projects/{project_id}",
      cleanupRunId: newUlid(),
      expectedProjectVersion: target.expectedProjectVersion,
      expectedEtag: target.expectedEtag,
      confirmation: await issueConfirmation(rig, "delete", target.expectedEtag),
    });
    await expect(rig.store.productApi.acceptApiProductOperation(request)).rejects.toThrow();
    expect(
      await db
        .prepare("select lifecycle_state from projects where project_id=?1")
        .bind(rig.projectId)
        .first(),
    ).toEqual({ lifecycle_state: "active" });

    const objects = new Map<string, { body: Buffer; type: string }>();
    const uncertainKey = `restore-pins/${rig.organizationId}/${rig.projectId}/${uncertainId}.zip`,
      verifiedKey = `restore-pins/${rig.organizationId}/${rig.projectId}/${verifiedId}.zip`,
      archiveKey = `native-exports/${rig.organizationId}/${rig.projectId}/${exportOperation}.zip`;
    objects.set(verifiedKey, { body: bytes, type: "application/zip" });
    objects.set(archiveKey, { body: bytes, type: "application/zip" });
    const deleted: string[] = [];
    let failPinDeleteOnce = true;
    const client = {
      async send(command: unknown) {
        const item = command as {
          constructor: { name: string };
          input: { Key?: string; Body?: Uint8Array; ContentType?: string; IfNoneMatch?: string };
        };
        const key = item.input.Key ?? "",
          name = item.constructor.name;
        if (name === "GetBucketLifecycleConfigurationCommand")
          throw Object.assign(new Error("none"), { name: "NoSuchLifecycleConfiguration" });
        if (name === "PutObjectCommand") {
          if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
          objects.set(key, {
            body: Buffer.from(item.input.Body ?? []),
            type: item.input.ContentType ?? "",
          });
          return {};
        }
        if (name === "GetObjectCommand") {
          const found = objects.get(key);
          if (!found) throw { $metadata: { httpStatusCode: 404 } };
          return {
            Body: Readable.from([found.body]),
            ContentLength: found.body.length,
            ContentType: found.type,
          };
        }
        if (name === "HeadObjectCommand") {
          const found = objects.get(key);
          if (!found) throw { $metadata: { httpStatusCode: 404 } };
          return { ContentType: found.type };
        }
        if (name === "DeleteObjectCommand") {
          if (key === verifiedKey && failPinDeleteOnce) {
            failPinDeleteOnce = false;
            throw new Error("temporary provider failure");
          }
          deleted.push(key);
          objects.delete(key);
          return {};
        }
        throw new Error("unexpected provider command");
      },
      destroy() {},
    };
    const archives = createRecoveryArchiveStore(
      {
        accountId: "a".repeat(32),
        bucket,
        accessKeyId: "b".repeat(32),
        apiToken: "fixture-token-not-real-123456",
        now: () => new Date(),
      },
      client as never,
    );
    const uncertainScope = { ...scope, restoreId: uncertainId };
    expect(
      await archives.inspectRestorePin({
        bucket,
        scope: uncertainScope,
        bytes: bytes.length,
        sha256: digest,
        signal: AbortSignal.timeout(5000),
        allowTombstone: true,
      }),
    ).toBe("tombstoned");
    await expect(
      archives.pinVerified({
        bucket,
        scope: uncertainScope,
        archive: bytes,
        bytes: bytes.length,
        sha256: digest,
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow();
    expect(objects.get(uncertainKey)?.type).toBe("application/vnd.ohmyho.restore-pin-tombstone");
    expect(
      await completeNativeRestorePinReconciliation(context, {
        ...uncertainScope,
        principalId: rig.principalId,
        outcome: "tombstoned",
      }),
    ).toEqual({ status: "tombstoned" });

    const accepted = await rig.store.productApi.acceptApiProductOperation(request);
    expect(accepted).toMatchObject({ operationId: request.operationId, state: "queued" });
    const frozen = await db
      .prepare(
        "select resource_kind,cleanup_locator from run_resource_inventory where operation_id=?1 and resource_kind='native-auth-restore-pin'",
      )
      .bind(request.operationId)
      .all<{ resource_kind: string; cleanup_locator: string }>();
    expect(frozen.results).toHaveLength(1);
    expect(frozen.results[0]?.cleanup_locator).toBe(
      `encoded/${Buffer.from(`${bucket}/${verifiedKey}`).toString("base64url")}`,
    );
    await db
      .prepare("update outbox_events set acknowledged_at=?2 where event_id=?1")
      .bind(request.outboxEventId, "2026-10-28T11:30:01.000000Z")
      .run();
    const command = parseProductCommandMessageV1({
      version: 1,
      eventType: "ProjectDeletionRequestedV1",
      eventId: request.outboxEventId,
      organizationId: rig.organizationId,
      projectId: rig.projectId,
      environmentId: rig.devEnvironmentId,
      operationId: request.operationId,
      billingEpochId: rig.billingEpochId,
    });
    await db
      .prepare(
        "INSERT INTO product_workflow_runs(organization_id,operation_id,event_type,workflow_id,event_id,project_id,environment_id,billing_epoch_id,state,created_at,updated_at) VALUES(?1,?2,'ProjectDeletionRequestedV1',?3,?4,?5,?6,?7,'queued',?8,?8)",
      )
      .bind(
        rig.organizationId,
        request.operationId,
        deterministicProductCommandWorkflowId(command),
        request.outboxEventId,
        rig.projectId,
        rig.devEnvironmentId,
        rig.billingEpochId,
        new Date().toISOString().replace(/Z$/u, "000Z"),
      )
      .run();
    const token = "t".repeat(43),
      tokenSha256 = await sha256Hex(token),
      store = rig.store.recovery;
    const privateStore = {
      ...store.executor,
      readArchive: store.owner.readArchive,
      ...store.cleanup,
    } as RecoveryStorePort;
    const handler = createRecoveryControlHandler({ dependencies: () => ({ store: privateStore }) });
    const invokeRecovery = async (raw: unknown) => {
      const item = raw as {
        action: "purge" | "purge-restore-pin";
        organizationId: string;
        projectId: string;
        operationId: string;
        exportId?: string;
        restoreId?: string;
      };
      const grant = {
        containerId: "fixture",
        action: item.action,
        organizationId: item.organizationId,
        projectId: item.projectId,
        operationId: item.operationId,
        ...(item.action === "purge" ? { exportId: item.exportId } : { restoreId: item.restoreId }),
        tokenSha256,
        expiresAtMs: Date.now() + 60_000,
      };
      const fetcher: typeof fetch = async (url, init) =>
        handler(
          new Request(url, init),
          {},
          { containerId: "fixture", className: "RecoverySandbox", params: grant },
        );
      const client = createRecoveryControlClient({ token, fetch: fetcher, attempts: 1 });
      return createRecoveryRuntime({
        control: client,
        archiveDownloads: archives,
        clock: { now: () => new Date() },
      } as never)(raw);
    };
    const handlers = {
      RECOVERY_INVOKER: { invokeRecovery },
      SES_MANAGEMENT: { deleteMailProject: () => sesMailDeletion(rig) },
      CLOUDFLARE_DOMAIN_MANAGEMENT: {
        deleteProject: (input: unknown) => domainDeletion(input as { operationId: string }),
      },
    };
    const { bindings } = coreWorkflowBindings(control, handlers);
    const journal = new Map<string, unknown>();
    let retriedPinCleanup = false;
    const step = {
      async do<T>(name: string, _config: unknown, execute: () => Promise<T>): Promise<T> {
        if (journal.has(name)) return structuredClone(journal.get(name)) as T;
        let value: T;
        try {
          value = await execute();
        } catch (error) {
          if (name !== "cleanup-run-inventory" || failPinDeleteOnce || retriedPinCleanup)
            throw error;
          expect(
            await db
              .prepare(
                "select 1 from native_auth_restore_pin_absences where organization_id=?1 and project_id=?2 and restore_id=?3",
              )
              .bind(rig.organizationId, rig.projectId, verifiedId)
              .first(),
          ).toBeNull();
          expect(
            await db
              .prepare("select state from operations where operation_id=?1")
              .bind(request.operationId)
              .first(),
          ).toEqual({ state: "running" });
          retriedPinCleanup = true;
          value = await execute();
        }
        journal.set(name, structuredClone(value));
        return value;
      },
      async sleep() {},
    } as Parameters<typeof runCoreDeploymentWorkflow>[2];
    const outcome = await runCoreDeploymentWorkflow(
      bindings,
      { payload: command, instanceId: deterministicProductCommandWorkflowId(command) },
      step,
    );
    expect(outcome).toEqual({ status: "succeeded", persistence: "applied" });
    expect(retriedPinCleanup).toBe(true);
    expect(deleted).toContain(verifiedKey);
    expect(deleted).toContain(archiveKey);
    expect(objects.has(archiveKey)).toBe(false);
    expect(
      await db
        .prepare(
          "select state from native_export_effects where organization_id=?1 and operation_id=?2",
        )
        .bind(rig.organizationId, exportOperation)
        .first(),
    ).toEqual({ state: "absent" });
    expect(deleted).not.toContain(uncertainKey);
    expect(objects.get(uncertainKey)?.type).toBe("application/vnd.ohmyho.restore-pin-tombstone");
    expect(objects.has(verifiedKey)).toBe(false);
    expect(
      await db
        .prepare(
          "select source from native_auth_restore_pin_absences where organization_id=?1 and project_id=?2 and restore_id=?3",
        )
        .bind(rig.organizationId, rig.projectId, verifiedId)
        .first(),
    ).toEqual({ source: "project-delete" });
    expect(
      await db
        .prepare("select state from operations where operation_id=?1")
        .bind(request.operationId)
        .first(),
    ).toEqual({ state: "succeeded" });
    expect(
      await db
        .prepare("select lifecycle_state from projects where project_id=?1")
        .bind(rig.projectId)
        .first(),
    ).toEqual({ lifecycle_state: "deleted" });
    expect(
      await db
        .prepare(
          "select ended_at is not null as ended from billing_epochs where billing_epoch_id=?1",
        )
        .bind(rig.billingEpochId)
        .first(),
    ).toEqual({ ended: 0 });
  } finally {
    await control.dispose();
  }
}, 120_000);
