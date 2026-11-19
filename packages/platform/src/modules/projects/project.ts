import type { Clock, Ulid, UlidFactory } from "../../shared/index.js";

export interface ProjectCreated {
  readonly eventId: Ulid;
  readonly type: "ProjectCreated";
  readonly projectId: Ulid;
  readonly occurredAt: string;
}

export interface Project {
  readonly projectId: Ulid;
  readonly createdAt: string;
  readonly events: readonly ProjectCreated[];
}

export interface CreateProjectInput {
  readonly projectId: Ulid;
  readonly clock: Clock;
  readonly eventIds: UlidFactory;
}

export function createProject({ projectId, clock, eventIds }: CreateProjectInput): Project {
  const createdAt = clock.now().toISOString();
  const event = Object.freeze<ProjectCreated>({
    eventId: eventIds.next(),
    type: "ProjectCreated",
    projectId,
    occurredAt: createdAt,
  });

  return Object.freeze({
    projectId,
    createdAt,
    events: Object.freeze([event]),
  });
}
