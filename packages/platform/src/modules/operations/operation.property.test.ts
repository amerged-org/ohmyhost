import fc from "fast-check";
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
  type Operation,
  type OperationState,
} from "./operation.js";

const PROPERTY_SEED = 0x0e4a710;
const PROPERTY_RUNS = 150;
const BASE_TIME = Date.UTC(2026, 0, 1);

type ActionKind = "start" | "succeed" | "fail" | "cancel";

interface Action {
  readonly kind: ActionKind;
  readonly key: string;
  readonly failureCode: string;
}

interface ReferenceModel {
  state: OperationState;
  readonly accepted: Map<string, string>;
  eventCount: number;
}

function dependencies(timestamp: number, seed: number): { clock: Clock; eventIds: UlidFactory } {
  const clock = new FixedClock(timestamp);
  return {
    clock,
    eventIds: createUlidFactory({ clock, entropy: new DeterministicEntropy(seed) }),
  };
}

function signature(action: Action): string {
  return action.kind === "fail" ? `${action.kind}:${action.failureCode}` : action.kind;
}

function expectedFrom(action: Action): OperationState {
  return action.kind === "start" ? "queued" : "running";
}

function expectedTo(action: Action): OperationState {
  if (action.kind === "start") return "running";
  if (action.kind === "succeed") return "succeeded";
  if (action.kind === "fail") return "failed";
  return "cancelled";
}

function applyReference(
  model: ReferenceModel,
  action: Action,
): "accepted" | "replayed" | "rejected" {
  const existing = model.accepted.get(action.key);
  if (existing !== undefined) {
    return existing === signature(action) ? "replayed" : "rejected";
  }
  if (model.state !== expectedFrom(action)) return "rejected";
  model.accepted.set(action.key, signature(action));
  model.state = expectedTo(action);
  model.eventCount += 1;
  return "accepted";
}

function applyActual(operation: Operation, action: Action, index: number): Operation {
  const deps = dependencies(BASE_TIME + index + 1, index + 100);
  if (action.kind === "start") {
    return startOperation(operation, { idempotencyKey: action.key }, deps);
  }
  if (action.kind === "succeed") {
    return succeedOperation(operation, { idempotencyKey: action.key }, deps);
  }
  if (action.kind === "fail") {
    return failOperation(
      operation,
      {
        idempotencyKey: action.key,
        failure: { code: action.failureCode, message: `Failure ${action.failureCode}` },
      },
      deps,
    );
  }
  return cancelOperation(operation, { idempotencyKey: action.key }, deps);
}

const actionArbitrary = fc.record<Action>({
  kind: fc.constantFrom<ActionKind>("start", "succeed", "fail", "cancel"),
  key: fc.integer({ min: 0, max: 5 }).map((value) => `key-${value}`),
  failureCode: fc.integer({ min: 0, max: 3 }).map((value) => `FAILURE_${value}`),
});

describe("operation state-machine properties", () => {
  it("matches a declarative model for transitions, terminal states, and idempotent replay", () => {
    fc.assert(
      fc.property(fc.array(actionArbitrary, { minLength: 1, maxLength: 40 }), (actions) => {
        const identity = dependencies(BASE_TIME, 1);
        let operation = createOperation({
          operationId: identity.eventIds.next(),
          projectId: identity.eventIds.next(),
          ...identity,
        });
        const model: ReferenceModel = {
          state: "queued",
          accepted: new Map(),
          eventCount: 1,
        };

        actions.forEach((action, index) => {
          const expected = applyReference(model, action);
          const before = operation;

          if (expected === "rejected") {
            expect(() => applyActual(operation, action, index)).toThrow();
          } else {
            operation = applyActual(operation, action, index);
            if (expected === "replayed") expect(operation).toBe(before);
          }

          expect(operation.state).toBe(model.state);
          expect(operation.events).toHaveLength(model.eventCount);
          expect(operation.events[0]?.type).toBe("OperationQueued");
          expect(
            operation.events.every((event) => event.operationId === operation.operationId),
          ).toBe(true);
          expect(operation.events.every((event) => event.projectId === operation.projectId)).toBe(
            true,
          );

          if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
            expect(operation.events.at(-1)?.type).toBe(
              operation.state === "succeeded"
                ? "OperationSucceeded"
                : operation.state === "failed"
                  ? "OperationFailed"
                  : "OperationCancelled",
            );
          }
        });
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });
});
