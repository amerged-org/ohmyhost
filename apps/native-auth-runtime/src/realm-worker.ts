import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { isIP } from "node:net";
import type { PreviewRuntimeFence, ProjectPreviewRuntime } from "@ohmyhost/contracts/previews";
import type { Pool } from "pg";
import {
  createNativeAuthRegistry,
  type NativeAuthRegistryAuthority,
  type NativeAuthRegistryReceipt,
  type NativeAuthRegistryRevocation,
  type NativeAuthRegistryDeletion,
} from "./registry.js";
import { createNativeRealmPool } from "./realm-pool.js";
import { nativeCustody, type NativeCustodyBindings } from "./custody.js";
import { isNativeAuthPublicRoute, isNativeAuthRedirectPath } from "@ohmyhost/contracts/native-auth";
import { admitNativeEdgeRequest, type NativeEdgeLimitBindings } from "./edge-rate-limit.js";
import {
  createNativePasswordHandler,
  createNativePasswordMailDispatcher,
} from "./password-handler.js";
import {
  createNativePasswordRateLimiter,
  nativeSessionRateAddress,
  nativeSessionRateIdentity,
} from "./rate-limit.js";
import { createNativeSocialHandler } from "./social-handler.js";
import { boundNativeRequest } from "./request-limits.js";
import {
  applyNativePreviewRealmPolicy,
  createNativePostgresPolicy,
  drainNativePreviewPolicy,
} from "./policy.js";
import type { NativeAuthRealmContext, NativeAuthSession } from "@ohmyhost/contracts/native-auth";
import { NativeAdminOperations, type NativeAdminBindings } from "./worker-main.js";
import { nativeDeadlinePool, nativeRequestDeadline } from "./deadline.js";
import {
  createNativeLatencyProfile,
  endNativeLatency,
  isNativeLatencyRequest,
  nativeCapturedDurations,
  nativeLatencyEnabled,
  startNativeLatency,
  type NativeLatencyEnvelope,
  type NativeLatencyOutcome,
  type NativeLatencyProfile,
  type NativeLatencyRequest,
} from "./latency-profile.js";
import {
  nativePreviewSecret,
  readNativePreviewIdentity,
  type NativePreviewIdentity,
} from "./preview-identity.js";
import {
  resolveProductPreviewAuthority,
  type PreviewNativeAuthorityPorts,
  type ProductPreviewContext,
} from "./preview-product-authority.js";

interface RealmNamespace {
  jurisdiction(region: "us" | "eu"): RealmNamespace;
  getByName(name: string, options: { locationHint: "enam" | "weur" }): NativeAuthEnvironment;
}
export interface RealmBindings extends NativeEdgeLimitBindings, NativeCustodyBindings {
  readonly PREVIEW_HOST_SUFFIX?: "preview.dev.omh.st" | "preview.omh.st";
  readonly PREVIEW_CONTROL?: Pick<ProjectPreviewRuntime, "resolveTokenHash">;
  readonly NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY?: {
    resolve: PreviewNativeAuthorityPorts["resolveNative"];
    resolveDrain(input: PreviewRuntimeFence): Promise<{
      previewId: string;
      runtimeGeneration: number;
      tokenGeneration: number;
      authGeneration: number;
      organizationId: string;
      projectId: string;
      environmentId: string;
      region: "eu" | "us";
      hasRegistration: boolean;
      registration: NativeAuthRegistryReceipt | null;
    } | null>;
    recordDrain(input: PreviewRuntimeFence & { authGeneration: number }): Promise<void>;
  };
  readonly NATIVE_AUTH_PRODUCT_PREVIEW_MAIL?: NonNullable<
    RealmBindings["NATIVE_AUTH_PREVIEW_MAIL"]
  >;
  readonly NATIVE_AUTH_REGION_ID: "us-dev" | "eu-dev";
  readonly NATIVE_AUTH_LATENCY_PROFILE?: string;
  readonly NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE?: string;
  readonly NATIVE_AUTH_QA_PREVIEW_ENABLED?: string;
  readonly NATIVE_AUTH_ENVIRONMENTS: RealmNamespace;
  readonly NATIVE_AUTH_REGISTRY_AUTHORITY: NativeAuthRegistryAuthority;
  readonly NATIVE_AUTH_PREVIEW_AUTHORITY?: {
    resolveForNative(identity: NativePreviewIdentity): Promise<NativePreviewAuthority>;
  };
  readonly NATIVE_AUTH_PREVIEW_MAIL?: {
    sendNativePreviewAuthMail(input: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      previewId: string;
      authGeneration: number;
      kind: "verification" | "password-reset";
      to: string;
      url: string;
      messageId: string;
    }): Promise<{ status: "accepted" | "uncertain" | "rejected" }>;
  };
  readonly NATIVE_AUTH_AUTHORITY: {
    resolve(scope: { projectId: string; environmentId: string; deploymentId?: string }): Promise<{
      organizationId: string;
      deploymentId: string | null;
      realm: NativeAuthRealmContext;
      revocationEpoch: number;
      enabled: boolean;
      sourceCapable: boolean;
      paidAllowed: boolean;
      runtimeAllowed: boolean;
      applicationName: string;
      signupPolicy: "open" | "invite-only";
      allowedRedirectPaths: readonly string[];
      resetPasswordPath: string;
      invitationPath: string;
    }>;
    resolveAtomic?(scope: NativeAuthBoundScope & { organizationHint?: string }): Promise<{
      authority: NativeRealmAuthority & {
        region: "us" | "eu";
        ownerEnabled: boolean;
        storageReady: boolean;
      };
      registration: NativeAuthRegistryReceipt;
    }>;
    recordProviderSuccess(input: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      deploymentId: string;
      provider: "google" | "github";
      configurationRevision: number;
      revocationEpoch: number;
    }): Promise<void>;
  };
  readonly NATIVE_AUTH_MAIL_AUTHORITY: {
    authorizeNativeMail(scope: {
      organizationId: string;
      projectId: string;
      environmentId: string;
    }): Promise<{ canonicalOrigin: string } | null>;
  };
  readonly NATIVE_AUTH_MAIL: {
    sendNativeAuthMail(input: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      kind: "verification" | "password-reset" | "invitation";
      to: string;
      url: string;
      messageId: string;
    }): Promise<{ status: "accepted" | "uncertain" | "rejected" }>;
  };
  readonly NATIVE_AUTH_ADMIN_AUTHORITY: {
    resolveProvider(scope: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      provider: "google" | "github";
    }): Promise<{
      organizationId: string;
      projectId: string;
      environmentId: string;
      provider: "google" | "github";
      configurationRevision: number;
      enabled: boolean;
    } | null>;
  };
  readonly NATIVE_AUTH_PROVIDER_SECRETS?: {
    resolve(input: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      provider: "google" | "github";
      configurationRevision: number;
      deploymentId: string;
    }): Promise<{ clientId: string; clientSecret: string; configurationRevision: number } | null>;
  };
}

export interface NativeAuthClientContext {
  readonly clientAddress: string;
}
export interface NativeAuthBoundScope {
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
}
export type NativeAuthPublicScope = NativeAuthRealmContext & { readonly deploymentId: string };
type NativeRealmAuthority = Awaited<ReturnType<RealmBindings["NATIVE_AUTH_AUTHORITY"]["resolve"]>>;
type NativePreviewAuthority = Omit<NativeRealmAuthority, "deploymentId"> & {
  readonly preview: NativePreviewIdentity;
};
type NativePreviewBoundScope = {
  readonly projectId: string;
  readonly environmentId: string;
  readonly preview: NativePreviewIdentity;
  readonly product?: ProductPreviewContext;
};
type NativeRuntimeBoundScope = NativeAuthBoundScope | NativePreviewBoundScope;
type NativeRuntimePublicScope =
  | NativeAuthPublicScope
  | (NativeAuthRealmContext & NativePreviewBoundScope);
type NativeRuntimeAuthority = NativeRealmAuthority | NativePreviewAuthority;

async function resolvePreviewAuthority(
  env: RealmBindings,
  raw: NativePreviewIdentity,
): Promise<NativePreviewAuthority> {
  const preview = readNativePreviewIdentity(raw);
  if (
    env.NATIVE_AUTH_QA_PREVIEW_ENABLED !== "development-only-v1" ||
    env.NATIVE_AUTH_REGION_ID !== "eu-dev" ||
    !env.NATIVE_AUTH_PREVIEW_AUTHORITY
  )
    throw new Error("auth_unavailable");
  const authority = await env.NATIVE_AUTH_PREVIEW_AUTHORITY.resolveForNative(preview);
  const received = readNativePreviewIdentity(authority?.preview);
  if (
    received.previewId !== preview.previewId ||
    received.authGeneration !== preview.authGeneration ||
    !authority.realm ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(authority.realm.projectId) ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(authority.realm.environmentId) ||
    !new RegExp(`^https://${preview.previewId}-[a-f0-9]{24}\\.preview\\.dev\\.omh\\.st$`, "u").test(
      authority.realm.canonicalOrigin,
    ) ||
    !authority.enabled ||
    !authority.sourceCapable ||
    !authority.paidAllowed ||
    !authority.runtimeAllowed
  )
    throw new Error("auth_unavailable");
  return authority;
}
async function resolveRuntimeAuthority(
  env: RealmBindings,
  scope: NativeRuntimeBoundScope,
): Promise<NativeRuntimeAuthority> {
  if ("preview" in scope) {
    const authority =
      scope.product === undefined
        ? await resolvePreviewAuthority(env, scope.preview)
        : await productPreviewAuthority(
            env,
            scope.product.fence,
            scope.product.publicOrigin,
            scope.product,
          );
    if (
      authority.realm.projectId !== scope.projectId ||
      authority.realm.environmentId !== scope.environmentId ||
      authority.preview.previewId !== scope.preview.previewId ||
      authority.preview.authGeneration !== scope.preview.authGeneration
    )
      throw new Error("auth_unavailable");
    return authority;
  }
  return env.NATIVE_AUTH_AUTHORITY.resolve({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    deploymentId: scope.deploymentId,
  });
}
async function productPreviewAuthority(
  env: RealmBindings,
  fence: PreviewRuntimeFence,
  publicOrigin: string,
  expected?: ProductPreviewContext,
) {
  const control = env.PREVIEW_CONTROL,
    authority = env.NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY,
    hostSuffix = env.PREVIEW_HOST_SUFFIX;
  if (!control || !authority || !hostSuffix) throw new Error("auth_unavailable");
  return resolveProductPreviewAuthority(
    {
      resolveTokenHash: (input) => control.resolveTokenHash(input),
      resolveNative: (input) => authority.resolve(input),
    },
    {
      fence,
      publicOrigin,
      hostSuffix,
      region: env.NATIVE_AUTH_REGION_ID === "eu-dev" ? "eu" : "us",
      ...(expected === undefined ? {} : { expected }),
    },
  );
}
function runtimeIdentityMatches(
  authority: NativeRuntimeAuthority,
  scope: NativeRuntimeBoundScope,
): boolean {
  return "preview" in scope
    ? "preview" in authority &&
        authority.preview.previewId === scope.preview.previewId &&
        authority.preview.authGeneration === scope.preview.authGeneration
    : "deploymentId" in authority && authority.deploymentId === scope.deploymentId;
}
function isQaPreviewRoute(method: string, path: string): boolean {
  return method === "GET"
    ? ["/api/auth/v1/get-session", "/api/auth/v1/verify-email"].includes(path)
    : method === "POST" &&
        [
          "/api/auth/v1/sign-up/email",
          "/api/auth/v1/sign-in/email",
          "/api/auth/v1/sign-out",
        ].includes(path);
}

function atomicEnabled(env: RealmBindings): boolean {
  if (env.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE === undefined) return false;
  if (env.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE !== "v1") throw new Error("auth_unavailable");
  return true;
}
function sameRegistryReceipt(
  a: NativeAuthRegistryReceipt | null,
  b: NativeAuthRegistryReceipt,
): boolean {
  return (
    a !== null &&
    typeof a === "object" &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(b).every((key) => Reflect.get(a, key) === Reflect.get(b, key))
  );
}
function isAtomicCanonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.port === "" &&
      url.hostname.length <= 253 &&
      url.hostname.includes(".") &&
      url.hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))
    );
  } catch {
    return false;
  }
}
async function atomicSnapshot(
  env: RealmBindings,
  scope: NativeAuthBoundScope,
  organizationHint: string,
): Promise<{ authority: NativeRealmAuthority; registration: NativeAuthRegistryReceipt }> {
  if (typeof env.NATIVE_AUTH_AUTHORITY.resolveAtomic !== "function")
    throw new Error("auth_unavailable");
  const value = await env.NATIVE_AUTH_AUTHORITY.resolveAtomic({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    deploymentId: scope.deploymentId,
    organizationHint,
  });
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "authority,registration" ||
    !value.authority ||
    !value.registration
  )
    throw new Error("auth_unavailable");
  const a = value.authority;
  if (
    typeof a !== "object" ||
    Object.keys(a).sort().join(",") !==
      "allowedRedirectPaths,applicationName,deploymentId,enabled,invitationPath,organizationId,ownerEnabled,paidAllowed,realm,region,resetPasswordPath,revocationEpoch,runtimeAllowed,signupPolicy,sourceCapable,storageReady" ||
    (a.region !== "us" && a.region !== "eu") ||
    typeof a.ownerEnabled !== "boolean" ||
    typeof a.storageReady !== "boolean" ||
    a.realm === null ||
    typeof a.realm !== "object" ||
    Object.keys(a.realm).sort().join(",") !==
      "canonicalOrigin,configurationRevision,environmentId,projectId,realmGeneration" ||
    a.realm.projectId !== scope.projectId ||
    a.realm.environmentId !== scope.environmentId ||
    a.deploymentId !== scope.deploymentId ||
    typeof a.organizationId !== "string" ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(a.organizationId) ||
    typeof a.realm.canonicalOrigin !== "string" ||
    !isAtomicCanonicalOrigin(a.realm.canonicalOrigin) ||
    !Number.isSafeInteger(a.realm.configurationRevision) ||
    a.realm.configurationRevision < 1 ||
    a.realm.configurationRevision > 2_147_483_647 ||
    !Number.isSafeInteger(a.realm.realmGeneration) ||
    a.realm.realmGeneration < 1 ||
    a.realm.realmGeneration > 2_147_483_647 ||
    !Number.isSafeInteger(a.revocationEpoch) ||
    a.revocationEpoch !== a.realm.realmGeneration ||
    typeof a.enabled !== "boolean" ||
    typeof a.sourceCapable !== "boolean" ||
    typeof a.paidAllowed !== "boolean" ||
    typeof a.runtimeAllowed !== "boolean" ||
    typeof a.applicationName !== "string" ||
    a.applicationName.length < 1 ||
    a.applicationName.length > 128 ||
    (a.signupPolicy !== "open" && a.signupPolicy !== "invite-only") ||
    !Array.isArray(a.allowedRedirectPaths) ||
    a.allowedRedirectPaths.length < 1 ||
    a.allowedRedirectPaths.length > 32 ||
    !a.allowedRedirectPaths.every(
      (path) => typeof path === "string" && isNativeAuthRedirectPath(path),
    ) ||
    typeof a.resetPasswordPath !== "string" ||
    !isNativeAuthRedirectPath(a.resetPasswordPath) ||
    !a.allowedRedirectPaths.includes(a.resetPasswordPath) ||
    typeof a.invitationPath !== "string" ||
    !isNativeAuthRedirectPath(a.invitationPath) ||
    !a.allowedRedirectPaths.includes(a.invitationPath)
  )
    throw new Error("auth_unavailable");
  return value;
}
/** Private per-realm registry and the single bounded PGCF pool for that realm. */
export class NativeAuthEnvironment extends DurableObject<RealmBindings> {
  #pool: Pool | undefined;
  #registry = createNativeAuthRegistry({
    regionId: this.env.NATIVE_AUTH_REGION_ID,
    keyBase64: this.env.NATIVE_AUTH_CUSTODY_KEY_BASE64,
    keyVersion: this.env.NATIVE_AUTH_CUSTODY_KEY_VERSION,
    ...(this.env.NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON === undefined
      ? {}
      : { additionalKeysJson: this.env.NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON }),
    storage: this.ctx.storage,
    authority: {
      authorizeRegistration: (receipt) =>
        this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.authorizeRegistration(receipt),
      readRegistration: (scope) => this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.readRegistration(scope),
      authorizeRevocation: (value) =>
        this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.authorizeRevocation(value),
      authorizeDeletion: (value) =>
        this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.authorizeDeletion(value),
      authorizeDeletionQuiescence: (value) =>
        this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.authorizeDeletionQuiescence(value),
    },
    invalidate: async () => {
      if (this.#pool) await this.#pool.end();
      this.#pool = undefined;
    },
  });

  public register(
    input: Omit<NativeAuthRegistryReceipt, "status"> & { readonly connectionString: string },
  ) {
    return this.#registry.register(input);
  }
  public revoke(input: NativeAuthRegistryRevocation) {
    return this.#registry.revoke(input);
  }
  public purgeForDeletion(input: NativeAuthRegistryDeletion) {
    return this.#registry.purgeForDeletion(input);
  }
  public quiesceForDeletion(input: NativeAuthRegistryDeletion) {
    return this.#registry.quiesceForDeletion(input);
  }

  public async applyProductPreviewPolicy(
    input: {
      fence: PreviewRuntimeFence;
      authGeneration: number;
      revocationEpoch: number;
      configurationRevision: number;
    },
    deadlineAt?: number,
  ): Promise<{ outcome: "applied" }> {
    const deadline = nativeRequestDeadline(deadlineAt);
    const service = this.env.NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY;
    if (!service) throw new Error("auth_unavailable");
    const check = async () => {
      const snapshot = await service.resolve(input.fence);
      if (
        !snapshot ||
        !snapshot.launchAllowed ||
        !snapshot.registration ||
        snapshot.preview.previewId !== input.fence.previewId ||
        snapshot.preview.runtimeGeneration !== input.fence.runtimeGeneration ||
        snapshot.preview.tokenGeneration !== input.fence.tokenGeneration ||
        snapshot.preview.authGeneration !== input.authGeneration ||
        snapshot.authority.revocationEpoch !== input.revocationEpoch ||
        snapshot.authority.realm.configurationRevision !== input.configurationRevision ||
        !snapshot.authority.ownerEnabled ||
        !snapshot.authority.storageReady ||
        !snapshot.authority.paidAllowed ||
        !snapshot.authority.runtimeAllowed
      )
        throw new Error("auth_unavailable");
      return snapshot;
    };
    const current = await deadline.run(check);
    const ids = {
      projectId: current.preview.projectId,
      environmentId: current.preview.environmentId,
    };
    const registration = await this.#registry.resolve(ids, deadline.at);
    if (
      registration.receipt.organizationId !== current.preview.organizationId ||
      !sameRegistryReceipt(current.registration as NativeAuthRegistryReceipt, registration.receipt)
    )
      throw new Error("auth_unavailable");
    const pool = (this.#pool ??= createNativeRealmPool(registration, ids));
    if (
      !(await deadline.run(() =>
        applyNativePreviewRealmPolicy(nativeDeadlinePool(pool, deadline), {
          previewId: input.fence.previewId,
          authGeneration: input.authGeneration,
          revocationEpoch: input.revocationEpoch,
          configurationRevision: input.configurationRevision,
        }),
      ))
    )
      throw new Error("auth_unavailable");
    const after = await deadline.run(check);
    if (!sameRegistryReceipt(after.registration as NativeAuthRegistryReceipt, registration.receipt))
      throw new Error("auth_unavailable");
    return { outcome: "applied" };
  }

  public async drainProductPreview(
    input: {
      fence: PreviewRuntimeFence;
      authGeneration: number;
      organizationId: string;
      projectId: string;
      environmentId: string;
    },
    deadlineAt?: number,
  ): Promise<void> {
    const deadline = nativeRequestDeadline(deadlineAt);
    const service = this.env.NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY;
    if (!service) throw new Error("auth_unavailable");
    const check = async () => {
      const state = await service.resolveDrain(input.fence);
      if (
        !state ||
        !state.hasRegistration ||
        state.authGeneration !== input.authGeneration ||
        state.organizationId !== input.organizationId ||
        state.projectId !== input.projectId ||
        state.environmentId !== input.environmentId
      )
        throw new Error("auth_unavailable");
      return state;
    };
    const initial = await deadline.run(check);
    if (!initial.registration) throw new Error("auth_unavailable");
    const ids = { projectId: input.projectId, environmentId: input.environmentId };
    const registration = await this.#registry.resolve(
      ids,
      deadline.at,
      async (receipt) => {
        if (!sameRegistryReceipt(initial.registration, receipt))
          throw new Error("auth_unavailable");
      },
      async (receipt) => {
        const current = await check();
        return sameRegistryReceipt(current.registration, receipt) ? current.registration : null;
      },
    );
    if (registration.receipt.organizationId !== input.organizationId)
      throw new Error("auth_unavailable");
    if (!this.#pool) this.#pool = createNativeRealmPool(registration, ids);
    const client = await nativeDeadlinePool(this.#pool, deadline).connect();
    try {
      await client.query("begin");
      await drainNativePreviewPolicy(client, {
        previewId: input.fence.previewId,
        authGeneration: input.authGeneration,
      });
      const after = await deadline.run(check);
      if (!sameRegistryReceipt(after.registration, registration.receipt))
        throw new Error("auth_unavailable");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async #admin(
    scope: {
      readonly organizationId: string;
      readonly projectId: string;
      readonly environmentId: string;
    },
    deadlineAt?: number,
  ) {
    const deadline = nativeRequestDeadline(deadlineAt);
    const ids = { projectId: scope.projectId, environmentId: scope.environmentId };
    const registration = await this.#registry.resolve(ids, deadline.at);
    if (registration.receipt.organizationId !== scope.organizationId)
      throw new Error("auth_unavailable");
    if (!this.#pool) this.#pool = createNativeRealmPool(registration, ids);
    const registrationCurrent = async () => {
      const current = await deadline.run(() =>
        this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.readRegistration(ids),
      );
      return (
        current !== null &&
        Object.keys(current).length === Object.keys(registration.receipt).length &&
        Object.keys(registration.receipt).every(
          (key) => Reflect.get(current, key) === Reflect.get(registration.receipt, key),
        )
      );
    };
    return new NativeAdminOperations(
      this.env as NativeAdminBindings,
      this.#pool,
      registration,
      registrationCurrent,
      deadline,
    );
  }
  public async listUsers(
    input: Parameters<NativeAdminOperations["listUsers"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).listUsers(input);
  }
  public async getUser(
    input: Parameters<NativeAdminOperations["getUser"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).getUser(input);
  }
  public async mutateUser(
    input: Parameters<NativeAdminOperations["mutateUser"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).mutateUser(input);
  }
  public async deliverInvitation(
    input: Parameters<NativeAdminOperations["deliverInvitation"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).deliverInvitation(input);
  }
  public async sanitizeRestore(
    input: Parameters<NativeAdminOperations["sanitizeRestore"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).sanitizeRestore(input);
  }
  public async applyRealmPolicy(
    input: Parameters<NativeAdminOperations["applyRealmPolicy"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).applyRealmPolicy(input);
  }
  public async applyProviderPolicy(
    input: Parameters<NativeAdminOperations["applyProviderPolicy"]>[0],
    deadlineAt?: number,
  ) {
    return (await this.#admin(input, deadlineAt)).applyProviderPolicy(input);
  }
  public async fetchPublic(
    request: Request,
    scope: NativeAuthPublicScope,
    client: NativeAuthClientContext,
    deadlineAt?: number,
  ): Promise<Response> {
    return this.#fetchPublic(request, scope, client, deadlineAt);
  }

  public async fetchStablePreview(
    request: Request,
    scope: NativeAuthRealmContext & NativePreviewBoundScope,
    client: NativeAuthClientContext,
    deadlineAt?: number,
  ): Promise<Response> {
    if (
      !(scope.product
        ? isNativeAuthPublicRoute(request.method, new URL(request.url).pathname)
        : isQaPreviewRoute(request.method, new URL(request.url).pathname))
    )
      return new Response(null, { status: 404 });
    return this.#fetchPublic(request, scope, client, deadlineAt);
  }

  /** The initial snapshot is accepted only from this realm's bound session entrypoint. */
  async #fetchPublic(
    request: Request,
    scope: NativeRuntimePublicScope,
    client: NativeAuthClientContext,
    deadlineAt?: number,
    initialAuthority?: NativeRuntimeAuthority,
    internalSession = false,
    latency?: NativeLatencyProfile,
    initialRegistration?: Awaited<
      ReturnType<ReturnType<typeof createNativeAuthRegistry>["resolve"]>
    >,
    useAtomic = false,
  ): Promise<Response> {
    const deadline = nativeRequestDeadline(deadlineAt);
    const ids = { projectId: scope.projectId, environmentId: scope.environmentId };
    const authority =
      initialAuthority ?? (await deadline.run(() => resolveRuntimeAuthority(this.env, scope)));
    if (
      !authority.enabled ||
      !authority.sourceCapable ||
      !authority.paidAllowed ||
      !authority.runtimeAllowed ||
      !runtimeIdentityMatches(authority, scope) ||
      authority.realm.canonicalOrigin !== scope.canonicalOrigin ||
      new URL(request.url).origin !== authority.realm.canonicalOrigin
    )
      throw new Error("auth_unavailable");
    const registryStarted = startNativeLatency(latency);
    let registration;
    try {
      registration = initialRegistration ?? (await this.#registry.resolve(ids, deadline.at));
    } finally {
      endNativeLatency(latency, "registryMs", registryStarted);
    }
    if (registration.receipt.organizationId !== authority.organizationId)
      throw new Error("auth_unavailable");
    const poolStarted = startNativeLatency(latency);
    try {
      if (!this.#pool) this.#pool = createNativeRealmPool(registration, ids);
    } finally {
      endNativeLatency(latency, "poolInitMs", poolStarted);
    }
    const pool = nativeDeadlinePool(this.#pool, deadline);
    const privateScope = { organizationId: authority.organizationId, ...ids };
    const previewPolicy = "preview" in scope && scope.product ? scope.preview : undefined;
    let authorityChecks = 0;
    const currentAuthority = async () => {
      // Read Core's authoritative receipt directly while the SQL transaction holds a pool
      // client. Calling the serialized registry here would deadlock a concurrent rotation
      // that is waiting for this pool to drain before acknowledging its new generation.
      const entryCheck = authorityChecks++ === 0;
      let live: NativeRuntimeAuthority;
      if (useAtomic && !("preview" in scope)) {
        const liveStarted = startNativeLatency(latency);
        let snapshot;
        try {
          snapshot = await deadline.run(() =>
            atomicSnapshot(this.env, scope, registration.receipt.organizationId),
          );
        } finally {
          endNativeLatency(
            latency,
            entryCheck ? "entryAuthorityMs" : "commitAuthorityMs",
            liveStarted,
          );
        }
        if (!sameRegistryReceipt(snapshot.registration, registration.receipt)) return null;
        live = snapshot.authority;
      } else {
        const registrationStarted = startNativeLatency(latency);
        let currentRegistration;
        try {
          currentRegistration = await deadline.run(() =>
            this.env.NATIVE_AUTH_REGISTRY_AUTHORITY.readRegistration(ids),
          );
        } finally {
          endNativeLatency(
            latency,
            entryCheck ? "entryRegistryMs" : "commitRegistryMs",
            registrationStarted,
          );
        }
        if (
          !currentRegistration ||
          Object.keys(registration.receipt).length !== Object.keys(currentRegistration).length ||
          Object.keys(registration.receipt).some(
            (key) =>
              Reflect.get(registration.receipt, key) !== Reflect.get(currentRegistration, key),
          )
        )
          return null;
        const liveStarted = startNativeLatency(latency);
        let legacyLive;
        try {
          legacyLive = await deadline.run(() => resolveRuntimeAuthority(this.env, scope));
        } finally {
          endNativeLatency(
            latency,
            entryCheck ? "entryAuthorityMs" : "commitAuthorityMs",
            liveStarted,
          );
        }
        live = legacyLive;
      }
      if (
        live.organizationId !== authority.organizationId ||
        !runtimeIdentityMatches(live, scope) ||
        live.realm.canonicalOrigin !== authority.realm.canonicalOrigin ||
        !live.sourceCapable ||
        !live.paidAllowed ||
        !live.runtimeAllowed
      )
        return null;
      return {
        enabled: live.enabled,
        revocationEpoch: live.revocationEpoch,
        configurationRevision: live.realm.configurationRevision,
        signupMode: live.signupPolicy,
      };
    };
    const cipher = nativeCustody(this.env);
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: registration.secret,
      trustedClientIdentity: async (incoming) =>
        internalSession ? nativeSessionRateIdentity(incoming) : client.clientAddress,
      ...(latency === undefined ? {} : { latency }),
    });
    const engineSecret =
      "preview" in scope
        ? nativePreviewSecret(registration.secret, scope.preview)
        : registration.secret;
    if (new URL(request.url).pathname === "/api/auth/v1/accept-invitation") {
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== authority.realm.canonicalOrigin ||
        !request.headers.get("content-type")?.includes("application/json")
      )
        return new Response(null, { status: 400 });
      const requestId = request.headers.get("idempotency-key");
      if (!requestId || requestId.length > 200) return new Response(null, { status: 400 });
      if (!(await limiter.admitAttempt(request))) return new Response(null, { status: 429 });
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return new Response(null, { status: 400 });
      const value = body as Record<string, unknown>;
      if (
        Object.keys(value).some((key) => !["token", "password", "name"].includes(key)) ||
        typeof value["token"] !== "string" ||
        typeof value["password"] !== "string" ||
        (value["name"] !== undefined && typeof value["name"] !== "string")
      )
        return new Response(null, { status: 400 });
      const policy = createNativePostgresPolicy(
        pool,
        { currentAuthority },
        registration.secret,
        previewPolicy,
      );
      const accepted = await policy.acceptInvitation({
        requestId,
        token: value["token"],
        password: value["password"],
        ...(typeof value["name"] === "string" ? { name: value["name"] } : {}),
      });
      return accepted ? Response.json({ status: "accepted" }) : new Response(null, { status: 400 });
    }
    const dispatch = createNativePasswordMailDispatcher({
      pool,
      currentAuthority,
      ...(previewPolicy === undefined ? {} : { previewPolicy }),
      send: async ({ messageId, sealedPayload }) => {
        const envelope = JSON.parse(new TextDecoder().decode(sealedPayload)) as {
          name: string;
          keyVersion: number;
          ciphertext: number[];
          nonce: number[];
          valueSha256: number[];
        };
        if (envelope.name !== `NATIVE_AUTH_MAIL_${messageId.replaceAll("-", "").toUpperCase()}`)
          throw new Error("auth_unavailable");
        const value = await cipher.decrypt({
          ...privateScope,
          name: envelope.name,
          keyVersion: envelope.keyVersion,
          ciphertext: Uint8Array.from(envelope.ciphertext),
          nonce: Uint8Array.from(envelope.nonce),
          valueSha256: Uint8Array.from(envelope.valueSha256),
        });
        const message = JSON.parse(value) as {
          kind: "verification" | "password-reset";
          to: string;
          url: string;
          token: string;
          messageId: string;
        };
        if (
          message.messageId !== messageId ||
          (message.kind !== "verification" && message.kind !== "password-reset")
        )
          throw new Error("auth_unavailable");
        const delivered = await deadline.run(() =>
          "preview" in scope
            ? ((scope.product
                ? this.env.NATIVE_AUTH_PRODUCT_PREVIEW_MAIL
                : this.env.NATIVE_AUTH_PREVIEW_MAIL
              )?.sendNativePreviewAuthMail({
                ...privateScope,
                ...scope.preview,
                kind: message.kind,
                to: message.to,
                url: message.url,
                messageId,
              }) ?? Promise.reject(new Error("auth_unavailable")))
            : this.env.NATIVE_AUTH_MAIL.sendNativeAuthMail({
                ...privateScope,
                kind: message.kind,
                to: message.to,
                url: message.url,
                messageId,
              }),
        );
        if (delivered.status !== "accepted") throw new Error("auth_unavailable");
      },
    });
    const provider = async (id: "google" | "github") => {
      if ("preview" in scope) return null;
      const status = await deadline.run(() =>
        this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolveProvider({
          ...privateScope,
          provider: id,
        }),
      );
      if (
        !status ||
        status.organizationId !== privateScope.organizationId ||
        status.projectId !== ids.projectId ||
        status.environmentId !== ids.environmentId ||
        status.provider !== id ||
        status.configurationRevision !== authority.realm.configurationRevision ||
        !status.enabled
      )
        return null;
      const resolver = this.env.NATIVE_AUTH_PROVIDER_SECRETS;
      if (!resolver) return null;
      const credentials = await deadline.run(() =>
        resolver.resolve({
          ...privateScope,
          provider: id,
          configurationRevision: authority.realm.configurationRevision,
          deploymentId: scope.deploymentId,
        }),
      );
      if (
        !credentials ||
        credentials.configurationRevision !== authority.realm.configurationRevision
      )
        return null;
      return {
        enabled: true,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        configurationRevision: credentials.configurationRevision,
      };
    };
    const mailPorts = {
      sealMail: async (message: {
        messageId: string;
        kind: "verification" | "password-reset";
        to: string;
        url: string;
        token: string;
      }) => {
        const ready = await deadline.run(() =>
          this.env.NATIVE_AUTH_MAIL_AUTHORITY.authorizeNativeMail(privateScope),
        );
        if (
          !ready ||
          (!("preview" in scope) && ready.canonicalOrigin !== authority.realm.canonicalOrigin)
        )
          throw new Error("auth_unavailable");
        const name = `NATIVE_AUTH_MAIL_${message.messageId.replaceAll("-", "").toUpperCase()}`;
        const encrypted = await cipher.encrypt({
          ...privateScope,
          name,
          value: JSON.stringify(message),
        });
        return new TextEncoder().encode(
          JSON.stringify({
            name,
            keyVersion: encrypted.keyVersion,
            ciphertext: Array.from(encrypted.ciphertext),
            nonce: Array.from(encrypted.nonce),
            valueSha256: Array.from(encrypted.valueSha256),
          }),
        );
      },
      deliverMail: async (idsToSend: readonly string[]) => {
        for (const id of idsToSend)
          if (!(await dispatch.dispatchOne(id))) throw new Error("auth_unavailable");
      },
    };
    let social = [
      "/api/auth/v1/sign-in/social",
      "/api/auth/v1/link-social",
      "/api/auth/v1/callback/google",
      "/api/auth/v1/callback/github",
    ].includes(new URL(request.url).pathname);
    if (
      new URL(request.url).pathname === "/api/auth/v1/reauthenticate" &&
      request.method === "POST"
    ) {
      try {
        const body: unknown = await request.clone().json();
        social = !!body && typeof body === "object" && !Array.isArray(body) && "provider" in body;
      } catch {
        return new Response(null, { status: 400 });
      }
    }
    if (social) {
      if ("preview" in scope) throw new Error("auth_unavailable");
      return createNativeSocialHandler({
        pool,
        deadlineAt: deadline.at,
        canonicalOrigin: authority.realm.canonicalOrigin,
        applicationName: authority.applicationName,
        secret: engineSecret,
        allowedRedirectPaths: authority.allowedRedirectPaths,
        resetPasswordPath: authority.resetPasswordPath,
        ports: {
          currentAuthority,
          provider,
          admitAttempt: (incoming) => limiter.admitAttempt(incoming),
          recordProviderSuccess: async (outcome) => {
            const live = await currentAuthority();
            if (
              !live?.enabled ||
              live.revocationEpoch !== outcome.revocationEpoch ||
              live.configurationRevision !== outcome.configurationRevision
            )
              throw new Error("auth_unavailable");
            await deadline.run(() =>
              this.env.NATIVE_AUTH_AUTHORITY.recordProviderSuccess({
                ...privateScope,
                deploymentId: scope.deploymentId,
                provider: outcome.provider,
                configurationRevision: outcome.configurationRevision,
                revocationEpoch: outcome.revocationEpoch,
              }),
            );
          },
          ...mailPorts,
        },
      }).handle(request);
    }
    const handler = createNativePasswordHandler({
      pool,
      deadlineAt: deadline.at,
      ...(latency === undefined ? {} : { latency }),
      canonicalOrigin: authority.realm.canonicalOrigin,
      applicationName: authority.applicationName,
      secret: engineSecret,
      ...(previewPolicy === undefined ? {} : { previewPolicy }),
      ...("preview" in scope ? { previewId: scope.preview.previewId } : {}),
      allowedRedirectPaths: authority.allowedRedirectPaths,
      resetPasswordPath: authority.resetPasswordPath,
      ports: {
        currentAuthority,
        admitAttempt: (incoming) => limiter.admitAttempt(incoming),
        isProviderUsable: async (id) => (await provider(id)) !== null,
        ...mailPorts,
      },
    });
    return handler.handle(request, internalSession);
  }

  public validateSession(
    scope: NativeAuthBoundScope,
    cookie: string,
    deadlineAt?: number,
  ): Promise<NativeAuthSession | null>;
  public validateSession(
    scope: NativeAuthBoundScope,
    cookie: string,
    deadlineAt: number | undefined,
    diagnostic: NativeLatencyRequest,
  ): Promise<NativeAuthSession | NativeLatencyEnvelope | null>;
  public async validateSession(
    scope: NativeAuthBoundScope,
    cookie: string,
    deadlineAt?: number,
    diagnostic?: NativeLatencyRequest,
  ): Promise<NativeAuthSession | NativeLatencyEnvelope | null> {
    const deadline = nativeRequestDeadline(deadlineAt);
    let requested = false;
    try {
      requested =
        isNativeLatencyRequest(diagnostic) &&
        nativeLatencyEnabled(this.env.NATIVE_AUTH_LATENCY_PROFILE, scope);
    } catch {
      // Diagnostics must never change authentication behavior.
    }
    if (!requested) return this.#validateSession(scope, cookie, deadline);

    let captured: unknown = null;
    let latency: NativeLatencyProfile | undefined;
    try {
      latency = createNativeLatencyProfile({
        emit: (record) => {
          try {
            captured = JSON.parse(record) as unknown;
          } catch {
            // A diagnostic capture is optional and is never an authentication result.
          }
        },
      });
    } catch {
      // Diagnostics must never change authentication behavior.
    }
    let outcome: NativeLatencyOutcome = "unavailable";
    let session: NativeAuthSession | null = null;
    try {
      session = await this.#validateSession(scope, cookie, deadline, latency);
      outcome = session === null ? "absent" : "active";
    } catch {
      // Return only a fixed status over the private RPC, never the exception or its contents.
      outcome = "unavailable";
    } finally {
      try {
        latency?.finish(outcome);
      } catch {
        // Diagnostics must never change authentication behavior.
      }
    }
    return {
      kind: "native_private_session_v2",
      status: outcome,
      session,
      profile: nativeCapturedDurations(captured, outcome),
    };
  }

  public validateStablePreviewSession(
    scope: NativePreviewBoundScope,
    cookie: string,
    deadlineAt?: number,
  ) {
    return this.#validateSession(scope, cookie, nativeRequestDeadline(deadlineAt));
  }

  async #validateSession(
    scope: NativeRuntimeBoundScope,
    cookie: string,
    deadline: ReturnType<typeof nativeRequestDeadline>,
    latency?: NativeLatencyProfile,
  ): Promise<NativeAuthSession | null> {
    if (typeof cookie !== "string" || cookie.length > 16384) throw new Error("auth_unavailable");
    // Without the native session token there is nothing to check: refuse before any authority or limiter work.
    // The prefix is the one the engine emits (__Secure- today, __Host- after the cookie change); a bare name is accepted too.
    const sessionCookie =
      "preview" in scope
        ? new RegExp(
            `(?:^|;\\s*)__Host-omh_native_preview_${readNativePreviewIdentity(scope.preview).previewId}\\.session_token=`,
            "u",
          )
        : /(?:^|;\s*)(?:__Host-|__Secure-)?omh_native\.session_token=/u;
    if (!sessionCookie.test(cookie)) return null;

    const useAtomic = !("preview" in scope) && atomicEnabled(this.env);
    const authorityStarted = startNativeLatency(latency);
    let authority: NativeRuntimeAuthority;
    let initialRegistration:
      | Awaited<ReturnType<ReturnType<typeof createNativeAuthRegistry>["resolve"]>>
      | undefined;
    try {
      if (useAtomic && !("preview" in scope)) {
        initialRegistration = await this.#registry.resolve(
          { projectId: scope.projectId, environmentId: scope.environmentId },
          deadline.at,
          async (receipt) => {
            const snapshot = await atomicSnapshot(this.env, scope, receipt.organizationId);
            const current = snapshot.authority;
            if (
              !sameRegistryReceipt(snapshot.registration, receipt) ||
              current.organizationId !== receipt.organizationId ||
              !current.enabled ||
              !current.sourceCapable ||
              !current.paidAllowed ||
              !current.runtimeAllowed ||
              current.deploymentId !== scope.deploymentId ||
              !current.realm?.canonicalOrigin
            )
              throw new Error("auth_unavailable");
            return current;
          },
          async (receipt) =>
            (await atomicSnapshot(this.env, scope, receipt.organizationId)).registration,
        );
        authority = initialRegistration.initialSnapshot as NativeRealmAuthority;
      } else {
        authority = await deadline.run(() => resolveRuntimeAuthority(this.env, scope));
      }
    } finally {
      endNativeLatency(latency, "initialAuthorityMs", authorityStarted);
    }
    if (!runtimeIdentityMatches(authority, scope)) throw new Error("auth_unavailable");
    const response = await this.#fetchPublic(
      new Request(
        `${authority.realm.canonicalOrigin}/api/auth/v1/get-session?disableRefresh=true`,
        { headers: { cookie, "cf-connecting-ip": nativeSessionRateAddress(cookie) } },
      ),
      { ...authority.realm, ...scope },
      { clientAddress: "private-server" },
      deadline.at,
      authority,
      true,
      latency,
      initialRegistration,
      useAtomic,
    );
    if (!response.ok) throw new Error("auth_unavailable");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const user = record["user"] as Record<string, unknown> | null;
    const session = record["session"] as Record<string, unknown> | null;
    if (
      !user ||
      !session ||
      typeof user["id"] !== "string" ||
      typeof user["email"] !== "string" ||
      typeof session["id"] !== "string" ||
      typeof session["expiresAt"] !== "string"
    )
      throw new Error("auth_unavailable");
    return {
      user: { id: user["id"], email: user["email"] },
      session: { id: session["id"], expiresAt: session["expiresAt"] },
    };
  }
}

export function realm(
  env: RealmBindings,
  scope: { readonly projectId: string; readonly environmentId: string },
) {
  const european = env.NATIVE_AUTH_REGION_ID === "eu-dev";
  return env.NATIVE_AUTH_ENVIRONMENTS.jurisdiction(european ? "eu" : "us").getByName(
    `${scope.projectId}:${scope.environmentId}`,
    { locationHint: european ? "weur" : "enam" },
  );
}

/** Registration is a private management capability, never bound to an application. */
export class NativeRegistryAdminService extends WorkerEntrypoint<RealmBindings> {
  public register(
    input: Omit<NativeAuthRegistryReceipt, "status"> & { readonly connectionString: string },
  ) {
    return realm(this.env, input).register(input);
  }
  public revoke(input: NativeAuthRegistryRevocation) {
    return realm(this.env, input.receipt).revoke(input);
  }
  public purgeForDeletion(input: NativeAuthRegistryDeletion) {
    return realm(this.env, input).purgeForDeletion(input);
  }
  public quiesceForDeletion(input: NativeAuthRegistryDeletion) {
    return realm(this.env, input).quiesceForDeletion(input);
  }
}

/** Only the trusted gateway receives this entrypoint and supplies the edge client address. */
export class NativePublicService extends WorkerEntrypoint<RealmBindings> {
  public async fetchPublic(
    request: Request,
    scope: NativeAuthPublicScope,
    client: NativeAuthClientContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(scope.deploymentId))
      return Response.json(
        { error: "auth_unavailable" },
        { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
      );
    if (!isNativeAuthPublicRoute(request.method, url.pathname))
      return new Response(null, {
        status: 404,
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const deadlineAt = Date.now() + 15000;
    try {
      const response = await Promise.race([
        (async () => {
          if (
            !(await admitNativeEdgeRequest({
              bindings: this.env,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              method: request.method,
              path: url.pathname,
              clientAddress: client.clientAddress,
            }))
          )
            return new Response(null, { status: 429 });
          const bounded = await boundNativeRequest(request, controller.signal);
          if (bounded instanceof Response) return bounded;
          return realm(this.env, scope).fetchPublic(bounded, scope, client, deadlineAt);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("auth_unavailable"));
          }, 15000);
        }),
      ]);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return Response.json(
        { error: "auth_unavailable" },
        { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Development-only private entrypoint; neither browser headers nor the guest select a realm. */
export class NativePreviewService extends WorkerEntrypoint<RealmBindings> {
  public async fetchStablePreview(
    request: Request,
    raw: NativePreviewIdentity,
    client: NativeAuthClientContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!isQaPreviewRoute(request.method, url.pathname)) return new Response(null, { status: 404 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) throw new Error("auth_unavailable");
      const deadlineAt = Date.now() + 15000;
      const response = await Promise.race([
        (async () => {
          const preview = readNativePreviewIdentity(raw);
          const authority = await resolvePreviewAuthority(this.env, preview);
          if (url.origin !== authority.realm.canonicalOrigin || request.signal.aborted)
            throw new Error("auth_unavailable");
          const scope = { ...authority.realm, preview };
          if (
            !(await admitNativeEdgeRequest({
              bindings: this.env,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
              method: request.method,
              path: url.pathname,
              clientAddress: client.clientAddress,
            }))
          )
            return new Response(null, { status: 429 });
          const bounded = await boundNativeRequest(request, controller.signal);
          if (bounded instanceof Response) return bounded;
          if (request.signal.aborted) throw new Error("auth_unavailable");
          return realm(this.env, scope).fetchStablePreview(bounded, scope, client, deadlineAt);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("auth_unavailable"));
          }, 15000);
        }),
      ]);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return Response.json(
        { error: "auth_unavailable" },
        { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
      );
    } finally {
      request.signal.removeEventListener("abort", abort);
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async validateStablePreviewSession(
    raw: NativePreviewIdentity,
    cookie: string,
  ): Promise<NativeAuthSession | null> {
    const preview = readNativePreviewIdentity(raw);
    if (typeof cookie !== "string" || cookie.length > 16384) throw new Error("auth_unavailable");
    const deadline = nativeRequestDeadline();
    const authority = await deadline.run(() => resolvePreviewAuthority(this.env, preview));
    const scope = {
      projectId: authority.realm.projectId,
      environmentId: authority.realm.environmentId,
      preview,
    };
    return deadline.run(() =>
      realm(this.env, scope).validateStablePreviewSession(scope, cookie, deadline.at),
    );
  }
}

/** Product-only private entrypoint. The runtime chooses the scope and verifies its source plan. */
export class NativeProductPreviewService extends WorkerEntrypoint<RealmBindings> {
  public async drainPreview(input: { readonly fence: PreviewRuntimeFence }): Promise<void> {
    const service = this.env.NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY;
    if (!service) throw new Error("auth_unavailable");
    const deadline = nativeRequestDeadline();
    const state = await deadline.run(() => service.resolveDrain(input.fence));
    if (
      !state ||
      state.previewId !== input.fence.previewId ||
      state.runtimeGeneration !== input.fence.runtimeGeneration ||
      state.tokenGeneration !== input.fence.tokenGeneration ||
      state.region !== (this.env.NATIVE_AUTH_REGION_ID === "eu-dev" ? "eu" : "us")
    )
      throw new Error("auth_unavailable");
    if (!state.hasRegistration) return;
    await deadline.run(() =>
      realm(this.env, state).drainProductPreview(
        {
          fence: input.fence,
          authGeneration: state.authGeneration,
          organizationId: state.organizationId,
          projectId: state.projectId,
          environmentId: state.environmentId,
        },
        deadline.at,
      ),
    );
    await deadline.run(() =>
      service.recordDrain({ ...input.fence, authGeneration: state.authGeneration }),
    );
  }

  public async fetchPreview(
    request: Request,
    input: {
      readonly fence: PreviewRuntimeFence;
      readonly publicOrigin: string;
      readonly clientAddress: string;
    },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (!isNativeAuthPublicRoute(request.method, url.pathname))
      return new Response(null, { status: 404 });
    const deadline = nativeRequestDeadline();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (
        request.signal.aborted ||
        isIP(input.clientAddress) === 0 ||
        url.origin !== input.publicOrigin
      )
        throw new Error("auth_unavailable");
      const authority = await deadline.run(() =>
        productPreviewAuthority(this.env, input.fence, input.publicOrigin),
      );
      const scope = { ...authority.realm, preview: authority.preview, product: authority.product };
      if (
        !(await deadline.run(() =>
          admitNativeEdgeRequest({
            bindings: this.env,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            method: request.method,
            path: url.pathname,
            clientAddress: input.clientAddress,
          }),
        ))
      )
        return new Response(null, { status: 429 });
      const bounded = await deadline.run(
        () => boundNativeRequest(request, controller.signal),
        abort,
      );
      if (bounded instanceof Response) return bounded;
      const response = await deadline.run(
        () =>
          realm(this.env, scope).fetchStablePreview(
            bounded,
            scope,
            { clientAddress: input.clientAddress },
            deadline.at,
          ),
        abort,
      );
      await deadline.run(() =>
        productPreviewAuthority(this.env, input.fence, input.publicOrigin, authority.product),
      );
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return Response.json(
        { error: "auth_unavailable" },
        { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
      );
    } finally {
      request.signal.removeEventListener("abort", abort);
    }
  }

  public async validatePreviewSession(input: {
    readonly fence: PreviewRuntimeFence;
    readonly publicOrigin: string;
    readonly cookie: string;
  }): Promise<NativeAuthSession | null> {
    if (typeof input.cookie !== "string" || input.cookie.length > 16384)
      throw new Error("auth_unavailable");
    const deadline = nativeRequestDeadline();
    const authority = await deadline.run(() =>
      productPreviewAuthority(this.env, input.fence, input.publicOrigin),
    );
    const scope = {
      projectId: authority.realm.projectId,
      environmentId: authority.realm.environmentId,
      preview: authority.preview,
      product: authority.product,
    };
    const session = await deadline.run(() =>
      realm(this.env, scope).validateStablePreviewSession(scope, input.cookie, deadline.at),
    );
    await deadline.run(() =>
      productPreviewAuthority(this.env, input.fence, input.publicOrigin, authority.product),
    );
    return session;
  }
}

/** The provisioner alone can project a Core-authorized Native preview policy. */
export class NativeProductPreviewPolicyService extends WorkerEntrypoint<RealmBindings> {
  public async applyPreviewRealmPolicy(input: {
    readonly fence: PreviewRuntimeFence;
    readonly authGeneration: number;
    readonly revocationEpoch: number;
    readonly configurationRevision: number;
  }): Promise<{ outcome: "applied" }> {
    const service = this.env.NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY;
    if (!service) throw new Error("auth_unavailable");
    const deadline = nativeRequestDeadline();
    const state = await deadline.run(() => service.resolve(input.fence));
    if (
      !state ||
      state.preview.authGeneration !== input.authGeneration ||
      state.preview.region !== (this.env.NATIVE_AUTH_REGION_ID === "eu-dev" ? "eu" : "us")
    )
      throw new Error("auth_unavailable");
    return deadline.run(() =>
      realm(this.env, state.preview).applyProductPreviewPolicy(input, deadline.at),
    );
  }
}
