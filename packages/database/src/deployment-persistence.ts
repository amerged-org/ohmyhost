import { type ProductionFrameworkPlan, type Ulid } from "@ohmyhost/platform";

import type { TransactionClient } from "./transaction.js";

export class DeploymentPersistenceConflictError extends Error {
  readonly code = "deployment_persistence_conflict" as const;

  constructor(message = "Persisted deployment identity conflicts with the request") {
    super(message);
    this.name = "DeploymentPersistenceConflictError";
  }
}

export class DeploymentMailDomainRequiredError extends Error {
  readonly code = "deployment_mail_domain_required" as const;

  public constructor() {
    super("Better Auth deployment plans require a configured sender domain");
    this.name = "DeploymentMailDomainRequiredError";
  }
}

/** A plan stays valid for a day, long enough for a human to approve the deploy (D312). */
export const DEPLOYMENT_PLAN_TTL_MILLISECONDS = 86_400_000;

export interface DeploymentPlanInput {
  readonly planId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  /** The Dev or Prod environment the deployment builds into. */
  readonly environmentId: Ulid;
  readonly sourceConnectionId: Ulid;
  readonly sourceGeneration?: number;
  readonly commitSha: string;
  readonly sourceDigest: Uint8Array;
  readonly buildPlanDigest: Uint8Array;
  readonly planDigest: Uint8Array;
  readonly runtime: string;
  readonly frameworkPlan: ProductionFrameworkPlan;
  readonly impacts: readonly string[];
  readonly risks: readonly string[];
  readonly costEstimate: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export declare function createDeploymentPlan(
  client: TransactionClient,
  input: DeploymentPlanInput,
): Promise<"created" | "existing">;

type ConfirmationTarget =
  | { readonly action: "rollback"; readonly targetDeploymentId: Ulid }
  | { readonly action: "promote"; readonly targetDeploymentId: Ulid }
  | { readonly action: "delete" | "data_change"; readonly targetDeploymentId?: never };

export type IssueActionConfirmationInput = ConfirmationTarget & {
  readonly confirmationId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly issuedToPrincipalId: string;
  readonly subjectEtag: string;
  readonly tokenDigest: Uint8Array;
  readonly issuedAt: string;
};

export declare function issueActionConfirmation(
  client: TransactionClient,
  input: IssueActionConfirmationInput,
): Promise<"created" | "existing">;

export type ConsumeActionConfirmationInput = ConfirmationTarget & {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly issuedToPrincipalId: string;
  readonly subjectEtag: string;
  readonly tokenDigest: Uint8Array;
  readonly consumedAt: string;
};

export declare function recordCleanupAttempt(
  client: TransactionClient,
  input: {
    readonly cleanupAttemptId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly provider: string;
    readonly resourceKind: string;
    readonly externalRefHash: Uint8Array;
    readonly outcome: "removed" | "not_found" | "failed";
    readonly errorCode?: string;
    readonly attemptedAt: string;
  },
): Promise<"created" | "existing">;
