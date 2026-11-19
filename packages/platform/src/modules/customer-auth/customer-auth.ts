import type { OhmyhostConfig } from "@ohmyhost/contracts";
import { MANAGED_BETTER_AUTH_VERSION } from "@ohmyhost/contracts/framework-source-rules";

export const SUPPORTED_BETTER_AUTH_VERSION = MANAGED_BETTER_AUTH_VERSION;

/**
 * Pins found in recorded plans and artifacts: the pin every new plan carries and the one before
 * it. A deployment recorded before a pin moved keeps its evidence; only new plans are limited to
 * the current pin, by source admission and `createCustomerAuthRequirement`.
 */
export type RecordedBetterAuthVersion = typeof SUPPORTED_BETTER_AUTH_VERSION | "1.7.1";

export function isRecordedBetterAuthVersion(value: unknown): value is RecordedBetterAuthVersion {
  return value === SUPPORTED_BETTER_AUTH_VERSION || value === "1.7.1";
}

export type CustomerAuthRequirement =
  | Readonly<{ readonly provider: "none" }>
  | Readonly<{
      readonly provider: "omh-native";
      readonly routePath: "/api/auth/v1";
      readonly bindingName: "OHMYHOST_AUTH";
    }>
  | Readonly<{
      readonly provider: "better-auth";
      readonly version: RecordedBetterAuthVersion;
      readonly deployment: "companion" | "embedded";
      readonly routePath: "/api/auth";
      readonly databaseSchema: "auth";
      readonly databaseBindingName: "OHMYHOST_DATABASE";
      readonly authSecretName: "BETTER_AUTH_SECRET";
    }>;

/**
 * The managed auth runtime of a plan whose source already passed the shared source rules.
 */
export function createCustomerAuthRequirement(
  config: OhmyhostConfig,
  deployment: "companion" | "embedded",
): CustomerAuthRequirement {
  if (config.auth?.provider === "omh-native") {
    return Object.freeze({
      provider: "omh-native" as const,
      routePath: "/api/auth/v1" as const,
      bindingName: "OHMYHOST_AUTH" as const,
    });
  }
  if (config.auth?.provider !== "better-auth") {
    return Object.freeze({ provider: "none" as const });
  }
  if (
    (deployment !== "embedded" && deployment !== "companion") ||
    config.database?.enabled !== true
  ) {
    throw new TypeError("Customer auth requirement is invalid");
  }
  return Object.freeze({
    provider: "better-auth" as const,
    version: SUPPORTED_BETTER_AUTH_VERSION,
    deployment,
    routePath: "/api/auth" as const,
    databaseSchema: "auth" as const,
    databaseBindingName: "OHMYHOST_DATABASE" as const,
    authSecretName: "BETTER_AUTH_SECRET" as const,
  });
}
