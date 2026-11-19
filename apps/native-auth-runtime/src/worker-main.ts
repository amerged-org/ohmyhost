import { WorkerEntrypoint } from "cloudflare:workers";
import { Pool } from "pg";
import type { NativeRealmRegistration } from "./realm-pool.js";
import { nativeCustody } from "./custody.js";
import { type NativeAuthAuthority, type NativeAuthDeploymentScope } from "./boundary.js";
import { applyNativeRealmPolicy } from "./policy.js";
import { sanitizeRestoredNativeRealm, type NativeRestoreAuthority } from "./restore.js";
import {
  createNativeUserManagement,
  createNativeInvitationDispatcher,
  type NativeUserMutation,
} from "./user-management.js";
import { isNativeAuthRedirectPath } from "@ohmyhost/contracts/native-auth";
import { realm, type RealmBindings, type NativeAuthBoundScope } from "./realm-worker.js";
import { nativeLatencyEnabled, unwrapNativeLatencySession } from "./latency-profile.js";
import {
  nativeDeadlinePool,
  nativeRequestDeadline,
  type NativeRequestDeadline,
} from "./deadline.js";
export {
  NativeAuthEnvironment,
  NativeRegistryAdminService,
  NativePublicService,
  NativePreviewService,
  NativeProductPreviewService,
  NativeProductPreviewPolicyService,
} from "./realm-worker.js";

interface NativeAdminScope extends NativeAuthDeploymentScope {
  readonly organizationId: string;
}
export interface NativeAdminBindings extends RealmBindings {
  readonly NATIVE_AUTH_ADMIN_AUTHORITY: {
    resolve(scope: NativeAdminScope): Promise<
      Omit<NativeAuthAuthority, "realm"> & {
        readonly organizationId: string;
        readonly ownerEnabled: boolean;
        readonly invitationPath: string;
        readonly allowedRedirectPaths: readonly string[];
        readonly realm: Omit<NativeAuthAuthority["realm"], "canonicalOrigin"> & {
          readonly canonicalOrigin: string | null;
        };
      }
    >;
    authorizeOwnerOperation(
      input: NativeControlContext & { readonly intent: "users-list" | "user-read" | "user-mutate" },
    ): Promise<boolean>;
    authorizeAcceptedOperation(input: NativeEffectInput): Promise<boolean>;
    readNativeRestoreForSanitization(
      input: NativeAdminScope & { readonly restoreId: string; readonly claimId: string },
    ): ReturnType<NativeRestoreAuthority["current"]>;
    resolveProvider(input: NativeAdminScope & { readonly provider: "google" | "github" }): Promise<
      | (NativeAdminScope & {
          readonly provider: "google" | "github";
          readonly configurationRevision: number;
          readonly enabled: boolean;
        })
      | null
    >;
  };
}

export interface NativeControlContext extends NativeAdminScope {
  readonly principalId: string;
  readonly requestId: string;
  readonly delegation?: unknown;
  readonly idempotencyKey?: string;
  readonly canonicalRequestDigest?: Uint8Array;
}
interface NativeEffectInput extends NativeAdminScope {
  readonly principalId: string;
  readonly action: NativeUserMutation["action"];
  readonly resourceId: string | null;
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: string;
  readonly delegation?: unknown;
}
function ownerInput(
  input: NativeControlContext,
  intent: "users-list" | "user-read" | "user-mutate",
) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    principalId: input.principalId,
    requestId: input.requestId,
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
    intent,
  };
}
function effectInput(
  input: NativeControlContext & {
    readonly idempotencyKey: string;
    readonly canonicalRequestDigest: Uint8Array;
  },
  action: NativeUserMutation["action"],
  resourceId: string | null,
): NativeEffectInput {
  if (
    !(input.canonicalRequestDigest instanceof Uint8Array) ||
    input.canonicalRequestDigest.length !== 32
  )
    throw new Error("auth_unavailable");
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    principalId: input.principalId,
    action,
    resourceId,
    idempotencyKey: input.idempotencyKey,
    canonicalRequestDigest: Array.from(input.canonicalRequestDigest, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join(""),
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
  };
}

async function withNativeUsers<T>(
  env: NativeAdminBindings,
  input: NativeControlContext,
  intent: "users-list" | "user-read" | "user-mutate",
  action: (users: ReturnType<typeof createNativeUserManagement>) => Promise<T>,
  config: NativeRealmRegistration,
  pool: Pool,
  registrationCurrent: () => Promise<boolean>,
  deadline: NativeRequestDeadline,
  effect?: NativeEffectInput,
): Promise<T> {
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
  };
  const resolve = () => deadline.run(() => env.NATIVE_AUTH_ADMIN_AUTHORITY.resolve(scope));
  const current = await resolve();
  if (
    current.organizationId !== scope.organizationId ||
    current.realm.projectId !== scope.projectId ||
    current.realm.environmentId !== scope.environmentId
  )
    throw new Error("auth_unavailable");
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(config.schema) ||
    !/^postgres(?:ql)?:\/\//u.test(config.connectionString)
  )
    throw new Error("auth_unavailable");
  {
    const users = createNativeUserManagement(pool, scope, {
      authorize: async (_scope, proof) => {
        if (!(await deadline.run(registrationCurrent))) return false;
        if (
          proof !== input.requestId ||
          !(await deadline.run(() =>
            env.NATIVE_AUTH_ADMIN_AUTHORITY.authorizeOwnerOperation(ownerInput(input, intent)),
          ))
        )
          return false;
        if (intent === "user-mutate")
          return (
            effect !== undefined &&
            deadline.run(() => env.NATIVE_AUTH_ADMIN_AUTHORITY.authorizeAcceptedOperation(effect))
          );
        return true;
      },
      currentAuthority: async () => {
        if (!(await deadline.run(registrationCurrent))) return null;
        const authority = await resolve();
        if (
          authority.organizationId !== scope.organizationId ||
          authority.realm.projectId !== scope.projectId ||
          authority.realm.environmentId !== scope.environmentId
        )
          return null;
        return {
          enabled: authority.enabled,
          revocationEpoch: authority.revocationEpoch,
          configurationRevision: authority.realm.configurationRevision,
        };
      },
      sealInvitation: async (payload) => {
        const name = `NATIVE_AUTH_INVITATION_${payload.messageId.replaceAll("-", "").toUpperCase()}`;
        const cipher = nativeCustody(env);
        const envelope = await cipher.encrypt({ ...scope, name, value: JSON.stringify(payload) });
        return new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            name,
            keyVersion: envelope.keyVersion,
            ciphertext: Array.from(envelope.ciphertext),
            nonce: Array.from(envelope.nonce),
            valueSha256: Array.from(envelope.valueSha256),
          }),
        );
      },
    });
    return action(users);
  }
}

/** This entrypoint is private to trusted Control; it is never bound to customer code. */
export class NativeAdminOperations {
  constructor(
    private readonly env: NativeAdminBindings,
    private readonly pool: Pool,
    private readonly config: NativeRealmRegistration,
    private readonly registrationCurrent: () => Promise<boolean>,
    private readonly deadline = nativeRequestDeadline(),
  ) {
    this.pool = nativeDeadlinePool(pool, deadline);
  }
  public async applyProviderPolicy(
    input: NativeAdminScope & {
      readonly provider: "google" | "github";
      readonly configurationRevision: number;
      readonly enabled: boolean;
    },
  ): Promise<{ readonly outcome: "applied" }> {
    if (!(await this.deadline.run(this.registrationCurrent))) throw new Error("auth_unavailable");
    const scope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
    };
    if (input.provider !== "google" && input.provider !== "github")
      throw new Error("auth_unavailable");
    const providerScope = { ...scope, provider: input.provider };
    const current = await this.deadline.run(() =>
      this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolve(scope),
    );
    const provider = await this.deadline.run(() =>
      this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolveProvider(providerScope),
    );
    if (
      !provider ||
      current.organizationId !== scope.organizationId ||
      current.realm.projectId !== scope.projectId ||
      current.realm.environmentId !== scope.environmentId ||
      current.realm.configurationRevision !== input.configurationRevision ||
      provider.organizationId !== scope.organizationId ||
      provider.projectId !== scope.projectId ||
      provider.environmentId !== scope.environmentId ||
      provider.provider !== input.provider ||
      provider.configurationRevision !== input.configurationRevision ||
      provider.enabled !== input.enabled
    )
      throw new Error("auth_unavailable");
    const pool = this.pool;
    try {
      if (
        !(await this.deadline.run(this.registrationCurrent)) ||
        !(await applyNativeRealmPolicy(pool, {
          configurationRevision: input.configurationRevision,
          revocationEpoch: current.revocationEpoch,
          enabled: current.enabled,
        }))
      )
        throw new Error("auth_unavailable");
      const after = await this.deadline.run(() =>
        this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolve(scope),
      );
      const afterProvider = await this.deadline.run(() =>
        this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolveProvider(providerScope),
      );
      if (
        !afterProvider ||
        after.organizationId !== scope.organizationId ||
        after.realm.projectId !== scope.projectId ||
        after.realm.environmentId !== scope.environmentId ||
        after.realm.configurationRevision !== input.configurationRevision ||
        after.revocationEpoch !== current.revocationEpoch ||
        after.enabled !== current.enabled ||
        after.sourceCapable !== current.sourceCapable ||
        after.realm.canonicalOrigin !== current.realm.canonicalOrigin ||
        afterProvider.organizationId !== scope.organizationId ||
        afterProvider.projectId !== scope.projectId ||
        afterProvider.environmentId !== scope.environmentId ||
        afterProvider.provider !== input.provider ||
        afterProvider.configurationRevision !== input.configurationRevision ||
        afterProvider.enabled !== input.enabled
      )
        throw new Error("auth_unavailable");
      return { outcome: "applied" };
    } finally {
      // The realm Durable Object owns and reuses this pool.
    }
  }
  public listUsers(
    input: NativeControlContext & {
      readonly limit?: number;
      readonly cursor?: string;
      readonly search?: string;
    },
  ) {
    return withNativeUsers(
      this.env,
      input,
      "users-list",
      (users) =>
        users.list(input.requestId, {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { after: input.cursor }),
          ...(input.search === undefined ? {} : { search: input.search }),
        }),
      this.config,
      this.pool,
      this.registrationCurrent,
      this.deadline,
    );
  }
  public getUser(input: NativeControlContext & { readonly userId: string }) {
    return withNativeUsers(
      this.env,
      input,
      "user-read",
      (users) => users.get(input.requestId, input.userId),
      this.config,
      this.pool,
      this.registrationCurrent,
      this.deadline,
    );
  }
  public mutateUser(
    input: NativeControlContext & {
      readonly idempotencyKey: string;
      readonly canonicalRequestDigest: Uint8Array;
      readonly mutation: NativeUserMutation;
    },
  ) {
    return withNativeUsers(
      this.env,
      input,
      "user-mutate",
      (users) =>
        users.mutate(
          input.requestId,
          input.idempotencyKey,
          input.canonicalRequestDigest,
          input.mutation,
        ),
      this.config,
      this.pool,
      this.registrationCurrent,
      this.deadline,
      effectInput(
        input,
        input.mutation.action,
        input.mutation.action === "create-invite" ? null : input.mutation.userId,
      ),
    );
  }
  public async deliverInvitation(
    input: NativeControlContext & {
      readonly idempotencyKey: string;
      readonly canonicalRequestDigest: Uint8Array;
      readonly userId: string;
      readonly action: "create-invite" | "resend-invitation";
    },
  ): Promise<{ readonly status: "accepted" | "uncertain" | "rejected" }> {
    if (!(await this.deadline.run(this.registrationCurrent))) throw new Error("auth_unavailable");
    const scope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
    };
    const resolve = () =>
      this.deadline.run(() => this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolve(scope));
    const current = await resolve();
    if (
      current.organizationId !== scope.organizationId ||
      current.realm.projectId !== scope.projectId ||
      current.realm.environmentId !== scope.environmentId ||
      !current.enabled ||
      !current.sourceCapable ||
      !current.paidAllowed ||
      !current.runtimeAllowed ||
      current.realm.canonicalOrigin === null ||
      !isNativeAuthRedirectPath(current.invitationPath) ||
      !current.allowedRedirectPaths.includes(current.invitationPath)
    )
      throw new Error("auth_unavailable");
    if (
      !(await this.deadline.run(() =>
        this.env.NATIVE_AUTH_ADMIN_AUTHORITY.authorizeOwnerOperation(
          ownerInput(input, "user-mutate"),
        ),
      )) ||
      !(await this.deadline.run(() =>
        this.env.NATIVE_AUTH_ADMIN_AUTHORITY.authorizeAcceptedOperation(
          effectInput(input, input.action, input.action === "create-invite" ? null : input.userId),
        ),
      ))
    )
      throw new Error("auth_unavailable");
    const pool = this.pool;
    const delivery: { status: "accepted" | "uncertain" | "rejected" } = { status: "uncertain" };
    try {
      const cipher = nativeCustody(this.env);
      const dispatcher = createNativeInvitationDispatcher(pool, scope, {
        currentAuthority: async () => {
          if (!(await this.deadline.run(this.registrationCurrent))) return null;
          const live = await resolve();
          if (
            live.organizationId !== scope.organizationId ||
            live.realm.projectId !== scope.projectId ||
            live.realm.environmentId !== scope.environmentId ||
            live.realm.canonicalOrigin !== current.realm.canonicalOrigin ||
            !live.sourceCapable ||
            !live.paidAllowed ||
            !live.runtimeAllowed
          )
            return null;
          return {
            enabled: live.enabled,
            revocationEpoch: live.revocationEpoch,
            configurationRevision: live.realm.configurationRevision,
          };
        },
        send: async (_scope, message) => {
          if (
            !(await this.deadline.run(() =>
              this.env.NATIVE_AUTH_ADMIN_AUTHORITY.authorizeOwnerOperation(
                ownerInput(input, "user-mutate"),
              ),
            )) ||
            !(await this.deadline.run(() =>
              this.env.NATIVE_AUTH_ADMIN_AUTHORITY.authorizeAcceptedOperation(
                effectInput(
                  input,
                  input.action,
                  input.action === "create-invite" ? null : input.userId,
                ),
              ),
            ))
          )
            throw new Error("auth_unavailable");
          const envelope = JSON.parse(new TextDecoder().decode(message.sealedPayload)) as {
            name: string;
            keyVersion: number;
            ciphertext: number[];
            nonce: number[];
            valueSha256: number[];
          };
          if (
            envelope.name !==
            `NATIVE_AUTH_INVITATION_${message.messageId.replaceAll("-", "").toUpperCase()}`
          )
            throw new Error("auth_unavailable");
          const plaintext = await cipher.decrypt({
            ...scope,
            name: envelope.name,
            keyVersion: envelope.keyVersion,
            ciphertext: Uint8Array.from(envelope.ciphertext),
            nonce: Uint8Array.from(envelope.nonce),
            valueSha256: Uint8Array.from(envelope.valueSha256),
          });
          const payload = JSON.parse(plaintext) as {
            email: string;
            token: string;
            messageId: string;
          };
          if (
            payload.messageId !== message.messageId ||
            typeof payload.email !== "string" ||
            typeof payload.token !== "string"
          )
            throw new Error("auth_unavailable");
          const url = new URL(current.invitationPath, current.realm.canonicalOrigin as string);
          url.searchParams.set("token", payload.token);
          const result = await this.deadline.run(() =>
            this.env.NATIVE_AUTH_MAIL.sendNativeAuthMail({
              ...scope,
              kind: "invitation",
              to: payload.email,
              url: url.href,
              messageId: message.messageId,
            }),
          );
          delivery.status = result.status;
          if (delivery.status !== "accepted") throw new Error("auth_unavailable");
        },
      });
      const sent = await dispatcher.dispatchOne(input.idempotencyKey, input.userId);
      return { status: sent ? "accepted" : "uncertain" };
    } catch {
      return { status: delivery.status === "rejected" ? "rejected" : "uncertain" };
    } finally {
      // The realm Durable Object owns and reuses this pool.
    }
  }
  public async sanitizeRestore(
    input: NativeAdminScope & { readonly restoreId: string; readonly claimId: string },
  ) {
    const scope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
    };
    if (!(await this.deadline.run(this.registrationCurrent))) throw new Error("auth_unavailable");
    return sanitizeRestoredNativeRealm({
      pool: this.pool,
      scope,
      restoreId: input.restoreId,
      databaseId: this.config.target.databaseId,
      claimId: input.claimId,
      receiptKey: this.env.NATIVE_AUTH_CUSTODY_KEY_BASE64,
      additionalReceiptKeys: nativeCustody(this.env).additionalReceiptKeys(),
      authority: {
        current: async () => {
          if (!(await this.deadline.run(this.registrationCurrent))) return null;
          return this.deadline.run(() =>
            this.env.NATIVE_AUTH_ADMIN_AUTHORITY.readNativeRestoreForSanitization(input),
          );
        },
      },
    });
  }
  public async applyRealmPolicy(
    input: NativeAdminScope & {
      readonly configurationRevision: number;
      readonly revocationEpoch: number;
      readonly enabled: boolean;
      readonly canonicalOrigin: string | null;
    },
  ): Promise<{ readonly outcome: "applied" }> {
    if (!(await this.deadline.run(this.registrationCurrent))) throw new Error("auth_unavailable");
    const scope = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
    };
    const resolve = () =>
      this.deadline.run(() => this.env.NATIVE_AUTH_ADMIN_AUTHORITY.resolve(scope));
    const current = await resolve();
    if (
      current.organizationId !== scope.organizationId ||
      current.realm.projectId !== scope.projectId ||
      current.realm.environmentId !== scope.environmentId ||
      current.revocationEpoch !== input.revocationEpoch ||
      current.realm.configurationRevision !== input.configurationRevision ||
      current.realm.canonicalOrigin !== input.canonicalOrigin ||
      current.ownerEnabled !== input.enabled
    ) {
      throw new Error("auth_unavailable");
    }
    const config = this.config;
    if (
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(config.schema) ||
      !/^postgres(?:ql)?:\/\//u.test(config.connectionString)
    )
      throw new Error("auth_unavailable");
    const pool = this.pool;
    try {
      if (
        !(await this.deadline.run(this.registrationCurrent)) ||
        !(await applyNativeRealmPolicy(pool, {
          ...input,
          enabled: current.enabled,
        }))
      )
        throw new Error("auth_unavailable");
      const after = await resolve();
      if (
        after.organizationId !== scope.organizationId ||
        after.realm.projectId !== scope.projectId ||
        after.realm.environmentId !== scope.environmentId ||
        after.revocationEpoch !== input.revocationEpoch ||
        after.realm.configurationRevision !== input.configurationRevision ||
        after.realm.canonicalOrigin !== input.canonicalOrigin ||
        after.sourceCapable !== current.sourceCapable ||
        after.ownerEnabled !== input.enabled ||
        after.enabled !== current.enabled
      )
        throw new Error("auth_unavailable");
      return { outcome: "applied" };
    } finally {
      // The realm Durable Object owns and reuses this pool.
    }
  }
}

/** Only Control receives this binding; all SQL runs in the realm's private DO. */
export class NativeAdminService extends WorkerEntrypoint<NativeAdminBindings> {
  public sanitizeRestore(input: Parameters<NativeAdminOperations["sanitizeRestore"]>[0]) {
    return realm(this.env, input).sanitizeRestore(input, nativeRequestDeadline().at);
  }
  public listUsers(input: Parameters<NativeAdminOperations["listUsers"]>[0]) {
    return realm(this.env, input).listUsers(input, nativeRequestDeadline().at);
  }
  public getUser(input: Parameters<NativeAdminOperations["getUser"]>[0]) {
    return realm(this.env, input).getUser(input, nativeRequestDeadline().at);
  }
  public mutateUser(input: Parameters<NativeAdminOperations["mutateUser"]>[0]) {
    return realm(this.env, input).mutateUser(input, nativeRequestDeadline().at);
  }
  public deliverInvitation(input: Parameters<NativeAdminOperations["deliverInvitation"]>[0]) {
    return realm(this.env, input).deliverInvitation(input, nativeRequestDeadline().at);
  }
  public applyRealmPolicy(input: Parameters<NativeAdminOperations["applyRealmPolicy"]>[0]) {
    return realm(this.env, input).applyRealmPolicy(input, nativeRequestDeadline().at);
  }
  public applyProviderPolicy(input: Parameters<NativeAdminOperations["applyProviderPolicy"]>[0]) {
    return realm(this.env, input).applyProviderPolicy(input, nativeRequestDeadline().at);
  }
}

/** Provisioning receives policy fencing only, never user-administration methods. */
export class NativePolicyService extends WorkerEntrypoint<NativeAdminBindings> {
  public applyRealmPolicy(input: Parameters<NativeAdminOperations["applyRealmPolicy"]>[0]) {
    return realm(this.env, input).applyRealmPolicy(input, nativeRequestDeadline().at);
  }
  public applyProviderPolicy(input: Parameters<NativeAdminOperations["applyProviderPolicy"]>[0]) {
    return realm(this.env, input).applyProviderPolicy(input, nativeRequestDeadline().at);
  }
}

/** The sole customer-visible entrypoint: immutable platform-supplied props bind the realm. */
export class NativeSessionService extends WorkerEntrypoint<RealmBindings, NativeAuthBoundScope> {
  public async validateSession(input: { readonly cookie: string }) {
    const scope = {
      projectId: this.ctx.props.projectId,
      environmentId: this.ctx.props.environmentId,
      deploymentId: this.ctx.props.deploymentId,
    };
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(scope.deploymentId))
      throw new Error("auth_unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineAt = nativeRequestDeadline().at;
    try {
      let diagnostic = false;
      try {
        diagnostic = nativeLatencyEnabled(this.env.NATIVE_AUTH_LATENCY_PROFILE, scope);
      } catch {
        // Diagnostics never affect the original session operation.
      }
      const instance = realm(this.env, scope);
      let started: number | null = null;
      if (diagnostic) {
        try {
          const value = performance.now();
          if (Number.isFinite(value)) started = value;
        } catch {
          /* diagnostics only */
        }
      }
      const request = diagnostic
        ? instance.validateSession(scope, input.cookie, deadlineAt, {
            kind: "native_private_latency_request_v2",
          })
        : instance.validateSession(scope, input.cookie, deadlineAt);
      const result = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("auth_unavailable")), 15000);
        }),
      ]);
      return diagnostic
        ? unwrapNativeLatencySession(result, undefined, () => {
            try {
              const end = performance.now();
              return started !== null && Number.isFinite(end) && end >= started
                ? end - started
                : null;
            } catch {
              return null;
            }
          })
        : result;
    } catch {
      throw new Error("auth_unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
