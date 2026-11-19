import { readRuntimeSecretDeliveryState } from "@ohmyhost/database";

import type { EnvironmentSecretsPort } from "./contracts.js";

export class EnvironmentSecretsUnavailableError extends Error {
  public constructor() {
    super("Environment secret storage is unavailable");
    this.name = "EnvironmentSecretsUnavailableError";
  }
}

export class EnvironmentSecretMutationBlockedError extends Error {
  public constructor() {
    super("Environment secret mutation is blocked by an active deployment");
    this.name = "EnvironmentSecretMutationBlockedError";
  }
}

/** The owner asked to rotate an installed platform key that the environment does not hold. */
export class EnvironmentSecretNotInstalledError extends Error {
  public constructor() {
    super("Environment secret is not installed");
    this.name = "EnvironmentSecretNotInstalledError";
  }
}

export function createUnavailableEnvironmentSecretsPort(): EnvironmentSecretsPort {
  const unavailable = async (): Promise<never> => {
    throw new EnvironmentSecretsUnavailableError();
  };
  return Object.freeze({
    list: unavailable,
    put: unavailable,
    remove: unavailable,
    rotate: unavailable,
  });
}

/**
 * The delivery state describes whether the desired secret generation reached the runtime. A
 * failure code from a later candidate delivery does not undo an applied generation: the active
 * runtime still holds every secret, so the state stays ready and reports no error. lastError
 * only accompanies a generation that has not been delivered yet.
 */
export function runtimeSecretDeliveryMetadata(
  state:
    | Pick<
        NonNullable<Awaited<ReturnType<typeof readRuntimeSecretDeliveryState>>>,
        | "desiredGeneration"
        | "appliedGeneration"
        | "lastFailureCode"
        | "runtimeProvider"
        | "manifestSecretCount"
      >
    | undefined,
) {
  const desiredGeneration = state?.desiredGeneration ?? 0;
  const appliedGeneration = state?.appliedGeneration ?? 0;
  const failureCode = state?.lastFailureCode ?? null;
  const deliveryState =
    state === undefined || state.runtimeProvider === undefined
      ? ("not_deployed" as const)
      : desiredGeneration > appliedGeneration
        ? failureCode !== null
          ? ("failed" as const)
          : ("pending" as const)
        : ("ready" as const);
  return Object.freeze({
    desiredGeneration,
    appliedGeneration,
    state: deliveryState,
    runtimeProvider: state?.runtimeProvider ?? null,
    appliedSecretCount: state?.manifestSecretCount ?? 0,
    lastError: deliveryState === "ready" ? null : failureCode,
  });
}
