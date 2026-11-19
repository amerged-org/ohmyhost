import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";
import {
  CloudflareCustomerDnsProvider,
  createCloudflareCustomerAuthorizationUrl,
  createCloudflareCustomHostnameProvider,
  createCloudflarePlatformDomainProvider,
  createCloudflareWorkerRouteProvider,
} from "@ohmyhost/provider-cloudflare";
import type {
  CloudflareDomainManagementBindings,
  CloudflareDomainManagementBaseBindings,
} from "./bindings.js";
import { createCloudflareDomainSecrets } from "./secrets.js";
import {
  createD1CloudflareDomainManagementPersistence,
  type GeneralCloudflareRuntimeBinding,
} from "./d1-persistence.js";
import {
  createD1CustomerDomainDnsAccess,
  type GeneralCloudflareDnsBinding,
} from "./d1-general-dns.js";
import { createCloudflareDomainManagementRuntime } from "./runtime.js";
import {
  createD1CloudflareDomainReconciliationPersistence,
  type CloudflareReconciliationRuntimeBinding,
} from "./d1-reconciliation.js";
import {
  createCloudflareDomainReconciliation,
  type CloudflareDomainReconciliationProviders,
} from "./reconciliation.js";
import {
  createD1CloudflareProjectDeletionPersistence,
  type CloudflareDeletionRuntimeBinding,
} from "./d1-project-deletion.js";
import {
  createCloudflareProjectDeletion,
  openDeletionDnsAccess,
  openDeletionHostnameDnsAccess,
} from "./project-deletion.js";
import {
  createD1PaidDomainPersistence,
  createLegacyProductionD1PaidDomainPersistence,
  type PaidDomainRuntimeBinding,
  type PaidDomainBaseRuntimeBinding,
  type NativePaidDomainRuntimeBinding,
} from "./d1-paid-persistence.js";
import { createPaidDomainRuntime, type CustomerDomainDns } from "./paid-domains.js";
import type { ScopedDnsAuthorizationRuntime } from "./d1-scoped-dns-authorization.js";
import {
  observeApplicationIdentityTxt,
  type createApplicationDomainIdentityRuntime,
} from "./application-domain-identity.js";
import type { createResendDns } from "./resend-dns.js";

interface D1CloudflareCompositionContext {
  bindings: CloudflareDomainManagementBaseBindings;
  clock: SystemClock;
  ids: ReturnType<typeof createUlidFactory>;
  secrets: ReturnType<typeof createCloudflareDomainSecrets>;
  oauth: ReturnType<typeof createCloudflareDomainProviderPorts>["authorization"];
  providerForUse(beforeRequest: () => Promise<void>): CloudflareCustomerDnsProvider;
  customerDns: CustomerDomainDns;
  deletionDependencies: Parameters<typeof createCloudflareProjectDeletion>[0];
}
type D1CloudflareComponents = (context: D1CloudflareCompositionContext) => Promise<{
  scopedDns: ScopedDnsAuthorizationRuntime;
  identities: ReturnType<typeof createApplicationDomainIdentityRuntime>;
  resendDns: ReturnType<typeof createResendDns>;
}>;
type Binding = GeneralCloudflareRuntimeBinding &
  GeneralCloudflareDnsBinding &
  CloudflareReconciliationRuntimeBinding &
  CloudflareDeletionRuntimeBinding &
  PaidDomainBaseRuntimeBinding;

export type Runtime = ReturnType<typeof createCloudflareDomainManagementRuntime> &
  ReturnType<typeof createCloudflareDomainReconciliation> &
  ReturnType<typeof createCloudflareProjectDeletion> &
  Omit<ReturnType<typeof createPaidDomainRuntime>, "deleteProjectPaidDomain"> &
  Partial<ReturnType<typeof createResendDns>> &
  Partial<ReturnType<typeof createApplicationDomainIdentityRuntime>> &
  Partial<ScopedDnsAuthorizationRuntime>;

/**
 * Providers call `dependencies.fetch(...)` as a method; Workers reject the unbound global fetch
 * with "Illegal invocation" there (Dev gateway wildcard check, 2026-09-23).
 */
export const workerFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

/** Synchronize the frozen Paid-domain withdrawal through the regional private policy service. */
export function createPaidDomainPolicySynchronizer(
  binding: Pick<PaidDomainRuntimeBinding, "readDomainPolicySync" | "ackDomainPolicySync">,
  bindings: Pick<
    CloudflareDomainManagementBindings,
    "NATIVE_AUTH_ADMIN_US" | "NATIVE_AUTH_ADMIN_EU"
  >,
) {
  return async (
    request: {
      organizationId: string;
      projectId: string;
      idempotencyKeySha256: string;
    },
    recovery?: { identity: string; recoveryId: string },
  ) => {
    const scope = {
      organizationId: request.organizationId,
      projectId: request.projectId,
      kind: "paid_delete",
      identity: recovery?.identity ?? request.idempotencyKeySha256.slice(7),
      ...(recovery === undefined ? {} : { recoveryId: recovery.recoveryId }),
    };
    const pending = await binding.readDomainPolicySync(scope);
    if (!Array.isArray(pending) || pending.length > 2)
      throw new Error("Native domain policy synchronization unavailable");
    for (const value of pending) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Native domain policy synchronization unavailable");
      const row = value as Record<string, unknown>;
      if (
        typeof row["environmentId"] !== "string" ||
        !["us", "eu"].includes(String(row["region"])) ||
        !Number.isSafeInteger(row["configurationRevision"]) ||
        Number(row["configurationRevision"]) < 1 ||
        !Number.isSafeInteger(row["revocationEpoch"]) ||
        Number(row["revocationEpoch"]) < 1 ||
        typeof row["ownerEnabled"] !== "boolean" ||
        row["canonicalOrigin"] !== null ||
        !(
          row["registryVersion"] === null ||
          (Number.isSafeInteger(row["registryVersion"]) && Number(row["registryVersion"]) > 0)
        )
      )
        throw new Error("Native domain policy synchronization unavailable");
      const policy = {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: row["environmentId"],
        configurationRevision: row["configurationRevision"],
        revocationEpoch: row["revocationEpoch"],
        enabled: row["ownerEnabled"],
        canonicalOrigin: null,
      };
      if (row["registryVersion"] !== null) {
        const service =
          row["region"] === "eu" ? bindings.NATIVE_AUTH_ADMIN_EU : bindings.NATIVE_AUTH_ADMIN_US;
        const outcome = await service.applyRealmPolicy(policy);
        if (
          typeof outcome !== "object" ||
          outcome === null ||
          (outcome as Record<string, unknown>)["outcome"] !== "applied"
        )
          throw new Error("Native domain policy synchronization unavailable");
      }
      const result = await binding.ackDomainPolicySync({
        ...scope,
        environmentId: row["environmentId"],
        configurationRevision: row["configurationRevision"],
        revocationEpoch: row["revocationEpoch"],
        ownerEnabled: row["ownerEnabled"],
        registryVersion: row["registryVersion"],
        acknowledgement: row["registryVersion"] === null ? "unprovisioned" : "applied",
      });
      if (result !== "acknowledged" && result !== "replayed")
        throw new Error("Native domain policy synchronization unavailable");
    }
  };
}

/** Full provider-facing factory: all persistence is closed Core RPC. */
type NativeDomainPolicyCapability = Required<
  Pick<
    Parameters<typeof createPaidDomainRuntime>[0],
    "synchronizeNativePolicy" | "recoverNativePolicy"
  >
>;
function createNativeDomainPolicyCapability(
  binding: Binding & NativePaidDomainRuntimeBinding,
  bindings: CloudflareDomainManagementBindings,
): NativeDomainPolicyCapability {
  for (const method of [
    "readDomainPolicySync",
    "ackDomainPolicySync",
    "beginPaidDomainRecovery",
    "completePaidDomainRecovery",
  ] as const)
    if (typeof Reflect.get(binding, method) !== "function")
      throw new TypeError("Cloudflare D1 capability is incomplete");
  for (const name of ["NATIVE_AUTH_ADMIN_US", "NATIVE_AUTH_ADMIN_EU"] as const)
    if (
      typeof bindings[name] !== "object" ||
      bindings[name] === null ||
      typeof bindings[name].applyRealmPolicy !== "function"
    )
      throw new TypeError("Cloudflare domain-management bindings are invalid");
  const synchronizeNativePolicy = createPaidDomainPolicySynchronizer(binding, bindings);
  return {
    synchronizeNativePolicy,
    recoverNativePolicy: async (request) => {
      const raw = await binding.beginPaidDomainRecovery(request);
      if (raw === null) return;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new Error("Native domain recovery unavailable");
      const row = raw as Record<string, unknown>;
      if (
        row["organizationId"] !== request.organizationId ||
        row["projectId"] !== request.projectId ||
        row["kind"] !== "paid_delete" ||
        typeof row["identity"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row["identity"]) ||
        row["recoveryId"] !== request.idempotencyKeySha256.slice(7)
      )
        throw new Error("Native domain recovery unavailable");
      await synchronizeNativePolicy(request, {
        identity: row["identity"],
        recoveryId: String(row["recoveryId"]),
      });
      if ((await binding.completePaidDomainRecovery(raw)) !== "completed")
        throw new Error("Native domain recovery unavailable");
    },
  };
}
export async function createD1ProductionCloudflareRuntime(
  bindings: CloudflareDomainManagementBindings,
  components: D1CloudflareComponents,
): Promise<Runtime> {
  if (typeof components !== "function")
    throw new TypeError("Cloudflare D1 composition is unavailable");
  const native = createNativeDomainPolicyCapability(
    bindings.GENERAL_CF_RUNTIME as Binding & NativePaidDomainRuntimeBinding,
    bindings,
  );
  return createComposedCloudflareRuntime(bindings, components, native, (binding, ids) =>
    createD1PaidDomainPersistence(binding as Binding & NativePaidDomainRuntimeBinding, ids),
  );
}
/** Explicit legacy Production composition: no Native capability is read or synthesized. */
export async function createLegacyProductionCloudflareRuntime(
  bindings: CloudflareDomainManagementBaseBindings,
  components: D1CloudflareComponents,
): Promise<Runtime> {
  if (typeof components !== "function")
    throw new TypeError("Cloudflare D1 composition is unavailable");
  if (
    bindings.CLOUDFLARE_OAUTH_REDIRECT_URI !== "https://app.ohmyho.st/v1/cloudflare/oauth/callback"
  )
    throw new TypeError("Legacy Production scope is invalid");
  return createComposedCloudflareRuntime(
    bindings,
    components,
    null,
    createLegacyProductionD1PaidDomainPersistence,
  );
}
async function createComposedCloudflareRuntime(
  bindings: CloudflareDomainManagementBaseBindings,
  components: D1CloudflareComponents,
  nativePolicy: NativeDomainPolicyCapability | null,
  paidPersistence: (
    binding: Binding,
    ids: { next(): string },
  ) => ReturnType<typeof createD1PaidDomainPersistence>,
): Promise<Runtime> {
  if (typeof components !== "function")
    throw new TypeError("Cloudflare D1 composition is unavailable");
  const binding = bindings.GENERAL_CF_RUNTIME as Binding;
  for (const method of [
    "claimAuthorization",
    "consumeAuthorization",
    "putGrant",
    "readStatus",
    "configureDomains",
    "readGrant",
    "claimGrantUse",
    "renewGrantUse",
    "finishGrantUse",
    "releaseGrantUse",
    "admitPaidProjectDomain",
    "readPaidDomainTarget",
    "claimPaidDomainApply",
    "putPaidDomainActive",
    "readPaidDomainRecord",
    "readPaidDomainProof",
    "ensurePaidDomainProof",
    "verifyPaidDomainProof",
    "claimPaidDomainDelete",
    "markPaidDomainDeleted",
    "claimPaidProjectDeletion",
    "readReconciliation",
    "rotateGrant",
    "readDeletion",
    "rotateDeletionGrant",
    "prepareRevocation",
    "restartRevocation",
    "finalizeDeletion",
    "finalizePlatformDeletion",
  ])
    if (typeof Reflect.get(binding, method) !== "function")
      throw new TypeError("Cloudflare D1 capability is incomplete");
  const platform =
    bindings.CLOUDFLARE_OAUTH_REDIRECT_URI === "https://app.ohmyho.st/v1/cloudflare/oauth/callback"
      ? "production"
      : "development";
  const trafficCnameTarget = platform === "production" ? "check.omh.st" : "dev.check.omh.st";
  const clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const secrets = createCloudflareDomainSecrets({
    keyBase64: bindings.CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64,
    keyVersion: Number(bindings.CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION),
    ...(bindings.CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON === undefined
      ? {}
      : { additionalKeysJson: bindings.CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON }),
    crypto: globalThis.crypto,
  });
  const providerForUse = (beforeRequest: () => Promise<void>) =>
    new CloudflareCustomerDnsProvider({
      clientId: bindings.CLOUDFLARE_OAUTH_CLIENT_ID,
      clientSecret: bindings.CLOUDFLARE_OAUTH_CLIENT_SECRET,
      redirectUri: bindings.CLOUDFLARE_OAUTH_REDIRECT_URI,
      fetch: async (input, init) => {
        await beforeRequest();
        return workerFetch(input, init);
      },
      timeoutMilliseconds: 15000,
    });
  const provider = providerForUse(async () => {});
  const customHostnames = createCloudflareCustomHostnameProvider({
    zoneId: bindings.CLOUDFLARE_SAAS_ZONE_ID,
    apiToken: bindings.CLOUDFLARE_SAAS_API_TOKEN,
    fetch: workerFetch,
  });
  const platformDomains = createCloudflarePlatformDomainProvider({
    zoneId: bindings.CLOUDFLARE_PLATFORM_ZONE_ID,
    zoneName: "omh.st",
    apiToken: bindings.CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN,
    fetch: workerFetch,
  });
  const paidRoutes = createCloudflareWorkerRouteProvider({
    zoneId: bindings.CLOUDFLARE_SAAS_ZONE_ID,
    apiToken: bindings.CLOUDFLARE_SAAS_API_TOKEN,
    fetch: workerFetch,
  });
  const platformRoutes = createCloudflareWorkerRouteProvider({
    zoneId: bindings.CLOUDFLARE_PLATFORM_ZONE_ID,
    apiToken: bindings.CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN,
    fetch: workerFetch,
  });
  const providerPorts = createCloudflareDomainProviderPorts({
    provider,
    clientId: bindings.CLOUDFLARE_OAUTH_CLIENT_ID,
    redirectUri: bindings.CLOUDFLARE_OAUTH_REDIRECT_URI,
    platformDomains,
    platformZoneId: bindings.CLOUDFLARE_PLATFORM_ZONE_ID,
    platformRoutes,
    fetcher: globalThis.fetch,
    runtimeProbeIssuer: bindings.DEV_ACCESS,
    runtimeProbes: bindings.RUNTIME_PROBES,
  });
  const customerDns = createD1CustomerDomainDnsAccess({
    binding,
    clock,
    ids,
    tokenCipher: secrets.tokenCipher,
    providerForUse,
  });
  const oauth = createCloudflareDomainManagementRuntime({
    platform,
    clock,
    ids,
    stateSigner: secrets.stateSigner,
    tokenCipher: secrets.tokenCipher,
    oauth: providerPorts.authorization,
    persistence: createD1CloudflareDomainManagementPersistence({ binding, clock, ids }),
    grantAccess: customerDns,
  });
  const reconciliation = createCloudflareDomainReconciliation({
    clock,
    platform: {
      zoneId: bindings.CLOUDFLARE_PLATFORM_ZONE_ID,
      zoneName: "omh.st",
      trafficCnameTarget,
    },
    persistence: createD1CloudflareDomainReconciliationPersistence(binding),
    providers: providerPorts.reconciliation,
  });
  const deletionDependencies = {
    clock,
    cipher: secrets.tokenCipher,
    persistence: createD1CloudflareProjectDeletionPersistence(binding),
    providers: providerPorts.deletion,
  };
  const deletion = createCloudflareProjectDeletion(deletionDependencies);
  const paid = createPaidDomainRuntime({
    cnameTarget: bindings.CLOUDFLARE_SAAS_CNAME_TARGET,
    clock,
    persistence: paidPersistence(binding, ids),
    customHostnames,
    routes: paidRoutes,
    observeTxt: (name, value) =>
      observeApplicationIdentityTxt(
        (request, init) => globalThis.fetch(request, init),
        name,
        value,
      ),
    ...(nativePolicy === null ? {} : nativePolicy),
    customerDns,
    projectDeletionDns: (scope) => ({
      ...customerDns,
      loadAccess: ({ hostname }) =>
        openDeletionHostnameDnsAccess(deletionDependencies, scope, hostname),
    }),
  });
  const parts = await components({
    bindings,
    clock,
    ids,
    secrets,
    oauth: providerPorts.authorization,
    providerForUse,
    customerDns,
    deletionDependencies,
  });
  const { deleteProjectPaidDomain, ...paidRpc } = paid;
  const {
    completeScopedAuthorization,
    ensureApplicationIdentityChallenge,
    reconcileWorkspaceMailRecords,
    ...scopedRpc
  } = parts.scopedDns;
  void ensureApplicationIdentityChallenge;
  void reconcileWorkspaceMailRecords;
  void openDeletionDnsAccess;
  return Object.freeze({
    ...oauth,
    ...scopedRpc,
    ...parts.identities,
    ...reconciliation,
    ...paidRpc,
    completeAuthorization: async (raw: unknown) => {
      const scoped = await completeScopedAuthorization(raw);
      return scoped.status === "invalid" ? oauth.completeAuthorization(raw) : scoped;
    },
    deleteProject: async (raw: unknown) => {
      await deleteProjectPaidDomain(raw);
      return deletion.deleteProject(raw);
    },
    ...parts.resendDns,
  });
}

export function createCloudflareDomainProviderPorts(input: {
  readonly provider: Pick<
    CloudflareCustomerDnsProvider,
    | "exchangeAuthorizationCode"
    | "observeZone"
    | "observeRefreshToken"
    | "refreshAccessToken"
    | "reconcileRecords"
    | "deleteRecords"
    | "revokeRefreshToken"
  >;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly platformDomains?: ReturnType<typeof createCloudflarePlatformDomainProvider>;
  readonly platformZoneId?: string;
  readonly platformRoutes: ReturnType<typeof createCloudflareWorkerRouteProvider>;
  readonly fetcher: typeof globalThis.fetch;
  readonly runtimeProbeIssuer: CloudflareDomainManagementBindings["DEV_ACCESS"];
  readonly runtimeProbes: CloudflareDomainManagementBindings["RUNTIME_PROBES"];
}) {
  const refreshAccessToken = (token: string) => input.provider.refreshAccessToken(token);
  return Object.freeze({
    authorization: Object.freeze({
      authorizationUrl: ({ state }: { readonly state: string }) =>
        createCloudflareCustomerAuthorizationUrl({
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          state,
        }),
      exchangeAuthorizationCode: (code: string) => input.provider.exchangeAuthorizationCode(code),
      observeZone: async (accessToken: string, zone: string) => {
        const observed = await input.provider.observeZone(accessToken, zone);
        if (observed.zoneName !== zone) throw new Error("Cloudflare OAuth zone identity changed");
        return observed.state === "absent"
          ? Object.freeze({ state: "absent" as const, zoneName: zone })
          : Object.freeze({ ...observed, zoneName: zone });
      },
      revokeRefreshToken: (token: string) => input.provider.revokeRefreshToken(token),
    }),
    reconciliation: Object.freeze({
      dns: Object.freeze({
        observeGatewayWildcard: (
          request: Parameters<
            CloudflareDomainReconciliationProviders["dns"]["observeGatewayWildcard"]
          >[0],
        ) => {
          if (input.platformDomains === undefined)
            throw new TypeError("Cloudflare platform DNS provider is unavailable");
          return input.platformDomains.observeGatewayWildcard(request);
        },
        reconcileRecords: (
          request: Parameters<
            CloudflareDomainReconciliationProviders["dns"]["reconcileRecords"]
          >[0],
        ) => {
          if (input.platformDomains === undefined)
            throw new TypeError("Cloudflare platform DNS provider is unavailable");
          return input.platformDomains.reconcileRecords(request);
        },
      }),
      routes: input.platformRoutes,
      probe: async (request: Parameters<CloudflareDomainReconciliationProviders["probe"]>[0]) => {
        const url = new URL(request.url);
        if (
          url.protocol !== "https:" ||
          url.origin !== request.origin ||
          url.pathname !== request.path ||
          url.search !== "" ||
          url.hash !== "" ||
          request.method !== "GET"
        )
          throw new TypeError("Shared gateway ingress probe input is invalid");
        let response: Response;
        try {
          response = await input.fetcher.call(globalThis, request.url, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          throw new Error("Shared gateway ingress is unavailable");
        }
        const valid =
          response.status === 404 && response.headers.get("x-ohmyhost-gateway") === "shared-v1";
        await response.body?.cancel();
        if (!valid) throw new Error("Shared gateway ingress is not ready");
        return Object.freeze({ status: 404 });
      },
    }),
    deletion: Object.freeze({
      oauth: Object.freeze({
        refreshAccessToken,
        observeRefreshToken: (token: string) => input.provider.observeRefreshToken(token),
        revokeRefreshToken: (token: string) => input.provider.revokeRefreshToken(token),
      }),
      dns: Object.freeze({
        deleteRecords: (
          token: string,
          request: Parameters<CloudflareCustomerDnsProvider["deleteRecords"]>[1],
        ) => input.provider.deleteRecords(token, request),
      }),
      platformDns: Object.freeze({
        deleteRecords: (
          request: Parameters<
            CloudflareDomainReconciliationProviders["dns"]["reconcileRecords"]
          >[0] & {
            readonly records: readonly import("@ohmyhost/provider-cloudflare").CloudflareCustomerDnsRecord[];
          },
        ) => {
          if (request.zoneId !== input.platformZoneId)
            throw new TypeError("Cloudflare platform DNS zone is invalid");
          if (input.platformDomains === undefined) {
            throw new TypeError("Cloudflare platform DNS provider is unavailable");
          }
          return input.platformDomains.deleteRecords(request);
        },
      }),
      platformRoutes: Object.freeze({
        deleteRoute: (
          request: Parameters<
            Parameters<
              typeof createCloudflareProjectDeletion
            >[0]["providers"]["platformRoutes"]["deleteRoute"]
          >[0],
        ) => {
          const { zoneId, ...receipt } = request;
          if (typeof zoneId !== "string" || !/^[a-f0-9]{32}$/u.test(zoneId))
            throw new TypeError("Cloudflare platform route zone is invalid");
          if (zoneId !== input.platformZoneId)
            throw new TypeError("Cloudflare platform route zone is invalid");
          return input.platformRoutes.deleteRoute(receipt);
        },
      }),
    }),
  });
}
