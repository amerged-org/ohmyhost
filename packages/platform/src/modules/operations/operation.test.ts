import { describe, expect, it } from "vitest";

import {
  DeterministicEntropy,
  FixedClock,
  createUlidFactory,
  type Clock,
  type UlidFactory,
} from "../../shared/index.js";
import {
  cancelOperation,
  createOperation,
  failOperation,
  startOperation,
  succeedOperation,
} from "./operation.js";

function dependencies(timestamp: string, seed: number): { clock: Clock; eventIds: UlidFactory } {
  const clock = new FixedClock(timestamp);
  return {
    clock,
    eventIds: createUlidFactory({ clock, entropy: new DeterministicEntropy(seed) }),
  };
}

function queuedOperation() {
  const identity = dependencies("2026-08-17T12:00:00.000Z", 1);
  return createOperation({
    operationId: identity.eventIds.next(),
    projectId: identity.eventIds.next(),
    ...identity,
  });
}

describe("operation state machine", () => {
  it("creates an immutable queued operation with injected identity and time", () => {
    const identity = dependencies("2026-08-17T12:00:00.000Z", 2);
    const operationId = identity.eventIds.next();
    const projectId = identity.eventIds.next();

    const operation = createOperation({ operationId, projectId, ...identity });

    expect(operation).toMatchObject({
      operationId,
      projectId,
      state: "queued",
      createdAt: "2026-08-17T12:00:00.000Z",
      updatedAt: "2026-08-17T12:00:00.000Z",
      events: [{ type: "OperationQueued", occurredAt: "2026-08-17T12:00:00.000Z" }],
    });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.events)).toBe(true);
    expect(Object.isFrozen(operation.events[0])).toBe(true);
  });

  it("allows queued -> running -> succeeded", () => {
    const queued = queuedOperation();
    const running = startOperation(
      queued,
      { idempotencyKey: "start-1" },
      dependencies("2026-08-17T12:00:01.000Z", 3),
    );
    const succeeded = succeedOperation(
      running,
      { idempotencyKey: "success-1" },
      dependencies("2026-08-17T12:00:02.000Z", 4),
    );

    expect(running.state).toBe("running");
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.updatedAt).toBe("2026-08-17T12:00:02.000Z");
    expect(succeeded.events.map((event) => event.type)).toEqual([
      "OperationQueued",
      "OperationStarted",
      "OperationSucceeded",
    ]);
  });

  it("allows running -> failed and preserves copied failure data", () => {
    const running = startOperation(
      queuedOperation(),
      { idempotencyKey: "start-1" },
      dependencies("2026-08-17T12:00:01.000Z", 5),
    );
    const failure = { code: "PROVIDER_TIMEOUT", message: "Provider did not answer" };

    const failed = failOperation(
      running,
      { idempotencyKey: "failure-1", failure },
      dependencies("2026-08-17T12:00:02.000Z", 6),
    );
    failure.message = "mutated outside";

    expect(failed.state).toBe("failed");
    expect(failed.failure).toEqual({
      code: "PROVIDER_TIMEOUT",
      message: "Provider did not answer",
    });
    expect(failed.events.at(-1)).toMatchObject({
      type: "OperationFailed",
      failure: { code: "PROVIDER_TIMEOUT", message: "Provider did not answer" },
    });
    expect(Object.isFrozen(failed.failure)).toBe(true);
    expect(Object.isFrozen(failed.events.at(-1))).toBe(true);
  });

  it("allows running -> cancelled", () => {
    const running = startOperation(
      queuedOperation(),
      { idempotencyKey: "start-1" },
      dependencies("2026-08-17T12:00:01.000Z", 7),
    );

    const cancelled = cancelOperation(
      running,
      { idempotencyKey: "cancel-1" },
      dependencies("2026-08-17T12:00:02.000Z", 8),
    );

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.events.at(-1)?.type).toBe("OperationCancelled");
  });

  it("rejects skipped, repeated, and terminal-state transitions", () => {
    const queued = queuedOperation();
    expect(() =>
      succeedOperation(
        queued,
        { idempotencyKey: "skip-running" },
        dependencies("2026-08-17T12:00:01.000Z", 9),
      ),
    ).toThrow(/queued.*succeeded/);
    expect(() =>
      cancelOperation(
        queued,
        { idempotencyKey: "cancel-queued" },
        dependencies("2026-08-17T12:00:01.000Z", 10),
      ),
    ).toThrow(/queued.*cancelled/);

    const running = startOperation(
      queued,
      { idempotencyKey: "start-1" },
      dependencies("2026-08-17T12:00:01.000Z", 11),
    );
    expect(() =>
      startOperation(
        running,
        { idempotencyKey: "start-again" },
        dependencies("2026-08-17T12:00:02.000Z", 12),
      ),
    ).toThrow(/running.*running/);

    const succeeded = succeedOperation(
      running,
      { idempotencyKey: "success-1" },
      dependencies("2026-08-17T12:00:02.000Z", 13),
    );
    expect(() =>
      failOperation(
        succeeded,
        {
          idempotencyKey: "late-failure",
          failure: { code: "LATE", message: "Too late" },
        },
        dependencies("2026-08-17T12:00:03.000Z", 14),
      ),
    ).toThrow(/succeeded.*failed/);

    const failed = failOperation(
      running,
      {
        idempotencyKey: "failure-1",
        failure: { code: "FAILED", message: "Stopped" },
      },
      dependencies("2026-08-17T12:00:02.000Z", 20),
    );
    expect(() =>
      cancelOperation(
        failed,
        { idempotencyKey: "after-failure" },
        dependencies("2026-08-17T12:00:03.000Z", 21),
      ),
    ).toThrow(/failed.*cancelled/);

    const cancelled = cancelOperation(
      running,
      { idempotencyKey: "cancel-1" },
      dependencies("2026-08-17T12:00:02.000Z", 22),
    );
    expect(() =>
      succeedOperation(
        cancelled,
        { idempotencyKey: "after-cancel" },
        dependencies("2026-08-17T12:00:03.000Z", 23),
      ),
    ).toThrow(/cancelled.*succeeded/);
  });

  it("returns the same event IDs when an identical transition is replayed", () => {
    const queued = queuedOperation();
    const first = startOperation(
      queued,
      { idempotencyKey: "stable-start" },
      dependencies("2026-08-17T12:00:01.000Z", 15),
    );

    const replayed = startOperation(
      first,
      { idempotencyKey: "stable-start" },
      dependencies("2026-08-17T13:00:00.000Z", 16),
    );

    expect(replayed).toBe(first);
    expect(replayed.events).toHaveLength(2);
    expect(replayed.events[1]?.eventId).toBe(first.events[1]?.eventId);
    expect(replayed.updatedAt).toBe("2026-08-17T12:00:01.000Z");
  });

  it("replays an identical failed transition without changing its stable failure event", () => {
    const running = startOperation(
      queuedOperation(),
      { idempotencyKey: "start-1" },
      dependencies("2026-08-17T12:00:01.000Z", 27),
    );
    const input = {
      idempotencyKey: "failure-1",
      failure: { code: "PROVIDER_TIMEOUT", message: "Provider did not answer" },
    };
    const failed = failOperation(running, input, dependencies("2026-08-17T12:00:02.000Z", 28));

    const replayed = failOperation(failed, input, dependencies("2026-08-17T13:00:00.000Z", 29));

    expect(replayed).toBe(failed);
    expect(replayed.events).toHaveLength(3);
    expect(replayed.events.at(-1)?.eventId).toBe(failed.events.at(-1)?.eventId);
    expect(replayed.failure).toEqual(input.failure);
  });

  it("rejects reuse of an idempotency key for different transition data", () => {
    const running = startOperation(
      queuedOperation(),
      { idempotencyKey: "shared-key" },
      dependencies("2026-08-17T12:00:01.000Z", 17),
    );

    expect(() =>
      failOperation(
        running,
        {
          idempotencyKey: "shared-key",
          failure: { code: "CONFLICT", message: "Different transition" },
        },
        dependencies("2026-08-17T12:00:02.000Z", 18),
      ),
    ).toThrow(/idempotency key/i);
  });

  it("rejects timestamps older than the current operation timestamp", () => {
    const queued = queuedOperation();

    expect(() =>
      startOperation(
        queued,
        { idempotencyKey: "past-start" },
        dependencies("2026-08-17T11:59:59.999Z", 19),
      ),
    ).toThrow(/timestamp/i);
  });

  it("rejects empty transition keys and incomplete failure data", () => {
    const queued = queuedOperation();
    expect(() =>
      startOperation(
        queued,
        { idempotencyKey: "  " },
        dependencies("2026-08-17T12:00:01.000Z", 24),
      ),
    ).toThrow(/idempotency key/i);

    const running = startOperation(
      queued,
      { idempotencyKey: "start-1" },
      dependencies("2026-08-17T12:00:01.000Z", 25),
    );
    expect(() =>
      failOperation(
        running,
        { idempotencyKey: "failure-1", failure: { code: "", message: "Missing code" } },
        dependencies("2026-08-17T12:00:02.000Z", 26),
      ),
    ).toThrow(/failure code and message/i);
  });
});
