import { derivedId } from "./project-data-changes.js";
import {
  nativeAuthRefusalFor,
  NativeAuthManagementError,
  type NativeAuthManagementPort,
} from "./native-auth-management.js";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";

interface Config {
  readonly configurationRevision: number;
  readonly revocationEpoch: number;
  readonly enabled: boolean;
  readonly signupPolicy: "open" | "invite-only";
  readonly appName: string;
  readonly canonicalOrigin: string | null;
  readonly allowedRedirectPaths: readonly string[];
  readonly resetPasswordPath: string;
  readonly invitationPath: string;
}
interface Catalog {
  readNativeAuthConfig(input: unknown): Promise<Config | null>;
  proveNativeAuthUnprovisionedPolicy(input: unknown): Promise<boolean>;
  updateNativeAuthConfig(input: unknown): Promise<Config>;
  readNativeAuthProvider(input: unknown): Promise<Provider | null>;
  updateNativeAuthProvider(input: unknown): Promise<Provider>;
}
interface Provider {
  readonly provider: "google" | "github";
  readonly enabled: boolean;
  readonly clientId: string;
  readonly secretPresent: boolean;
  readonly configurationRevision: number;
  readonly lastSuccessfulFlowAt: string | null;
}
type Scope = Parameters<NativeAuthManagementPort["getConfiguration"]>[0];
type Readiness = Pick<
  NonNullable<Awaited<ReturnType<NativeAuthManagementPort["getConfiguration"]>>>,
  "canonicalOrigin" | "readiness"
>;
type PolicyFence = { readonly outcome: "applied" | "proven-not-provisioned-pending" };

/** Readiness must come from current platform-owned sender, origin, billing and storage state. */
export interface NativeAuthManagementDependencies {
  readonly catalog: Catalog;
  readonly readReadiness: (scope: Scope) => Promise<Readiness>;
  readonly cipher: ReturnType<typeof createEnvironmentSecretCipherKeyring>;
  /** Serializes with Native DB mutations before a pause can be acknowledged. */
  readonly applyRealmPolicy: (input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    configurationRevision: number;
    revocationEpoch: number;
    enabled: boolean;
    canonicalOrigin: string | null;
  }) => Promise<PolicyFence>;
  readonly applyProviderPolicy: (input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    provider: "google" | "github";
    configurationRevision: number;
    enabled: boolean;
  }) => Promise<PolicyFence>;
  /** Private operations must independently enforce current Owner and mutation authority. */
  readonly privateManagement: Omit<
    NativeAuthManagementPort,
    "getConfiguration" | "updateConfiguration" | "getProvider" | "updateProvider"
  >;
}

export function createD1NativeAuthManagementPort(
  input: NativeAuthManagementDependencies,
): NativeAuthManagementPort {
  const scope = (value: Scope) => ({
    organizationId: value.organizationId,
    projectId: value.projectId,
    environmentId: value.environmentId,
    principalId: value.principalId,
  });
  const result = async (value: Scope, config: Config) => {
    const readiness = await input.readReadiness(value);
    return {
      configurationRevision: config.configurationRevision,
      revocationEpoch: config.revocationEpoch,
      enabled: config.enabled,
      signupPolicy: config.signupPolicy,
      applicationName: config.appName,
      allowedRedirectPaths: [...config.allowedRedirectPaths],
      resetPasswordPath: config.resetPasswordPath,
      invitationPath: config.invitationPath,
      canonicalOrigin: config.canonicalOrigin,
      readiness: readiness.readiness,
    };
  };
  const providerResult = async (value: Scope, provider: Provider) => {
    const { canonicalOrigin } = await input.readReadiness(value);
    return {
      provider: provider.provider,
      enabled: provider.enabled,
      configured: provider.clientId.length > 0 && provider.secretPresent,
      clientId: provider.clientId || null,
      secretPresent: provider.secretPresent,
      callbackUrl:
        canonicalOrigin === null
          ? null
          : `${canonicalOrigin}/api/auth/v1/callback/${provider.provider}`,
      scopes:
        provider.provider === "google"
          ? ["openid", "email", "profile"]
          : ["read:user", "user:email"],
      lastSuccessfulFlowAt: provider.lastSuccessfulFlowAt,
    };
  };
  return {
    ...input.privateManagement,
    async getConfiguration(value) {
      const config = await input.catalog.readNativeAuthConfig(scope(value));
      return config === null ? null : result(value, config);
    },
    async updateConfiguration(value) {
      try {
        // This operation controls owner policy only. Serving still checks current admission.
        const config = await input.catalog.updateNativeAuthConfig({
          ...scope(value),
          ...(value.delegation === undefined ? {} : { handoffDelegation: value.delegation }),
          expectedRevision: value.body.configurationRevision,
          operationId: derivedId(
            `native-auth\n${value.organizationId}\n${value.projectId}\n${value.environmentId}\n${value.principalId}\n${value.idempotencyKey}`,
          ),
          enabled: value.body.enabled,
          signupPolicy: value.body.signupPolicy,
          appName: value.body.applicationName,
          ...(value.body.canonicalOrigin === undefined
            ? {}
            : { canonicalOrigin: value.body.canonicalOrigin }),
          ...(value.body.allowedRedirectPaths === undefined
            ? {}
            : { allowedRedirectPaths: value.body.allowedRedirectPaths }),
          ...(value.body.resetPasswordPath === undefined
            ? {}
            : { resetPasswordPath: value.body.resetPasswordPath }),
          ...(value.body.invitationPath === undefined
            ? {}
            : { invitationPath: value.body.invitationPath }),
        });
        // Replays return their original receipt; reconcile the current policy, never the old receipt.
        const current = await input.catalog.readNativeAuthConfig(scope(value));
        if (current === null) throw new NativeAuthManagementError("scope");
        const fenceInput = {
          ...scope(value),
          ...(value.delegation === undefined ? {} : { handoffDelegation: value.delegation }),
          configurationRevision: current.configurationRevision,
          revocationEpoch: current.revocationEpoch,
          enabled: current.enabled,
          canonicalOrigin: current.canonicalOrigin,
        };
        const unprovisioned = await input.catalog.proveNativeAuthUnprovisionedPolicy(fenceInput);
        if (typeof unprovisioned !== "boolean") throw new Error("native_auth_policy_unavailable");
        if (!unprovisioned) {
          const fence = await input.applyRealmPolicy({
            organizationId: value.organizationId,
            projectId: value.projectId,
            environmentId: value.environmentId,
            configurationRevision: current.configurationRevision,
            revocationEpoch: current.revocationEpoch,
            enabled: current.enabled,
            canonicalOrigin: current.canonicalOrigin,
          });
          if (fence?.outcome !== "applied") throw new Error("native_auth_policy_unavailable");
        }
        return result(value, config);
      } catch (error) {
        throw nativeAuthRefusalFor(error) ?? error;
      }
    },
    async getProvider(value) {
      const provider = await input.catalog.readNativeAuthProvider({
        ...scope(value),
        provider: value.provider,
      });
      if (provider !== null && provider.provider !== value.provider)
        throw new Error("native_provider_response_invalid");
      if (provider !== null) return providerResult(value, provider);
      const config = await input.catalog.readNativeAuthConfig(scope(value));
      return config === null
        ? null
        : providerResult(value, {
            provider: value.provider,
            enabled: false,
            clientId: "",
            secretPresent: false,
            configurationRevision: config.configurationRevision,
            lastSuccessfulFlowAt: null,
          });
    },
    async updateProvider(value) {
      const encryptedSecret =
        value.body.clientSecret === undefined
          ? undefined
          : await input.cipher.encrypt({
              ...scope(value),
              name: `NATIVE_AUTH_${value.provider.toUpperCase()}_CLIENT_SECRET`,
              value: value.body.clientSecret,
            });
      try {
        const provider = await input.catalog.updateNativeAuthProvider({
          ...scope(value),
          provider: value.provider,
          ...(value.delegation === undefined ? {} : { handoffDelegation: value.delegation }),
          expectedRevision: value.body.configurationRevision,
          operationId: derivedId(
            `native-auth\n${value.organizationId}\n${value.projectId}\n${value.environmentId}\n${value.principalId}\n${value.idempotencyKey}`,
          ),
          enabled: value.body.enabled,
          ...(value.body.clientId === undefined ? {} : { clientId: value.body.clientId }),
          ...(encryptedSecret === undefined ? {} : { encryptedSecret }),
        });
        if (provider.provider !== value.provider)
          throw new Error("native_provider_response_invalid");
        const current = await input.catalog.readNativeAuthProvider({
          ...scope(value),
          provider: value.provider,
        });
        if (current === null) throw new NativeAuthManagementError("scope");
        if (current.provider !== value.provider)
          throw new Error("native_provider_response_invalid");
        const fence = await input.applyProviderPolicy({
          organizationId: value.organizationId,
          projectId: value.projectId,
          environmentId: value.environmentId,
          provider: value.provider,
          configurationRevision: current.configurationRevision,
          enabled: current.enabled,
        });
        if (fence?.outcome !== "applied" && fence?.outcome !== "proven-not-provisioned-pending")
          throw new Error("native_auth_policy_unavailable");
        return providerResult(value, provider);
      } catch (error) {
        throw nativeAuthRefusalFor(error) ?? error;
      }
    },
  };
}
