import { type Ulid } from "@ohmyhost/platform";

import type { TransactionClient } from "./transaction.js";

export interface PromotionPlanTarget {
  readonly dataMode: "shared" | "isolated";
  readonly databaseEnabled: boolean;
  readonly billingEpochId: Ulid;
  readonly sourceEnvironmentId: Ulid;
  readonly sourceDeploymentId: Ulid;
  readonly sourceRevisionId: Ulid;
  readonly sourceArtifactId: Ulid;
  readonly sourceArtifactDigest: Uint8Array;
  readonly expectedSourceHeadVersion: number;
  readonly targetEnvironmentId: Ulid;
  readonly expectedTargetHeadVersion: number;
}

export declare function readPromotionPlanTarget(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly sourceEnvironmentId: Ulid;
    readonly targetEnvironmentId: Ulid;
  },
): Promise<PromotionPlanTarget | null>;
