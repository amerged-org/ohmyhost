import { z } from "zod";
import {
  createD1NativeAuthManagementPort,
  type NativeAuthManagementDependencies,
} from "./d1-native-auth-management.js";
import { createNativeAuthUserPort } from "./native-auth-users.js";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";
import { nativeAuthRefusalFor } from "./native-auth-management.js";

export type NativeAuthCatalog = NativeAuthManagementDependencies["catalog"] & {
  readNativeAuthReadiness(input: unknown): Promise<unknown>;
  acceptNativeUserOperation(input: unknown): Promise<{ readonly outcome: "accepted" | "replayed" }>;
};
export interface NativeAuthAdmin {
  applyRealmPolicy(
    input: unknown,
  ): ReturnType<NativeAuthManagementDependencies["applyRealmPolicy"]>;
  applyProviderPolicy(
    input: unknown,
  ): ReturnType<NativeAuthManagementDependencies["applyProviderPolicy"]>;
  listUsers(
    input: unknown,
  ): ReturnType<Parameters<typeof createNativeAuthUserPort>[0]["admin"]["listUsers"]>;
  getUser(
    input: unknown,
  ): ReturnType<Parameters<typeof createNativeAuthUserPort>[0]["admin"]["getUser"]>;
  mutateUser(
    input: unknown,
  ): ReturnType<Parameters<typeof createNativeAuthUserPort>[0]["admin"]["mutateUser"]>;
  deliverInvitation(
    input: unknown,
  ): Promise<{ readonly status: "accepted" | "uncertain" | "rejected" }>;
}
const readinessSchema = z.strictObject({
  paid: z.boolean(),
  sender: z.boolean(),
  origin: z.boolean(),
  storage: z.boolean(),
});

/** Compose only private bindings; absence or uncertainty never fabricates a successful operation. */
export function createNativeAuthManagementComposition(input: {
  catalog: NativeAuthCatalog;
  admin: NativeAuthAdmin;
  cipher: ReturnType<typeof createEnvironmentSecretCipherKeyring>;
}) {
  // Every private refusal is translated once here, by the closed map in native-auth-management.ts.
  const refusing = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw nativeAuthRefusalFor(error) ?? error;
    }
  };
  const privateManagement = createNativeAuthUserPort({
    acceptMutation: (value) => refusing(() => input.catalog.acceptNativeUserOperation(value)),
    admin: {
      listUsers: (value) => input.admin.listUsers(value),
      getUser: (value) => refusing(() => input.admin.getUser(value)),
      mutateUser: (value) => refusing(() => input.admin.mutateUser(value)),
    },
    async deliverInvitation(value) {
      const result = await input.admin.deliverInvitation(value);
      if (result.status !== "accepted") throw new Error("native_mail_unavailable");
    },
  });
  return createD1NativeAuthManagementPort({
    catalog: input.catalog,
    cipher: input.cipher,
    privateManagement,
    applyRealmPolicy: (value) => input.admin.applyRealmPolicy(value),
    applyProviderPolicy: (value) => input.admin.applyProviderPolicy(value),
    async readReadiness(scope) {
      const selected = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        principalId: scope.principalId,
      };
      const [config, raw] = await Promise.all([
        input.catalog.readNativeAuthConfig(selected),
        input.catalog.readNativeAuthReadiness(selected),
      ]);
      if (config === null || raw === null) throw new Error("native_auth_readiness_unavailable");
      return { canonicalOrigin: config.canonicalOrigin, readiness: readinessSchema.parse(raw) };
    },
  });
}
