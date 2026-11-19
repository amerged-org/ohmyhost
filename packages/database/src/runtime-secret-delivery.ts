import type { Ulid } from "@ohmyhost/platform";

import type { EnvironmentSecretScope } from "./environment-secrets.js";
import type { TransactionClient } from "./transaction.js";
import type { WfpCandidateReceipt } from "./wfp-candidate-persistence.js";

export type RuntimeSecretDeliveryTrigger = "deploy" | "rollback" | "promotion" | "reconcile";
export type RuntimeSecretProvider = "wfp";

export interface EncryptedRuntimeSecret {
  readonly name: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly valueSha256: Uint8Array;
  readonly keyVersion: number;
  readonly revision: number;
}

export interface RuntimeSecretDeliveryState extends EnvironmentSecretScope {
  readonly runtimeProvider?: RuntimeSecretProvider;
  readonly nextReleaseSequence: number;
  readonly appliedReleaseSequence: number;
  readonly activeClaimReleaseSequence?: number;
  readonly desiredGeneration: number;
  readonly appliedGeneration: number;
  readonly activeLeaseExpiresAt?: string;
  readonly lastFailureCode?: string;
  readonly providerTag?: string;
  readonly appliedSecretNames: readonly string[];
  readonly manifestSha256?: Uint8Array;
  readonly manifestSecretCount: number;
  readonly updatedAt: string;
}

export interface PendingRuntimeSecretDelivery extends EnvironmentSecretScope {
  readonly runtimeProvider?: RuntimeSecretProvider;
  readonly desiredGeneration: number;
  readonly appliedGeneration: number;
  readonly lastFailureCode?: string;
  readonly activeCandidate?: WfpCandidateReceipt;
}

export type ClaimRuntimeSecretDeliveryResult =
  | Readonly<{
      outcome: "claimed";
      generation: number;
      trigger: RuntimeSecretDeliveryTrigger;
      runtimeProvider: RuntimeSecretProvider;
      releaseSequence: number;
      leaseId: Ulid;
      leaseExpiresAt: string;
      secrets: readonly EncryptedRuntimeSecret[];
      appliedSecretNames: readonly string[];
      providerTag?: string;
    }>
  | Readonly<{ outcome: "current"; generation: number; releaseSequence: number }>
  | Readonly<{ outcome: "busy"; generation: number; releaseSequence: number; retryAt: string }>;

export declare class RuntimeSecretDeliveryInputError extends Error {
  constructor();
}

export declare class RuntimeSecretDeliveryScopeError extends Error {
  constructor();
}

export declare class RuntimeSecretDeliveryLeaseError extends Error {
  constructor();
}

export declare class RuntimeSecretDeliveryConflictError extends Error {
  constructor();
}

export declare function readRuntimeSecretDeliveryState(
  client: TransactionClient,
  scope: EnvironmentSecretScope,
): Promise<RuntimeSecretDeliveryState | undefined>;
