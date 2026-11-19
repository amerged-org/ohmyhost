import { revokeMcpConsent } from "../../src/catalog/identity/mcp-delegations.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createRecoveryCommands } from "../../src/catalog/recovery/commands.js";
import {
  ARCHIVE_RETENTION_MILLISECONDS,
  atExecution,
  DB_NOW,
  effectiveNowSql,
  INPUT_RETENTION_MILLISECONDS,
  readRecoverySnapshot,
} from "../../src/catalog/recovery/shared.js";
import { storedTimestamp } from "../../src/timestamps.js";
import {
  MAXIMUM_FENCE_LEASE_MILLISECONDS,
  recoveryCaptureHeldGuard,
} from "../../src/catalog/recovery/fence.js";
import {
  ProjectRecoveryConflictError,
  ProjectRecoveryDailyLimitError,
  RecoveryFenceLostError,
  RecoverySourceBusyError,
} from "../../src/catalog/recovery/errors.js";
import type { PlatformContext } from "../../src/catalog/platform-support.js";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { BucketMovingError, withRouteRefresh } from "../../src/fence.js";
import { bucketOf } from "../../src/router.js";
import { classifyFailure } from "../../src/guards.js";
import {
  coreRouter,
  createTestControl,
  shardBinding,
  type TestControl,
} from "../support/control-d1.js";
import {
  beforeFirstWrite,
  bytes,
  freezeOwnership,
  losingWriteResponses,
  seedProject,
  ulidOf,
  type SeededProject,
} from "../support/platform-fixtures.js";

let control: TestControl;

function commandsOver(shards: Record<string, D1Database>) {
  const context: PlatformContext = {
    directory: control.directory,
    router: coreRouter(control, shards),
  };
  return createRecoveryCommands(
    (command) => (input) => withRouteRefresh(context.router, () => command(context, input)),
  );
}
let recovery: ReturnType<typeof commandsOver>;
beforeAll(async () => {
  control = await createTestControl(2);
  recovery = commandsOver(control.shards);
});
afterAll(async () => control.dispose());

let sequence = 0;
const next = () => (sequence += 1);
const T0 = "2026-10-28T10:00:00.000Z";
const at = (offsetMinutes: number, base = T0) =>
  new Date(Date.parse(base) + offsetMinutes * 60_000).toISOString();
const HOLDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOLDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAIM_1 = "11111111-1111-4111-8111-111111111111";
const CLAIM_2 = "22222222-2222-4222-8222-222222222222";
const ARCHIVE = {
  sqlFiles: ["dev.sql", "prod.sql"],
  bytes: 4096,
  sha256: bytes(32, 7),
  capturedAt: at(5),
};

interface Job {
  readonly project: SeededProject;
  readonly operationId: string;
  readonly scope: { organizationId: string; projectId: string; operationId: string };
}

function acceptInput(project: SeededProject, occurredAt: string, overrides: object = {}) {
  const n = next();
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    billingEpochId: project.billingEpochId,
    operationId: ulidOf("rop", n),
    operationEventId: ulidOf("rope", n),
    auditEventId: ulidOf("ropa", n),
    outboxEventId: ulidOf("ropo", n),
    principalId: "user:owner",
    requestId: `request-${n}`,
    httpMethod: "POST" as const,
    routeTemplate: "/v1/projects/{project_id}/exports",
    idempotencyKey: `key-${n}`,
    canonicalRequestDigest: String(n).padStart(64, "0"),
    occurredAt,
    archiveBucket: "ohmyho-development-backups" as const,
    sealedInput: { ciphertext: bytes(40, 9), nonce: bytes(12, 3), keyVersion: 1 },
    ...overrides,
  };
}

async function accepted(project?: SeededProject, occurredAt = T0): Promise<Job> {
  const seeded = project ?? (await seedProject(control, { shard: next() % 2 }));
  const input = acceptInput(seeded, occurredAt);
  const result = await recovery.owner.acceptRecoveryJob(input);
  expect(result).toEqual({ outcome: "created", operationId: input.operationId });
  return {
    project: seeded,
    operationId: input.operationId,
    scope: {
      organizationId: seeded.organizationId,
      projectId: seeded.projectId,
      operationId: input.operationId,
    },
  };
}

function mutation(job: Job, occurredAt = T0, claimId = CLAIM_1) {
  const n = next();
  return {
    ...job.scope,
    claimId,
    occurredAt,
    operationEventId: ulidOf("mev", n),
    auditEventId: ulidOf("mau", n),
  };
}

async function claimed(job: Job, now = at(1)) {
  const result = await recovery.executor.claim(mutation(job, now));
  expect(result.status).toBe("claimed");
  return result;
}

async function held(job: Job, holderId = HOLDER_A, now = at(2), leaseMilliseconds = 300_000) {
  return recovery.executor.acquireFence({
    ...job.scope,
    claimId: CLAIM_1,
    holderId,
    now,
    leaseMilliseconds,
  });
}

async function count(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  return (
    (
      await db
        .prepare(sql)
        .bind(...params)
        .first<{ n: number }>()
    )?.n ?? -1
  );
}

async function state(job: Job) {
  const db = job.project.shard;
  return {
    operation: await db
      .prepare(
        "SELECT state, failure FROM operations WHERE organization_id = ? AND operation_id = ?",
      )
      .bind(job.scope.organizationId, job.operationId)
      .first<{ state: string; failure: string | null }>(),
    job: await db
      .prepare(
        "SELECT claim_id, finished_at, verified_at, failure_code, archive_bytes, input_ciphertext IS NOT NULL AS has_input FROM project_recovery_jobs WHERE organization_id = ? AND operation_id = ?",
      )
      .bind(job.scope.organizationId, job.operationId)
      .first<Record<string, unknown>>(),
    events: await count(
      db,
      "SELECT count(*) AS n FROM operation_events WHERE organization_id = ? AND operation_id = ?",
      job.scope.organizationId,
      job.operationId,
    ),
    fence: await db
      .prepare(
        "SELECT epoch, holder_id, released_at, lease_expires_at FROM project_recovery_fences WHERE organization_id = ? AND project_id = ?",
      )
      .bind(job.scope.organizationId, job.scope.projectId)
      .first<{ epoch: number; holder_id: string; released_at: string | null }>(),
  };
}

/** Claim, hold the fence and prepare the archive: the state right before the final verified step. */
async function prepared(job: Job) {
  await claimed(job);
  const lease = await held(job, HOLDER_A, at(2), 600_000);
  await recovery.executor.prepareArchive({
    ...mutation(job, at(6)),
    archive: ARCHIVE,
    fence: { epoch: lease.epoch, holderId: lease.holderId },
  });
  return lease;
}

/** The archive columns and whether the sealed input is still held, read straight from the row. */
function archiveColumns(job: Job) {
  return job.project.shard
    .prepare(
      "SELECT archive_bytes, archive_sha256, sql_files, captured_at, archive_expires_at, input_ciphertext IS NOT NULL AS input_held FROM project_recovery_jobs WHERE operation_id = ?",
    )
    .bind(job.operationId)
    .first<Record<string, unknown>>();
}

/** Claim, hold the fence and prepare the archive, returning the job with its current holder. */
async function preparedJob() {
  const job = await accepted();
  const lease = await prepared(job);
  return { job, holder: { epoch: lease.epoch, holderId: lease.holderId } };
}

function discardFor(job: Job, holder: { epoch: number; holderId: string }, now = at(7)) {
  return recovery.executor.discardArchive({
    ...mutation(job, now),
    archive: ARCHIVE,
    fence: holder,
  });
}

describe("recovery job schema", () => {
  it("keeps the original constraints: identity, archive contract, finality and retention", async () => {
    const job = await accepted();
    const db = job.project.shard;
    const attempt = (sql: string, ...params: unknown[]) =>
      db
        .prepare(sql)
        .bind(...params)
        .run();
    await expect(
      attempt(
        "UPDATE project_recovery_jobs SET project_id = ? WHERE organization_id = ? AND operation_id = ?",
        ulidOf("other", 1),
        job.scope.organizationId,
        job.operationId,
      ),
    ).rejects.toThrow(/identity is immutable/u);
    await expect(
      attempt(
        "UPDATE project_recovery_jobs SET archive_bytes = 0, archive_sha256 = ?, sql_files = '[\"dev.sql\"]', captured_at = ?, archive_expires_at = ? WHERE organization_id = ? AND operation_id = ?",
        bytes(32, 1),
        "2026-10-28T10:00:00.000000Z",
        "2026-11-04T10:00:00.000000Z",
        job.scope.organizationId,
        job.operationId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      attempt(
        "UPDATE project_recovery_jobs SET archive_bytes = 5, archive_sha256 = ?, sql_files = '[\"dev.sql\"]', captured_at = ?, archive_expires_at = ? WHERE organization_id = ? AND operation_id = ?",
        bytes(32, 1),
        "2026-10-28T10:00:00.000000Z",
        "2026-11-03T10:00:00.000000Z",
        job.scope.organizationId,
        job.operationId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      attempt(
        "UPDATE project_recovery_jobs SET sql_files = '[\"evil.sql\"]' WHERE organization_id = ? AND operation_id = ?",
        job.scope.organizationId,
        job.operationId,
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      attempt(
        "DELETE FROM project_recovery_jobs WHERE organization_id = ? AND operation_id = ?",
        job.scope.organizationId,
        job.operationId,
      ),
    ).rejects.toThrow(/retained/u);
    // a job of one project cannot name another project's operation or environment
    const other = await seedProject(control, { shard: 0 });
    await expect(
      attempt(
        "INSERT INTO project_recovery_jobs(organization_id, operation_id, project_id, environment_id, input_expires_at, requested_at, archive_bucket) VALUES (?1, ?2, ?3, ?4, '2026-10-28T11:00:00.000000Z', '2026-10-28T10:00:00.000000Z', 'ohmyho-development-backups')",
        job.scope.organizationId,
        job.operationId,
        other.projectId,
        other.devEnvironmentId,
      ),
    ).rejects.toThrow();
  });
});

describe("delegated export authority", () => {
  async function seedDelegatedExport() {
    const project = await seedProject(control, { shard: 0 });
    const grantId = crypto.randomUUID();
    const consentHash = crypto.randomUUID().replaceAll("-", "").repeat(2);
    const timestamp = "2026-10-28T10:00:00.000000Z";
    await project.shard.batch([
      project.shard
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(project.organizationId, timestamp),
      project.shard
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_owner','admin','active',1,?2,?3,'evt')",
        )
        .bind(project.organizationId, bytes(32, 1), timestamp),
      project.shard
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_owner','owner',?3)",
        )
        .bind(project.organizationId, ulidOf("auth", next()), timestamp),
      project.shard
        .prepare(
          "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at) VALUES(?1,?2,'user_owner','export-client',?3,?4,1,?5,0,1,?6)",
        )
        .bind(
          project.organizationId,
          grantId,
          consentHash,
          project.projectId,
          project.billingEpochId,
          timestamp,
        ),
    ]);
    const delegation = {
      grantId,
      clientId: "export-client",
      consentHash: consentHash,
      action: "projects:write" as const,
      authorizationRestriction: {
        actions: ["projects:write" as const],
        projectIds: [project.projectId],
      },
    };
    const input = acceptInput(project, T0, { delegation, principalId: "user:user_owner" });
    await expect(recovery.owner.acceptRecoveryJob(input)).resolves.toMatchObject({
      outcome: "created",
    });
    const stored = await project.shard
      .prepare(
        "SELECT authorization_action,authorization_restriction FROM operation_mcp_delegations WHERE operation_id=?1",
      )
      .bind(input.operationId)
      .first<{ authorization_action: string; authorization_restriction: string }>();
    expect(stored?.authorization_action).toBe("projects:write");
    if (!stored) throw new Error("Accepted delegation fixture missing");
    expect(JSON.parse(stored.authorization_restriction)).toEqual(
      delegation.authorizationRestriction,
    );
    const job = {
      project,
      operationId: input.operationId,
      scope: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: input.operationId,
      },
    };
    return { project, input, delegation, job, timestamp };
  }
  it("retains the accepted cap and fences disconnect against the capture lease", async () => {
    const { project, delegation, job, timestamp } = await seedDelegatedExport();
    await claimed(job);
    const now = new Date().toISOString();
    await held(job, HOLDER_A, now);
    const context = { directory: control.directory, router: coreRouter(control, control.shards) };
    const revoke = () =>
      revokeMcpConsent(context, {
        userId: "user_owner",
        clientId: delegation.clientId,
        consentHash: delegation.consentHash,
        now,
      });
    // The terminal intent is stored before acknowledgement waits for the active lease.
    await expect(revoke()).resolves.toEqual({ state: "pending" });
    const intent = await project.shard
      .prepare(
        "SELECT 1 FROM mcp_connection_revocations WHERE user_id='user_owner' AND client_id='export-client' AND consent_hash=?1",
      )
      .bind(delegation.consentHash)
      .first();
    expect(intent).not.toBeNull();
    await expect(
      recovery.executor.acquireFence({
        ...job.scope,
        claimId: CLAIM_1,
        holderId: HOLDER_A,
        now,
        leaseMilliseconds: 300_000,
      }),
    ).rejects.toThrow();
    await project.shard
      .prepare("UPDATE project_recovery_fences SET released_at=?2 WHERE organization_id=?1")
      .bind(project.organizationId, timestamp)
      .run();
    await expect(revoke()).resolves.toEqual({ state: "revoked" });
    await expect(
      recovery.executor.acquireFence({
        ...job.scope,
        claimId: CLAIM_1,
        holderId: HOLDER_B,
        now,
        leaseMilliseconds: 300_000,
      }),
    ).rejects.toThrow();
    const fence = await project.shard
      .prepare("SELECT holder_id,released_at FROM project_recovery_fences WHERE organization_id=?1")
      .bind(project.organizationId)
      .first<{ holder_id: string; released_at: string | null }>();
    expect(fence?.holder_id).toBe(HOLDER_A);
    expect(fence?.released_at).not.toBeNull();
    await expect(recovery.executor.claim(mutation(job, at(1), CLAIM_1))).rejects.toThrow();
  });
  it("aborts lease acquisition if disconnect wins after its snapshot", async () => {
    const { project, delegation, job } = await seedDelegatedExport();
    await claimed(job);
    const now = new Date().toISOString();
    const context = { directory: control.directory, router: coreRouter(control, control.shards) };
    const racing = commandsOver({
      ...control.shards,
      [shardBinding(0)]: beforeFirstWrite(project.shard, async () => {
        await revokeMcpConsent(context, {
          userId: "user_owner",
          clientId: delegation.clientId,
          consentHash: delegation.consentHash,
          now,
        });
      }),
    });
    await expect(
      racing.executor.acquireFence({
        ...job.scope,
        claimId: CLAIM_1,
        holderId: HOLDER_A,
        now,
        leaseMilliseconds: 300_000,
      }),
    ).rejects.toThrow();
    expect(
      await project.shard
        .prepare("SELECT 1 FROM project_recovery_fences WHERE organization_id=?1")
        .bind(project.organizationId)
        .first(),
    ).toBeNull();
    expect(
      await project.shard
        .prepare(
          "SELECT 1 FROM mcp_connection_revocations WHERE user_id='user_owner' AND client_id='export-client' AND consent_hash=?1",
        )
        .bind(delegation.consentHash)
        .first(),
    ).not.toBeNull();
  });
});

describe("acceptRecoveryJob: one batch, one job", () => {
  it("creates the job, the queued operation, audit, outbox and receipt together and replays under the same key", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    const input = acceptInput(project, T0);
    expect(await recovery.owner.acceptRecoveryJob(input)).toEqual({
      outcome: "created",
      operationId: input.operationId,
    });
    const db = project.shard;
    const rows = async () => ({
      jobs: await count(
        db,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        project.projectId,
      ),
      operations: await count(
        db,
        "SELECT count(*) AS n FROM operations WHERE project_id = ?",
        project.projectId,
      ),
      outbox: await count(
        db,
        "SELECT count(*) AS n FROM outbox_events WHERE project_id = ? AND event_type = 'ProjectRecoveryRequestedV1'",
        project.projectId,
      ),
      audit: await count(
        db,
        "SELECT count(*) AS n FROM audit_events WHERE operation_id = ? AND event_type = 'ProjectRecoveryRequestedV1'",
        input.operationId,
      ),
      receipts: await count(
        db,
        "SELECT count(*) AS n FROM api_idempotency_records WHERE organization_id = ?",
        project.organizationId,
      ),
    });
    expect(await rows()).toEqual({ jobs: 1, operations: 1, outbox: 1, audit: 1, receipts: 1 });
    const stored = await db
      .prepare(
        "SELECT lower(hex(input_ciphertext)) AS c, lower(hex(input_nonce)) AS n, input_key_version AS v, input_expires_at AS e, archive_key AS k, archive_bucket AS b FROM project_recovery_jobs WHERE operation_id = ?",
      )
      .bind(input.operationId)
      .first<Record<string, unknown>>();
    expect(stored).toEqual({
      c: "09".repeat(40),
      n: "03".repeat(12),
      v: 1,
      e: "2026-10-28T11:00:00.000000Z",
      k: `snapshots/${project.organizationId}/${project.projectId}/${input.operationId}.zip`,
      b: "ohmyho-development-backups",
    });
    // the same request again (a retry after any response) is the original job, nothing new
    expect(await recovery.owner.acceptRecoveryJob({ ...input, occurredAt: at(3) })).toEqual({
      outcome: "replayed",
      operationId: input.operationId,
    });
    expect(await rows()).toEqual({ jobs: 1, operations: 1, outbox: 1, audit: 1, receipts: 1 });
    // the same key with another request is an idempotency conflict, never a second job
    await expect(
      recovery.owner.acceptRecoveryJob({ ...input, canonicalRequestDigest: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await rows()).jobs).toBe(1);
  });

  it("allows one export per project in a rolling 24 hours and again after it", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    await recovery.owner.acceptRecoveryJob(acceptInput(project, T0));
    const refused = await recovery.owner
      .acceptRecoveryJob(acceptInput(project, at(60 * 23 + 59)))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProjectRecoveryDailyLimitError);
    expect((refused as ProjectRecoveryDailyLimitError).retryAt).toBe(at(60 * 24));
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        project.projectId,
      ),
    ).toBe(1);
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM operations WHERE project_id = ?",
        project.projectId,
      ),
    ).toBe(1);
    await expect(
      recovery.owner.acceptRecoveryJob(acceptInput(project, at(60 * 24 + 1))),
    ).resolves.toMatchObject({
      outcome: "created",
    });
    // a different project is unaffected by this project's window
    const other = await seedProject(control, { shard: next() % 2 });
    await expect(
      recovery.owner.acceptRecoveryJob(acceptInput(other, at(5))),
    ).resolves.toMatchObject({
      outcome: "created",
    });
  });

  it("does not start the daily window with an export that failed because its database was unavailable", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    const unavailable = await accepted(project, T0);
    await claimed(unavailable);
    const lease = await held(unavailable);
    await recovery.executor.finish({
      ...mutation(unavailable, at(4)),
      failureCode: "RECOVERY_DATABASE_UNAVAILABLE",
      fence: { epoch: lease.epoch, holderId: HOLDER_A },
    });
    // The status tells the owner that a new export is allowed at once: the failed attempt is not counted.
    await expect(recovery.owner.readExportStatus(unavailable.scope)).resolves.toMatchObject({
      state: "failed",
      failureCode: "RECOVERY_DATABASE_UNAVAILABLE",
      nextRequestAt: T0,
    });
    // A new export is accepted within the same 24 hours, and a queued export starts the window again.
    await accepted(project, at(60));
    const refused = await recovery.owner
      .acceptRecoveryJob(acceptInput(project, at(120)))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProjectRecoveryDailyLimitError);
    expect((refused as ProjectRecoveryDailyLimitError).retryAt).toBe(at(60 + 60 * 24));
  });

  it("still counts an export that failed for any other reason within the daily window", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    const failed = await accepted(project, T0);
    await claimed(failed);
    const lease = await held(failed);
    await recovery.executor.finish({
      ...mutation(failed, at(4)),
      failureCode: "RECOVERY_CAPTURE_FAILED",
      fence: { epoch: lease.epoch, holderId: HOLDER_A },
    });
    await expect(
      recovery.owner.acceptRecoveryJob(acceptInput(project, at(60))),
    ).rejects.toBeInstanceOf(ProjectRecoveryDailyLimitError);
  });

  it("lets exactly one of two concurrent exports of one project commit", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    const results = await Promise.allSettled([
      recovery.owner.acceptRecoveryJob(acceptInput(project, T0)),
      recovery.owner.acceptRecoveryJob(acceptInput(project, at(1))),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ProjectRecoveryDailyLimitError);
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        project.projectId,
      ),
    ).toBe(1);
  });

  it("answers a lost response with the original job and never a second one", async () => {
    const project = await seedProject(control, { shard: 0 });
    const lossy = commandsOver({
      ...control.shards,
      [shardBinding(0)]: losingWriteResponses(control.shards[shardBinding(0)] as D1Database, 1),
    });
    const input = acceptInput(project, T0);
    await expect(lossy.owner.acceptRecoveryJob(input)).resolves.toEqual({
      outcome: "replayed",
      operationId: input.operationId,
    });
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        project.projectId,
      ),
    ).toBe(1);
  });

  it("rolls everything back when any statement of the batch fails", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    await accepted(project);
    // a reused outbox event id aborts the batch late: no operation, receipt, audit or job of the second request
    const clash = acceptInput(project, at(60 * 25), {});
    const existingOutbox = (
      await project.shard
        .prepare("SELECT event_id FROM outbox_events WHERE project_id = ?")
        .bind(project.projectId)
        .first<{ event_id: string }>()
    )?.event_id as string;
    await expect(
      recovery.owner.acceptRecoveryJob({ ...clash, outboxEventId: existingOutbox }),
    ).rejects.toThrow();
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM operations WHERE project_id = ?",
        project.projectId,
      ),
    ).toBe(1);
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        project.projectId,
      ),
    ).toBe(1);
    expect(
      await count(
        project.shard,
        "SELECT count(*) AS n FROM api_idempotency_records WHERE organization_id = ?",
        project.organizationId,
      ),
    ).toBe(1);
  });

  it("refuses an inactive project, a foreign organization and a malformed envelope", async () => {
    const frozen = await seedProject(control, { shard: next() % 2 });
    await freezeOwnership(frozen);
    await expect(recovery.owner.acceptRecoveryJob(acceptInput(frozen, T0))).rejects.toMatchObject({
      code: "scope_inactive",
    });
    const mine = await seedProject(control, { shard: 0 });
    const theirs = await seedProject(control, { shard: 1 });
    await expect(
      recovery.owner.acceptRecoveryJob(acceptInput(mine, T0, { projectId: theirs.projectId })),
    ).rejects.toMatchObject({ code: "scope_inactive" });
    await expect(
      recovery.owner.acceptRecoveryJob(
        acceptInput(mine, T0, {
          sealedInput: { ciphertext: bytes(5, 1), nonce: bytes(12, 1), keyVersion: 1 },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await count(
        mine.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        mine.projectId,
      ),
    ).toBe(0);
    expect(
      await count(
        theirs.shard,
        "SELECT count(*) AS n FROM project_recovery_jobs WHERE project_id = ?",
        theirs.projectId,
      ),
    ).toBe(0);
  });
});

describe("claimRecoveryJob", () => {
  it("claims once, returns the sealed bytes unchanged and replays only the same claim", async () => {
    const job = await accepted();
    const first = await recovery.executor.claim(mutation(job, at(1)));
    expect(first).toMatchObject({
      status: "claimed",
      replayed: false,
      expired: false,
      denialCode: null,
      preparedArchive: null,
      archiveBucket: "ohmyho-development-backups",
      archiveKey: `snapshots/${job.scope.organizationId}/${job.scope.projectId}/${job.operationId}.zip`,
    });
    const sealed = (
      first as { sealedInput: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number } }
    ).sealedInput;
    expect([...sealed.ciphertext]).toEqual([...bytes(40, 9)]);
    expect([...sealed.nonce]).toEqual([...bytes(12, 3)]);
    expect(sealed.keyVersion).toBe(1);
    const afterFirst = await state(job);
    expect(afterFirst.operation?.state).toBe("running");
    expect(afterFirst.events).toBe(2);
    expect(
      await count(
        job.project.shard,
        "SELECT count(*) AS n FROM audit_events WHERE operation_id = ? AND event_type = 'OperationStarted'",
        job.operationId,
      ),
    ).toBe(1);
    // the same claim again (lost response): same answer, no second start
    expect(await recovery.executor.claim(mutation(job, at(2)))).toMatchObject({
      status: "claimed",
      replayed: true,
    });
    expect((await state(job)).events).toBe(2);
    // another claim of a running job is not a claim
    expect(await recovery.executor.claim(mutation(job, at(2), CLAIM_2))).toEqual({
      status: "running",
    });
    expect((await state(job)).job?.["claim_id"]).toBe(CLAIM_1);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const job = await accepted();
    const results = await Promise.all([
      recovery.executor.claim(mutation(job, at(1), CLAIM_1)),
      recovery.executor.claim(mutation(job, at(1), CLAIM_2)),
    ]);
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "running")).toHaveLength(1);
    expect((await state(job)).events).toBe(2);
  });

  it("withdraws an expired input at a later now and denies it", async () => {
    const job = await accepted();
    const result = await recovery.executor.claim(mutation(job, at(61)));
    expect(result).toMatchObject({
      status: "claimed",
      expired: true,
      denialCode: "RECOVERY_INPUT_EXPIRED",
      sealedInput: null,
    });
    expect((await state(job)).job?.["has_input"]).toBe(0);
  });

  it("denies a project that left the active scope and keeps other scopes absent", async () => {
    const job = await accepted();
    await freezeOwnership(job.project);
    expect(await recovery.executor.claim(mutation(job, at(1)))).toMatchObject({
      status: "claimed",
      denialCode: "RECOVERY_SCOPE_UNAVAILABLE",
      sealedInput: null,
    });
    const other = await seedProject(control, { shard: next() % 2 });
    expect(
      await recovery.executor.claim({
        ...mutation(job, at(1)),
        organizationId: other.organizationId,
      }),
    ).toEqual({ status: "absent" });
    expect(
      await recovery.executor.claim({ ...mutation(job, at(1)), projectId: other.projectId }),
    ).toEqual({ status: "absent" });
  });

  it("waits while another holder captures the project and claims after the lease lapsed", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    const older = await accepted(project, at(-60 * 26));
    const newer = await accepted(project, T0);
    await claimed(older, at(-60 * 26 + 1));
    await recovery.executor.acquireFence({
      ...older.scope,
      claimId: CLAIM_1,
      holderId: HOLDER_A,
      now: at(2),
      leaseMilliseconds: 300_000,
    });
    // PG: the advisory lock was unavailable, the job reports its state and nothing changes
    expect(await recovery.executor.claim(mutation(newer, at(3), CLAIM_2))).toEqual({
      status: "queued",
    });
    expect((await state(newer)).operation?.state).toBe("queued");
    // after the lease lapsed there is no live holder
    expect(await recovery.executor.claim(mutation(newer, at(8), CLAIM_2))).toMatchObject({
      status: "claimed",
    });
  });

  it("refuses input that has an unusable stored envelope", async () => {
    const job = await accepted();
    await job.project.shard
      .prepare(
        "UPDATE project_recovery_jobs SET input_ciphertext = NULL, input_nonce = NULL, input_key_version = NULL WHERE operation_id = ?",
      )
      .bind(job.operationId)
      .run();
    await expect(recovery.executor.claim(mutation(job, at(1)))).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    expect((await state(job)).operation?.state).toBe("queued");
  });
});

describe("the durable fence", () => {
  it("is exclusive, replays the same holder and raises the epoch on takeover", async () => {
    const job = await accepted();
    await claimed(job);
    const first = await held(job);
    expect(first).toMatchObject({
      outcome: "acquired",
      epoch: 1,
      holderId: HOLDER_A,
      leaseExpiresAt: at(7),
    });
    expect(await held(job, HOLDER_A, at(3))).toMatchObject({ outcome: "replayed", epoch: 1 });
    await expect(held(job, HOLDER_B, at(3))).rejects.toBeInstanceOf(RecoverySourceBusyError);
    // a crashed holder's lease lapses; takeover is epoch 2, nothing was ever deleted
    const second = await held(job, HOLDER_B, at(8));
    expect(second).toMatchObject({ outcome: "acquired", epoch: 2, holderId: HOLDER_B });
    expect((await state(job)).fence).toMatchObject({
      epoch: 2,
      holder_id: HOLDER_B,
      released_at: null,
    });
  });

  it("lets exactly one of two concurrent holders acquire", async () => {
    const job = await accepted();
    await claimed(job);
    const results = await Promise.allSettled([held(job, HOLDER_A), held(job, HOLDER_B)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(RecoverySourceBusyError);
    expect((await state(job)).fence?.epoch).toBe(1);
  });

  it("answers a lost acquire response with the same lease", async () => {
    const job = await accepted(await seedProject(control, { shard: 0 }));
    await claimed(job);
    const lossy = commandsOver({
      ...control.shards,
      [shardBinding(0)]: losingWriteResponses(control.shards[shardBinding(0)] as D1Database, 1),
    });
    const lease = await lossy.executor.acquireFence({
      ...job.scope,
      claimId: CLAIM_1,
      holderId: HOLDER_A,
      now: at(2),
      leaseMilliseconds: 300_000,
    });
    expect(lease).toMatchObject({ epoch: 1, holderId: HOLDER_A });
    expect((await state(job)).fence?.epoch).toBe(1);
  });

  it("acquires only for the running claimed job of an active project", async () => {
    const queued = await accepted();
    await expect(held(queued)).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    const job = await accepted();
    await claimed(job);
    await expect(
      recovery.executor.acquireFence({
        ...job.scope,
        claimId: CLAIM_2,
        holderId: HOLDER_A,
        now: at(2),
        leaseMilliseconds: 300_000,
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    await freezeOwnership(job.project);
    await expect(held(job)).rejects.toMatchObject({ code: "recovery_scope_unavailable" });
    expect((await state(job)).fence).toBeNull();
  });

  it("renews only the current holder, never backwards and never past one operation lease", async () => {
    const job = await accepted();
    await claimed(job);
    const lease = await held(job);
    const renewed = await recovery.executor.renewFence({
      ...job.scope,
      epoch: lease.epoch,
      holderId: HOLDER_A,
      now: at(4),
      leaseMilliseconds: 300_000,
    });
    expect(renewed).toMatchObject({ outcome: "renewed", leaseExpiresAt: at(9) });
    // a shorter request never shortens the lease
    expect(
      await recovery.executor.renewFence({
        ...job.scope,
        epoch: 1,
        holderId: HOLDER_A,
        now: at(4),
        leaseMilliseconds: 1000,
      }),
    ).toMatchObject({ outcome: "replayed", leaseExpiresAt: at(9) });
    // the lease never exceeds the acquisition plus one operation lease
    const capped = await recovery.executor.renewFence({
      ...job.scope,
      epoch: 1,
      holderId: HOLDER_A,
      now: at(8),
      leaseMilliseconds: MAXIMUM_FENCE_LEASE_MILLISECONDS,
    });
    expect(capped.leaseExpiresAt).toBe(at(2 + 15));
    await expect(
      recovery.executor.renewFence({
        ...job.scope,
        epoch: 1,
        holderId: HOLDER_B,
        now: at(9),
        leaseMilliseconds: 5000,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    await expect(
      recovery.executor.renewFence({
        ...job.scope,
        epoch: 2,
        holderId: HOLDER_A,
        now: at(9),
        leaseMilliseconds: 5000,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    await expect(
      recovery.executor.renewFence({
        ...job.scope,
        epoch: 1,
        holderId: HOLDER_A,
        now: at(30),
        leaseMilliseconds: 5000,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    await expect(
      recovery.executor.renewFence({
        ...job.scope,
        epoch: 1,
        holderId: HOLDER_A,
        now: at(9),
        leaseMilliseconds: 5,
      }),
    ).rejects.toThrow();
  });

  it("refuses to renew once the project's ownership or lifecycle version moved", async () => {
    const job = await accepted();
    await claimed(job);
    const lease = await held(job);
    await job.project.shard
      .prepare(
        "UPDATE projects SET ownership_version = ownership_version + 1 WHERE organization_id = ? AND project_id = ?",
      )
      .bind(job.scope.organizationId, job.scope.projectId)
      .run();
    await expect(
      recovery.executor.renewFence({
        ...job.scope,
        epoch: lease.epoch,
        holderId: HOLDER_A,
        now: at(3),
        leaseMilliseconds: 60_000,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    await expect(
      recovery.executor.prepareArchive({
        ...mutation(job, at(4)),
        archive: ARCHIVE,
        fence: { epoch: lease.epoch, holderId: HOLDER_A },
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect((await state(job)).job?.["archive_bytes"]).toBeNull();
  });

  it("releases only the exact holder and epoch", async () => {
    const job = await accepted();
    await claimed(job);
    const release = (holderId: string, epoch: number, now = at(3)) =>
      recovery.executor.releaseFence({ ...job.scope, epoch, holderId, now });
    expect(await release(HOLDER_A, 1)).toEqual({ outcome: "absent" });
    await held(job);
    expect(await release(HOLDER_B, 1)).toEqual({ outcome: "superseded" });
    expect(await release(HOLDER_A, 7)).toEqual({ outcome: "superseded" });
    expect((await state(job)).fence?.released_at).toBeNull();
    expect(await release(HOLDER_A, 1)).toEqual({ outcome: "released" });
    expect(await release(HOLDER_A, 1, at(4))).toEqual({ outcome: "replayed" });
    // a released fence is free at once, and the next holder is epoch 2
    expect(await held(job, HOLDER_B, at(5))).toMatchObject({ epoch: 2 });
    expect(await release(HOLDER_A, 1, at(6))).toEqual({ outcome: "superseded" });
    expect((await state(job)).fence).toMatchObject({
      epoch: 2,
      holder_id: HOLDER_B,
      released_at: null,
    });
  });

  it("is the deletion side: held while a capture lives, free after release or expiry", async () => {
    const job = await accepted();
    await claimed(job);
    const scope = { organizationId: job.scope.organizationId, projectId: job.scope.projectId };
    expect(await recovery.owner.readCaptureHeld({ ...scope, now: at(2) })).toEqual({ held: false });
    await held(job);
    expect(await recovery.owner.readCaptureHeld({ ...scope, now: at(3) })).toEqual({ held: true });
    expect(await recovery.owner.readCaptureHeld({ ...scope, now: at(8) })).toEqual({ held: false });
    // a composing command's batch is aborted by a capture that started after its snapshot
    const db = job.project.shard;
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES ('deletion-probe', 'n', 'd', '{}', 1)",
        ),
        recoveryCaptureHeldGuard(db, scope, at(3), false),
      ]),
    ).rejects.toSatisfy((error: unknown) => {
      const failure = classifyFailure(error);
      return failure.kind === "guard" && failure.code === "precondition_changed";
    });
    expect(
      await count(db, "SELECT count(*) AS n FROM command_log WHERE command_id = 'deletion-probe'"),
    ).toBe(0);
    await db.batch([recoveryCaptureHeldGuard(db, scope, at(8), false)]);
    const other = await seedProject(control, { shard: next() % 2 });
    expect(
      await recovery.owner.readCaptureHeld({
        organizationId: other.organizationId,
        projectId: other.projectId,
        now: at(3),
      }),
    ).toEqual({ held: false });
    expect(
      await recovery.owner.readCaptureHeld({
        organizationId: other.organizationId,
        projectId: scope.projectId,
        now: at(3),
      }),
    ).toEqual({ held: false });
  });
});

describe("prepare and finish", () => {
  it("records the archive once for the current holder and replays the identical archive", async () => {
    const job = await accepted();
    await claimed(job);
    const lease = await held(job);
    const fence = { epoch: lease.epoch, holderId: lease.holderId };
    const attempt = (overrides: object = {}, claimId = CLAIM_1, now = at(6)) =>
      recovery.executor.prepareArchive({
        ...mutation(job, now, claimId),
        archive: ARCHIVE,
        fence,
        ...overrides,
      });
    expect(await attempt()).toEqual({ outcome: "prepared" });
    expect(await attempt()).toEqual({ outcome: "replayed" });
    await expect(attempt({ archive: { ...ARCHIVE, bytes: 4097 } })).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    await expect(attempt({}, CLAIM_2)).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    const row = await job.project.shard
      .prepare(
        "SELECT archive_bytes, sql_files, captured_at, archive_expires_at FROM project_recovery_jobs WHERE operation_id = ?",
      )
      .bind(job.operationId)
      .first();
    expect(row).toEqual({
      archive_bytes: 4096,
      sql_files: '["dev.sql","prod.sql"]',
      captured_at: "2026-10-28T10:05:00.000000Z",
      archive_expires_at: "2026-11-04T10:05:00.000000Z",
    });
    await expect(
      recovery.executor.prepareArchive({
        ...mutation(job, at(6)),
        archive: { ...ARCHIVE, sqlFiles: ["x.sql"] },
        fence,
      }),
    ).rejects.toThrow();
    await expect(
      recovery.executor.prepareArchive({
        ...mutation(job, at(6)),
        archive: { ...ARCHIVE, bytes: 0 },
        fence,
      }),
    ).rejects.toThrow();
  });

  it("refuses a stale holder's metadata before anything is written", async () => {
    const job = await accepted();
    await claimed(job);
    const stale = await held(job, HOLDER_A, at(2), 60_000);
    const current = await held(job, HOLDER_B, at(4));
    expect(current.epoch).toBe(2);
    await expect(
      recovery.executor.prepareArchive({
        ...mutation(job, at(4)),
        archive: ARCHIVE,
        fence: { epoch: stale.epoch, holderId: HOLDER_A },
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    await expect(
      recovery.executor.prepareArchive({
        ...mutation(job, at(4)),
        archive: ARCHIVE,
        fence: { epoch: current.epoch, holderId: HOLDER_A },
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect((await state(job)).job?.["archive_bytes"]).toBeNull();
    await expect(
      recovery.executor.prepareArchive({
        ...mutation(job, at(10)),
        archive: ARCHIVE,
        fence: { epoch: current.epoch, holderId: HOLDER_B },
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
  });

  it("aborts the whole prepare when the lease dies between snapshot and write", async () => {
    const job = await accepted(await seedProject(control, { shard: 0 }));
    await claimed(job);
    const lease = await held(job);
    const raw = control.shards[shardBinding(0)] as D1Database;
    const racing = commandsOver({
      ...control.shards,
      [shardBinding(0)]: beforeFirstWrite(raw, async () => {
        await raw
          .prepare(
            "UPDATE project_recovery_fences SET lease_expires_at = '2026-10-28T10:02:30.000000Z' WHERE organization_id = ?",
          )
          .bind(job.scope.organizationId)
          .run();
      }),
    });
    await expect(
      racing.executor.prepareArchive({
        ...mutation(job, at(3)),
        archive: ARCHIVE,
        fence: { epoch: lease.epoch, holderId: HOLDER_A },
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect((await state(job)).job?.["archive_bytes"]).toBeNull();
  });

  it("finishes with a verified archive: operation, job, audit and fence in one batch, final afterwards", async () => {
    const job = await accepted();
    const lease = await prepared(job);
    const finish = (overrides: object = {}, now = at(7)) =>
      recovery.executor.finish({
        ...mutation(job, now),
        archive: ARCHIVE,
        fence: { epoch: lease.epoch, holderId: lease.holderId },
        ...overrides,
      });
    // an archive that differs from the prepared one is never accepted
    await expect(finish({ archive: { ...ARCHIVE, sha256: bytes(32, 8) } })).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    expect((await state(job)).operation?.state).toBe("running");
    expect(await finish()).toEqual({ outcome: "finished", status: "succeeded" });
    const done = await state(job);
    expect(done.operation).toEqual({ state: "succeeded", failure: null });
    expect(done.job).toMatchObject({
      finished_at: "2026-10-28T10:07:00.000000Z",
      verified_at: "2026-10-28T10:07:00.000000Z",
      failure_code: null,
      has_input: 0,
    });
    expect(done.fence?.released_at).toBe("2026-10-28T10:07:00.000000Z");
    expect(done.events).toBe(3);
    expect(
      await count(
        job.project.shard,
        "SELECT count(*) AS n FROM audit_events WHERE operation_id = ? AND event_type = 'OperationSucceeded'",
        job.operationId,
      ),
    ).toBe(1);
    // terminal replay (the response was lost): the same result, no second event
    expect(await finish({}, at(9))).toEqual({ outcome: "replayed", status: "succeeded" });
    expect((await state(job)).events).toBe(3);
    // the other outcome after success is a conflict, and a finished row cannot be edited
    await expect(
      recovery.executor.finish({ ...mutation(job, at(9)), failureCode: "RECOVERY_JOB_FAILED" }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    await expect(
      job.project.shard
        .prepare("UPDATE project_recovery_jobs SET failure_code = 'LATE' WHERE operation_id = ?")
        .bind(job.operationId)
        .run(),
    ).rejects.toThrow(/final once finished/u);
  });

  it("refuses success from a stale holder and from a lapsed lease, leaving the job running", async () => {
    const job = await accepted();
    const lease = await prepared(job);
    const finish = (holderId: string, epoch: number, now: string) =>
      recovery.executor.finish({
        ...mutation(job, now),
        archive: ARCHIVE,
        fence: { epoch, holderId },
      });
    await expect(finish(HOLDER_B, lease.epoch, at(7))).rejects.toBeInstanceOf(
      RecoveryFenceLostError,
    );
    await expect(finish(HOLDER_A, lease.epoch + 1, at(7))).rejects.toBeInstanceOf(
      RecoveryFenceLostError,
    );
    await expect(finish(HOLDER_A, lease.epoch, at(30))).rejects.toBeInstanceOf(
      RecoveryFenceLostError,
    );
    const after = await state(job);
    expect(after.operation?.state).toBe("running");
    expect(after.events).toBe(2);
    expect(after.job?.["finished_at"]).toBeNull();
  });

  it("rolls the whole success back when the lease dies between snapshot and write", async () => {
    const project = await seedProject(control, { shard: 0 });
    const job = await accepted(project);
    const lease = await prepared(job);
    const raw = control.shards[shardBinding(0)] as D1Database;
    const racing = commandsOver({
      ...control.shards,
      [shardBinding(0)]: beforeFirstWrite(raw, async () => {
        await raw
          .prepare(
            "UPDATE project_recovery_fences SET lease_expires_at = '2026-10-28T10:06:30.000000Z' WHERE organization_id = ?",
          )
          .bind(job.scope.organizationId)
          .run();
      }),
    });
    await expect(
      racing.executor.finish({
        ...mutation(job, at(7)),
        archive: ARCHIVE,
        fence: { epoch: lease.epoch, holderId: HOLDER_A },
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    const after = await state(job);
    expect(after.operation?.state).toBe("running");
    expect(after.events).toBe(2);
    expect(after.job).toMatchObject({ finished_at: null, verified_at: null });
    expect(
      await count(
        raw,
        "SELECT count(*) AS n FROM audit_events WHERE operation_id = ? AND event_type = 'OperationSucceeded'",
        job.operationId,
      ),
    ).toBe(0);
  });

  it("answers a lost finish response with the recorded success", async () => {
    const job = await accepted(await seedProject(control, { shard: 0 }));
    const lease = await prepared(job);
    const lossy = commandsOver({
      ...control.shards,
      [shardBinding(0)]: losingWriteResponses(control.shards[shardBinding(0)] as D1Database, 1),
    });
    const outcome = await lossy.executor.finish({
      ...mutation(job, at(7)),
      archive: ARCHIVE,
      fence: { epoch: lease.epoch, holderId: HOLDER_A },
    });
    expect(outcome.status).toBe("succeeded");
    expect((await state(job)).events).toBe(3);
  });

  it("records a failure once, releases the holder's fence and replays only the same code", async () => {
    const job = await accepted();
    await claimed(job);
    const lease = await held(job);
    const fail = (failureCode: string, overrides: object = {}, now = at(4)) =>
      recovery.executor.finish({ ...mutation(job, now), failureCode, ...overrides });
    await expect(fail("lowercase")).rejects.toThrow();
    expect(
      await fail("RECOVERY_STORAGE_UNAVAILABLE", {
        fence: { epoch: lease.epoch, holderId: HOLDER_A },
      }),
    ).toEqual({
      outcome: "finished",
      status: "failed",
    });
    const done = await state(job);
    expect(done.operation?.state).toBe("failed");
    expect(JSON.parse(done.operation?.failure as string)).toEqual({
      code: "RECOVERY_STORAGE_UNAVAILABLE",
      message: "The recovery job did not complete.",
    });
    expect(done.job).toMatchObject({
      failure_code: "RECOVERY_STORAGE_UNAVAILABLE",
      verified_at: null,
      has_input: 0,
    });
    expect(done.fence?.released_at).not.toBeNull();
    expect(await fail("RECOVERY_STORAGE_UNAVAILABLE", {}, at(6))).toEqual({
      outcome: "replayed",
      status: "failed",
    });
    await expect(fail("RECOVERY_JOB_FAILED", {}, at(6))).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    await expect(
      recovery.executor.finish({
        ...mutation(job, at(6)),
        archive: ARCHIVE,
        fence: { epoch: 1, holderId: HOLDER_A },
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
  });

  it("makes a failure wait while another holder captures, and refuses a foreign claim", async () => {
    const job = await accepted();
    await claimed(job);
    await held(job, HOLDER_A);
    expect(
      await recovery.executor.finish({
        ...mutation(job, at(3)),
        failureCode: "RECOVERY_JOB_FAILED",
      }),
    ).toEqual({ outcome: "waiting", status: "running" });
    expect((await state(job)).operation?.state).toBe("running");
    await expect(
      recovery.executor.finish({
        ...mutation(job, at(3), CLAIM_2),
        failureCode: "RECOVERY_JOB_FAILED",
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    // once the lease lapsed the failure is recorded without a fence
    expect(
      await recovery.executor.finish({
        ...mutation(job, at(8)),
        failureCode: "RECOVERY_JOB_FAILED",
      }),
    ).toEqual({ outcome: "finished", status: "failed" });
  });

  it("does not touch a job of another organization", async () => {
    const job = await accepted();
    await claimed(job);
    const other = await seedProject(control, { shard: next() % 2 });
    await expect(
      recovery.executor.finish({
        ...mutation(job, at(3)),
        organizationId: other.organizationId,
        failureCode: "RECOVERY_JOB_FAILED",
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    expect((await state(job)).operation?.state).toBe("running");
  });

  it("discards an unlanded archive only for the exact receipt, claim, holder and running job", async () => {
    const { job, holder } = await preparedJob();
    const discard = (overrides: object = {}, claimId = CLAIM_1, now = at(7)) =>
      recovery.executor.discardArchive({
        ...mutation(job, now, claimId),
        archive: ARCHIVE,
        fence: holder,
        ...overrides,
      });
    // refused, and the recorded archive stays exactly as it was: a different receipt, another claim, another or
    // stale holder, a lapsed lease
    await expect(discard({ archive: { ...ARCHIVE, sha256: bytes(32, 8) } })).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    await expect(discard({ archive: { ...ARCHIVE, bytes: 4097 } })).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    await expect(discard({ archive: { ...ARCHIVE, capturedAt: at(6) } })).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    await expect(discard({}, CLAIM_2)).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    await expect(discard({ fence: { ...holder, holderId: HOLDER_B } })).rejects.toBeInstanceOf(
      RecoveryFenceLostError,
    );
    await expect(discard({ fence: { ...holder, epoch: holder.epoch + 1 } })).rejects.toBeInstanceOf(
      RecoveryFenceLostError,
    );
    await expect(discard({}, CLAIM_1, at(13))).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect(await archiveColumns(job)).toMatchObject({ archive_bytes: 4096 });
    // a queued job and a job of another organization are not discardable
    const queued = await accepted();
    await expect(
      recovery.executor.discardArchive({
        ...mutation(queued, at(7)),
        archive: ARCHIVE,
        fence: holder,
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    const other = await seedProject(control, { shard: next() % 2 });
    await expect(discard({ organizationId: other.organizationId })).rejects.toBeInstanceOf(
      ProjectRecoveryConflictError,
    );
    expect(await archiveColumns(job)).toMatchObject({ archive_bytes: 4096 });
    // the sealed input withdrawn: the last recorded archive is kept, nothing can be captured again
    const withdrawn = await preparedJob();
    await withdrawn.job.project.shard
      .prepare(
        "UPDATE project_recovery_jobs SET input_ciphertext = NULL, input_nonce = NULL, input_key_version = NULL WHERE operation_id = ?",
      )
      .bind(withdrawn.job.operationId)
      .run();
    await expect(
      recovery.executor.discardArchive({
        ...mutation(withdrawn.job, at(7)),
        archive: ARCHIVE,
        fence: withdrawn.holder,
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    expect(await archiveColumns(withdrawn.job)).toMatchObject({ archive_bytes: 4096 });
    // a finished job keeps its verified archive, readable and unchanged
    const finished = await preparedJob();
    await recovery.executor.finish({
      ...mutation(finished.job, at(7)),
      archive: ARCHIVE,
      fence: finished.holder,
    });
    const verified = await archiveColumns(finished.job);
    await expect(
      recovery.executor.discardArchive({
        ...mutation(finished.job, at(8)),
        archive: ARCHIVE,
        fence: finished.holder,
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    expect(await archiveColumns(finished.job)).toEqual(verified);
    expect(await recovery.owner.readArchive({ ...finished.job.scope, now: at(10) })).toMatchObject({
      bytes: 4096,
    });
    // concurrent identical discards: exactly one clears the archive, the other replays
    const racing = await preparedJob();
    const [first, second] = await Promise.all([
      discardFor(racing.job, racing.holder),
      discardFor(racing.job, racing.holder),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["discarded", "replayed"]);
    // the happy path: the archive is cleared, the input and the operation stay, nothing is audited
    const before = await state(job);
    expect(await discard()).toEqual({ outcome: "discarded" });
    expect(await archiveColumns(job)).toEqual({
      archive_bytes: null,
      archive_sha256: null,
      sql_files: null,
      captured_at: null,
      archive_expires_at: null,
      input_held: 1,
    });
    const after = await state(job);
    expect(after.operation?.state).toBe("running");
    expect(after.events).toBe(before.events);
    expect(after.fence).toEqual(before.fence);
    expect(await discard({}, CLAIM_1, at(8))).toEqual({ outcome: "replayed" });
    expect(await state(job)).toEqual(after);
    // the job captures a fresh archive and finishes with it
    const fresh = { ...ARCHIVE, bytes: 8192, sha256: bytes(32, 9) };
    expect(
      await recovery.executor.prepareArchive({
        ...mutation(job, at(9)),
        archive: fresh,
        fence: holder,
      }),
    ).toEqual({ outcome: "prepared" });
    expect(
      await recovery.executor.finish({ ...mutation(job, at(10)), archive: fresh, fence: holder }),
    ).toEqual({ outcome: "finished", status: "succeeded" });

    // no archive was ever recorded: a replay for the current holder discards nothing
    const unrecorded = await accepted();
    await claimed(unrecorded);
    const unrecordedLease = await held(unrecorded, HOLDER_A, at(2), 600_000);
    expect(
      await recovery.executor.discardArchive({
        ...mutation(unrecorded, at(7)),
        archive: ARCHIVE,
        fence: { epoch: unrecordedLease.epoch, holderId: unrecordedLease.holderId },
      }),
    ).toEqual({ outcome: "replayed" });
    expect(await archiveColumns(unrecorded)).toMatchObject({ archive_bytes: null });
    // a prepared archive is final: its only permitted change is the clearing of all five archive fields while the
    // sealed input is still held; any other change, and any change once the input is gone, is refused
    const clearArchive =
      "UPDATE project_recovery_jobs SET archive_bytes = NULL, archive_sha256 = NULL, sql_files = NULL, captured_at = NULL, archive_expires_at = NULL WHERE operation_id = ?";
    const rawUpdate = (target: Job, sql: string) =>
      target.project.shard.prepare(sql).bind(target.operationId).run();
    const rawReplaced = await preparedJob();
    await expect(
      rawUpdate(
        rawReplaced.job,
        `UPDATE project_recovery_jobs SET archive_sha256 = X'${"08".repeat(32)}' WHERE operation_id = ?`,
      ),
    ).rejects.toThrow(/final once prepared/u);
    const rawKept = await preparedJob();
    await rawUpdate(rawKept.job, clearArchive);
    expect(await archiveColumns(rawKept.job)).toMatchObject({ archive_bytes: null, input_held: 1 });
    const rawGone = await preparedJob();
    await rawUpdate(
      rawGone.job,
      "UPDATE project_recovery_jobs SET input_ciphertext = NULL, input_nonce = NULL, input_key_version = NULL WHERE operation_id = ?",
    );
    await expect(rawUpdate(rawGone.job, clearArchive)).rejects.toThrow(/final once prepared/u);
    // a finished job is never updated again, not even to clear its archive
    const rawDone = await preparedJob();
    await recovery.executor.finish({
      ...mutation(rawDone.job, at(7)),
      archive: ARCHIVE,
      fence: rawDone.holder,
    });
    await expect(rawUpdate(rawDone.job, clearArchive)).rejects.toThrow(/final once/u);
  });
});

describe("prepareRecoveryDispatch", () => {
  const dispatch = (job: Job, now: string, extra: object = {}) => {
    const n = next();
    return recovery.owner.prepareDispatch({
      ...job.scope,
      claimId: CLAIM_1,
      occurredAt: now,
      operationEventId: ulidOf("dev", n),
      auditEventId: ulidOf("dau", n),
      terminalOperationEventId: ulidOf("dte", n),
      terminalAuditEventId: ulidOf("dta", n),
      ...extra,
    });
  };

  it("claims into a run command, keeps the earlier claim id and reports a held fence", async () => {
    const job = await accepted();
    expect(await dispatch(job, at(1))).toEqual({
      status: "running",
      command: { action: "run", ...job.scope, claimId: CLAIM_1 },
    });
    // a retry with another uuid keeps the stored claim
    const again = await dispatch(job, at(2), { claimId: CLAIM_2 });
    expect(again.command?.claimId).toBe(CLAIM_1);
    expect((await state(job)).events).toBe(2);
    await held(job);
    expect(await dispatch(job, at(3))).toEqual({ status: "running", command: null });
  });

  it("fails a denied claim in one batch and reports absent and terminal jobs", async () => {
    const expired = await accepted();
    expect(await dispatch(expired, at(61))).toEqual({ status: "failed", command: null });
    const done = await state(expired);
    expect(done.operation?.state).toBe("failed");
    expect(done.events).toBe(3);
    expect(done.job).toMatchObject({ failure_code: "RECOVERY_INPUT_EXPIRED", has_input: 0 });
    expect(await dispatch(expired, at(62))).toEqual({ status: "failed", command: null });
    const frozen = await accepted();
    await freezeOwnership(frozen.project);
    expect(await dispatch(frozen, at(1))).toEqual({ status: "failed", command: null });
    expect((await state(frozen)).job?.["failure_code"]).toBe("RECOVERY_SCOPE_UNAVAILABLE");
    const other = await seedProject(control, { shard: next() % 2 });
    expect(
      await dispatch(
        { ...expired, scope: { ...expired.scope, projectId: other.projectId } },
        at(1),
      ),
    ).toEqual({
      status: "absent",
      command: null,
    });
  });

  it("fails a named dispatch failure with one batch of claim and terminal step", async () => {
    const job = await accepted();
    expect(await dispatch(job, at(1), { failureCode: "RECOVERY_DISPATCH_FAILED" })).toEqual({
      status: "failed",
      command: null,
    });
    const done = await state(job);
    expect(done).toMatchObject({ events: 3, operation: { state: "failed" } });
    expect(done.job?.["failure_code"]).toBe("RECOVERY_DISPATCH_FAILED");
  });

  it("surfaces a claim conflict from a different stored claim", async () => {
    const job = await accepted();
    await job.project.shard
      .prepare(
        "UPDATE project_recovery_jobs SET claim_id = ?, started_at = ? WHERE operation_id = ?",
      )
      .bind(CLAIM_2, "2026-10-28T10:00:30.000000Z", job.operationId)
      .run();
    await expect(dispatch(job, at(1))).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
  });
});

describe("exact-scope reads", () => {
  it("reports the state, the export status and the archive only for the exact job and while it is valid", async () => {
    const job = await accepted();
    const read = { ...job.scope };
    expect(await recovery.executor.readClaimState(read)).toEqual({ status: "queued" });
    expect(await recovery.owner.readExportStatus(read)).toMatchObject({
      state: "queued",
      requestedAt: T0,
      nextRequestAt: at(60 * 24),
      failureCode: null,
      archive: null,
    });
    expect(await recovery.owner.readArchive({ ...read, now: at(10) })).toBeNull();
    const lease = await prepared(job);
    await recovery.executor.finish({
      ...mutation(job, at(7)),
      archive: ARCHIVE,
      fence: { epoch: lease.epoch, holderId: lease.holderId },
    });
    expect(await recovery.executor.readClaimState(read)).toEqual({ status: "succeeded" });
    const status = await recovery.owner.readExportStatus(read);
    expect(status?.archive).toEqual({
      bytes: 4096,
      sha256: `sha256:${"07".repeat(32)}`,
      sqlFiles: ["dev.sql", "prod.sql"],
      capturedAt: at(5),
      expiresAt: at(5, "2026-11-04T10:00:00.000Z"),
    });
    const locator = await recovery.owner.readArchive({ ...read, now: at(10) });
    expect(locator).toMatchObject({
      operationId: job.operationId,
      bucket: "ohmyho-development-backups",
      key: `snapshots/${job.scope.organizationId}/${job.scope.projectId}/${job.operationId}.zip`,
      bytes: 4096,
      sqlFiles: ["dev.sql", "prod.sql"],
      capturedAt: at(5),
      expiresAt: "2026-11-04T10:05:00.000Z",
    });
    expect([...(locator?.sha256 ?? [])]).toEqual([...bytes(32, 7)]);
    // seven days retention: unavailable at and after the expiry
    expect(
      await recovery.owner.readArchive({ ...read, now: "2026-11-04T10:05:00.000Z" }),
    ).toBeNull();
    // other tenants and an inactive project see nothing
    const other = await seedProject(control, { shard: next() % 2 });
    for (const foreign of [
      { organizationId: other.organizationId },
      { projectId: other.projectId },
    ]) {
      expect(await recovery.executor.readClaimState({ ...read, ...foreign })).toBeNull();
      expect(await recovery.owner.readExportStatus({ ...read, ...foreign })).toBeNull();
      expect(await recovery.owner.readArchive({ ...read, ...foreign, now: at(10) })).toBeNull();
    }
    await freezeOwnership(job.project);
    expect(await recovery.owner.readExportStatus(read)).toBeNull();
    expect(await recovery.owner.readArchive({ ...read, now: at(10) })).toBeNull();
  });

  it("returns the shard scope of an active project and nothing for another organization", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    // seeded without data assignments: the inventory is incomplete, never a guess
    await expect(
      recovery.executor.readScope({
        organizationId: project.organizationId,
        projectId: project.projectId,
      }),
    ).rejects.toThrow("recovery_inventory_invalid");
    expect(
      await recovery.executor.readScope({
        organizationId: project.organizationId,
        projectId: ulidOf("zz", 1),
      }),
    ).toBeNull();
    const other = await seedProject(control, { shard: next() % 2 });
    expect(
      await recovery.executor.readScope({
        organizationId: other.organizationId,
        projectId: project.projectId,
      }),
    ).toBeNull();
    await freezeOwnership(project);
    expect(
      await recovery.executor.readScope({
        organizationId: project.organizationId,
        projectId: project.projectId,
      }),
    ).toBeNull();
  });
});

describe("recovery scope assignments", () => {
  async function assign(
    project: SeededProject,
    environmentId: string,
    version: number,
    dataEnvironmentId: string,
  ) {
    const db = project.shard;
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, '2026-10-28T10:00:00.000000Z')",
        )
        .bind(project.organizationId, project.projectId, dataEnvironmentId),
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id, environment_id, assignment_version, project_id, data_environment_id, assigned_at) VALUES (?1, ?2, ?3, ?4, ?5, '2026-10-28T10:00:00.000000Z')",
        )
        .bind(project.organizationId, environmentId, version, project.projectId, dataEnvironmentId),
    ]);
  }

  it("reads the newest assignment of both environments and rejects an incomplete project", async () => {
    const project = await seedProject(control, { shard: next() % 2 });
    const input = { organizationId: project.organizationId, projectId: project.projectId };
    await expect(recovery.executor.readScope(input)).rejects.toThrow("recovery_inventory_invalid");
    await assign(project, project.devEnvironmentId, 1, ulidOf("data", 1));
    await expect(recovery.executor.readScope(input)).rejects.toThrow("recovery_inventory_invalid");
    await assign(project, project.prodEnvironmentId, 1, ulidOf("data", 2));
    await assign(project, project.prodEnvironmentId, 2, ulidOf("data", 3));
    const scope = await recovery.executor.readScope(input);
    expect(
      scope?.environments.map((environment) => [
        environment.name,
        environment.databaseEnvironmentId,
        environment.assignmentVersion,
      ]),
    ).toEqual([
      ["dev", ulidOf("data", 1), 1],
      ["prod", ulidOf("data", 3), 2],
    ]);
    expect(scope?.environments[0]).toMatchObject({
      environmentId: project.devEnvironmentId,
      headVersion: 0,
      activeDeploymentId: null,
    });
  });
});

describe("shard sweeps and the bucket fence", () => {
  async function shardIdOf(job: Job) {
    return control.shards[shardBinding(0)] === job.project.shard ? 0 : 1;
  }

  it("drops expired and terminal envelopes only, of the one core partition and skipping a moving bucket", async () => {
    const project = await seedProject(control, { shard: 0 });
    const expired = await accepted(project, at(-120));
    const live = await accepted(await seedProject(control, { shard: 0 }), T0);
    const moving = await accepted(await seedProject(control, { shard: 0 }), at(-120));
    await control.shards[shardBinding(0)]
      ?.prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moving', ?, '2026-10-28T12:00:00.000000Z')",
      )
      .bind(await bucketOf(moving.scope.organizationId), ulidOf("move", 1))
      .run();
    const cleared = await recovery.maintenance.discardInputs({ shardId: 0, now: T0, limit: 100 });
    // earlier tests leave expired envelopes of their own on this shard; the exact rows below are the contract
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect((await state(expired)).job?.["has_input"]).toBe(0);
    expect((await state(live)).job?.["has_input"]).toBe(1);
    expect((await state(moving)).job?.["has_input"]).toBe(1);
    await expect(
      recovery.maintenance.discardInputs({ shardId: 0, now: T0, limit: 0 }),
    ).rejects.toThrow();
    expect(await shardIdOf(live)).toBe(0);
    // the fence is released so that no later test in this shard lands in a moving bucket
    await control.shards[shardBinding(0)]
      ?.prepare("DELETE FROM bucket_fences WHERE bucket = ? AND state = 'moving'")
      .bind(await bucketOf(moving.scope.organizationId))
      .run();
  });

  it("reports unfinished expired, failed-dispatch and out-of-scope jobs of the shard", async () => {
    const expired = await accepted(await seedProject(control, { shard: 1 }), at(-120));
    const failedDispatch = await accepted(await seedProject(control, { shard: 1 }), at(-3));
    const gone = await accepted(await seedProject(control, { shard: 1 }), at(-2));
    const healthy = await accepted(await seedProject(control, { shard: 1 }), at(-1));
    await failedDispatch.project.shard
      .prepare(
        "UPDATE outbox_events SET reconciliation_required_at = '2026-10-28T09:58:00.000000Z', last_error_code = 'RECOVERY_DISPATCH_FAILED' WHERE operation_id = ?",
      )
      .bind(failedDispatch.operationId)
      .run();
    await freezeOwnership(gone.project);
    const found = await recovery.maintenance.readUnfinishedExpired({ shardId: 0, now: T0 });
    const byOperation = new Map(found.map((entry) => [entry.operationId, entry]));
    expect(byOperation.get(expired.operationId)).toMatchObject({ dispatchFailed: false });
    expect(byOperation.get(failedDispatch.operationId)).toMatchObject({ dispatchFailed: true });
    expect(byOperation.get(gone.operationId)).toMatchObject({ dispatchFailed: false });
    expect(byOperation.has(healthy.operationId)).toBe(false);
    for (const entry of found) {
      expect(
        await count(
          control.core,
          "SELECT count(*) AS n FROM project_recovery_jobs WHERE operation_id = ?",
          entry.operationId,
        ),
      ).toBe(1);
    }
  });

  it("refuses a write while the organization's bucket is moving and serves nothing partial", async () => {
    const job = await accepted(await seedProject(control, { shard: next() % 2 }));
    await job.project.shard
      .prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moving', ?, '2026-10-28T12:00:00.000000Z')",
      )
      .bind(await bucketOf(job.scope.organizationId), ulidOf("move", 2))
      .run();
    await expect(recovery.executor.claim(mutation(job, at(1)))).rejects.toBeInstanceOf(
      BucketMovingError,
    );
    await expect(
      recovery.owner.acceptRecoveryJob(acceptInput(job.project, at(60 * 30))),
    ).rejects.toBeInstanceOf(BucketMovingError);
    expect(await recovery.executor.readClaimState(job.scope)).toEqual({ status: "queued" });
    expect((await state(job)).events).toBe(1);
    await job.project.shard
      .prepare("DELETE FROM bucket_fences WHERE bucket = ? AND state = 'moving'")
      .bind(await bucketOf(job.scope.organizationId))
      .run();
  });
});

describe("retry bounds", () => {
  it("is not exposed with raw SQL: the port has only typed methods", () => {
    expect(Object.keys(recovery.executor).sort()).toEqual([
      "acquireFence",
      "authorizeNativeCapture",
      "claim",
      "discardArchive",
      "dispatchArchive",
      "finish",
      "prepareArchive",
      "readClaimState",
      "readScope",
      "releaseFence",
      "renewFence",
    ]);
    for (const group of [recovery.executor, recovery.owner, recovery.maintenance]) {
      expect(Object.isFrozen(group)).toBe(true);
    }
  });
});

/**
 * Failure injection at the D1 boundary: the FIRST write batch commits and `hook` then runs before its response is
 * returned (a slow reply). Read-only batches pass untouched.
 */
function afterFirstWrite(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true;
  type Wrapped = D1PreparedStatement & { inner: D1PreparedStatement; sql: string };
  const wrap = (inner: D1PreparedStatement, sql: string): Wrapped => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: (...args: []) => inner.first(...args),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as unknown as Wrapped[];
      const results = await db.batch(wrapped.map((statement) => statement.inner));
      if (
        pending &&
        wrapped.some((statement) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(statement.sql))
      ) {
        pending = false;
        await hook();
      }
      return results;
    },
  };
}

describe('execution clock (`clock: "execution"`): the SQL clock of the shard database', () => {
  const sqlClock = async (db: D1Database): Promise<string> =>
    (await db.prepare(`SELECT ${DB_NOW} AS now`).first<{ now: string }>())?.now ?? "";
  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  const realNow = () => new Date().toISOString();
  const inMilliseconds = (milliseconds: number) =>
    new Date(Date.now() + milliseconds).toISOString();
  const pastSqlClock = async (db: D1Database, instant: string) => {
    const stored = storedTimestamp(instant);
    while ((await sqlClock(db)) <= stored) await sleep(20);
  };

  /** Commands over a shard whose FIRST write batch is submitted late: it waits until the SQL clock passed `instant`. */
  function delayedWrite(job: Job, instant: string) {
    const pauses = { count: 0 };
    const db = beforeFirstWrite(job.project.shard, async () => {
      pauses.count += 1;
      await pastSqlClock(job.project.shard, instant);
    });
    return { pauses, commands: commandsOver({ ...control.shards, [shardBinding(0)]: db }) };
  }

  /** Commands over a shard whose FIRST write batch commits and whose response then arrives only after `instant`, as a lost reply. */
  function lostReplyAfter(job: Job, instant: string) {
    const late = afterFirstWrite(job.project.shard, () => pastSqlClock(job.project.shard, instant));
    return commandsOver({
      ...control.shards,
      [shardBinding(0)]: losingWriteResponses(late, 1),
    });
  }

  /**
   * A job accepted at the real time whose sealed input expires `expiresInMilliseconds` from now (the expiry is the
   * acceptance instant plus the fixed retention, and is immutable afterwards, so the acceptance instant is moved).
   */
  async function acceptedExpiringIn(expiresInMilliseconds: number): Promise<Job> {
    return accepted(
      await seedProject(control, { shard: 0 }),
      inMilliseconds(expiresInMilliseconds - INPUT_RETENTION_MILLISECONDS),
    );
  }

  /** A running claimed job (no fence yet) on shard 0. */
  async function runningJob(
    expiresInMilliseconds = INPUT_RETENTION_MILLISECONDS - 1_000,
  ): Promise<Job> {
    const job = await acceptedExpiringIn(expiresInMilliseconds);
    await expect(
      recovery.executor.claim({ ...mutation(job, realNow()), clock: "execution" }),
    ).resolves.toMatchObject({ status: "claimed" });
    return job;
  }

  async function fenced(leaseMilliseconds: number, expiresInMilliseconds?: number) {
    const job = await runningJob(expiresInMilliseconds);
    const lease = await recovery.executor.acquireFence({
      ...job.scope,
      claimId: CLAIM_1,
      holderId: HOLDER_A,
      now: realNow(),
      clock: "execution",
      leaseMilliseconds,
    });
    return { job, lease, holder: { epoch: lease.epoch, holderId: lease.holderId } };
  }

  const failedEvents = (job: Job) =>
    count(
      job.project.shard,
      "SELECT count(*) AS n FROM operation_events WHERE organization_id = ?1 AND operation_id = ?2 AND event_type = 'OperationFailed'",
      job.scope.organizationId,
      job.operationId,
    );

  it("has no supplied instant in the decision: the snapshot carries the SQL clock and the guard takes the later instant", async () => {
    const db = control.shards[shardBinding(0)] as D1Database;
    const stored = await sqlClock(db);
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
    const row = async (param: string) =>
      (
        await db
          .prepare(
            `SELECT ${effectiveNowSql("?1", true)} AS now, ${effectiveNowSql("?1", false)} AS bound`,
          )
          .bind(param)
          .first<{ now: string; bound: string }>()
      )?.now ?? "";
    const past = "2000-01-01T00:00:00.000000Z";
    const future = "2999-01-01T00:00:00.000000Z";
    expect((await row(past)) >= stored).toBe(true);
    expect(await row(future)).toBe(future);
    expect(effectiveNowSql("?6", false)).toBe("?6");
    const supplied = { now: "2026-10-28T10:00:00.000000Z", clock: "execution" as const };
    expect(atExecution(supplied, "now", stored).now).toBe(stored);
    const plain = { now: "2026-10-28T10:00:00.000000Z" };
    expect(atExecution(plain, "now", stored)).toBe(plain);
    const snapshot = await readRecoverySnapshot(db, {
      organizationId: ulidOf("none", 1),
      projectId: ulidOf("none", 2),
      operationId: ulidOf("none", 3),
    });
    expect(snapshot.dbNow >= stored).toBe(true);
  });

  it("refuses the closed clock field and any other way to select an instant or a mode", async () => {
    const job = await runningJob();
    const base = {
      ...job.scope,
      claimId: CLAIM_1,
      holderId: HOLDER_A,
      now: realNow(),
      leaseMilliseconds: 60_000,
    };
    for (const forged of [
      { clock: "supplied" },
      { clock: true },
      { clock: "execution", sqlNow: "2999-01-01T00:00:00.000000Z" },
      { dbNow: "2999-01-01T00:00:00.000000Z" },
    ]) {
      await expect(recovery.executor.acquireFence({ ...base, ...forged })).rejects.toThrow();
    }
    expect((await state(job)).fence).toBeNull();
  });

  it("ignores a forged future instant in execution mode: the lease is cut from the SQL clock", async () => {
    const job = await runningJob();
    const lease = await recovery.executor.acquireFence({
      ...job.scope,
      claimId: CLAIM_1,
      holderId: HOLDER_A,
      now: "2099-01-01T00:00:00.000Z",
      clock: "execution",
      leaseMilliseconds: 60_000,
    });
    expect(lease.outcome).toBe("acquired");
    expect(Date.parse(lease.leaseExpiresAt)).toBeLessThan(Date.now() + 61_000);
    expect(Date.parse(lease.leaseExpiresAt)).toBeGreaterThan(Date.now());
  });

  it("renew: decided while the lease is live, its write batch submitted after the SQL clock passed the lease, changes nothing", async () => {
    const { job, lease, holder } = await fenced(2_000);
    const before = await state(job);
    const { commands, pauses } = delayedWrite(job, lease.leaseExpiresAt);
    // The Worker clock is frozen before the expiry (as inside one Worker execution): only the SQL clock can fence.
    const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      await expect(
        commands.executor.renewFence({
          ...job.scope,
          ...holder,
          now: realNow(),
          leaseMilliseconds: 60_000,
          clock: "execution",
        }),
      ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    } finally {
      frozen.mockRestore();
    }
    expect(pauses.count).toBe(1);
    expect(await state(job)).toEqual(before);
    expect((await state(job)).fence).toMatchObject({ epoch: 1, released_at: null });
  });

  it("prepare: an archive write queued past the lease rolls back whole, with no archive and no event", async () => {
    const { job, lease, holder } = await fenced(2_000);
    const before = await state(job);
    const { commands, pauses } = delayedWrite(job, lease.leaseExpiresAt);
    await expect(
      commands.executor.prepareArchive({
        ...mutation(job, realNow()),
        clock: "execution",
        archive: { ...ARCHIVE, capturedAt: realNow() },
        fence: holder,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect(pauses.count).toBe(1);
    expect(await state(job)).toEqual(before);
    expect((await state(job)).job).toMatchObject({ archive_bytes: null });
  });

  it("finish: a success queued past the lease commits no event, no verification and no release; a later failure still can", async () => {
    const { job, lease, holder } = await fenced(2_500);
    const archive = { ...ARCHIVE, capturedAt: realNow() };
    await recovery.executor.prepareArchive({
      ...mutation(job, realNow()),
      clock: "execution",
      archive,
      fence: holder,
    });
    const before = await state(job);
    const { commands, pauses } = delayedWrite(job, lease.leaseExpiresAt);
    await expect(
      commands.executor.finish({
        ...mutation(job, realNow()),
        clock: "execution",
        archive,
        fence: holder,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect(pauses.count).toBe(1);
    const after = await state(job);
    expect(after).toEqual(before);
    expect(after.operation).toMatchObject({ state: "running" });
    expect(after.job).toMatchObject({ finished_at: null, verified_at: null });
    expect(await failedEvents(job)).toBe(0);
    // The failure side withdraws authority, so it is still accepted for the holder whose lease lapsed.
    await expect(
      recovery.executor.finish({
        ...mutation(job, realNow()),
        clock: "execution",
        failureCode: "RECOVERY_LEASE_EXPIRED",
        fence: holder,
      }),
    ).resolves.toEqual({ outcome: "finished", status: "failed" });
  });

  it("acquire: a lease that would be dead on arrival is never committed; the command decides again at the database time", async () => {
    const job = await runningJob();
    const passed = inMilliseconds(1_500);
    const { commands, pauses } = delayedWrite(job, passed);
    const lease = await commands.executor.acquireFence({
      ...job.scope,
      claimId: CLAIM_1,
      holderId: HOLDER_A,
      now: realNow(),
      clock: "execution",
      leaseMilliseconds: 1_000,
    });
    expect(pauses.count).toBe(1);
    expect(lease.outcome).toBe("acquired");
    const row = await job.project.shard
      .prepare(
        "SELECT epoch, acquired_at, lease_expires_at FROM project_recovery_fences WHERE organization_id = ?1",
      )
      .bind(job.scope.organizationId)
      .first<{ epoch: number; acquired_at: string; lease_expires_at: string }>();
    expect(row?.epoch).toBe(1);
    expect((row?.acquired_at ?? "") >= storedTimestamp(passed)).toBe(true);
    expect((row?.lease_expires_at ?? "") > (await sqlClock(job.project.shard))).toBe(true);
  });

  it("claim: an input that expired while the write batch waited is withdrawn with the denial, the failure and no ciphertext", async () => {
    const job = await acceptedExpiringIn(1_500);
    const { commands, pauses } = delayedWrite(job, inMilliseconds(1_500));
    const result = await commands.executor.claim({
      ...mutation(job, realNow()),
      clock: "execution",
      denial: { operationEventId: ulidOf("dnl", next()), auditEventId: ulidOf("dna", next()) },
    });
    expect(result).toEqual({ status: "failed" });
    expect(pauses.count).toBe(1);
    const after = await state(job);
    expect(after.operation).toMatchObject({ state: "failed" });
    expect(after.job).toMatchObject({ failure_code: "RECOVERY_INPUT_EXPIRED", has_input: 0 });
    expect(after.events).toBe(3);
    expect(await failedEvents(job)).toBe(1);
  });

  it("claim inside a fence: the same late write also releases the holder's fence in the one batch", async () => {
    const { job, holder } = await fenced(60_000, 2_500);
    const { commands, pauses } = delayedWrite(job, inMilliseconds(2_500));
    const result = await commands.executor.claim({
      ...mutation(job, realNow()),
      clock: "execution",
      holderId: holder.holderId,
      denial: {
        epoch: holder.epoch,
        operationEventId: ulidOf("dnl", next()),
        auditEventId: ulidOf("dna", next()),
      },
    });
    expect(result).toEqual({ status: "failed" });
    expect(pauses.count).toBe(1);
    const after = await state(job);
    expect(after.job).toMatchObject({ failure_code: "RECOVERY_INPUT_EXPIRED", has_input: 0 });
    expect(after.fence?.released_at).not.toBeNull();
    expect(after.events).toBe(3);
  });

  it("claim without a denial step: the late claim hands out no ciphertext and withdraws the input (fail closed)", async () => {
    const job = await acceptedExpiringIn(1_500);
    const { commands, pauses } = delayedWrite(job, inMilliseconds(1_500));
    const result = await commands.executor.claim({
      ...mutation(job, realNow()),
      clock: "execution",
    });
    expect(pauses.count).toBe(1);
    expect(result).toMatchObject({
      status: "claimed",
      expired: true,
      denialCode: "RECOVERY_INPUT_EXPIRED",
      sealedInput: null,
    });
    expect((await state(job)).job).toMatchObject({ has_input: 0 });
  });

  it("claim + denial whose response was lost replays once: one failure event, one release", async () => {
    const { job, holder } = await fenced(60_000, -1_000);
    const lossy = commandsOver({
      ...control.shards,
      [shardBinding(0)]: losingWriteResponses(job.project.shard, 1),
    });
    const result = await lossy.executor.claim({
      ...mutation(job, realNow()),
      clock: "execution",
      holderId: holder.holderId,
      denial: {
        epoch: holder.epoch,
        operationEventId: ulidOf("dnl", next()),
        auditEventId: ulidOf("dna", next()),
      },
    });
    expect(result).toEqual({ status: "failed" });
    const after = await state(job);
    expect(after.events).toBe(3);
    expect(await failedEvents(job)).toBe(1);
    expect(after.fence?.released_at).not.toBeNull();
  });

  it("finish committed before the lease expiry is answered from the receipt when the reply is retried after the expiry", async () => {
    const { job, lease, holder } = await fenced(1_500);
    const archive = { ...ARCHIVE, capturedAt: realNow() };
    await recovery.executor.prepareArchive({
      ...mutation(job, realNow()),
      clock: "execution",
      archive,
      fence: holder,
    });
    const finish = {
      ...mutation(job, realNow()),
      clock: "execution" as const,
      archive,
      fence: holder,
    };
    // The commit happens inside the lease; the reply arrives (and is retried) only after the SQL clock passed it.
    const lossy = lostReplyAfter(job, lease.leaseExpiresAt);
    await expect(lossy.executor.finish(finish)).resolves.toEqual({
      outcome: "replayed",
      status: "succeeded",
    });
    const committed = await state(job);
    expect(committed.operation).toMatchObject({ state: "succeeded" });
    expect(committed.events).toBe(3);
    expect(Date.parse(lease.leaseExpiresAt)).toBeLessThanOrEqual(Date.now());
    // A later repeat of the same request is the same receipt; a different outcome is a conflict; nothing repeats.
    await expect(
      recovery.executor.finish({ ...finish, ...mutation(job, realNow()) }),
    ).resolves.toEqual({
      outcome: "replayed",
      status: "succeeded",
    });
    await expect(
      recovery.executor.finish({
        ...mutation(job, realNow()),
        clock: "execution",
        failureCode: "RECOVERY_LATE",
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    expect(await state(job)).toEqual(committed);
  });

  it("dispatch: the same late write cannot hand out an expired input either; it fails the job in the one batch", async () => {
    const job = await acceptedExpiringIn(1_500);
    const { commands, pauses } = delayedWrite(job, inMilliseconds(1_500));
    const result = await commands.owner.prepareDispatch({
      ...mutation(job, realNow()),
      clock: "execution",
      terminalOperationEventId: ulidOf("dtl", next()),
      terminalAuditEventId: ulidOf("dta", next()),
    });
    expect(result).toEqual({ status: "failed", command: null });
    expect(pauses.count).toBe(1);
    const after = await state(job);
    expect(after.job).toMatchObject({ failure_code: "RECOVERY_INPUT_EXPIRED", has_input: 0 });
    expect(after.events).toBe(3);
  });

  it("archive locator: expiry is judged at the SQL clock of the read, never at a supplied instant", async () => {
    const { job, holder } = await fenced(60_000);
    const archive = {
      ...ARCHIVE,
      capturedAt: inMilliseconds(1_500 - ARCHIVE_RETENTION_MILLISECONDS),
    };
    await recovery.executor.prepareArchive({
      ...mutation(job, realNow()),
      clock: "execution",
      archive,
      fence: holder,
    });
    await recovery.executor.finish({
      ...mutation(job, realNow()),
      clock: "execution",
      archive,
      fence: holder,
    });
    const past = "2000-01-01T00:00:00.000Z";
    await expect(
      recovery.owner.readArchive({ ...job.scope, now: past, clock: "execution" }),
    ).resolves.toMatchObject({ operationId: job.operationId });
    await pastSqlClock(job.project.shard, inMilliseconds(1_600));
    // A supplied instant before the expiry does not revive it; only the deterministic caller trusts it.
    await expect(
      recovery.owner.readArchive({ ...job.scope, now: past, clock: "execution" }),
    ).resolves.toBeNull();
    await expect(recovery.owner.readArchive({ ...job.scope, now: past })).resolves.toMatchObject({
      operationId: job.operationId,
    });
  });

  it("composes the denial of an expired input with the failure and the fence release in one batch", async () => {
    const job = await accepted();
    const first = await recovery.executor.claim({ ...mutation(job, at(1)) });
    expect(first.status).toBe("claimed");
    await held(job, HOLDER_A, at(2), 600_000);
    const denial = {
      epoch: 1,
      operationEventId: ulidOf("dnl", next()),
      auditEventId: ulidOf("dna", next()),
    };
    const result = await recovery.executor.claim({
      ...mutation(job, at(70)),
      holderId: HOLDER_A,
      denial,
    });
    expect(result).toEqual({ status: "failed" });
    const after = await state(job);
    expect(after.events).toBe(3);
    expect(
      await count(
        job.project.shard,
        "SELECT count(*) AS n FROM project_recovery_fences WHERE organization_id = ?1 AND released_at IS NOT NULL",
        job.scope.organizationId,
      ),
    ).toBe(1);
    // A repeat (a lost response) is the recorded terminal outcome, not a second failure.
    const again = {
      epoch: 1,
      operationEventId: ulidOf("dnl", next()),
      auditEventId: ulidOf("dna", next()),
    };
    expect(
      await recovery.executor.claim({
        ...mutation(job, at(71)),
        holderId: HOLDER_A,
        denial: again,
      }),
    ).toEqual({ status: "failed" });
    expect((await state(job)).events).toBe(3);
    // The epoch of a fence needs the holder that owns it; the shape is closed.
    await expect(
      recovery.executor.claim({ ...mutation(job, at(70)), denial: { ...denial, epoch: 1 } }),
    ).rejects.toThrow();
  });

  it("discard: a write queued past the lease or past the input expiry rolls back whole and keeps the archive", async () => {
    const lease = await fenced(2_000);
    const archive = { ...ARCHIVE, capturedAt: realNow() };
    await recovery.executor.prepareArchive({
      ...mutation(lease.job, realNow()),
      clock: "execution",
      archive,
      fence: lease.holder,
    });
    const before = await state(lease.job);
    const late = delayedWrite(lease.job, lease.lease.leaseExpiresAt);
    await expect(
      late.commands.executor.discardArchive({
        ...mutation(lease.job, realNow()),
        clock: "execution",
        archive,
        fence: lease.holder,
      }),
    ).rejects.toBeInstanceOf(RecoveryFenceLostError);
    expect(late.pauses.count).toBe(1);
    expect(await state(lease.job)).toEqual(before);
    expect(await archiveColumns(lease.job)).toMatchObject({ archive_bytes: 4096 });
    // the input expires while the discard waits: the archive is kept, the input is not gone for it
    const expiring = await fenced(60_000, 3_000);
    const expiringArchive = { ...ARCHIVE, capturedAt: realNow() };
    await recovery.executor.prepareArchive({
      ...mutation(expiring.job, realNow()),
      clock: "execution",
      archive: expiringArchive,
      fence: expiring.holder,
    });
    const slow = delayedWrite(expiring.job, inMilliseconds(3_000));
    await expect(
      slow.commands.executor.discardArchive({
        ...mutation(expiring.job, realNow()),
        clock: "execution",
        archive: expiringArchive,
        fence: expiring.holder,
      }),
    ).rejects.toBeInstanceOf(ProjectRecoveryConflictError);
    expect(await archiveColumns(expiring.job)).toMatchObject({ archive_bytes: 4096 });
  });
});
