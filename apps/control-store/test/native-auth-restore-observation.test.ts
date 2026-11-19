import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { observeNativeRestoreJob } from "../src/catalog/identity/native-auth-restore-observation.js";
import {
  acceptNativeRestoreJob,
  claimNativeRestoreJob,
  readNativeRestoreJobClaim,
  completeNativeRestoreJob,
  recordNativeRestorePinAbsent,
} from "../src/catalog/identity/native-auth-restore-job.js";
import { runNativeRestoreJob } from "../../project-recovery-worker/src/native-restore-job.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("../../recovery-container/node_modules/@cloudflare/containers", () => ({
  Container: class {
    protected ctx: { container: { running: boolean } };
    protected env: unknown;
    constructor(ctx: { container: { running: boolean } }, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async destroy() {
      this.ctx.container.running = false;
    }
    async startAndWaitForPorts() {
      this.ctx.container.running = true;
    }
    async setOutboundByHost() {}
    async removeOutboundByHost() {}
  },
}));
import { newUlid } from "../src/catalog/common.js";
import { SharedCoreRouter } from "../src/router.js";
import { createTestControl } from "./support/control-d1.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";
import { seedOperation } from "./support/accepted-operation.js";

async function fixture() {
  const control = await createTestControl();
  const { project, principalId } = await seedDevAccessProject(control);
  const { organizationId, projectId, devEnvironmentId: environmentId } = project;
  const exportOperationId = await seedOperation(project),
    restoreId = newUlid(),
    claimId = crypto.randomUUID();
  const databaseId = "a1234567890123456789",
    archive = new Uint8Array(32).fill(7);
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
        schemaName: `omh_auth_${environmentId.toLowerCase()}`,
        revocationEpoch: 1,
        configurationRevision: 1,
        dumpOffset: 0,
        dumpBytes: 1,
        dumpSha256: "a".repeat(64),
      },
    ],
  });
  const db = control.core;
  await db.batch([
    db
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(organizationId),
    db
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,0,'open','App',1,1)",
      )
      .bind(organizationId, projectId, environmentId),
    db
      .prepare(
        "INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'provider',?3,'operation','eu-dev','r256-s500m',1,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z')",
      )
      .bind(organizationId, projectId, databaseId),
    db
      .prepare(
        "INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,native_manifest,native_manifest_sha256,captured_at,archive_expires_at,verified_at,finished_at) VALUES(?1,?2,?3,?4,'2099-01-01T01:00:00.000000Z','2099-01-01T00:00:00.000000Z','ohmyho-development-backups',123,?5,'[\"auth.sql\"]',?6,?7,'2099-01-01T00:00:00.000000Z','2099-01-08T00:00:00.000000Z','2099-01-01T00:00:00.000000Z','2099-01-01T00:00:00.000000Z')",
      )
      .bind(
        organizationId,
        exportOperationId,
        projectId,
        environmentId,
        archive,
        manifest,
        createHash("sha256").update(manifest).digest(),
      ),
  ]);
  const input = {
    organizationId,
    projectId,
    exportOperationId,
    restoreId,
    claimId,
    principalId,
    archiveSha256: Buffer.from(archive).toString("hex"),
  };
  const ids = [organizationId, projectId, restoreId];
  const job = async (expired = false) => {
    await db
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,claim_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,'${expired ? "2000" : "2099"}-01-01T00:00:00.000000Z','${expired ? "2000" : "2099"}-01-01T01:00:00.000000Z',?10,'claimed')`,
      )
      .bind(
        ...ids,
        exportOperationId,
        archive,
        principalId,
        new Uint8Array(17),
        new Uint8Array(12),
        new Uint8Array(32),
        claimId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO native_auth_restore_claims(organization_id,project_id,restore_id,claim_id,input_generation) VALUES(?1,?2,?3,?4,1)",
      )
      .bind(...ids, claimId)
      .run();
  };
  const pin = (state: "reserved" | "verified") =>
    db
      .prepare(
        "INSERT INTO native_auth_restore_pins(organization_id,project_id,restore_id,export_operation_id,claim_id,bucket,object_key,archive_bytes,archive_sha256,manifest_sha256,state) VALUES(?1,?2,?3,?4,?5,'ohmyho-development-backups',?6,123,?7,?8,?9)",
      )
      .bind(
        ...ids,
        exportOperationId,
        claimId,
        `restore-pins/${organizationId}/${projectId}/${restoreId}.zip`,
        archive,
        createHash("sha256").update(manifest).digest(),
        state,
      )
      .run();
  return {
    control,
    db,
    input,
    ids,
    job,
    pin,
    databaseId,
    archive,
    context: { directory: db, router: new SharedCoreRouter(db) },
    environmentId,
  };
}

it("proves absence only for a current Owner and the exact verified archive and target", async () => {
  const f = await fixture();
  try {
    expect(await observeNativeRestoreJob(f.context, f.input)).toEqual({
      status: "absent",
      restoreId: f.input.restoreId,
      claimId: f.input.claimId,
    });
    for (const changed of [
      { principalId: "user:user_foreign" },
      { organizationId: newUlid() },
      { projectId: newUlid() },
      { exportOperationId: newUlid() },
      { archiveSha256: "a".repeat(64) },
      { delegation: {} },
    ])
      await expect(
        observeNativeRestoreJob(f.context, { ...f.input, ...changed }),
      ).rejects.toThrow();
    await f.db
      .prepare(
        "UPDATE native_auth_database_targets SET ended_at='2099-01-02T00:00:00.000000Z' WHERE project_id=?1",
      )
      .bind(f.input.projectId)
      .run();
    await expect(observeNativeRestoreJob(f.context, f.input)).rejects.toThrow();
  } finally {
    await f.control.dispose();
  }
}, 120_000);

it("retains original actor and claim, and refuses to certify a reserved provider effect as resumable", async () => {
  const f = await fixture();
  try {
    await f.job();
    expect(await observeNativeRestoreJob(f.context, f.input)).toMatchObject({
      status: "resume-input",
    });
    await expect(
      observeNativeRestoreJob(f.context, { ...f.input, claimId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await f.pin("reserved");
    expect(await observeNativeRestoreJob(f.context, f.input)).toMatchObject({ status: "unknown" });
    await f.db
      .prepare("UPDATE native_auth_restore_pins SET state='verified' WHERE restore_id=?1")
      .bind(f.input.restoreId)
      .run();
    expect(await observeNativeRestoreJob(f.context, f.input)).toMatchObject({
      status: "resume-input",
    });
    await f.db
      .prepare(
        "UPDATE local_authorization_grants SET revoked_at='2099-01-02T00:00:00.000000Z' WHERE principal_id=?1",
      )
      .bind(f.input.principalId)
      .run();
    await expect(observeNativeRestoreJob(f.context, f.input)).rejects.toThrow();
  } finally {
    await f.control.dispose();
  }
  const expired = await fixture();
  try {
    await expired.job(true);
    await expired.pin("verified");
    expect(await observeNativeRestoreJob(expired.context, expired.input)).toMatchObject({
      status: "rearm-input",
    });
    await expired.db
      .prepare(
        "UPDATE native_auth_restore_jobs SET state='expired',input_ciphertext=NULL,input_nonce=NULL,input_key_version=NULL WHERE restore_id=?1",
      )
      .bind(expired.input.restoreId)
      .run();
    expect(await observeNativeRestoreJob(expired.context, expired.input)).toMatchObject({
      status: "rearm-input",
    });
    const claimId = crypto.randomUUID();
    await acceptNativeRestoreJob(expired.context, {
      organizationId: expired.input.organizationId,
      projectId: expired.input.projectId,
      restoreId: expired.input.restoreId,
      principalId: expired.input.principalId,
      exportOperationId: expired.input.exportOperationId,
      archiveSha256: expired.input.archiveSha256,
      rearm: { expectedPreviousClaimId: expired.input.claimId, claimId },
      inputDigest: new Uint8Array(32),
      sealedInput: { ciphertext: new Uint8Array(17), nonce: new Uint8Array(12), keyVersion: 1 },
    });
    await claimNativeRestoreJob(expired.context, {
      organizationId: expired.input.organizationId,
      projectId: expired.input.projectId,
      restoreId: expired.input.restoreId,
      claimId,
    });
    expect(
      await observeNativeRestoreJob(expired.context, { ...expired.input, claimId }),
    ).toMatchObject({ status: "resume-input" });
    await expect(observeNativeRestoreJob(expired.context, expired.input)).rejects.toThrow();
  } finally {
    await expired.control.dispose();
  }
}, 120_000);

it("resumes only cleanup after completion commits and the pin deletion response is lost", async () => {
  const f = await fixture();
  try {
    await f.job();
    await f.pin("verified");
    await f.db.batch([
      f.db
        .prepare(
          "INSERT INTO native_auth_restores(organization_id,project_id,restore_id,export_operation_id,database_id,archive_sha256,principal_id,restore_generation,captured_at,state) VALUES(?1,?2,?3,?4,?5,?6,?7,1,'2099-01-01T00:00:00.000000Z','complete')",
        )
        .bind(...f.ids, f.input.exportOperationId, f.databaseId, f.archive, f.input.principalId),
      f.db
        .prepare(
          "INSERT INTO native_auth_restore_realms(organization_id,project_id,restore_id,environment_id,revocation_epoch,configuration_revision) VALUES(?1,?2,?3,?4,1,1)",
        )
        .bind(...f.ids, f.environmentId),
      f.db
        .prepare(
          "UPDATE native_auth_restore_jobs SET state='consumed',input_ciphertext=NULL,input_nonce=NULL,input_key_version=NULL WHERE restore_id=?1",
        )
        .bind(f.input.restoreId),
    ]);
    expect(await observeNativeRestoreJob(f.context, f.input)).toMatchObject({
      status: "resume-consumed",
    });
    const { organizationId, projectId, restoreId, claimId } = f.input;
    const scope = { organizationId, projectId, restoreId },
      claim = { ...scope, claimId };
    const forbidden = vi.fn(() => {
      throw new Error("cleanup_must_not_restore_data");
    });
    const control = new Proxy(
      {
        readRestoreClaim: () => readNativeRestoreJobClaim(f.context, claim),
        completeRestore: async () => {
          await completeNativeRestoreJob(f.context, claim);
        },
        recordRestorePinAbsent: () => recordNativeRestorePinAbsent(f.context, claim),
      },
      {
        get(target, property) {
          return Reflect.get(target, property) ?? forbidden;
        },
      },
    ) as Parameters<typeof runNativeRestoreJob>[0]["control"];
    const removeRestorePin = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost_delete_response"))
      .mockResolvedValue({ status: "absent" });
    const runCleanup = () =>
      runNativeRestoreJob({
        scope,
        control,
        archives: {
          removeRestorePin,
          readVerified: forbidden,
          pinVerified: forbidden,
          readRestorePin: forbidden,
          inspectRestorePin: forbidden,
        },
        provider: {} as Parameters<typeof runNativeRestoreJob>[0]["provider"],
        cipher: { open: forbidden },
        signal: new AbortController().signal,
      });
    await expect(runCleanup()).rejects.toThrow("lost_delete_response");
    expect(await observeNativeRestoreJob(f.context, f.input)).toMatchObject({
      status: "resume-cleanup",
    });
    for (const changed of [
      { claimId: crypto.randomUUID() },
      { principalId: "user:user_foreign" },
      { archiveSha256: "a".repeat(64) },
      { organizationId: newUlid() },
      { projectId: newUlid() },
    ])
      await expect(
        observeNativeRestoreJob(f.context, { ...f.input, ...changed }),
      ).rejects.toThrow();
    const runtime = {
      observe: (raw: unknown) => observeNativeRestoreJob(f.context, raw),
      readClaim: (raw: unknown) => readNativeRestoreJobClaim(f.context, raw),
      claim: (raw: unknown) => claimNativeRestoreJob(f.context, raw),
    };
    const { RecoveryContainerService, RecoverySandbox } = await import(
      new URL("../../recovery-container/src/worker-main.ts", import.meta.url).href
    );
    const env = {
      RESOURCE_NAMESPACE: "production",
      RECOVERY_CONFIGURATION: JSON.stringify({
        inputKeyBase64: Buffer.alloc(32, 1).toString("base64"),
        r2AccountId: "00000000000000000000000000000001",
        r2AccessKeyId: "a".repeat(32),
        r2ApiToken: "fixture-recovery-token",
        pgcf: {
          baseUrl: "https://pgcf.example.test/",
          projectId: "prj_" + "a".repeat(20),
          apiKey: "fixture-provider-key",
        },
      }),
      NATIVE_RESTORE_JOB_STORE: runtime,
      RECOVERY_CONTROL_STORE: {},
      NATIVE_RESTORE_ADMIN_US: {},
      NATIVE_RESTORE_ADMIN_EU: {},
      NATIVE_RESTORE_POLICY_US: {},
      NATIVE_RESTORE_POLICY_EU: {},
      NATIVE_RESTORE_PREPARATION_US: {},
      NATIVE_RESTORE_PREPARATION_EU: {},
      RECOVERY_SANDBOX: {
        getByName(name: string) {
          expect(name).toBe(`native-restore/${organizationId}/${projectId}/${restoreId}`);
          return sandbox;
        },
      },
    };
    const sandbox = new RecoverySandbox(
      {
        id: { toString: () => "cleanup-sandbox" },
        container: {
          running: false,
          getTcpPort: () => ({ fetch: async () => Response.json(await runCleanup()) }),
        },
      } as never,
      env as never,
    );
    const service = new RecoveryContainerService({} as never, env as never);
    const { perform } = await import(
      new URL("../../../scripts/native-auth-restore-operator.mjs", import.meta.url).href
    );
    const bindings = [
      { type: "plain_text", name: "RESOURCE_NAMESPACE", text: "production" },
      {
        type: "durable_object_namespace",
        name: "RECOVERY_SANDBOX",
        class_name: "RecoverySandbox",
        namespace_id: "a".repeat(32),
      },
      { type: "secret_text", name: "RECOVERY_CONFIGURATION" },
      ...[
        [
          "NATIVE_RESTORE_JOB_STORE",
          "ohmyho-control-store-production",
          "NativeAuthRestoreJobRuntime",
        ],
        ["RECOVERY_CONTROL_STORE", "ohmyho-control-store-production", "RecoveryRuntime"],
        ...["US", "EU"].flatMap((region) => [
          [
            `NATIVE_RESTORE_ADMIN_${region}`,
            `ohmyho-native-auth-production-${region.toLowerCase()}`,
            "NativeAdminService",
          ],
          [
            `NATIVE_RESTORE_POLICY_${region}`,
            `ohmyho-native-auth-production-${region.toLowerCase()}`,
            "NativePolicyService",
          ],
          [
            `NATIVE_RESTORE_PREPARATION_${region}`,
            "ohmyho-neon-management-production",
            "NativeAuthRestorePreparationService",
          ],
        ]),
      ].map(([name, service, entrypoint]) => ({ type: "service", name, service, entrypoint })),
    ];
    const session = [
      "e30",
      Buffer.from(
        JSON.stringify({
          iss: "https://api.workos.com/user_management/client_00000000000000000000000018",
          client_id: "client_00000000000000000000000018",
          sub: f.input.principalId.slice(5),
          sid: "session_cleanup",
          org_id: "org_cleanup",
          exp: Math.floor(Date.now() / 1000) + 1000,
        }),
      ).toString("base64url"),
      "c2ln",
    ].join(".");
    const previousToken = process.env["CLOUDFLARE_API_TOKEN"];
    process.env["CLOUDFLARE_API_TOKEN"] = "fixture-token";
    try {
      const output = await perform(
        {
          execute: true,
          environment: "production",
          account: "00000000000000000000000000000001",
          ...f.input,
        },
        { session },
        {
          fetcher: async (url: string) => ({
            ok: true,
            json: async () =>
              url.endsWith("/v1/me")
                ? { actor_id: f.input.principalId, organization_ids: [organizationId] }
                : {
                    success: true,
                    result: url.endsWith("/containers/me")
                      ? { external_account_id: "00000000000000000000000000000001" }
                      : { bindings },
                  },
          }),
          openProxy: async () => ({ env: { RECOVERY: service }, dispose: async () => {} }),
        },
      );
      expect(output).toEqual({ status: "complete", restoreId });
    } finally {
      if (previousToken === undefined) delete process.env["CLOUDFLARE_API_TOKEN"];
      else process.env["CLOUDFLARE_API_TOKEN"] = previousToken;
    }
    expect(removeRestorePin).toHaveBeenCalledTimes(2);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await observeNativeRestoreJob(f.context, f.input)).toEqual({
      status: "complete",
      restoreId: f.input.restoreId,
      claimId: f.input.claimId,
    });
    await f.db
      .prepare("UPDATE projects SET owner_state='security_frozen' WHERE project_id=?1")
      .bind(projectId)
      .run();
    await expect(observeNativeRestoreJob(f.context, f.input)).rejects.toThrow();
  } finally {
    await f.control.dispose();
  }
}, 120_000);
