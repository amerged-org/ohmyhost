import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newUlid } from "../src/catalog/common.js";
import { bucketOf } from "../src/router.js";
import { createControlStore } from "../src/store.js";
import { seedAcceptedOperation } from "./support/accepted-operation.js";
import { createTestControl, shardOf, type TestControl } from "./support/control-d1.js";
import { accountOf, reserveBuild } from "./support/credit-fixtures.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";
import { acceptInput, digest, projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
// A shard-wide drain claims the oldest due work of the whole partition, and there is exactly one partition:
// every test therefore starts on its own empty core.
// A fresh core applies every migration; a loaded machine needs more than the default hook timeout for that.
beforeEach(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
}, 60_000);
afterEach(async () => control.dispose());

const first = async <Row>(shard: number, sql: string, ...binds: unknown[]) =>
  shardOf(control, shard)
    .prepare(sql)
    .bind(...binds)
    .first<Row>();
const directoryFirst = async <Row>(sql: string, ...binds: unknown[]) =>
  control.directory
    .prepare(sql)
    .bind(...binds)
    .first<Row>();

async function seedProject(shard: number, handle: string) {
  const organizationId = await seedOrganization(store, 2, shard);
  const project = projectInput(organizationId, handle);
  await store.projects.createInitialProject(project);
  return project;
}

/** The workflow rows an accepted operation has once its outbox event was delivered: intent, run and claim. */
async function seedWorkflow(
  shard: number,
  project: ReturnType<typeof projectInput>,
  accepted: ReturnType<typeof acceptInput>,
  claim: boolean,
) {
  const seeded = await seedAcceptedOperation(
    { ...project, shard: shardOf(control, shard) },
    accepted.environmentId,
    {
      operationId: accepted.operationId,
      eventId: accepted.outboxEventId,
      claim,
      at: "2026-10-28T11:00:00.000000Z",
    },
  );
  return seeded.workflowId;
}

describe("operation leases and queueing", () => {
  it("queues behind the provider-mutation claim, renews only the live execution lease and recovers an abandoned one", async () => {
    const project = await seedProject(0, "lease-handle");
    const organizationId = project.organizationId;
    const holder = acceptInput(project, { idempotencyKey: "holder" });
    await store.operations.acceptApiOperation(holder);
    const workflowId = await seedWorkflow(0, project, holder, true);

    // queueOperation: created, replayed as existing, and an operation id of another project is refused.
    const queued = {
      organizationId,
      billingEpochId: project.billingEpochId,
      operation: {
        operationId: newUlid(),
        projectId: project.projectId,
        eventId: newUlid(),
        occurredAt: "2026-10-28T11:01:00.000Z",
      },
      audit: {
        auditEventId: newUlid(),
        projectId: project.projectId,
        operationId: "",
        eventType: "OperationQueued",
        actorType: "system",
        actorId: "workflow",
        payload: {},
        occurredAt: "2026-10-28T11:01:00.000Z",
      },
      outbox: {
        eventId: newUlid(),
        eventType: "DeploymentRequestedV1",
        createdAt: "2026-10-28T11:01:00.000Z",
        maxAttempts: 5,
      },
    };
    queued.audit.operationId = queued.operation.operationId;
    expect(await store.operations.queueOperation(queued)).toBe("created");
    expect(await store.operations.queueOperation(queued)).toBe("existing");
    const otherProject = newUlid();
    await expect(
      store.operations.queueOperation({
        ...queued,
        operation: { ...queued.operation, projectId: otherProject },
        audit: { ...queued.audit, projectId: otherProject },
      }),
    ).rejects.toMatchObject({ code: "operation_id_taken" });
    await expect(
      store.operations.queueOperation({
        ...queued,
        operation: { ...queued.operation, operationId: newUlid() },
      }),
    ).rejects.toThrow("Audit event must share the operation scope");
    await expect(
      store.operations.queueOperation({
        ...queued,
        billingEpochId: newUlid(),
        operation: { ...queued.operation, operationId: queued.audit.operationId },
      }),
    ).resolves.toBe("existing");
    const stale = newUlid();
    await expect(
      store.operations.queueOperation({
        ...queued,
        billingEpochId: newUlid(),
        operation: { ...queued.operation, operationId: stale },
        audit: { ...queued.audit, operationId: stale },
      }),
    ).rejects.toMatchObject({ code: "scope_inactive" });

    // The queued operation waits behind the holder; the holder waits behind nobody.
    expect(
      await store.operations.readBlockingProductOperation({
        organizationId,
        operationId: queued.operation.operationId,
      }),
    ).toBe(holder.operationId);
    expect(
      await store.operations.readBlockingProductOperation({
        organizationId,
        operationId: holder.operationId,
      }),
    ).toBeNull();

    // Renewal: the physical workflow of the run is the only one that may move the lease.
    const renew = (physicalWorkflowId: string, now: string) =>
      store.operations.renewOperationLease({
        organizationId,
        operationId: holder.operationId,
        workflowId,
        physicalWorkflowId,
        now,
        durationMilliseconds: 900_000,
      });
    await expect(
      renew("some-other-physical-workflow", "2026-10-28T12:00:00.000Z"),
    ).rejects.toMatchObject({ code: "operation_lease_inactive" });
    await expect(renew(workflowId, "2026-10-28T12:00:00.000Z")).resolves.toBeUndefined();
    const lease = await first<{ lease_expires_at: string }>(
      0,
      "SELECT lease_expires_at FROM operations WHERE operation_id = ?",
      holder.operationId,
    );
    expect(lease?.lease_expires_at).toBe("2026-10-28T12:15:00.000000Z");
    // The previous lease lapsed: it cannot be revived.
    await expect(renew(workflowId, "2026-10-28T12:15:00.000Z")).rejects.toMatchObject({
      code: "operation_lease_inactive",
    });

    // Recovery of one exact captured execution refuses another lease value and an unexpired lease.
    const exact = (leaseExpiresAt: string, now: string) => ({
      now,
      exactOperation: {
        organizationId,
        projectId: project.projectId,
        operationId: holder.operationId,
        leaseExpiresAt,
      },
    });
    expect(
      await store.maintenance.recoverExpiredOperationLease(
        exact("2026-10-28T12:15:00.000Z", "2026-10-28T12:14:00.000Z"),
      ),
    ).toBeNull();
    expect(
      await store.maintenance.recoverExpiredOperationLease(
        exact("2026-10-28T12:16:00.000Z", "2026-10-28T12:20:00.000Z"),
      ),
    ).toBeNull();
    // The shard-wide reaper skips an organization whose bucket is fenced, then recovers it once released.
    const bucket = await bucketOf(organizationId);
    await shardOf(control, 0)
      .prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moving', ?, '2026-10-28T12:00:00.000000Z')",
      )
      .bind(bucket, newUlid())
      .run();
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:20:00.000Z",
        shardId: 0,
      }),
    ).toBeNull();
    await shardOf(control, 0)
      .prepare("DELETE FROM bucket_fences WHERE bucket = ?")
      .bind(bucket)
      .run();
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:20:00.000Z",
        shardId: 0,
      }),
    ).toEqual({ organizationId, operationId: holder.operationId, releaseBuildCredits: true });
    expect(
      await first(
        0,
        "SELECT 1 AS present FROM product_provider_mutation_claims WHERE operation_id = ?",
        holder.operationId,
      ),
    ).toBeNull();
    expect(
      await first<{ state: string }>(
        0,
        "SELECT state FROM operations WHERE operation_id = ?",
        holder.operationId,
      ),
    ).toEqual({ state: "failed" });
    // Abandoned means the waiting operation no longer has a blocker.
    expect(
      await store.operations.readBlockingProductOperation({
        organizationId,
        operationId: queued.operation.operationId,
      }),
    ).toBeNull();
    expect(
      await store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:20:00.000Z",
        shardId: 0,
      }),
    ).toBeNull();
  });

  it("recovers an abandoned execution once when the reply of the recovery is lost", async () => {
    const project = await seedProject(0, "lost-lease-handle");
    const holder = acceptInput(project, { idempotencyKey: "lost-lease" });
    await store.operations.acceptApiOperation(holder);
    const workflowId = await seedWorkflow(0, project, holder, true);
    await store.operations.renewOperationLease({
      organizationId: project.organizationId,
      operationId: holder.operationId,
      workflowId,
      physicalWorkflowId: workflowId,
      now: "2026-10-28T12:00:00.000Z",
      durationMilliseconds: 900_000,
    });
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    expect(
      await flaky.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:20:00.000Z",
        shardId: 0,
      }),
    ).toEqual({
      organizationId: project.organizationId,
      operationId: holder.operationId,
      releaseBuildCredits: true,
    });
    expect(
      await first(
        0,
        "SELECT count(*) AS n FROM operation_events WHERE operation_id = ? AND event_type = 'OperationFailed'",
        holder.operationId,
      ),
    ).toEqual({ n: 1 });
  });
});

describe("the build reservation of an abandoned execution", () => {
  it("is released when the build never started and kept while a build may still run", async () => {
    const abandon = async (handle: string, startBuild: boolean) => {
      const project = await seedProject(0, handle);
      const holder = acceptInput(project, { idempotencyKey: handle });
      await store.operations.acceptApiOperation(holder);
      const workflowId = await seedWorkflow(0, project, holder, true);
      await store.operations.renewOperationLease({
        organizationId: project.organizationId,
        operationId: holder.operationId,
        workflowId,
        physicalWorkflowId: workflowId,
        now: "2026-10-28T12:00:00.000Z",
        durationMilliseconds: 900_000,
      });
      await reserveBuild(control.core, {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: holder.operationId,
      });
      if (startBuild)
        await store.build.claimBuildInput({
          scope: {
            projectId: project.projectId,
            environmentId: holder.environmentId,
            operationId: holder.operationId,
          },
          inputFingerprint: `sha256:${"ab".repeat(32)}`,
          claimId: crypto.randomUUID(),
          leaseMilliseconds: 30_000,
        });
      return { project, holder };
    };
    const idle = await abandon("idle-build-handle", false);
    const running = await abandon("running-build-handle", true);
    for (let swept = 0; swept < 2; swept += 1)
      expect(
        await store.maintenance.recoverExpiredOperationLease({
          now: "2026-10-28T12:20:00.000Z",
          shardId: 0,
        }),
      ).not.toBeNull();
    const reservation = (operationId: string) =>
      first(
        0,
        "SELECT amount_micros FROM credit_reservation WHERE reservation_id = ?",
        operationId,
      );
    expect(await reservation(idle.holder.operationId)).toBeNull();
    expect(await accountOf(control.core, idle.project.organizationId)).toMatchObject({
      reserved_micros: 0,
    });
    expect(
      await first(
        0,
        "SELECT kind FROM credit_log WHERE key = ?",
        `release:${idle.holder.operationId}`,
      ),
    ).toEqual({ kind: "release" });
    // The build may be running at the provider: its reservation stays for the measured settlement.
    expect(await reservation(running.holder.operationId)).toEqual({ amount_micros: 16_869_120 });
    expect(await accountOf(control.core, running.project.organizationId)).toMatchObject({
      reserved_micros: 16_869_120,
    });
    expect(
      await first(
        0,
        "SELECT state FROM operations WHERE operation_id = ?",
        running.holder.operationId,
      ),
    ).toEqual({ state: "failed" });
  });
});

describe("doorbells and retention sweeps", () => {
  it("claims overdue doorbells once, re-arms them from the shard rows and heals lost rings", async () => {
    const project = await seedProject(1, "bell-handle");
    await store.operations.acceptApiOperation(acceptInput(project, { idempotencyKey: "bell" }));
    // Accepting rang the outbox doorbell of the core partition (the shard row is the truth, the bell is advisory).
    await store.maintenance.ringDoorbell({
      kind: "outbox",
      shardId: 0,
      dueAt: "2026-10-28T10:00:00.000Z",
    });
    const claimOf = (claimToken: string, now: string) =>
      store.maintenance.claimDoorbells({ now, limit: 10, claimToken });
    const [one, two] = [newUlid(), newUlid()];
    const claimed = await claimOf(one, "2026-10-28T13:00:00.000Z");
    expect(claimed).toContainEqual(expect.objectContaining({ kind: "outbox", shardId: 0 }));
    // A held doorbell is not handed out again while the claim lasts, only after it lapsed.
    expect(await claimOf(two, "2026-10-28T13:00:30.000Z")).toEqual([]);
    expect(
      (await claimOf(two, "2026-10-28T13:05:00.000Z")).filter(
        (bell) => bell.kind === "outbox" && bell.shardId === 0,
      ),
    ).toHaveLength(1);
    // Settling with the lapsed token loses; with the current one it re-arms from the shard's own rows.
    expect(
      await store.maintenance.settleDoorbell({ kind: "outbox", shardId: 0, claimToken: one }),
    ).toMatchObject({ settled: false });
    const settled = await store.maintenance.settleDoorbell({
      kind: "outbox",
      shardId: 0,
      claimToken: two,
    });
    expect(settled.settled).toBe(true);
    expect(settled.nextDueAt).not.toBeNull();
    // A doorbell with nothing behind it is deleted by settle; heal restores bells for pending work.
    await control.directory.prepare("DELETE FROM work_due").run();
    const healed = await store.maintenance.healDoorbells({ shardId: 0 });
    expect(healed.rung).toEqual(expect.arrayContaining(["outbox", "retention"]));
    expect(
      await directoryFirst("SELECT 1 AS ok FROM work_due WHERE kind = 'outbox' AND shard_id = 0"),
    ).not.toBeNull();
    await control.directory
      .prepare(
        "INSERT INTO work_due(kind, shard_id, due_at) VALUES ('inbox', 0, '2026-10-28T10:00:00.000000Z')",
      )
      .run();
    expect((await store.maintenance.healDoorbells({ shardId: 0 })).removed).toContain("inbox");
    const inboxToken = newUlid();
    await control.directory
      .prepare(
        "INSERT INTO work_due(kind, shard_id, due_at, claim_token, claim_until) VALUES ('op_lease', 0, '2026-10-28T10:00:00.000000Z', ?, '2099-01-01T00:00:00.000000Z')",
      )
      .bind(inboxToken)
      .run();
    expect((await store.maintenance.healDoorbells({ shardId: 0 })).removed).not.toContain(
      "op_lease",
    );
    expect(
      await store.maintenance.settleDoorbell({
        kind: "op_lease",
        shardId: 0,
        claimToken: inboxToken,
      }),
    ).toEqual({ settled: true, nextDueAt: null });
  });

  it("purges expired receipts and old command identities in chunks and leaves fenced organizations alone", async () => {
    const project = await seedProject(0, "purge-handle");
    await store.operations.acceptApiOperation(acceptInput(project, { idempotencyKey: "purge" }));
    const receipts = () =>
      first<{ n: number }>(
        0,
        "SELECT count(*) AS n FROM api_idempotency_records WHERE organization_id = ?",
        project.organizationId,
      );
    const bucket = await bucketOf(project.organizationId);
    await shardOf(control, 0)
      .prepare(
        "INSERT INTO bucket_fences(bucket, state, move_id, fenced_at) VALUES (?, 'moved', ?, '2026-10-28T12:00:00.000000Z')",
      )
      .bind(bucket, newUlid())
      .run();
    const purge = () =>
      store.maintenance.purgeExpiredIdempotencyRecords({
        shardId: 0,
        now: "2026-12-01T00:00:00.000Z",
        limit: 100,
      });
    await purge(); // other organizations' expired receipts go; the fenced organization's are being copied
    expect((await receipts())?.n).toBe(1);
    await shardOf(control, 0)
      .prepare("DELETE FROM bucket_fences WHERE bucket = ?")
      .bind(bucket)
      .run();
    expect(await purge()).toBeGreaterThanOrEqual(1);
    expect((await receipts())?.n).toBe(0);

    const logged = async (target: number | "directory") =>
      (
        await (target === "directory" ? control.directory : shardOf(control, target))
          .prepare("SELECT count(*) AS n FROM command_log")
          .first<{ n: number }>()
      )?.n as number;
    for (const target of [0, "directory"] as const) {
      const db = target === "directory" ? control.directory : shardOf(control, target);
      await db
        .prepare(
          "INSERT INTO command_log(command_id, name, digest, result, applied_at) VALUES (?, 'test', 'd', '{}', 1000)",
        )
        .bind(newUlid())
        .run();
      const before = await logged(target);
      expect(before).toBeGreaterThan(0);
      expect(await store.maintenance.purgeCommandLog({ target, appliedBefore: 1, limit: 10 })).toBe(
        0,
      );
      expect(
        await store.maintenance.purgeCommandLog({
          target,
          appliedBefore: Date.now() + 1,
          limit: 1000,
        }),
      ).toBe(before);
      expect(await logged(target)).toBe(0);
    }
  });
});

describe("inbox leases, audit feed and evidence paging", () => {
  it("renews a live claim, parks an abandoned final attempt and recovers it exactly once", async () => {
    const organizationId = await seedOrganization(store, 2, 1);
    const event = {
      provider: "github",
      inboxEventId: newUlid(),
      externalEventId: "delivery-final",
      eventType: "push",
      payload: { repository: "r" },
      bodyDigest: digest(31),
      receivedAt: "2026-10-28T10:00:00.000Z",
      maxAttempts: 1,
      routing: { kind: "organization", organizationId },
    };
    await store.operations.recordInboxEvent(event);
    const claim = await store.operations.claimInboxEvent({
      organizationId,
      provider: "github",
      claimId: newUlid(),
      claimedAt: "2026-10-28T10:01:00.000Z",
      leaseExpiresAt: "2026-10-28T10:02:00.000Z",
    });
    expect(claim).toMatchObject({ attemptNumber: 1, maxAttempts: 1 });
    const held = claim as { claimId: string; inboxEventId: string };
    const scope = {
      organizationId,
      provider: "github",
      inboxEventId: held.inboxEventId,
      claimId: held.claimId,
    };
    await expect(
      store.operations.renewInboxLease({
        ...scope,
        renewedAt: "2026-10-28T10:01:30.000Z",
        leaseExpiresAt: "2026-10-28T10:01:30.000Z",
      }),
    ).rejects.toThrow("Renewed inbox lease must expire after renewal");
    expect(
      await store.operations.renewInboxLease({
        ...scope,
        renewedAt: "2026-10-28T10:01:30.000Z",
        leaseExpiresAt: "2026-10-28T10:03:00.000Z",
      }),
    ).toBe(true);
    expect(
      await store.operations.renewInboxLease({
        ...scope,
        claimId: newUlid(),
        renewedAt: "2026-10-28T10:01:30.000Z",
        leaseExpiresAt: "2026-10-28T10:04:00.000Z",
      }),
    ).toBe(false);
    // Nothing is parked while the renewed lease still runs; afterwards the shard sweep finds it.
    const find = (observedAt: string) =>
      store.maintenance.findExpiredFinalInboxClaim({ shardId: 0, provider: "github", observedAt });
    expect(await find("2026-10-28T10:02:30.000Z")).toBeNull();
    expect(await find("2026-10-28T10:03:00.000Z")).toMatchObject({
      inboxEventId: held.inboxEventId,
    });
    // An organization-bound lookup of another organization sees nothing.
    expect(
      await store.operations.findExpiredFinalInboxClaim({
        organizationId: await seedOrganization(store, 2, 1),
        provider: "github",
        observedAt: "2026-10-28T10:03:00.000Z",
      }),
    ).toBeNull();
    const recover = (recoveredAt: string) =>
      store.operations.recoverExpiredFinalInboxLease({
        ...scope,
        recoveredAt,
        errorCode: "FINAL_ATTEMPT_LEASE_EXPIRED",
      });
    expect(await recover("2026-10-28T10:02:30.000Z")).toBe(false);
    expect(await recover("2026-10-28T10:03:00.000Z")).toBe(true);
    expect(await recover("2026-10-28T10:03:00.000Z")).toBe(false);
    expect(
      await store.maintenance.claimInboxEvent({
        shardId: 0,
        provider: "github",
        claimId: newUlid(),
        claimedAt: "2026-10-28T10:05:00.000Z",
        leaseExpiresAt: "2026-10-28T10:06:00.000Z",
      }),
    ).toBeNull();
  });

  it("keeps an acknowledged global event evidence-only after its owner appears", async () => {
    const organizationId = await organizationIdWithShardFor(1, 910_000);
    const event = {
      provider: "workos",
      inboxEventId: newUlid(),
      externalEventId: "evt_auth_only",
      eventType: "session.created",
      payload: { workosOrganizationId: "org_ackonly" },
      bodyDigest: digest(41),
      receivedAt: "2026-10-28T10:00:00.000Z",
      signatureTimestamp: "2026-10-28T10:00:00.000Z",
      acknowledgedAt: "2026-10-28T10:00:00.000Z",
      maxAttempts: 3,
      routing: { kind: "workos_organization", workosOrganizationId: "org_ackonly" },
    };
    expect(await store.operations.recordInboxEvent(event)).toEqual({
      outcome: "created",
      routed: "unrouted",
    });
    await store.identity.applyOrganizationSnapshot({
      organizationId,
      workosOrganizationId: "org_ackonly",
      state: "active",
      snapshotDigest: digest(42),
      snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
      synchronizedAt: "2026-10-28T09:00:00.000Z",
      triggerEventId: "evt_seed",
      memberships: [],
      auditEventId: newUlid(),
    });
    expect(await store.maintenance.routeUnroutedInboxEvents({ limit: 100 })).toBe(0);
    expect(
      await store.maintenance.claimInboxEvent({
        organizationId,
        provider: "workos",
        claimId: newUlid(),
        claimedAt: "2026-10-28T10:05:00.000Z",
        leaseExpiresAt: "2026-10-28T10:06:00.000Z",
      }),
    ).toBeNull();
    expect(
      await directoryFirst(
        "SELECT 1 AS kept FROM webhook_inbox WHERE external_event_id = 'evt_auth_only' AND organization_id IS NULL AND state='acknowledged' AND attempt_count=0 AND max_attempts=1",
      ),
    ).not.toBeNull();
  });

  it("pages the audit feed by cursor and the evidence rows of a period by key", async () => {
    const project = await seedProject(0, "feed-handle");
    const organizationId = project.organizationId;
    for (const key of ["feed-1", "feed-2"]) {
      await store.operations.acceptApiOperation(
        acceptInput(project, { idempotencyKey: key, occurredAt: "2026-10-28T11:00:00.000Z" }),
      );
    }
    const page1 = await store.operations.readAuditEvents({ organizationId, limit: 1 });
    expect(page1.events).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await store.operations.readAuditEvents({
      organizationId,
      limit: 1,
      cursor: page1.nextCursor as string,
    });
    expect(page2.events[0]?.eventId).not.toBe(page1.events[0]?.eventId);
    const outside = projectInput(organizationId, "feed-outside-cap");
    await store.projects.createInitialProject(outside);
    const limited = await store.operations.readAuditEvents({
      organizationId,
      projectIds: [project.projectId],
      limit: 1,
    });
    expect(limited.events).toHaveLength(1);
    const limitedNext = await store.operations.readAuditEvents({
      organizationId,
      projectIds: [project.projectId],
      limit: 100,
      cursor: limited.nextCursor ?? "",
    });
    expect(
      [...limited.events, ...limitedNext.events].every(
        (event) => event.projectId === project.projectId,
      ),
    ).toBe(true);
    const operationId = page1.events[0]?.operationId;
    if (!operationId) throw new Error("Audit fixture operation missing");
    expect(
      await store.operations.readAuditEvents({
        organizationId,
        projectIds: [outside.projectId],
        operationId,
        limit: 100,
      }),
    ).toEqual({ events: [], nextCursor: null });
    expect(
      await store.operations.readAuditEvents({ organizationId, projectIds: [], limit: 100 }),
    ).toEqual({ events: [], nextCursor: null });
    // A millisecond-precision cursor of an older client still pages; a malformed one is refused.
    const legacy = btoa(
      JSON.stringify({
        occurredAt: "2026-10-28T11:00:00.000Z",
        eventId: page1.events[0]?.eventId,
      }),
    );
    await expect(
      store.operations.readAuditEvents({ organizationId, limit: 5, cursor: legacy }),
    ).resolves.toMatchObject({ nextCursor: null });
    await expect(
      store.operations.readAuditEvents({ organizationId, limit: 5, cursor: "!!not-a-cursor" }),
    ).rejects.toMatchObject({ code: "invalid_audit_cursor" });

    const evidence = (after?: string) =>
      store.maintenance.pageEvidenceRows({
        organizationId,
        tableName: "audit_events",
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-11-01T00:00:00.000Z",
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await evidence(cursor);
      for (const row of page.rows) seen.push(row["audit_event_id"] as string);
      expect(page.rows.every((row) => !("page_key" in row))).toBe(true);
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    const total = await first<{ n: number }>(
      0,
      "SELECT count(*) AS n FROM audit_events WHERE organization_id = ? AND occurred_at >= '2026-10-01' AND occurred_at < '2026-11-01'",
      organizationId,
    );
    expect(seen.length).toBe(total?.n);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

async function organizationIdWithShardFor(shardId: number, seed: number) {
  const { organizationIdWithShard } = await import("./support/control-d1.js");
  return organizationIdWithShard(2, shardId, seed);
}

describe("outbox filters and reconciliation", () => {
  it("claims only supported, unblocked events and parks the exact claimed attempt for reconciliation once", async () => {
    const project = await seedProject(1, "filter-handle");
    const organizationId = project.organizationId;
    const accepted = acceptInput(project, { idempotencyKey: "filter" });
    await store.operations.acceptApiOperation(accepted);
    const eventScope = {
      eventId: accepted.outboxEventId,
      organizationId,
      projectId: project.projectId,
      operationId: accepted.operationId,
    };
    const claim = (attemptId: string, extra: Record<string, unknown> = {}) =>
      store.operations.claimOutboxEvent({
        eventScope,
        now: "2026-10-28T11:10:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId,
        ...extra,
      });
    await expect(
      claim(newUlid(), { supportedEventTypes: ["DeploymentRequestedV1", "DeploymentRequestedV1"] }),
    ).rejects.toThrow("event types must be unique");
    await expect(
      store.operations.claimOutboxEvent({
        now: "2026-10-28T11:10:00.000Z",
        leaseMilliseconds: 1,
        attemptId: newUlid(),
      }),
    ).rejects.toThrow("name either a shard or an exact event scope");
    // The project's provider-mutation claim blocks the event of a sweeper that excludes such projects.
    await seedWorkflow(1, project, accepted, true);
    expect(await claim(newUlid(), { excludeProjectsWithActiveProviderMutation: true })).toBeNull();
    expect(await claim(newUlid(), { supportedEventTypes: ["ProjectCreated"] })).toBeNull();
    const attemptId = newUlid();
    expect(
      await claim(attemptId, { supportedEventTypes: ["DeploymentRequestedV1"] }),
    ).toMatchObject({ attemptNumber: 1, attemptId });

    const reconcile = (id: string, auditEventId: string, projectId = project.projectId) => ({
      organizationId,
      eventId: accepted.outboxEventId,
      attemptId: id,
      errorCode: "PROVIDER_UNCERTAIN",
      reconciledAt: "2026-10-28T11:11:00.000Z",
      audit: {
        auditEventId,
        projectId,
        operationId: accepted.operationId,
        eventType: "OutboxReconciliationRequired",
        actorType: "system",
        actorId: "outbox",
        payload: { providerRequestId: "req-1" },
        occurredAt: "2026-10-28T11:11:00.000Z",
      },
    });
    await expect(
      store.operations.requireOutboxReconciliation({
        ...reconcile(attemptId, newUlid()),
        audit: { ...reconcile(attemptId, newUlid()).audit, occurredAt: "2026-10-28T11:12:00.000Z" },
      }),
    ).rejects.toThrow("must use the reconciliation time");
    await expect(
      store.operations.requireOutboxReconciliation(reconcile(attemptId, newUlid(), newUlid())),
    ).rejects.toThrow("must share the exact event scope");
    await expect(
      store.operations.requireOutboxReconciliation({
        ...reconcile(attemptId, newUlid()),
        reconciledAt: "2026-10-28T11:09:00.000Z",
        audit: { ...reconcile(attemptId, newUlid()).audit, occurredAt: "2026-10-28T11:09:00.000Z" },
      }),
    ).rejects.toThrow("must not be before the claim time");
    // An attempt that is not the claimed one parks nothing.
    expect(
      await store.operations.requireOutboxReconciliation(reconcile(newUlid(), newUlid())),
    ).toBeNull();
    const auditEventId = newUlid();
    expect(
      await store.operations.requireOutboxReconciliation(reconcile(attemptId, auditEventId)),
    ).toEqual({
      attemptNumber: 1,
    });
    // The same audit event again is the replay of the committed parking.
    expect(
      await store.operations.requireOutboxReconciliation(reconcile(attemptId, auditEventId)),
    ).toEqual({
      attemptNumber: 1,
    });
    expect(await claim(newUlid())).toBeNull();
    expect(
      await first<{ reconciliation_required_at: string | null; acknowledged_at: string | null }>(
        1,
        "SELECT reconciliation_required_at, acknowledged_at FROM outbox_events WHERE event_id = ?",
        accepted.outboxEventId,
      ),
    ).toEqual({ reconciliation_required_at: "2026-10-28T11:11:00.000000Z", acknowledged_at: null });
  });
});

describe("shard and directory purges", () => {
  it("retains original acknowledged outbox history and preserves separately defined unrouted and revocation policies", async () => {
    const project = await seedProject(0, "purge2-handle");
    const organizationId = project.organizationId;
    const deliver = async (key: string, withRun: boolean) => {
      const accepted = acceptInput(project, { idempotencyKey: key });
      await store.operations.acceptApiOperation(accepted);
      if (withRun) await seedWorkflow(0, project, accepted, false);
      const attemptId = newUlid();
      await store.operations.claimOutboxEvent({
        eventScope: {
          eventId: accepted.outboxEventId,
          organizationId,
          projectId: project.projectId,
          operationId: accepted.operationId,
        },
        now: "2026-10-28T11:10:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId,
      });
      await store.operations.acknowledgeOutboxEvent({
        organizationId,
        eventId: accepted.outboxEventId,
        attemptId,
        now: "2026-10-28T11:10:05.000Z",
      });
      return accepted.outboxEventId;
    };
    const plain = await deliver("purge-plain", false);
    const withRun = await deliver("purge-run", true);
    const present = (eventId: string) =>
      first(0, "SELECT 1 AS present FROM outbox_events WHERE event_id = ?", eventId);
    await expect(
      store.maintenance.purgeAcknowledgedOutbox({
        shardId: 0,
        before: "2026-10-28T11:10:00.000Z",
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "outbox_history_immutable" });
    await expect(
      store.maintenance.purgeAcknowledgedOutbox({
        shardId: 0,
        before: "2026-12-01T00:00:00.000Z",
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "outbox_history_immutable" });
    expect(await present(plain)).not.toBeNull();
    expect(await present(withRun)).not.toBeNull(); // a workflow run still points at it

    await store.operations.recordInboxEvent({
      provider: "github",
      inboxEventId: newUlid(),
      externalEventId: "delivery-unrouted",
      eventType: "push",
      payload: {},
      bodyDigest: digest(51),
      receivedAt: "2026-10-28T10:00:00.000Z",
      maxAttempts: 3,
      routing: {
        kind: "external",
        externalKind: "github_installation",
        externalId: "no-such-installation",
      },
    });
    await expect(
      store.maintenance.purgeUnroutedInbox({ before: "2026-10-29T00:00:00.000Z", limit: 10 }),
    ).rejects.toMatchObject({ code: "inbox_retention_unqualified" });
    await expect(
      store.maintenance.purgeUnroutedInbox({ before: "2026-12-01T00:00:00.000Z", limit: 10 }),
    ).rejects.toMatchObject({ code: "inbox_retention_unqualified" });
    await control.directory
      .prepare(
        "INSERT INTO revocations(kind, resource_id, source_event_id, effective_at, purge_after) VALUES ('session', 'sess_1', 'evt-sess', '2026-10-28T11:40:00.000000Z', '2026-12-02T00:00:00.000000Z'), ('user', 'user_forever', 'evt-user-forever', '2026-10-28T11:40:00.000000Z', NULL)",
      )
      .run();
    expect(
      await store.maintenance.purgeRevocations({ before: "2026-12-03T00:00:00.000Z", limit: 10 }),
    ).toBe(1);
    expect(
      await directoryFirst("SELECT 1 AS kept FROM revocations WHERE resource_id = 'user_forever'"),
    ).not.toBeNull();
  });

  it("purges a shard's reconciled membership barriers in chunks and keeps the open ones", async () => {
    const project = await seedProject(0, "purge3-handle");
    const barrier = (user: string, reconciledAt: string | null) =>
      shardOf(control, 0)
        .prepare(
          "INSERT INTO workos_membership_sync_barriers(organization_id, workos_user_id, source_event_id, event_created_at, reconciled_at) VALUES (?, ?, 'evt-barrier', '2026-10-28T10:00:00.000000Z', ?)",
        )
        .bind(project.organizationId, user, reconciledAt)
        .run();
    await barrier("user_done", "2026-10-28T11:00:00.000000Z");
    await barrier("user_open", null);
    const purge = () =>
      store.maintenance.purgeMembershipBarriers({
        shardId: 0,
        before: "2026-12-01T00:00:00.000Z",
        limit: 10,
      });
    expect(await purge()).toBe(1);
    expect(await purge()).toBe(0);
    expect(
      (
        await shardOf(control, 0)
          .prepare("SELECT workos_user_id FROM workos_membership_sync_barriers")
          .all<{ workos_user_id: string }>()
      ).results.map((row) => row.workos_user_id),
    ).toEqual(["user_open"]);
  });
});

describe("acceptance races", () => {
  it("refuses an operation whose project left the active lifecycle between the read and the write, without a trace", async () => {
    const project = await seedProject(0, "race-handle");
    let calls = 0;
    const shard = shardOf(control, 0);
    const racing = {
      prepare: (sql: string) => shard.prepare(sql),
      batch: async (statements: Parameters<typeof shard.batch>[0]) => {
        const results = await shard.batch(statements);
        calls += 1;
        if (calls === 1) {
          await shard
            .prepare(
              "UPDATE projects SET lifecycle_state = 'deleting' WHERE organization_id = ? AND project_id = ?",
            )
            .bind(project.organizationId, project.projectId)
            .run();
        }
        return results;
      },
    } as typeof shard;
    const racingStore = createControlStore({ CONTROL_CORE: racing });
    const input = acceptInput(project, { idempotencyKey: "race" });
    await expect(racingStore.operations.acceptApiOperation(input)).rejects.toMatchObject({
      code: "scope_inactive",
    });
    expect(
      await first(
        0,
        "SELECT 1 AS present FROM operations WHERE operation_id = ?",
        input.operationId,
      ),
    ).toBeNull();
    expect(
      await first(
        0,
        "SELECT 1 AS present FROM api_idempotency_records WHERE idempotency_key = 'race'",
      ),
    ).toBeNull();
    // A project that is no longer active refuses later requests outright, deleting included.
    await expect(
      store.operations.acceptApiOperation(acceptInput(project, { idempotencyKey: "race-after" })),
    ).rejects.toMatchObject({ code: "scope_inactive" });
  });
});

describe("project creation races", () => {
  /** A shard whose `nth` batch commits and is then followed by `interfere`, as a concurrent writer would. */
  const interfering = (nth: number, interfere: () => Promise<unknown>) => {
    const shard = shardOf(control, 0);
    let calls = 0;
    return {
      prepare: (sql: string) => shard.prepare(sql),
      batch: async (statements: Parameters<typeof shard.batch>[0]) => {
        const results = await shard.batch(statements);
        calls += 1;
        if (calls === nth) await interfere();
        return results;
      },
    } as typeof shard;
  };

  it("maps a reservation closed or an organization deleted between the snapshot and the creating write", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    const storeWith = (shard: ReturnType<typeof shardOf>) =>
      createControlStore({ CONTROL_CORE: shard });
    // Core batches of one creation: the snapshot read (1) and the creating write (2).
    const closed = projectInput(organizationId, "closed-late");
    await expect(
      storeWith(
        interfering(1, () =>
          shardOf(control, 0)
            .prepare(
              "INSERT INTO project_creation_aborts(project_id, organization_id, aborted_at) VALUES (?, ?, '2026-10-28T10:20:00.000000Z')",
            )
            .bind(closed.projectId, organizationId)
            .run(),
        ),
      ).projects.createInitialProject(closed),
    ).rejects.toMatchObject({ code: "project_reservation_expired" });
    expect(
      await first(0, "SELECT 1 AS present FROM projects WHERE project_id = ?", closed.projectId),
    ).toBeNull();

    const gone = projectInput(organizationId, "org-gone-late");
    await expect(
      storeWith(
        interfering(1, () =>
          shardOf(control, 0)
            .prepare("DELETE FROM project_creation_aborts WHERE project_id = ?")
            .bind(closed.projectId)
            .run()
            .then(() =>
              shardOf(control, 0)
                .prepare("UPDATE organizations SET state = 'deleted' WHERE organization_id = ?")
                .bind(organizationId)
                .run(),
            ),
        ),
      ).projects.createInitialProject(gone),
    ).rejects.toMatchObject({ code: "organization_inactive" });
    expect(
      await first(0, "SELECT 1 AS present FROM projects WHERE project_id = ?", gone.projectId),
    ).toBeNull();
  });
});

describe("expired-operation recovery is isolated per operation", () => {
  it("recovers another tenant's expired operation while one expired operation has a dispatched Native Auth create", async () => {
    const poisoned = await seedProject(0, "poisoned-create-handle");
    const poisonedHolder = acceptInput(poisoned, { idempotencyKey: "poisoned-create" });
    await store.operations.acceptApiOperation(poisonedHolder);
    const poisonedWorkflow = await seedWorkflow(0, poisoned, poisonedHolder, true);
    await store.operations.renewOperationLease({
      organizationId: poisoned.organizationId,
      operationId: poisonedHolder.operationId,
      workflowId: poisonedWorkflow,
      physicalWorkflowId: poisonedWorkflow,
      now: "2026-10-28T12:00:00.000Z",
      durationMilliseconds: 900_000,
    });
    // The provider create of that operation was dispatched and its outcome is unknown: its claim must stay.
    const claim = await first<{ claim_id: string }>(
      0,
      "SELECT claim_id FROM product_provider_mutation_claims WHERE operation_id = ?",
      poisonedHolder.operationId,
    );
    await shardOf(control, 0)
      .prepare(
        "INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','fixture','eu-dev','r256-s500m','poisoned-create','dispatched','2026-10-28T12:00:00.000000Z')",
      )
      .bind(
        poisoned.organizationId,
        poisoned.projectId,
        poisonedHolder.environmentId,
        poisonedHolder.operationId,
        claim?.claim_id,
      )
      .run();

    // A healthy tenant's operation expires after the poisoned one, so the poisoned one is the oldest candidate.
    const healthy = await seedProject(0, "healthy-recovery-handle");
    const healthyHolder = acceptInput(healthy, { idempotencyKey: "healthy-recovery" });
    await store.operations.acceptApiOperation(healthyHolder);
    const healthyWorkflow = await seedWorkflow(0, healthy, healthyHolder, true);
    await store.operations.renewOperationLease({
      organizationId: healthy.organizationId,
      operationId: healthyHolder.operationId,
      workflowId: healthyWorkflow,
      physicalWorkflowId: healthyWorkflow,
      now: "2026-10-28T12:05:00.000Z",
      durationMilliseconds: 900_000,
    });

    await expect(
      store.maintenance.recoverExpiredOperationLease({
        now: "2026-10-28T12:25:00.000Z",
        shardId: 0,
      }),
    ).resolves.toEqual({
      organizationId: healthy.organizationId,
      operationId: healthyHolder.operationId,
      releaseBuildCredits: true,
    });
    expect(
      await first(
        0,
        "SELECT 1 AS present FROM product_provider_mutation_claims WHERE operation_id = ?",
        poisonedHolder.operationId,
      ),
    ).toEqual({ present: 1 });
  });
});

describe("lease recovery documentation", () => {
  it("describes abandoned GitHub push deployments as failed with cleanup_required staying 0", async () => {
    const chapter = await readFile(
      new URL("../../../docs/architecture/database.md", import.meta.url),
      "utf8",
    );
    const recovery = chapter
      .split("\n")
      .find((line) =>
        line.includes("ends unfinished GitHub push deployments of an abandoned operation"),
      );
    expect(recovery).toBeDefined();
    expect(recovery).not.toContain("as `failed` with `cleanup_required`");
    expect(recovery).toContain("`cleanup_required` stays 0");
  });
});
