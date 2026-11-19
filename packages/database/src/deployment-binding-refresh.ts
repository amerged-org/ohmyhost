import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface ProjectBindingRefreshSnapshot {
  readonly sourceDeploymentId: Ulid;
  readonly sourceRevisionId: Ulid;
  readonly sourceCandidateReceiptId: Ulid;
  readonly sourceArtifactId: Ulid;
  readonly sourcePlanId: Ulid;
  readonly sourceBuildExecutionId: Ulid;
  readonly sourceArtifactSha256: string;
  readonly sourceNamespace: string;
  readonly sourceScriptName: string;
  readonly sourceProviderTag: string;
  readonly expectedHeadVersion: number;
  readonly expectedGatewayRevision: number;
  readonly dataEnvironmentId: Ulid;
  readonly assignmentVersion: number;
  readonly registrationVersion: number;
}
interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** A frozen source head, or this operation's exact published replacement; never an arbitrary successor. */
export declare function assertProjectBindingRefreshSnapshot(
  client: TransactionClient,
  input: Scope & {
    readonly operationId: string;
    readonly snapshot: ProjectBindingRefreshSnapshot;
    readonly allowPublished: boolean;
  },
): Promise<void>;
