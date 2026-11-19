import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface GithubAutoDeployConfig {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly sourceConnectionId: Ulid;
  readonly branchRef: string;
  readonly generation: number;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly grantActive: boolean;
}
export class GithubAutoDeployTargetDeniedError extends Error {
  constructor(
    readonly denialCode: "GITHUB_AUTO_DEPLOY_GRANT_REVOKED" | "GITHUB_AUTO_DEPLOY_DISABLED",
  ) {
    super("GitHub auto-deploy target is denied");
    this.name = "GithubAutoDeployTargetDeniedError";
  }
}

export declare function configureGithubAutoDeployIdempotently(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly principalId: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly canonicalRequestDigest: Uint8Array;
    readonly operationId: Ulid;
    readonly queuedEventId: Ulid;
    readonly succeededEventId: Ulid;
    readonly auditEventId: Ulid;
    readonly branchRef: string;
    readonly enabled: boolean;
    readonly configuredAt: string;
  },
): Promise<GithubAutoDeployConfig | null>;

export declare function readGithubAutoDeployConfig(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  },
): Promise<GithubAutoDeployConfig | null>;

export declare function authorizeGithubPushActivation(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<boolean>;
