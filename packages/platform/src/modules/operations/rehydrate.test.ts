import { describe, expect, it } from "vitest";

import { parseUlid } from "../../shared/index.js";
import { rehydrateOperation as publicRehydrateOperation } from "../../index.js";
import {
  rehydrateOperation,
  type OperationCancelled,
  type OperationEvent,
  type OperationFailed,
  type OperationQueued,
  type OperationStarted,
  type OperationSucceeded,
} from "./operation.js";

const operationId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const projectId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW");

const queued: OperationQueued = {
  eventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
  type: "OperationQueued",
  operationId,
  projectId,
  occurredAt: "2026-08-17T12:00:00.000Z",
};
const started: OperationStarted = {
  eventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
  type: "OperationStarted",
  operationId,
  projectId,
  occurredAt: "2026-08-17T12:00:01.000Z",
  idempotencyKey: "start-1",
};
const succeeded: OperationSucceeded = {
  eventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
  type: "OperationSucceeded",
  operationId,
  projectId,
  occurredAt: "2026-08-17T12:00:02.000Z",
  idempotencyKey: "finish-1",
};
const failed: OperationFailed = {
  eventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB0"),
  type: "OperationFailed",
  operationId,
  projectId,
  occurredAt: "2026-08-17T12:00:02.000Z",
  idempotencyKey: "fail-1",
  failure: { code: "PROVIDER_TIMEOUT", message: "Provider did not answer" },
};
const cancelled: OperationCancelled = {
  eventId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1"),
  type: "OperationCancelled",
  operationId,
  projectId,
  occurredAt: "2026-08-17T12:00:02.000Z",
  idempotencyKey: "cancel-1",
};

function malformed(value: unknown): OperationEvent {
  return value as OperationEvent;
}

describe("rehydrateOperation", () => {
  it.each([
    { history: [queued], state: "queued", updatedAt: queued.occurredAt },
    { history: [queued, started], state: "running", updatedAt: started.occurredAt },
    { history: [queued, started, succeeded], state: "succeeded", updatedAt: succeeded.occurredAt },
    { history: [queued, started, failed], state: "failed", updatedAt: failed.occurredAt },
    { history: [queued, started, cancelled], state: "cancelled", updatedAt: cancelled.occurredAt },
  ] as const)("derives a valid $state operation from history", ({ history, state, updatedAt }) => {
    const operation = rehydrateOperation(history);

    expect(operation).toMatchObject({
      operationId,
      projectId,
      state,
      createdAt: queued.occurredAt,
      updatedAt,
    });
    expect(operation.failure).toEqual(state === "failed" ? failed.failure : undefined);
  });

  it("is deterministic on replay, copies history, freezes output, and is publicly exported", () => {
    const history = [queued, started, failed];

    const first = rehydrateOperation(history);
    const replayed = publicRehydrateOperation(history);

    expect(replayed).toEqual(first);
    expect(replayed.events).toHaveLength(history.length);
    expect(replayed.events).not.toBe(history);
    expect(Object.isFrozen(replayed)).toBe(true);
    expect(Object.isFrozen(replayed.events)).toBe(true);
    expect(replayed.events.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(replayed.failure)).toBe(true);
  });

  it("requires exactly one initial OperationQueued event", () => {
    expect(() => rehydrateOperation([])).toThrow(/first.*OperationQueued/i);
    expect(() => rehydrateOperation([started])).toThrow(/first.*OperationQueued/i);
    expect(() => rehydrateOperation([queued, queued])).toThrow(/OperationQueued.*first/i);
  });

  it("requires every event to use the initial operation and project IDs", () => {
    expect(() =>
      rehydrateOperation([
        queued,
        { ...started, operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB2") },
      ]),
    ).toThrow(/operation ID/i);
    expect(() =>
      rehydrateOperation([
        queued,
        { ...started, projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB3") },
      ]),
    ).toThrow(/project ID/i);
  });

  it("accepts only queued -> running -> terminal transition sequences", () => {
    expect(() => rehydrateOperation([queued, succeeded])).toThrow(/queued.*succeeded/i);
    expect(() =>
      rehydrateOperation([queued, started, { ...started, idempotencyKey: "start-2" }]),
    ).toThrow(/running.*running/i);
    expect(() => rehydrateOperation([queued, started, succeeded, cancelled])).toThrow(
      /terminal.*event/i,
    );
  });

  it("requires valid monotonic event timestamps", () => {
    expect(() => rehydrateOperation([{ ...queued, occurredAt: "not-a-date" }])).toThrow(
      /timestamp/i,
    );
    expect(() =>
      rehydrateOperation([queued, { ...started, occurredAt: "2026-08-17T11:59:59.999Z" }]),
    ).toThrow(/timestamp.*backwards/i);
  });

  it("requires non-empty, unique transition idempotency keys", () => {
    expect(() => rehydrateOperation([queued, { ...started, idempotencyKey: "  " }])).toThrow(
      /idempotency key.*required/i,
    );
    expect(() =>
      rehydrateOperation([
        queued,
        started,
        { ...succeeded, idempotencyKey: started.idempotencyKey },
      ]),
    ).toThrow(/idempotency key.*already used/i);
  });

  it("allows failure data only on a valid failed event", () => {
    expect(() =>
      rehydrateOperation([
        queued,
        started,
        malformed({ ...succeeded, failure: { code: "WRONG", message: "Wrong event" } }),
      ]),
    ).toThrow(/failure.*OperationFailed/i);
    expect(() =>
      rehydrateOperation([queued, started, malformed({ ...failed, failure: undefined })]),
    ).toThrow(/failure code and message/i);
    expect(() =>
      rehydrateOperation([
        queued,
        started,
        { ...failed, failure: { code: " ", message: "Missing code" } },
      ]),
    ).toThrow(/failure code and message/i);
  });
});
