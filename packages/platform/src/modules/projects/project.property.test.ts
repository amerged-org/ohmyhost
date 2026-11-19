import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DeterministicEntropy,
  FixedClock,
  createUlidFactory,
  parseUlid,
} from "../../shared/index.js";
import { createProject } from "./project.js";

const PROPERTY_SEED = 0x50720;
const PROPERTY_RUNS = 100;
const MAX_ULID_TIMESTAMP = 0xffffffffffff;

const timestampArbitrary = fc.integer({ min: 0, max: MAX_ULID_TIMESTAMP });
const entropySeedArbitrary = fc.integer({ min: 0, max: 0xffffffff });

function createFromInjected(timestamp: number, entropySeed: number) {
  const clock = new FixedClock(timestamp);
  const eventIds = createUlidFactory({
    clock,
    entropy: new DeterministicEntropy(entropySeed),
  });
  const projectId = eventIds.next();

  return createProject({ projectId, clock, eventIds });
}

describe("project aggregate properties", () => {
  it("preserves injected ULID identity, canonical time, and immutable creation history", () => {
    fc.assert(
      fc.property(timestampArbitrary, entropySeedArbitrary, (timestamp, entropySeed) => {
        const project = createFromInjected(timestamp, entropySeed);
        const event = project.events[0];
        const expectedTimestamp = new Date(timestamp).toISOString();

        expect(parseUlid(project.projectId)).toBe(project.projectId);
        expect(event).toEqual({
          eventId: parseUlid(event?.eventId ?? ""),
          type: "ProjectCreated",
          projectId: project.projectId,
          occurredAt: expectedTimestamp,
        });
        expect(project.createdAt).toBe(expectedTimestamp);
        expect(project.events).toHaveLength(1);
        expect(event?.eventId).not.toBe(project.projectId);
        expect(Object.isFrozen(project)).toBe(true);
        expect(Object.isFrozen(project.events)).toBe(true);
        expect(Object.isFrozen(event)).toBe(true);
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });

  it("depends only on injected clock and entropy", () => {
    fc.assert(
      fc.property(timestampArbitrary, entropySeedArbitrary, (timestamp, entropySeed) => {
        const first = createFromInjected(timestamp, entropySeed);
        const replayed = createFromInjected(timestamp, entropySeed);

        expect(replayed).toEqual(first);
      }),
      { seed: PROPERTY_SEED + 1, numRuns: PROPERTY_RUNS },
    );
  });

  it("keeps event IDs unique across distinct generated inputs", () => {
    const distinctInputs = fc.uniqueArray(
      fc.record({ timestamp: timestampArbitrary, entropySeed: entropySeedArbitrary }),
      {
        minLength: 2,
        maxLength: 30,
        selector: (input) => input.timestamp,
      },
    );

    fc.assert(
      fc.property(distinctInputs, (inputs) => {
        const eventIds = inputs.map(
          ({ timestamp, entropySeed }) =>
            createFromInjected(timestamp, entropySeed).events[0]?.eventId,
        );

        expect(new Set(eventIds).size).toBe(eventIds.length);
      }),
      { seed: PROPERTY_SEED + 2, numRuns: PROPERTY_RUNS },
    );
  });
});
