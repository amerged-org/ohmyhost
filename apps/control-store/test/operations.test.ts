import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../src/catalog/common.js";
import { createControlStore } from "../src/store.js";
import { createTestControl, shardOf, type TestControl } from "./support/control-d1.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";
import { acceptInput, projectInput, seedOrganization, type Store } from "./support/seed.js";

let control: TestControl;
let store: Store;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

const count = async (shard: number, table: string, where: string) =>
  (
    await shardOf(control, shard)
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
      .first<{ n: number }>()
  )?.n;

async function seedProject(shard: number, handle: string) {
  const organizationId = await seedOrganization(store, 2, shard);
  const project = projectInput(organizationId, handle);
  await store.projects.createInitialProject(project);
  return project;
}

describe("operations.acceptApiOperation", () => {
  it("accepts once with receipt, operation, audit and outbox in one batch, replays, and refuses foreign or stale scopes without a trace", async () => {
    const project = await seedProject(1, "accept-handle");
    const input = acceptInput(project);
    expect(await store.operations.acceptApiOperation(input)).toEqual({
      outcome: "created",
      operationId: input.operationId,
    });
    const where = `organization_id = '${project.organizationId}' AND operation_id = '${input.operationId}'`;
    expect(await count(1, "operations", where)).toBe(1);
    expect(
      await count(
        1,
        "audit_events",
        `organization_id = '${project.organizationId}' AND operation_id = '${input.operationId}'`,
      ),
    ).toBe(1);
    expect(await count(1, "outbox_events", where)).toBe(1);
    // The same key and digest, even with fresh ids, is the first operation again; nothing new is written.
    const again = { ...acceptInput(project), idempotencyKey: input.idempotencyKey };
    expect(await store.operations.acceptApiOperation(again)).toEqual({
      outcome: "replayed",
      operationId: input.operationId,
    });
    expect(
      await count(
        1,
        "operations",
        `organization_id = '${project.organizationId}' AND project_id = '${project.projectId}'`,
      ),
    ).toBe(2); // initial project operation + this one
    expect(
      await store.operations.readStoredIdempotencyResponse({
        organizationId: input.organizationId,
        principalId: input.principalId,
        httpMethod: input.httpMethod,
        routeTemplate: input.routeTemplate,
        idempotencyKey: input.idempotencyKey,
      }),
    ).toEqual({
      httpStatus: 202,
      responseHeaders: { Location: `/v1/operations/${input.operationId}` },
      responseBody: { operation_id: input.operationId },
    });
    // Same key, different request.
    await expect(
      store.operations.acceptApiOperation({ ...again, canonicalRequestDigest: "ab".repeat(32) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    // Cross-tenant: another organization (other shard) cannot accept an operation on this project.
    const stranger = await seedOrganization(store, 2, 0);
    const foreign = acceptInput(project, { organizationId: stranger, idempotencyKey: "foreign" });
    await expect(store.operations.acceptApiOperation(foreign)).rejects.toMatchObject({
      code: "scope_inactive",
    });
    expect(await count(0, "operations", `operation_id = '${foreign.operationId}'`)).toBe(0);
    expect(
      await store.operations.loadOperation({
        organizationId: stranger,
        operationId: input.operationId,
      }),
    ).toBeNull();

    // A stale billing epoch rolls the whole batch back, receipt included, so the caller may retry the key.
    const stale = acceptInput(project, {
      billingEpochId: newUlid(),
      idempotencyKey: "stale-epoch",
    });
    await expect(store.operations.acceptApiOperation(stale)).rejects.toMatchObject({
      code: "owner_changed",
    });
    for (const [table, column] of [
      ["operations", "operation_id"],
      ["audit_events", "audit_event_id"],
      ["outbox_events", "event_id"],
    ] as const) {
      const id = {
        operation_id: stale.operationId,
        audit_event_id: stale.auditEventId,
        event_id: stale.outboxEventId,
      }[column];
      expect(await count(1, table, `${column} = '${id}'`), table).toBe(0);
    }
    expect(await count(1, "api_idempotency_records", "idempotency_key = 'stale-epoch'")).toBe(0);

    // Two racers with one key: one operation, the other is told it was replayed.
    const racers = [
      acceptInput(project, { idempotencyKey: "racing" }),
      acceptInput(project, { idempotencyKey: "racing" }),
    ];
    const results = await Promise.all(
      racers.map((racer) => store.operations.acceptApiOperation(racer)),
    );
    expect(new Set(results.map((result) => result.operationId)).size).toBe(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(["created", "replayed"]);
    expect(await count(1, "api_idempotency_records", "idempotency_key = 'racing'")).toBe(1);
  });
});

describe("operation transitions and the outbox", () => {
  it("fences transitions, claims, failures and acknowledgements by state, attempt and tenant", async () => {
    const project = await seedProject(0, "outbox-handle");
    const accepted = acceptInput(project);
    await store.operations.acceptApiOperation(accepted);
    const organizationId = project.organizationId;
    const transition = (type: string, expectedState: string, eventCount: number) => ({
      organizationId,
      operationId: accepted.operationId,
      expected: { state: expectedState, eventCount },
      event: {
        eventId: newUlid(),
        type,
        idempotencyKey: `${type}-${eventCount}`,
        occurredAt: "2026-10-28T11:05:00.000Z",
      },
      audit: {
        auditEventId: newUlid(),
        projectId: project.projectId,
        operationId: accepted.operationId,
        eventType: type,
        actorType: "system",
        actorId: "workflow",
        payload: {},
        occurredAt: "2026-10-28T11:05:00.000Z",
      },
    });
    // Racing starts: one applies, the other loses the compare-and-swap and is refused.
    const settled = await Promise.allSettled([
      store.operations.transitionOperation(transition("OperationStarted", "queued", 1)),
      store.operations.transitionOperation(transition("OperationStarted", "queued", 1)),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: "operation_conflict",
    });
    expect(await count(0, "operation_events", `operation_id = '${accepted.operationId}'`)).toBe(2);
    expect(
      await count(
        0,
        "audit_events",
        `operation_id = '${accepted.operationId}' AND event_type = 'OperationStarted'`,
      ),
    ).toBe(1);
    // The replay of a lost response is answered from the committed event.
    const lost = transition("OperationSucceeded", "running", 2);
    expect(await store.operations.transitionOperation(lost)).toMatchObject({
      outcome: "applied",
      state: "succeeded",
    });
    expect(await store.operations.transitionOperation(lost)).toMatchObject({
      outcome: "replayed",
      state: "succeeded",
    });

    // Outbox: two claimers, one event.
    const scope = {
      eventId: accepted.outboxEventId,
      organizationId,
      projectId: project.projectId,
      operationId: accepted.operationId,
    };
    const claimInput = (attemptId: string) => ({
      eventScope: scope,
      now: "2026-10-28T11:10:00.000Z",
      leaseMilliseconds: 60_000,
      attemptId,
    });
    const [first, second] = [newUlid(), newUlid()];
    const claims = await Promise.all(
      [first, second].map((id) => store.operations.claimOutboxEvent(claimInput(id))),
    );
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const winner = claims.find((claim) => claim !== null) as {
      attemptId: string;
      attemptNumber: number;
    };
    expect(winner.attemptNumber).toBe(1);
    // Repeating the winner's claim (lost response) returns the same attempt instead of burning another.
    expect(await store.operations.claimOutboxEvent(claimInput(winner.attemptId))).toMatchObject({
      attemptNumber: 1,
    });
    // Another organization cannot acknowledge it, a stale attempt cannot either; the owner can, once.
    const stranger = await seedOrganization(store, 2, 0);
    const ack = (id: string, org = organizationId) => ({
      organizationId: org,
      eventId: accepted.outboxEventId,
      attemptId: id,
      now: "2026-10-28T11:10:05.000Z",
    });
    expect(await store.operations.acknowledgeOutboxEvent(ack(winner.attemptId, stranger))).toBe(
      false,
    );
    expect(await store.operations.acknowledgeOutboxEvent(ack(newUlid()))).toBe(false);
    expect(await store.operations.acknowledgeOutboxEvent(ack(winner.attemptId))).toBe(true);
    expect(await store.operations.acknowledgeOutboxEvent(ack(winner.attemptId))).toBe(false);
    expect(await store.operations.claimOutboxEvent(claimInput(newUlid()))).toBeNull();
  });

  it("answers an acknowledgement whose reply was lost from the committed event and attempt", async () => {
    const project = await seedProject(0, "lost-ack-handle");
    const accepted = acceptInput(project, { idempotencyKey: "lost-ack" });
    await store.operations.acceptApiOperation(accepted);
    const attemptId = newUlid();
    await store.operations.claimOutboxEvent({
      eventScope: {
        eventId: accepted.outboxEventId,
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: accepted.operationId,
      },
      now: "2026-10-28T11:10:00.000Z",
      leaseMilliseconds: 60_000,
      attemptId,
    });
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    expect(
      await flaky.operations.acknowledgeOutboxEvent({
        organizationId: project.organizationId,
        eventId: accepted.outboxEventId,
        attemptId,
        now: "2026-10-28T11:10:05.000Z",
      }),
    ).toBe(true);
    expect(
      await count(
        0,
        "delivery_attempts",
        `attempt_id = '${attemptId}' AND status = 'acknowledged'`,
      ),
    ).toBe(1);
  });

  it("schedules a retry for a failed attempt, parks the last one and recovers an expired final lease without loss", async () => {
    const project = await seedProject(1, "retry-handle");
    const organizationId = project.organizationId;
    const accepted = acceptInput(project, { idempotencyKey: "retry" });
    await store.operations.acceptApiOperation(accepted);
    const scope = {
      eventId: accepted.outboxEventId,
      organizationId,
      projectId: project.projectId,
      operationId: accepted.operationId,
    };
    const at = (seconds: number) => `2026-10-28T12:00:${String(seconds).padStart(2, "0")}.000Z`;
    const claim = (attemptId: string, now: string) =>
      store.operations.claimOutboxEvent({
        eventScope: scope,
        now,
        leaseMilliseconds: 10_000,
        attemptId,
      });
    const failure = (
      attemptId: string,
      eventType: string,
      next: string | undefined,
      seconds: number,
    ) => ({
      organizationId,
      eventId: accepted.outboxEventId,
      attemptId,
      errorCode: "PROVIDER_TIMEOUT",
      failedAt: at(seconds),
      ...(next === undefined ? {} : { nextAvailableAt: next }),
      audit: {
        auditEventId: newUlid(),
        projectId: project.projectId,
        operationId: accepted.operationId,
        eventType,
        actorType: "system",
        actorId: "outbox",
        payload: {},
        occurredAt: at(seconds),
      },
    });
    const attempts = [newUlid(), newUlid(), newUlid(), newUlid(), newUlid()];
    // Attempts 1..4 fail with a retry; the retry is not claimable before its time.
    for (const [index, attemptId] of attempts.slice(0, 4).entries()) {
      expect(await claim(attemptId, at(index * 10))).toMatchObject({ attemptNumber: index + 1 });
      const retry = failure(attemptId, "OutboxRetryScheduled", at(index * 10 + 5), index * 10 + 1);
      expect(await store.operations.recordOutboxDeliveryFailure(retry)).toEqual({
        outcome: "retry_scheduled",
        attemptNumber: index + 1,
      });
      // The same failure reported again (lost response) is a replay, not a second attempt.
      expect(await store.operations.recordOutboxDeliveryFailure(retry)).toEqual({
        outcome: "retry_scheduled",
        attemptNumber: index + 1,
      });
      expect(await claim(newUlid(), at(index * 10 + 2))).toBeNull();
    }
    // The final attempt claims, then its lease lapses without an outcome: it may have been delivered, so it is
    // parked for reconciliation and never retried.
    expect(await claim(attempts[4] as string, at(45))).toMatchObject({
      attemptNumber: 5,
      maxAttempts: 5,
    });
    expect(
      await store.operations.recoverExpiredFinalOutboxLease({
        eventScope: scope,
        now: at(50),
        auditEventId: newUlid(),
        actorType: "system",
        actorId: "outbox-sweeper",
      }),
    ).toBeNull();
    const recovery = {
      eventScope: scope,
      now: at(56),
      auditEventId: newUlid(),
      actorType: "system",
      actorId: "outbox-sweeper",
    };
    expect(await store.operations.recoverExpiredFinalOutboxLease(recovery)).toMatchObject({
      attemptNumber: 5,
      attemptId: attempts[4],
    });
    expect(await store.operations.recoverExpiredFinalOutboxLease(recovery)).toMatchObject({
      attemptNumber: 5,
    });
    expect(await claim(newUlid(), at(59))).toBeNull();
    expect(
      await count(
        1,
        "outbox_events",
        `event_id = '${accepted.outboxEventId}' AND reconciliation_required_at IS NOT NULL AND acknowledged_at IS NULL`,
      ),
    ).toBe(1);
  });
});
