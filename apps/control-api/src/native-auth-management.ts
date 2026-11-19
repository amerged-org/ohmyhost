import { z } from "zod";
import type { EnvironmentSecretContext, ProductSurfaceMutationContext } from "./contracts.js";
import { isNativeAuthRedirectPath } from "@ohmyhost/contracts/native-auth";

const revision = z.number().int().nonnegative().safe();
export const nativeAppPath = z.string().max(256).refine(isNativeAuthRedirectPath);
const canonicalOrigin = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
    } catch {
      return false;
    }
  });
export const nativeConfigUpdate = z.strictObject({
  configurationRevision: revision,
  enabled: z.boolean(),
  signupPolicy: z.enum(["open", "invite-only"]),
  applicationName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !/\p{Cc}/u.test(value)),
  canonicalOrigin: canonicalOrigin.nullable().optional(),
  allowedRedirectPaths: z
    .array(nativeAppPath)
    .min(1)
    .max(16)
    .refine((paths) => new Set(paths).size === paths.length)
    .optional(),
  resetPasswordPath: nativeAppPath.optional(),
  invitationPath: nativeAppPath.optional(),
});
export const nativeProviderUpdate = z.strictObject({
  configurationRevision: revision,
  enabled: z.boolean(),
  clientId: z.string().min(1).max(1024).optional(),
  clientSecret: z
    .string()
    .min(1)
    .max(5120)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 5120)
    .optional(),
});
export const nativeInvite = z.strictObject({ email: z.email().max(254) });
export const nativeConfigResponse = nativeConfigUpdate
  .extend({
    revocationEpoch: revision,
    canonicalOrigin: canonicalOrigin.nullable(),
    allowedRedirectPaths: z.array(nativeAppPath).min(1).max(16),
    resetPasswordPath: nativeAppPath,
    invitationPath: nativeAppPath,
    readiness: z.strictObject({
      paid: z.boolean(),
      sender: z.boolean(),
      origin: z.boolean(),
      storage: z.boolean(),
    }),
  })
  .refine(
    (value) =>
      new Set(value.allowedRedirectPaths).size === value.allowedRedirectPaths.length &&
      value.allowedRedirectPaths.includes(value.resetPasswordPath) &&
      value.allowedRedirectPaths.includes(value.invitationPath),
  );
export const nativeProviderResponse = z.strictObject({
  provider: z.enum(["google", "github"]),
  enabled: z.boolean(),
  configured: z.boolean(),
  clientId: z.string().nullable(),
  secretPresent: z.boolean(),
  callbackUrl: z.string().url().nullable(),
  scopes: z.array(z.string()).max(8),
  lastSuccessfulFlowAt: z.iso.datetime().nullable(),
});
export const nativeUserResponse = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  status: z.enum(["pending", "active", "suspended"]),
  recoveryAvailable: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const nativeUserPageResponse = z.strictObject({
  items: z.array(nativeUserResponse).max(100),
  nextCursor: z.uuid().nullable(),
});

type Scope = EnvironmentSecretContext;
type Mutation = Scope &
  Pick<ProductSurfaceMutationContext, "idempotencyKey" | "canonicalRequestDigest">;
type Provider = "google" | "github";
type UserAction = "invite" | "suspend" | "reactivate" | "revoke-sessions";

/** Implementations recheck current Owner authority at their private mutation boundary. */
export interface NativeAuthManagementPort {
  getConfiguration(input: Scope): Promise<z.output<typeof nativeConfigResponse> | null>;
  updateConfiguration(
    input: Mutation & { body: z.output<typeof nativeConfigUpdate> },
  ): Promise<z.output<typeof nativeConfigResponse>>;
  getProvider(
    input: Scope & { provider: Provider },
  ): Promise<z.output<typeof nativeProviderResponse> | null>;
  updateProvider(
    input: Mutation & { provider: Provider; body: z.output<typeof nativeProviderUpdate> },
  ): Promise<z.output<typeof nativeProviderResponse>>;
  listUsers(
    input: Scope & { limit: number; cursor?: string; search?: string },
  ): Promise<z.output<typeof nativeUserPageResponse>>;
  createUser(input: Mutation & { email: string }): Promise<z.output<typeof nativeUserResponse>>;
  getUser(input: Scope & { userId: string }): Promise<z.output<typeof nativeUserResponse> | null>;
  deleteUser(input: Mutation & { userId: string }): Promise<void>;
  userAction(
    input: Mutation & { userId: string; action: UserAction },
  ): Promise<z.output<typeof nativeUserResponse>>;
}

/** Every typed refusal the Native Auth management routes can answer; each maps to one public problem in app.ts. */
export type NativeAuthRefusal =
  | "scope"
  | "revision"
  | "provider_incomplete"
  | "idempotency"
  | "not_found"
  | "conflict"
  | "launch_unavailable"
  | "provider_unavailable"
  | "origin_unapproved"
  | "paths_invalid"
  | "epoch_exhausted";

export class NativeAuthManagementError extends Error {
  constructor(public readonly code: NativeAuthRefusal) {
    super(code);
  }
}

/**
 * The one closed map from Core and private-runtime refusal codes to typed refusals. Core and runtime errors cross
 * service bindings as plain errors, so they are matched by their exact code or message.
 */
const REFUSALS: Readonly<Record<string, NativeAuthRefusal>> = {
  native_auth_owner_required: "scope",
  native_auth_revision_conflict: "revision",
  native_auth_provider_incomplete: "provider_incomplete",
  native_auth_idempotency_conflict: "idempotency",
  idempotency_key_reused: "idempotency",
  native_auth_launch_unavailable: "launch_unavailable",
  native_auth_provider_unavailable: "provider_unavailable",
  native_auth_origin_unapproved: "origin_unapproved",
  native_auth_paths_invalid: "paths_invalid",
  native_auth_epoch_exhausted: "epoch_exhausted",
  native_user_not_found: "not_found",
  native_user_email_exists: "conflict",
  native_user_not_pending: "conflict",
  native_user_pending: "conflict",
};

/** The typed refusal for a Core or runtime error, or null when the error is not a known refusal. */
export function nativeAuthRefusalFor(error: unknown): NativeAuthManagementError | null {
  if (error instanceof NativeAuthManagementError) return error;
  const code = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  const message = error instanceof Error ? error.message : "";
  for (const key of [code, message]) {
    if (typeof key === "string" && Object.hasOwn(REFUSALS, key))
      return new NativeAuthManagementError(REFUSALS[key] as NativeAuthRefusal);
  }
  return null;
}
