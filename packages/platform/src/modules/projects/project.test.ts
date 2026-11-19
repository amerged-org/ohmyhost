import { describe, expect, it } from "vitest";

import { DeterministicEntropy, FixedClock, createUlidFactory } from "../../shared/index.js";
import { createProject } from "./project.js";

describe("project aggregate", () => {
  it("creates an immutable project and ProjectCreated event from injected dependencies", () => {
    const clock = new FixedClock("2026-08-17T12:00:00.000Z");
    const ids = createUlidFactory({ clock, entropy: new DeterministicEntropy(11) });
    const projectId = ids.next();

    const project = createProject({ projectId, clock, eventIds: ids });

    expect(project).toEqual({
      projectId,
      createdAt: "2026-08-17T12:00:00.000Z",
      events: [
        {
          eventId: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
          type: "ProjectCreated",
          projectId,
          occurredAt: "2026-08-17T12:00:00.000Z",
        },
      ],
    });
    expect(project.events[0]?.eventId).not.toBe(projectId);
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.events)).toBe(true);
    expect(Object.isFrozen(project.events[0])).toBe(true);
  });
});
