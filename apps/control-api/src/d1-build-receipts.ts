import { BuildCapacityReachedError, BuildInputConflictError } from "@ohmyhost/database";
import type {
  BuildInputClaimRequest,
  BuildInputClaimResult,
  BuildUsageInput,
  PersistedBuildReceiptEnvelope,
} from "@ohmyhost/database";
import type { BuildReceiptPersistencePort } from "./product-surface.js";

/** The actual receipt service holds this private binding, never a D1 binding or a Control SQL credential. */
export interface ControlBuildRuntimeBinding {
  claimBuildInput(input: BuildInputClaimRequest): Promise<BuildInputClaimResult>;
  authorizeBuildStart(input: {
    scope: BuildInputClaimRequest["scope"];
    claimId: string;
  }): Promise<boolean>;
  putBuildReceipt(input: PersistedBuildReceiptEnvelope): Promise<void>;
  putBuildUsage(input: BuildUsageInput): Promise<void>;
}

export function createD1BuildReceiptPersistence(value: unknown): BuildReceiptPersistencePort {
  if (
    value === null ||
    value === undefined ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new Error("D1 build receipt runtime is unavailable");
  }
  const binding = value as ControlBuildRuntimeBinding;
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      // RPC retains a closed refusal message, not the remote Error subclass's prototype.
      if (error instanceof Error && error.message === "build_input_conflict")
        throw new BuildInputConflictError();
      if (error instanceof Error && error.message === "build_capacity_reached")
        throw new BuildCapacityReachedError();
      throw error;
    }
  };
  return {
    claimBuildInput: (input) => call(() => binding.claimBuildInput(input)),
    authorizeBuildStart: (scope, claimId) =>
      call(() => binding.authorizeBuildStart({ scope, claimId })),
    putBuildReceipt: (input) => call(() => binding.putBuildReceipt(input)),
    putBuildUsage: (input) => call(() => binding.putBuildUsage(input)),
  };
}
