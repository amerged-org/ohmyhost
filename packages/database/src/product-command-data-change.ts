import { type Ulid } from "@ohmyhost/platform";
import { type ProjectDataChangeTransition } from "./project-data-environments.js";
import type { TransactionClient } from "./transaction.js";

export interface ProjectDataChangeSnapshot {
  readonly transition: ProjectDataChangeTransition;
  readonly environmentHeads: readonly {
    readonly environmentId: Ulid;
    readonly expectedHeadVersion: number;
  }[];
  readonly registrationGenerations: readonly {
    readonly dataEnvironmentId: string;
    readonly registrationVersion: number;
  }[];
}

export interface ProjectDataChangePersistenceInput {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid;
  readonly claimId: Ulid;
  readonly snapshot: ProjectDataChangeSnapshot;
  readonly now: string;
}

/** Start only the cleanup owned by the accepted data snapshot and active provider claim. */
export declare function startProjectDataChangeCleanup(
  client: TransactionClient,
  input: ProjectDataChangePersistenceInput,
): Promise<"created" | "existing">;

/** Append the assignment switch and its single audit atomically in the caller's transaction. */
export declare function appendAuditedProjectDataChangeAssignments(
  client: TransactionClient,
  input: ProjectDataChangePersistenceInput,
): Promise<"created" | "existing">;
