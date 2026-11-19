import { describe, expect, it } from "vitest";

import { DeterministicEntropy, FixedClock, createUlidFactory } from "../../shared/index.js";
import {
  createOperationDeploymentResult,
  createOperationDataChangeResult,
  createOperation,
  rehydrateOperation,
  startOperation,
  succeedOperation,
} from "./operation.js";

function result(operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV") {
  return createOperationDeploymentResult({
    operationId,
    deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    planId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    artifactSha256: "4".repeat(64),
    url: "https://demo.ohmyho.st/",
  });
}

function dependencies(timestamp: string, seed: number) {
  const clock = new FixedClock(timestamp);
  return {
    clock,
    eventIds: createUlidFactory({ clock, entropy: new DeterministicEntropy(seed) }),
  };
}

function runningOperation() {
  const identity = dependencies("2026-08-17T12:00:00.000Z", 1);
  return startOperation(
    createOperation({
      operationId: identity.eventIds.next(),
      projectId: identity.eventIds.next(),
      ...identity,
    }),
    { idempotencyKey: "start-1" },
    dependencies("2026-08-17T12:00:01.000Z", 2),
  );
}

describe("operation deployment result", () => {
  it("preserves a closed data-change result and refuses false modes, redeploys or counts", () => {
    const running = runningOperation();
    const input = {
      schemaVersion: "ohmyhost.operation-data-change-result/v1",
      operationId: running.operationId,
      change: "reset_dev",
      data_mode: "isolated",
      redeploy_environments: ["dev"],
      deleted_database: false,
      deleted_files: 0,
    };
    expect(
      createOperationDataChangeResult({
        operationId: running.operationId,
        change: "reset_dev",
        data_mode: "isolated",
        redeploy_environments: ["dev"],
        deleted_database: false,
        deleted_files: 0,
      }),
    ).toEqual(input);
    const succeeded = succeedOperation(
      running,
      { idempotencyKey: "data-change", result: input },
      dependencies("2026-08-17T12:00:02.000Z", 3),
    );
    expect(rehydrateOperation(succeeded.events).result).toEqual(input);
    expect(Object.isFrozen(succeeded.result)).toBe(true);
    for (const altered of [
      { ...input, data_mode: "shared" },
      { ...input, redeploy_environments: ["prod"] },
      { ...input, deleted_files: -1 },
      { ...input, deleted_database: "yes" },
      { ...input, credential: "not-result" },
      { ...input, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" },
    ])
      expect(() =>
        succeedOperation(
          running,
          { idempotencyKey: "invalid", result: altered },
          dependencies("2026-08-17T12:00:02.000Z", 4),
        ),
      ).toThrow();
  });

  it("validates, copies, freezes, and rehydrates an optional success result", () => {
    const running = runningOperation();
    const input = result(running.operationId);
    const succeeded = succeedOperation(
      running,
      { idempotencyKey: "success-1", result: input },
      dependencies("2026-08-17T12:00:02.000Z", 3),
    );
    const rehydrated = rehydrateOperation(succeeded.events);

    expect(succeeded.result).toEqual(input);
    expect(succeeded.result).not.toBe(input);
    expect(succeeded.events.at(-1)).toMatchObject({ type: "OperationSucceeded", result: input });
    expect(rehydrated).toEqual(succeeded);
    expect(Object.isFrozen(rehydrated.result)).toBe(true);
  });

  it("keeps legacy success events without a result valid", () => {
    const succeeded = succeedOperation(
      runningOperation(),
      { idempotencyKey: "success-1" },
      dependencies("2026-08-17T12:00:02.000Z", 4),
    );
    expect(rehydrateOperation(succeeded.events).result).toBeUndefined();
  });

  it("rejects invalid results and idempotent replay with different content", () => {
    const running = runningOperation();
    expect(() =>
      succeedOperation(
        running,
        { idempotencyKey: "success-1", result: { schemaVersion: "wrong" } },
        dependencies("2026-08-17T12:00:02.000Z", 5),
      ),
    ).toThrow(/operation deployment result/i);

    const succeeded = succeedOperation(
      running,
      { idempotencyKey: "success-1", result: result(running.operationId) },
      dependencies("2026-08-17T12:00:02.000Z", 6),
    );
    expect(() =>
      succeedOperation(
        succeeded,
        { idempotencyKey: "success-1" },
        dependencies("2026-08-17T12:00:03.000Z", 7),
      ),
    ).toThrow(/idempotency key.*already used/i);
  });

  it("rejects result data on a non-success history event", () => {
    const running = runningOperation();
    const malformed = running.events.map((event, index) =>
      index === 1 ? ({ ...event, result: result(running.operationId) } as never) : event,
    );
    expect(() => rehydrateOperation(malformed)).toThrow(/result.*OperationSucceeded/i);
  });

  it("rejects a success result bound to another operation during transition and rehydration", () => {
    const running = runningOperation();
    const foreign = result("01ARZ3NDEKTSV4RRFFQ69G5FAY");
    expect(() =>
      succeedOperation(
        running,
        { idempotencyKey: "success-foreign", result: foreign },
        dependencies("2026-08-17T12:00:02.000Z", 8),
      ),
    ).toThrow(/match the operation ID/i);

    const succeeded = succeedOperation(
      running,
      { idempotencyKey: "success-1" },
      dependencies("2026-08-17T12:00:02.000Z", 9),
    );
    const history = succeeded.events.map((event) =>
      event.type === "OperationSucceeded" ? { ...event, result: foreign } : event,
    );
    expect(() => rehydrateOperation(history)).toThrow(/match the operation ID/i);
  });
});
