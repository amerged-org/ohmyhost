import type { TransactionClient } from "./transaction.js";

export interface BuildOperationScope {
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
}

export interface PersistedBuildReceipt {
  readonly buildId: string;
  readonly projectName: string;
  readonly scope: BuildOperationScope;
}

export interface PersistedBuildReceiptEnvelope {
  readonly receipt: PersistedBuildReceipt;
  readonly inputFingerprint: `sha256:${string}`;
  readonly claimId: string;
}

export interface BuildInputClaimRequest {
  readonly scope: BuildOperationScope;
  readonly inputFingerprint: `sha256:${string}`;
  readonly claimId: string;
  readonly leaseMilliseconds: number;
}

export type BuildReceiptCompletion = PersistedBuildReceiptEnvelope;

export interface BuildUsageInput {
  readonly receipt: PersistedBuildReceipt;
  /** What the build runner measured; `provisioningStartedAt` is the start of the customer build. */
  readonly usage: {
    readonly runner: "cloudflare-build-sandbox";
    readonly instanceType: string;
    readonly status: string;
    readonly startedAt: string;
    readonly provisioningStartedAt: string | null;
    readonly completedAt: string;
  };
}

export type BuildInputClaimResult =
  | Readonly<{
      status: "claimed";
      mode: "start" | "observe";
      attemptNumber: number;
      reservationCreatedAt: Date;
      startAllowedUntil: Date;
      leaseExpiresAt: Date;
    }>
  | Readonly<{ status: "pending"; leaseExpiresAt: Date; startAllowedUntil: Date }>
  | Readonly<{ status: "completed"; envelope: PersistedBuildReceiptEnvelope }>;

export class BuildCapacityReachedError extends Error {
  public readonly code = "build_capacity_reached" as const;

  public constructor() {
    super("The organization already holds its open build capacity");
    this.name = "BuildCapacityReachedError";
  }
}

export class BuildInputConflictError extends Error {
  public readonly code = "build_input_conflict" as const;

  public constructor() {
    super("Build input conflicts with the reserved operation scope");
    this.name = "BuildInputConflictError";
  }
}

export declare function claimBuildInput(
  client: TransactionClient,
  request: BuildInputClaimRequest,
): Promise<BuildInputClaimResult>;

export declare function authorizeBuildStart(
  client: TransactionClient,
  scope: BuildOperationScope,
  claimId: string,
): Promise<boolean>;

export declare function putBuildReceipt(
  client: TransactionClient,
  completion: BuildReceiptCompletion,
): Promise<"created" | "existing">;
