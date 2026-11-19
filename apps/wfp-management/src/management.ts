import {
  classifyPlatformGatewayHostname,
  createPinnedStorageGatewayOrigin,
} from "@ohmyhost/contracts/platform-origins";
import { createHash } from "node:crypto";
import {
  readGatewayReceipt,
  type GatewayRegistry,
  type SharedGatewayReceipt as WfpProjectGatewayReceipt,
} from "./gateway-registry.js";
type WfpProjectGatewayAbsenceReceipt = WfpProjectGatewayReceipt;
import type {
  RuntimeSecretManifest,
  VerifiedWfpArtifact,
  WfpDeploymentReceipt,
  WfpMetadataAbsenceReceipt,
  WfpObservation,
  WfpPublishInput,
  WfpRemoveInput,
  WfpRuntimePolicy,
  WfpScope,
  WfpDatabaseBinding,
  WfpStorageBinding,
  WfpNativeAuthBinding,
  WfpNextCacheBinding,
} from "@ohmyhost/provider-cloudflare";
import { Buffer } from "node:buffer";
import {
  CloudflareWfpSecretSyncUncertainError,
  WFP_CANDIDATE_LAYOUT_TAG,
  createRuntimeSecretManifest,
  computeDatabaseBindingDigest,
  computeStorageBindingDigest,
  computeNativeAuthBindingDigest,
  computeNextCacheBindingDigest,
  computeBindingSetDigest,
  parseWfpRuntimePolicy,
  projectGatewayPublicOrigin,
} from "@ohmyhost/provider-cloudflare";
import {
  parseVerifiedBuildLifecycleEvidence,
  type VerifiedBuildLifecycleEvidence,
  type VerifiedArtifactBundle,
  type VerifiedArtifactModule,
  type VerifiedArtifactMigration,
  type VerifiedArtifactRuntime,
} from "@ohmyhost/build-broker";
import { normalizeCrons } from "@ohmyhost/contracts";
import {
  AI_BASE_URL_NAME,
  BROWSER_BASE_URL_NAME,
  BROWSER_KEY_NAME,
  BROWSER_GATEWAY_ORIGIN_DEVELOPMENT,
  BROWSER_GATEWAY_ORIGIN_PRODUCTION,
  browserBaseUrl,
  AI_GATEWAY_ORIGIN_DEVELOPMENT,
  AI_GATEWAY_ORIGIN_PRODUCTION,
  AI_KEY_NAME,
  aiBaseUrl,
  isRecordedBetterAuthVersion,
  type RecordedBetterAuthVersion,
} from "@ohmyhost/platform";
import {
  normalizeBrowserPolicy,
  type BrowserPolicy,
} from "@ohmyhost/contracts/browser-capabilities";
import {
  readDatabaseRegistrationReceipt,
  type ProjectDatabaseRegistrationReceipt,
} from "@ohmyhost/project-database-runtime/registry";

export class WfpManagementInputError extends Error {
  public readonly code = "invalid_wfp_management_input";

  public constructor() {
    super("WFP management input is invalid");
    this.name = "WfpManagementInputError";
  }
}

export class WfpManagementContractError extends Error {
  public readonly code = "cloudflare_contract_invalid";

  public constructor() {
    super("Cloudflare asset upload response is invalid");
    this.name = "WfpManagementContractError";
  }
}

export interface WfpManagementBindings {
  readonly WFP_ACCOUNT_ID: string;
  readonly WFP_DISPATCH_NAMESPACE: string;
  readonly WFP_API_TOKEN: string;
  readonly WFP_WORKERS_DEV_SUBDOMAIN: string;
  readonly DATABASE_SERVICE_US: string;
  readonly DATABASE_SERVICE_EU: string;
  readonly NATIVE_AUTH_SERVICE_US?: string;
  readonly NATIVE_AUTH_SERVICE_EU?: string;
  readonly WFP_MAIL_GATEWAY_SERVICE: string;
  readonly WFP_MAIL_GATEWAY_ORIGIN: string;
  readonly WFP_STORAGE_GATEWAY_ORIGIN: string;
  readonly WFP_AI_GATEWAY_ORIGIN: string;
}

export type { VerifiedArtifactBundle };

export interface StageVerifiedArtifactInput {
  readonly organizationId: string;
  readonly scope: WfpScope;
  readonly deploymentId: string;
  readonly artifact: VerifiedArtifactBundle;
  readonly artifactReuse?: "promotion" | "binding-refresh";
  readonly knownDeployments: readonly WfpDeploymentReceipt[];
  readonly previousGateway?: WfpProjectGatewayReceipt;
  readonly runtimeSecretManifest: RuntimeSecretManifest;
  readonly databaseRegistration?: ProjectDatabaseRegistrationReceipt;
  readonly databaseOriginHost?: string;
  readonly storageBucketName?: string;
  readonly storageDataEnvironmentId?: string;
}

/** The producer roots a platform refresh in an accepted current head, never arbitrary source. */
export function requireBindingRefreshSourceDeployment(
  input: Readonly<{
    organizationId: string;
    scope: WfpScope;
    deploymentId: string;
    artifactProvenance: VerifiedArtifactBundle["provenance"];
    knownDeployments: readonly WfpDeploymentReceipt[];
    previousGateway?: WfpProjectGatewayReceipt;
  }>,
): WfpDeploymentReceipt {
  const head = input.previousGateway;
  if (
    head === undefined ||
    !head.active ||
    head.organizationId !== input.organizationId ||
    head.projectId !== input.scope.projectId ||
    head.environmentId !== input.scope.environmentId ||
    head.environmentName !== input.scope.environmentName ||
    head.handle !== input.scope.handle ||
    head.targetArtifactDigest !== input.artifactProvenance.artifactDigest ||
    head.targetDeploymentId === input.deploymentId ||
    input.artifactProvenance.deploymentId === input.deploymentId
  ) {
    throw new WfpManagementInputError();
  }
  const source = input.knownDeployments.find(
    (candidate) =>
      candidate.productDeploymentId === head.targetDeploymentId &&
      candidate.scriptName === head.targetScriptName &&
      candidate.providerTag === head.targetProviderTag &&
      candidate.artifactDigest === head.targetArtifactDigest &&
      candidate.projectId === input.scope.projectId &&
      candidate.environmentId === input.scope.environmentId,
  );
  if (source === undefined) throw new WfpManagementInputError();
  return source;
}

export interface SyncRuntimeSecretsInput {
  readonly scope: WfpScope;
  readonly expectedDeployment: WfpDeploymentReceipt;
  readonly runtimeSecretManifest: RuntimeSecretManifest;
}

export interface ActivateCandidateInput {
  readonly operationId: string;
  readonly claimId: string;
  readonly candidateReceiptId: string;
  readonly organizationId: string;
  readonly scope: WfpScope;
  readonly candidate: WfpDeploymentReceipt;
  readonly previousGateway?: WfpProjectGatewayReceipt;
  readonly runtimePolicy: WfpRuntimePolicy;
}

export type ObserveActivationInput = Omit<
  ActivateCandidateInput,
  "previousGateway" | "operationId" | "claimId" | "candidateReceiptId"
> & {
  readonly expectedGateway?: WfpProjectGatewayReceipt;
};

/** Restoring the route acts under claimId, the operation's provider-mutation claim. */
export interface CompensateGatewayActivationInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly scope: WfpScope;
  readonly candidate: WfpDeploymentReceipt;
  readonly expectedGateway: WfpProjectGatewayReceipt;
  readonly previousGateway?: WfpProjectGatewayReceipt;
}

/** Also removes the candidate, under cleanupClaimId, the candidate's own cleanup claim. */
export interface CompensateActivationInput extends CompensateGatewayActivationInput {
  readonly cleanupClaimId: string;
}

export interface RemoveCandidateInput {
  readonly organizationId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly candidateReceiptId: string;
  readonly scope: WfpScope;
  readonly candidate: WfpDeploymentReceipt;
}

export type ObserveCandidateInput = Pick<RemoveCandidateInput, "scope" | "candidate">;

export type RemoveCandidateResult =
  | {
      readonly status: "removed";
      readonly outcome: "removed" | "not_found";
      readonly receipt: WfpMetadataAbsenceReceipt;
    }
  | {
      readonly status: "reconciliation_required";
      readonly reconciliationPhase: "candidate";
      readonly currentProviderTag: string | null;
      readonly currentProductDeploymentId: string | null;
    };

export interface PrepareExistingCandidateInput {
  readonly artifactSourceDeploymentId: string;
  readonly organizationId: string;
  readonly scope: WfpScope;
  readonly candidate: WfpDeploymentReceipt;
  readonly artifact: VerifiedArtifactBundle;
  readonly runtimeSecretManifest: RuntimeSecretManifest;
  readonly databaseRegistration?: ProjectDatabaseRegistrationReceipt;
  readonly storageBucketName?: string;
  readonly storageDataEnvironmentId?: string;
}

export type FinalizeRemovalInput = Readonly<{
  organizationId: string;
  operationId: string;
  claimId: string;
  scope: WfpScope;
  deploymentId: string;
  expectedGateway: WfpProjectGatewayReceipt;
}>;

export interface WfpManagementProvider {
  stageCandidate(input: WfpPublishInput): Promise<WfpDeploymentReceipt>;
  observeCandidate(input: {
    readonly scope: WfpScope;
    readonly deploymentId: string;
    readonly knownDeployment?: WfpDeploymentReceipt;
    readonly expectedDatabaseBindingDigest?: `sha256:${string}` | null;
    readonly expectedStorageBindingDigest?: `sha256:${string}` | null;
    readonly expectedNativeAuthBindingDigest?: `sha256:${string}` | null;
    readonly expectedBindingSetDigest?: `sha256:${string}` | null;
  }): Promise<WfpObservation>;
  removeCandidate(input: WfpRemoveInput): Promise<WfpMetadataAbsenceReceipt>;
  syncRuntimeSecrets(input: {
    readonly scope: WfpScope;
    readonly deployment: WfpDeploymentReceipt;
    readonly manifest: RuntimeSecretManifest;
  }): Promise<import("@ohmyhost/provider-cloudflare").WfpRuntimeSecretSyncReceipt>;
}

export interface WfpManagementDependencies {
  readonly bindings: WfpManagementBindings;
  readonly provider: WfpManagementProvider;
  readonly gatewayRegistry: GatewayRegistry;
  readonly nextCacheAuthority?: {
    registerNextCacheScope?(input: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      deploymentId: string;
    }): Promise<unknown>;
  };
  readonly nativeAuthAuthority?: {
    readRegistration(input: { projectId: string; environmentId: string }): Promise<unknown>;
  };
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly removalPollMilliseconds?: number;
  readonly removalProbeTimeoutMilliseconds?: number;
  readonly removalDeadlineMilliseconds?: number;
  readonly trace?: (phase: string) => void;
}

type SecretSyncReconciliation = Readonly<{
  status: "reconciliation_required";
  reconciliationPhase: "wfp";
  currentProviderTag: string | null;
  currentProductDeploymentId: string | null;
}>;

type CandidateContractReconciliation = {
  readonly status: "reconciliation_required";
  readonly reconciliationPhase: "candidate";
  readonly currentProviderTag: string | null;
  readonly currentProductDeploymentId: string | null;
  readonly reason?: "candidate_bindings_outdated";
};

export type StageCandidateResult =
  | {
      readonly status: "staged" | "replayed";
      readonly candidate: WfpDeploymentReceipt;
      readonly priorGateway: WfpProjectGatewayReceipt | null;
      readonly activationRuntimePolicy: WfpRuntimePolicy;
      readonly deploymentUrl: string;
      readonly runtimeSecretManifestDigest: `sha256:${string}`;
    }
  | {
      readonly status: "reconciliation_required";
      readonly reconciliationPhase: "secrets";
      readonly currentProviderTag: string | null;
      readonly currentProductDeploymentId: string | null;
    }
  | CandidateContractReconciliation
  | {
      // The provider refused the script itself; the same artifact can never be staged, so the
      // deployment fails terminally instead of entering reconciliation.
      readonly status: "rejected";
      readonly reason: "script_rejected";
      readonly providerStatus: number;
      readonly providerCode: number | null;
    };

export type ActivateCandidateResult =
  | CandidateContractReconciliation
  | {
      readonly status: "activated";
      readonly candidate: WfpDeploymentReceipt;
      readonly gateway: WfpProjectGatewayReceipt;
      readonly deploymentUrl: string;
    }
  | {
      readonly status: "reconciliation_required";
      readonly reconciliationPhase: "gateway" | "health";
      readonly currentProviderTag: string | null;
      readonly currentProductDeploymentId: string;
      readonly gateway: WfpProjectGatewayReceipt | null;
    };

export type ObserveActivationResult =
  | {
      readonly status: "observed";
      readonly candidate: WfpDeploymentReceipt;
      readonly gateway: WfpProjectGatewayReceipt;
      readonly deploymentUrl: string;
    }
  | {
      readonly status: "absent";
    }
  | {
      readonly status: "reconciliation_required";
      readonly reconciliationPhase: "gateway";
      readonly currentProviderTag: string | null;
      readonly currentProductDeploymentId: string | null;
    }
  | (CandidateContractReconciliation & { readonly gateway?: never })
  | (Omit<CandidateContractReconciliation, "reason"> & {
      readonly reason: "candidate_bindings_outdated";
      readonly gateway?: WfpProjectGatewayReceipt;
    });

export type CompensateActivationResult =
  | {
      readonly status: "compensated";
      readonly gateway: WfpProjectGatewayReceipt | WfpProjectGatewayAbsenceReceipt;
      readonly candidate: WfpMetadataAbsenceReceipt;
    }
  | {
      readonly status: "reconciliation_required";
      readonly reconciliationPhase: "gateway" | "candidate";
      readonly currentProviderTag: string | null;
      readonly currentProductDeploymentId: string;
    };

export type CompensateGatewayActivationResult =
  | {
      readonly status: "compensated";
      readonly gateway: WfpProjectGatewayReceipt | WfpProjectGatewayAbsenceReceipt;
      readonly candidateRetained: true;
    }
  | Extract<CompensateActivationResult, { readonly status: "reconciliation_required" }>;

export type PrepareExistingCandidateResult =
  | {
      readonly status: "prepared";
      readonly candidate: WfpDeploymentReceipt;
      readonly activationRuntimePolicy: WfpRuntimePolicy;
      readonly runtimeSecretManifestDigest: `sha256:${string}`;
    }
  | Extract<StageCandidateResult, { readonly status: "reconciliation_required" }>;

type SyncRuntimeSecretsResult =
  | {
      readonly status: "synchronized";
      readonly receipt: import("@ohmyhost/provider-cloudflare").WfpRuntimeSecretSyncReceipt;
    }
  | {
      readonly status: "reconciliation_required";
      readonly currentSecretNames: readonly string[] | null;
    };

type RemovalReconciliation = Readonly<{
  status: "reconciliation_required";
  reason: "stale_edge" | "provider_conflict";
  currentProviderTag: string | null;
}>;

type FinalizeRemovalResult =
  | {
      readonly status: "removed";
      readonly metadata: WfpMetadataAbsenceReceipt | null;
      readonly gateway: WfpProjectGatewayAbsenceReceipt | null;
      readonly consecutive404s: 3;
    }
  | RemovalReconciliation;

type RemovalProbeResult =
  | { readonly gone: true }
  | {
      readonly gone: false;
      readonly reason: "transport_failure" | "non_404" | "deadline";
      readonly samples: number;
      readonly lastStatus: number | null;
      readonly transportFailures: number;
    };

interface ArtifactManifest {
  readonly schemaVersion: "ohmyhost.artifact/v3";
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly operationId: string;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly buildPlanDigest: `sha256:${string}`;
  readonly lifecycleEvidence: VerifiedBuildLifecycleEvidence;
  readonly applicationRoot: string;
  readonly frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5";
  readonly runtimePolicy: RuntimePolicy;
  readonly database: DatabaseRequirement;
  readonly auth: CustomerAuthRequirement;
  readonly storage: StorageRequirement;
  readonly functions?: FunctionsRequirement;
  readonly artifactDigest: `sha256:${string}`;
  readonly sbom: { readonly path: "sbom.cdx.json"; readonly digest: `sha256:${string}` };
  readonly assets: readonly {
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly size: number;
  }[];
  readonly runtime: SupportedArtifactRuntime | null;
  readonly modules: readonly Omit<VerifiedArtifactModule, "body">[];
  readonly migrations: readonly Omit<VerifiedArtifactMigration, "body">[];
}

interface RuntimePolicy {
  readonly healthCheckPath: string;
  readonly egressAllowedOrigins: readonly string[];
  readonly browser?: BrowserPolicy;
}

type DatabaseRequirement =
  | Readonly<{ readonly enabled: false }>
  | Readonly<{ readonly enabled: true; readonly migrations: string }>;
/** Declared crons of the environment's Worker module; the platform scheduler dispatches them. */
interface FunctionsRequirement {
  readonly crons: readonly string[];
}
type CustomerAuthRequirement =
  | Readonly<{ readonly provider: "none" }>
  | Readonly<{
      readonly provider: "omh-native";
      readonly routePath: "/api/auth/v1";
      readonly bindingName: "OHMYHOST_AUTH";
    }>
  | Readonly<{
      readonly provider: "better-auth";
      readonly version: RecordedBetterAuthVersion;
      readonly deployment: "embedded" | "companion";
      readonly routePath: "/api/auth";
      readonly databaseSchema: "auth";
      readonly databaseBindingName: "OHMYHOST_DATABASE";
      readonly authSecretName: "BETTER_AUTH_SECRET";
    }>;

async function nextCacheBindingForArtifact(
  dependencies: WfpManagementDependencies,
  organizationId: string,
  scope: WfpScope,
  deploymentId: string,
  artifact: CheckedArtifact,
): Promise<WfpNextCacheBinding | undefined> {
  if (artifact.manifest.runtime?.nextRevalidatePath !== true) return undefined;
  if (typeof dependencies.nextCacheAuthority?.registerNextCacheScope !== "function")
    throw new WfpManagementInputError();
  const response = await dependencies.nextCacheAuthority.registerNextCacheScope({
    organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    deploymentId,
  });
  if (
    !isRecord(response) ||
    !hasExactKeys(response, ["region"]) ||
    (response["region"] !== "us" && response["region"] !== "eu")
  )
    throw new WfpManagementInputError();
  const namespace = resourceNamespace(dependencies.bindings.WFP_DISPATCH_NAMESPACE);
  if (namespace === null) throw new WfpManagementInputError();
  return Object.freeze({
    service: `ohmyho-next-cache-${namespace}`,
    props: Object.freeze({
      organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      deploymentId,
      region: response["region"],
    }),
  });
}

async function nativeAuthBindingForArtifact(
  dependencies: WfpManagementDependencies,
  organizationId: string,
  scope: WfpScope,
  deploymentId: string,
  artifact: CheckedArtifact,
): Promise<WfpNativeAuthBinding | undefined> {
  if (artifact.manifest.auth.provider !== "omh-native") return undefined;
  if (!dependencies.nativeAuthAuthority) throw new WfpManagementInputError();
  const receipt = await dependencies.nativeAuthAuthority.readRegistration({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  });
  if (
    !isRecord(receipt) ||
    !hasExactKeys(receipt, [
      "organizationId",
      "projectId",
      "environmentId",
      "operationId",
      "claimId",
      "providerProjectId",
      "databaseId",
      "regionId",
      "originHost",
      "schema",
      "role",
      "targetVersion",
      "registryVersion",
      "registryReference",
      "status",
    ]) ||
    receipt["organizationId"] !== organizationId ||
    receipt["projectId"] !== scope.projectId ||
    receipt["environmentId"] !== scope.environmentId ||
    receipt["status"] !== "active" ||
    typeof receipt["providerProjectId"] !== "string" ||
    !/^prj_[a-z0-9]{20}$/u.test(receipt["providerProjectId"]) ||
    typeof receipt["databaseId"] !== "string" ||
    !/^[a-z][a-z0-9]{19}$/u.test(receipt["databaseId"]) ||
    typeof receipt["originHost"] !== "string" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(
      receipt["originHost"],
    ) ||
    (receipt["regionId"] !== "us-dev" && receipt["regionId"] !== "eu-dev") ||
    receipt["schema"] !== `omh_auth_${scope.environmentId.toLowerCase()}` ||
    receipt["role"] !== `omh_ar_${scope.environmentId.toLowerCase()}` ||
    receipt["registryReference"] !== `${scope.projectId}:${scope.environmentId}` ||
    !isUlid(receipt["operationId"]) ||
    !isUlid(receipt["claimId"]) ||
    !Number.isSafeInteger(receipt["targetVersion"]) ||
    Number(receipt["targetVersion"]) < 1 ||
    !Number.isSafeInteger(receipt["registryVersion"]) ||
    Number(receipt["registryVersion"]) < 1
  )
    throw new WfpManagementInputError();
  if (artifact.manifest.runtime === null) return undefined;
  const platform =
    dependencies.bindings.WFP_DISPATCH_NAMESPACE === "ohmyho-production"
      ? "production"
      : "development";
  const region = receipt["regionId"] === "us-dev" ? "us" : "eu";
  const service =
    region === "us"
      ? dependencies.bindings.NATIVE_AUTH_SERVICE_US
      : dependencies.bindings.NATIVE_AUTH_SERVICE_EU;
  if (service !== `ohmyho-native-auth-${platform}-${region}`) throw new WfpManagementInputError();
  return Object.freeze({
    service,
    props: Object.freeze({
      organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      deploymentId,
    }),
  });
}
type StorageRequirement =
  | Readonly<{ readonly enabled: false }>
  | Readonly<{
      readonly enabled: true;
      readonly provider: "r2";
      readonly jurisdiction: "eu" | "us";
      readonly public: false;
    }>;

type SupportedArtifactRuntime = Omit<VerifiedArtifactRuntime, "entryWrapperVersion"> & {
  readonly entryWrapperVersion:
    | "astro-edge-wrapper-v1"
    | "tanstack-edge-wrapper-v1"
    | "nextjs-opennext-wrapper-v1"
    | "vite-api-companion-v1"
    | "functions-v1";
};

interface CheckedArtifact {
  readonly manifest: ArtifactManifest;
  readonly filesByPath: ReadonlyMap<string, Uint8Array>;
  readonly modulesByPath: ReadonlyMap<string, Uint8Array>;
  readonly migrationsByPath: ReadonlyMap<string, Uint8Array>;
}

interface AssetUploadSession {
  readonly jwt: string;
  readonly buckets: readonly (readonly string[])[];
}

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_SBOM_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_PUBLIC_ASSET_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_SSG_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_COUNT = 1_000;
const MAX_MODULE_BYTES = 15 * 1024 * 1024;
const MAX_NEXTJS_COMPRESSED_MODULE_BYTES = 10 * 1024 * 1024;
const MAX_MODULE_COUNT = 1_000;
const MAX_MIGRATION_BYTES = 256 * 1024;
const MAX_MIGRATION_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_MIGRATION_COUNT = 128;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const COMPATIBILITY_DATE = "2026-08-19";
const MAIN_MODULE = "worker.mjs";
const EDGE_WRAPPER_MODULE = "ohmyhost-entry.mjs";
const MULTIPART_BOUNDARY_ATTEMPTS = 8;
/** The bundled Worker module of declared crons beside a Next.js or TanStack module inventory. */
const FUNCTIONS_WORKER_MODULE = "ohmyhost-worker.js";
const SCHEDULED_HOST = "scheduled.ohmyhost.internal";
const SCHEDULED_PATH = "/.ohmyhost/scheduled";
const STATIC_ASSET_MODULE =
  "export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };\n";

export function createWfpManagement(dependencies: WfpManagementDependencies) {
  validateDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date());
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pollMilliseconds = dependencies.removalPollMilliseconds ?? 1_000;
  const probeTimeoutMilliseconds = dependencies.removalProbeTimeoutMilliseconds ?? 5_000;
  const deadlineMilliseconds = dependencies.removalDeadlineMilliseconds ?? 30_000;
  const trace = dependencies.trace ?? (() => undefined);
  validatePolling(pollMilliseconds, deadlineMilliseconds, probeTimeoutMilliseconds);
  const synchronizePublishedSecrets = async (
    scope: WfpScope,
    manifest: RuntimeSecretManifest,
    receipt: WfpDeploymentReceipt,
  ): Promise<SecretSyncReconciliation | null> => {
    try {
      trace("runtime-secret-sync-start");
      await dependencies.provider.syncRuntimeSecrets({
        scope,
        deployment: receipt,
        manifest,
      });
      trace("runtime-secret-sync-complete");
      return null;
    } catch (error) {
      if (isRuntimeSecretSyncUncertain(error)) return healthReconciliation(receipt);
      throw redactProviderFailure(error);
    }
  };

  const stageVerifiedArtifact = async (
    input: StageVerifiedArtifactInput,
  ): Promise<StageCandidateResult> => {
    const runtimeSecretManifest = await validatedRuntimeSecretManifest(input.runtimeSecretManifest);
    const artifactScope =
      input.artifactReuse !== undefined
        ? Object.freeze({
            projectId: input.artifact.provenance.scope.projectId,
            environmentId: input.artifact.provenance.scope.environmentId,
            environmentName:
              input.artifact.provenance.scope.environmentId === input.scope.environmentId
                ? input.scope.environmentName
                : ("dev" as const),
            handle: input.scope.handle,
          })
        : input.scope;
    if (
      (input.artifactReuse !== undefined &&
        input.artifactReuse !== "promotion" &&
        input.artifactReuse !== "binding-refresh") ||
      (input.artifactReuse === "binding-refresh" &&
        (artifactScope.projectId !== input.scope.projectId ||
          (artifactScope.environmentId !== input.scope.environmentId &&
            input.scope.environmentName !== "prod"))) ||
      (input.artifactReuse === "promotion" &&
        (input.scope.environmentName !== "prod" ||
          artifactScope.projectId !== input.scope.projectId ||
          artifactScope.environmentId === input.scope.environmentId ||
          input.artifact.provenance.deploymentId === input.deploymentId)) ||
      (input.artifactReuse === undefined &&
        (input.artifact.provenance.scope.environmentId !== input.scope.environmentId ||
          input.artifact.provenance.deploymentId !== input.deploymentId))
    ) {
      throw new WfpManagementInputError();
    }
    const checked = await checkArtifact(
      artifactScope,
      input.artifactReuse !== undefined
        ? input.artifact.provenance.deploymentId
        : input.deploymentId,
      input.artifact,
    );
    const nativeAuthBinding = await nativeAuthBindingForArtifact(
      dependencies,
      input.organizationId,
      input.scope,
      input.deploymentId,
      checked,
    );
    const nextCacheBinding = await nextCacheBindingForArtifact(
      dependencies,
      input.organizationId,
      input.scope,
      input.deploymentId,
      checked,
    );
    const databaseRegistration = validateDatabaseRegistrationBinding(
      checked.manifest.database,
      input.databaseRegistration,
      input.organizationId,
      input.scope,
    );
    validateDatabaseOriginHost(
      checked.manifest.database,
      input.databaseOriginHost,
      databaseRegistration,
    );
    const storageBucketName = validateStorageBinding(
      checked.manifest.storage,
      input.storageBucketName,
      input.scope,
    );
    const storageBinding = storageBindingForScope(
      checked.manifest.storage,
      input.storageDataEnvironmentId,
      databaseRegistration,
      input.organizationId,
      input.scope,
      dependencies.bindings,
    );
    // Reject retained customer policies before uploading or changing a provider candidate.
    const activationRuntimePolicy = projectGatewayRuntimePolicy(
      checked.manifest.runtimePolicy,
      runtimeSecretManifest,
      dependencies.bindings,
      checked.manifest.storage,
      storageBinding?.props,
    );
    trace("artifact-validated");
    validateKnownDeployments(
      input.knownDeployments,
      input.scope,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    if (input.previousGateway !== undefined) {
      if (input.previousGateway.organizationId !== input.organizationId)
        throw new WfpManagementInputError();
      validateGatewayReceipt(
        input.previousGateway,
        { ...input.scope, handle: input.previousGateway.handle },
        dependencies.bindings.WFP_DISPATCH_NAMESPACE,
      );
    }
    if (input.artifactReuse === "binding-refresh") {
      const source = requireBindingRefreshSourceDeployment({
        organizationId: input.organizationId,
        scope: input.scope,
        deploymentId: input.deploymentId,
        artifactProvenance: input.artifact.provenance,
        knownDeployments: input.knownDeployments,
        ...(input.previousGateway === undefined ? {} : { previousGateway: input.previousGateway }),
      });
      const observed = await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: source.productDeploymentId,
        knownDeployment: source,
        ...bindingExpectation(source),
      });
      if (
        (observed.state !== "ready" && !isOutdatedCandidateObservation(observed, source)) ||
        observed.scriptName !== source.scriptName ||
        observed.providerTag !== source.providerTag ||
        observed.productDeploymentId !== source.productDeploymentId ||
        observed.artifactDigest !== source.artifactDigest
      ) {
        throw new WfpManagementInputError();
      }
    }
    const databaseServiceScriptName =
      databaseRegistration === null
        ? null
        : databaseRegistration.region === "us"
          ? dependencies.bindings.DATABASE_SERVICE_US
          : dependencies.bindings.DATABASE_SERVICE_EU;
    const databaseBindingDigest = await computeDatabaseBindingDigest(
      databaseBindingForScope(databaseRegistration, input.scope, dependencies.bindings),
      input.scope,
    );
    const storageBindingDigest = await computeStorageBindingDigest(
      storageBinding,
      input.scope,
      databaseBindingForScope(databaseRegistration, input.scope, dependencies.bindings),
    );
    const nativeAuthBindingDigest = await computeNativeAuthBindingDigest(
      nativeAuthBinding,
      input.scope,
      input.deploymentId,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const nextCacheBindingDigest = await computeNextCacheBindingDigest(
      nextCacheBinding,
      input.scope,
      input.deploymentId,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const cronBindingsDigest = checked.manifest.functions?.crons.length
      ? await digest(new TextEncoder().encode(JSON.stringify(checked.manifest.functions.crons)))
      : null;
    const bindingSetDigest = await computeBindingSetDigest(
      cronBindingsDigest,
      databaseBindingDigest,
      storageBindingDigest,
      nativeAuthBindingDigest,
      nextCacheBindingDigest,
    );
    const publicOrigin = publicOriginForScope(
      input.scope,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const replay = input.knownDeployments.find(
      (candidate) =>
        candidate.productDeploymentId === input.deploymentId &&
        candidate.artifactDigest === checked.manifest.artifactDigest,
    );
    let candidate: WfpDeploymentReceipt;
    let outcome: "staged" | "replayed" = "staged";
    if (replay !== undefined) {
      if ((replay.bindingSetDigest ?? null) !== bindingSetDigest)
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: null,
          currentProductDeploymentId: null,
        });
      const observation = await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: input.deploymentId,
        knownDeployment: replay,
        expectedDatabaseBindingDigest: databaseBindingDigest,
        expectedStorageBindingDigest: storageBindingDigest,
        expectedNativeAuthBindingDigest: nativeAuthBindingDigest,
        ...(bindingSetDigest === null ? {} : { expectedBindingSetDigest: bindingSetDigest }),
      });
      if (observation.reason === "candidate_bindings_outdated") {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: observation.providerTag,
          currentProductDeploymentId: observation.productDeploymentId,
          ...(isOutdatedCandidateObservation(observation, replay)
            ? { reason: "candidate_bindings_outdated" as const }
            : {}),
        });
      }
      if (
        observation.state === "ready" &&
        observation.scriptName === replay.scriptName &&
        observation.providerTag === replay.providerTag &&
        observation.productDeploymentId === replay.productDeploymentId &&
        observation.artifactDigest === replay.artifactDigest
      ) {
        candidate = replay;
        outcome = "replayed";
      } else {
        const staged = await tryStageCandidate();
        if ("status" in staged) return staged;
        candidate = staged.candidate;
      }
    } else {
      const staged = await tryStageCandidate();
      if ("status" in staged) return staged;
      candidate = staged.candidate;
    }
    if ((candidate.bindingSetDigest ?? null) !== bindingSetDigest)
      throw new WfpManagementContractError();
    if (outcome === "staged") {
      await sleep(5_000);
      let settled: Awaited<ReturnType<WfpManagementProvider["observeCandidate"]>>;
      try {
        settled = await dependencies.provider.observeCandidate({
          scope: input.scope,
          deploymentId: input.deploymentId,
          knownDeployment: candidate,
          expectedDatabaseBindingDigest: databaseBindingDigest,
          expectedStorageBindingDigest: storageBindingDigest,
          expectedNativeAuthBindingDigest: nativeAuthBindingDigest,
          ...(bindingSetDigest === null ? {} : { expectedBindingSetDigest: bindingSetDigest }),
        });
      } catch {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: null,
          currentProductDeploymentId: candidate.productDeploymentId,
        });
      }
      if (settled.reason === "candidate_bindings_outdated") {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: settled.providerTag,
          currentProductDeploymentId: settled.productDeploymentId,
          ...(isOutdatedCandidateObservation(settled, candidate)
            ? { reason: "candidate_bindings_outdated" as const }
            : {}),
        });
      }
      if (
        (settled.state !== "ready" &&
          (bindingSetDigest !== null ||
            databaseRegistration !== null ||
            settled.state !== "unknown")) ||
        settled.scriptName !== candidate.scriptName ||
        settled.providerTag === null ||
        settled.productDeploymentId !== candidate.productDeploymentId ||
        settled.artifactDigest !== candidate.artifactDigest
      ) {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: settled.providerTag,
          currentProductDeploymentId: settled.productDeploymentId,
        });
      }
      candidate = Object.freeze({
        ...candidate,
        providerTag: settled.providerTag,
        deployedAt: settled.observedAt,
      });
    }
    if (outcome === "replayed") {
      const secretReconciliation = await synchronizePublishedSecrets(
        input.scope,
        runtimeSecretManifest,
        candidate,
      );
      if (secretReconciliation !== null) {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "secrets" as const,
          currentProviderTag: secretReconciliation.currentProviderTag,
          currentProductDeploymentId: candidate.productDeploymentId,
        });
      }
    }
    return Object.freeze({
      status: outcome,
      candidate,
      priorGateway: input.previousGateway ?? null,
      activationRuntimePolicy,
      deploymentUrl: publicOrigin,
      runtimeSecretManifestDigest: runtimeSecretManifest.digest,
    });

    async function tryStageCandidate(): Promise<
      | { readonly candidate: WfpDeploymentReceipt }
      | Extract<StageCandidateResult, { readonly status: "reconciliation_required" | "rejected" }>
    > {
      // The multipart body lives only for this call, not through the settle wait that follows.
      const artifact = await prepareProviderArtifact(
        dependencies,
        input.scope,
        input.deploymentId,
        checked,
        runtimeSecretManifest,
        publicOrigin,
        databaseRegistration,
        storageBucketName,
        storageBinding,
        databaseServiceScriptName,
        nativeAuthBinding,
        nextCacheBinding,
        trace,
      );
      try {
        trace("candidate-stage-start");
        const receipt = await dependencies.provider.stageCandidate({
          scope: input.scope,
          artifact,
          ...(input.artifactReuse === undefined ? {} : { buildReused: true }),
        });
        trace("candidate-stage-complete");
        return Object.freeze({ candidate: receipt });
      } catch (error) {
        if (isScriptRejectedError(error)) {
          trace("candidate-stage-rejected");
          return Object.freeze({
            status: "rejected" as const,
            reason: "script_rejected" as const,
            providerStatus: error.status,
            providerCode: error.providerCode ?? null,
          });
        }
        if (!isUncertainProviderError(error)) throw redactProviderFailure(error);
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: error.currentProviderTag,
          currentProductDeploymentId: error.currentProductDeploymentId ?? null,
          ...(error.reason === "candidate_bindings_outdated" ? { reason: error.reason } : {}),
        });
      }
    }
  };

  const activateCandidate = async (
    input: ActivateCandidateInput,
  ): Promise<ActivateCandidateResult> => {
    validateScope(input.scope);
    if (![input.operationId, input.claimId, input.candidateReceiptId].every(isUlid))
      throw new WfpManagementInputError();
    if (!isUlid(input.organizationId)) throw new WfpManagementInputError();
    validateReceipt(input.candidate, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    validateRuntimePolicy(input.runtimePolicy);
    if (input.previousGateway !== undefined) {
      if (input.previousGateway.organizationId !== input.organizationId)
        throw new WfpManagementInputError();
      // A rename publishes the chosen address over the route that still carries the old one, so
      // the replaced route is checked by project and environment, as staging checks it.
      validateGatewayReceipt(
        input.previousGateway,
        { ...input.scope, handle: input.previousGateway.handle },
        dependencies.bindings.WFP_DISPATCH_NAMESPACE,
      );
    }
    let observed: WfpObservation;
    try {
      observed = await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: input.candidate.productDeploymentId,
        knownDeployment: input.candidate,
        ...bindingExpectation(input.candidate),
      });
    } catch (error) {
      throw redactProviderFailure(error);
    }
    if (
      observed.state !== "ready" ||
      observed.reason === "candidate_bindings_outdated" ||
      observed.scriptName !== input.candidate.scriptName ||
      observed.providerTag !== input.candidate.providerTag ||
      observed.productDeploymentId !== input.candidate.productDeploymentId ||
      observed.artifactDigest !== input.candidate.artifactDigest
    )
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: observed.providerTag,
        currentProductDeploymentId: observed.productDeploymentId,
        ...(isOutdatedCandidateObservation(observed, input.candidate)
          ? { reason: "candidate_bindings_outdated" as const }
          : {}),
      });
    let gateway: WfpProjectGatewayReceipt;
    try {
      trace("candidate-activation-start");
      gateway = readGatewayReceipt(
        await dependencies.gatewayRegistry.activate({
          organizationId: input.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          operationId: input.operationId,
          claimId: input.claimId,
          candidateReceiptId: input.candidateReceiptId,
          expectedRevision: input.previousGateway?.revision ?? null,
          egressAllowedOrigins: input.runtimePolicy.egressAllowedOrigins,
          ...(input.runtimePolicy.browser === undefined
            ? {}
            : { browserPolicy: input.runtimePolicy.browser }),
        }),
      );
      trace("candidate-activation-complete");
    } catch (error) {
      if (!isUncertainProviderError(error)) throw redactProviderFailure(error);
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "gateway" as const,
        currentProviderTag: error.currentProviderTag,
        currentProductDeploymentId: input.candidate.productDeploymentId,
        gateway: null,
      });
    }
    if (
      gateway.operationId !== input.operationId ||
      gateway.candidateReceiptId !== input.candidateReceiptId ||
      JSON.stringify(gateway.egressAllowedOrigins) !==
        JSON.stringify(input.runtimePolicy.egressAllowedOrigins)
    )
      throw new WfpManagementContractError();
    validateActivatedGateway(
      gateway,
      input.organizationId,
      input.scope,
      input.candidate,
      dependencies.bindings,
    );
    return Object.freeze({
      status: "activated" as const,
      candidate: input.candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
    });
  };

  const observeActivation = async (
    input: ObserveActivationInput,
  ): Promise<ObserveActivationResult> => {
    validateScope(input.scope);
    if (!isUlid(input.organizationId)) throw new WfpManagementInputError();
    validateReceipt(input.candidate, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    validateRuntimePolicy(input.runtimePolicy);
    let candidate: WfpObservation;
    let gateway: WfpProjectGatewayReceipt | null;
    try {
      [candidate, gateway] = await Promise.all([
        dependencies.provider.observeCandidate({
          scope: input.scope,
          deploymentId: input.candidate.productDeploymentId,
          knownDeployment: input.candidate,
          ...bindingExpectation(input.candidate),
        }),
        dependencies.gatewayRegistry
          .observe({
            organizationId: input.organizationId,
            projectId: input.scope.projectId,
            environmentId: input.scope.environmentId,
          })
          .then((value) => (value === null ? null : readGatewayReceipt(value))),
      ]);
    } catch (error) {
      throw redactProviderFailure(error);
    }
    if (
      (gateway === null || !gateway.active) &&
      candidate.state !== "unknown" &&
      candidate.reason !== "candidate_bindings_outdated"
    ) {
      return Object.freeze({ status: "absent" as const });
    }
    if (
      candidate.state !== "ready" ||
      candidate.reason === "candidate_bindings_outdated" ||
      candidate.scriptName !== input.candidate.scriptName ||
      candidate.providerTag !== input.candidate.providerTag ||
      candidate.productDeploymentId !== input.candidate.productDeploymentId ||
      candidate.artifactDigest !== input.candidate.artifactDigest
    ) {
      if (isOutdatedCandidateObservation(candidate, input.candidate)) {
        let predecessor: WfpProjectGatewayReceipt | undefined;
        if (
          gateway !== null &&
          gateway.active &&
          JSON.stringify(gateway.egressAllowedOrigins) ===
            JSON.stringify(input.runtimePolicy.egressAllowedOrigins) &&
          JSON.stringify(normalizeBrowserPolicy(gateway.browserPolicy)) ===
            JSON.stringify(normalizeBrowserPolicy(input.runtimePolicy.browser)) &&
          (input.expectedGateway === undefined ||
            gateway.revision === input.expectedGateway.revision)
        ) {
          try {
            validateActivatedGateway(
              gateway,
              input.organizationId,
              input.scope,
              input.candidate,
              dependencies.bindings,
            );
            predecessor = gateway;
          } catch (error) {
            if (
              !(error instanceof WfpManagementInputError) &&
              !(error instanceof WfpManagementContractError)
            )
              throw error;
          }
        }
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: candidate.providerTag,
          currentProductDeploymentId: candidate.productDeploymentId,
          reason: "candidate_bindings_outdated" as const,
          ...(predecessor === undefined ? {} : { gateway: predecessor }),
        });
      }
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: candidate.providerTag,
        currentProductDeploymentId:
          candidate.productDeploymentId === input.candidate.productDeploymentId
            ? candidate.productDeploymentId
            : null,
      });
    }
    if (
      gateway === null ||
      !gateway.active ||
      gateway.targetDeploymentId !== input.candidate.productDeploymentId ||
      gateway.targetScriptName !== input.candidate.scriptName ||
      gateway.targetProviderTag !== input.candidate.providerTag ||
      gateway.targetArtifactDigest !== input.candidate.artifactDigest ||
      JSON.stringify(gateway.egressAllowedOrigins) !==
        JSON.stringify(input.runtimePolicy.egressAllowedOrigins) ||
      (input.expectedGateway !== undefined && gateway.revision !== input.expectedGateway.revision)
    ) {
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "gateway" as const,
        currentProviderTag: gateway?.targetProviderTag ?? null,
        currentProductDeploymentId:
          gateway?.targetDeploymentId === input.candidate.productDeploymentId
            ? gateway.targetDeploymentId
            : null,
      });
    }
    validateActivatedGateway(
      gateway,
      input.organizationId,
      input.scope,
      input.candidate,
      dependencies.bindings,
    );
    return Object.freeze({
      status: "observed" as const,
      candidate: input.candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
    });
  };

  const removeCandidate = async (input: RemoveCandidateInput): Promise<RemoveCandidateResult> => {
    validateScope(input.scope);
    validateReceipt(input.candidate, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    let before: WfpObservation;
    try {
      before = await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: input.candidate.productDeploymentId,
        knownDeployment: input.candidate,
        ...bindingExpectation(input.candidate),
      });
    } catch (error) {
      throw redactProviderFailure(error);
    }
    if (before.state === "unknown" && !isOutdatedCandidateObservation(before, input.candidate)) {
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: before.providerTag,
        currentProductDeploymentId: before.productDeploymentId,
      });
    }
    await authorizeCandidateRemoval(input, input.candidate, input.candidateReceiptId);
    let receipt: WfpMetadataAbsenceReceipt;
    try {
      receipt = await dependencies.provider.removeCandidate({
        scope: input.scope,
        expectedDeployment: input.candidate,
      });
    } catch (error) {
      if (isUncertainProviderError(error)) {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reconciliationPhase: "candidate" as const,
          currentProviderTag: error.currentProviderTag,
          currentProductDeploymentId: error.currentProductDeploymentId ?? null,
        });
      }
      throw redactProviderFailure(error);
    }
    let after: WfpObservation;
    try {
      after = await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: input.candidate.productDeploymentId,
        knownDeployment: input.candidate,
        ...bindingExpectation(input.candidate),
      });
    } catch (error) {
      throw redactProviderFailure(error);
    }
    if (after.state !== "metadata_absent") {
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: after.providerTag,
        currentProductDeploymentId: after.productDeploymentId,
      });
    }
    return Object.freeze({
      status: "removed" as const,
      outcome: before.state === "metadata_absent" ? ("not_found" as const) : ("removed" as const),
      receipt,
    });
  };

  const observeCandidate = async (input: ObserveCandidateInput): Promise<WfpObservation> => {
    validateScope(input.scope);
    validateReceipt(input.candidate, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    try {
      return await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: input.candidate.productDeploymentId,
        knownDeployment: input.candidate,
        ...bindingExpectation(input.candidate),
      });
    } catch (error) {
      throw redactProviderFailure(error);
    }
  };

  const prepareExistingCandidate = async (
    input: PrepareExistingCandidateInput,
  ): Promise<PrepareExistingCandidateResult> => {
    if (
      !isUlid(input.artifactSourceDeploymentId) ||
      input.artifact.provenance.deploymentId !== input.artifactSourceDeploymentId
    ) {
      throw new WfpManagementInputError();
    }
    const runtimeSecretManifest = await validatedRuntimeSecretManifest(input.runtimeSecretManifest);
    validateReceipt(input.candidate, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    if (input.artifact.provenance.scope.projectId !== input.scope.projectId) {
      throw new WfpManagementInputError();
    }
    const checked = await checkArtifact(
      {
        ...input.scope,
        environmentId: input.artifact.provenance.scope.environmentId,
      },
      input.artifactSourceDeploymentId,
      input.artifact,
    );
    const nativeAuthBinding = await nativeAuthBindingForArtifact(
      dependencies,
      input.organizationId,
      input.scope,
      input.candidate.productDeploymentId,
      checked,
    );
    if (checked.manifest.artifactDigest !== input.candidate.artifactDigest) {
      throw new WfpManagementInputError();
    }
    const nextCacheBinding = await nextCacheBindingForArtifact(
      dependencies,
      input.organizationId,
      input.scope,
      input.candidate.productDeploymentId,
      checked,
    );
    const databaseRegistration = validateDatabaseRegistrationBinding(
      checked.manifest.database,
      input.databaseRegistration,
      input.organizationId,
      input.scope,
    );
    validateStorageBinding(checked.manifest.storage, input.storageBucketName, input.scope);
    const storageBinding = storageBindingForScope(
      checked.manifest.storage,
      input.storageDataEnvironmentId,
      databaseRegistration,
      input.organizationId,
      input.scope,
      dependencies.bindings,
    );
    const activationRuntimePolicy = projectGatewayRuntimePolicy(
      checked.manifest.runtimePolicy,
      runtimeSecretManifest,
      dependencies.bindings,
      checked.manifest.storage,
      storageBinding?.props,
    );
    const rollbackDatabaseDigest = await computeDatabaseBindingDigest(
      databaseBindingForScope(databaseRegistration, input.scope, dependencies.bindings),
      input.scope,
    );
    const rollbackStorageDigest = await computeStorageBindingDigest(
      storageBinding,
      input.scope,
      databaseBindingForScope(databaseRegistration, input.scope, dependencies.bindings),
    );
    const rollbackNativeDigest = await computeNativeAuthBindingDigest(
      nativeAuthBinding,
      input.scope,
      input.candidate.productDeploymentId,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const rollbackNextDigest = await computeNextCacheBindingDigest(
      nextCacheBinding,
      input.scope,
      input.candidate.productDeploymentId,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const rollbackCronDigest = checked.manifest.functions?.crons.length
      ? await digest(new TextEncoder().encode(JSON.stringify(checked.manifest.functions.crons)))
      : null;
    const rollbackBindingSetDigest = await computeBindingSetDigest(
      rollbackCronDigest,
      rollbackDatabaseDigest,
      rollbackStorageDigest,
      rollbackNativeDigest,
      rollbackNextDigest,
    );
    if ((input.candidate.bindingSetDigest ?? null) !== rollbackBindingSetDigest)
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: null,
        currentProductDeploymentId: null,
      });
    const observation = await dependencies.provider.observeCandidate({
      scope: input.scope,
      deploymentId: input.candidate.productDeploymentId,
      knownDeployment: input.candidate,
      expectedDatabaseBindingDigest: await computeDatabaseBindingDigest(
        databaseBindingForScope(databaseRegistration, input.scope, dependencies.bindings),
        input.scope,
      ),
      expectedStorageBindingDigest: await computeStorageBindingDigest(
        storageBinding,
        input.scope,
        databaseBindingForScope(databaseRegistration, input.scope, dependencies.bindings),
      ),
      expectedNativeAuthBindingDigest: await computeNativeAuthBindingDigest(
        nativeAuthBinding,
        input.scope,
        input.candidate.productDeploymentId,
        dependencies.bindings.WFP_DISPATCH_NAMESPACE,
      ),
      ...(rollbackBindingSetDigest === null
        ? {}
        : { expectedBindingSetDigest: rollbackBindingSetDigest }),
    });
    if (
      observation.state !== "ready" ||
      observation.reason === "candidate_bindings_outdated" ||
      observation.scriptName !== input.candidate.scriptName ||
      observation.providerTag !== input.candidate.providerTag ||
      observation.productDeploymentId !== input.candidate.productDeploymentId ||
      observation.artifactDigest !== input.candidate.artifactDigest
    ) {
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: observation.providerTag,
        currentProductDeploymentId: observation.productDeploymentId,
        ...(isOutdatedCandidateObservation(observation, input.candidate)
          ? { reason: "candidate_bindings_outdated" as const }
          : {}),
      });
    }
    const secretReconciliation = await synchronizePublishedSecrets(
      input.scope,
      runtimeSecretManifest,
      input.candidate,
    );
    if (secretReconciliation !== null) {
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "secrets" as const,
        currentProviderTag: secretReconciliation.currentProviderTag,
        currentProductDeploymentId: input.candidate.productDeploymentId,
      });
    }
    return Object.freeze({
      status: "prepared" as const,
      candidate: input.candidate,
      activationRuntimePolicy,
      runtimeSecretManifestDigest: runtimeSecretManifest.digest,
    });
  };

  const compensateActivation = async (
    input: CompensateActivationInput,
  ): Promise<CompensateActivationResult> => {
    validateCompensationInput(input);
    if (!isUlid(input.cleanupClaimId)) throw new WfpManagementInputError();
    let gateway: WfpProjectGatewayReceipt | WfpProjectGatewayAbsenceReceipt;
    try {
      gateway = readGatewayReceipt(
        await dependencies.gatewayRegistry.compensate({
          organizationId: input.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          operationId: input.operationId,
          claimId: input.claimId,
          expectedRevision: input.expectedGateway.revision,
        }),
      );
    } catch (error) {
      if (!isUncertainProviderError(error)) throw redactProviderFailure(error);
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "gateway" as const,
        currentProviderTag: error.currentProviderTag,
        currentProductDeploymentId: input.candidate.productDeploymentId,
      });
    }
    validateCompensatedGateway(gateway, input);
    await authorizeCandidateRemoval(
      { ...input, claimId: input.cleanupClaimId },
      input.candidate,
      input.expectedGateway.candidateReceiptId,
    );
    try {
      const candidate = await dependencies.provider.removeCandidate({
        scope: input.scope,
        expectedDeployment: input.candidate,
      });
      return Object.freeze({ status: "compensated" as const, gateway, candidate });
    } catch (error) {
      if (!isUncertainProviderError(error)) throw redactProviderFailure(error);
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "candidate" as const,
        currentProviderTag: error.currentProviderTag,
        currentProductDeploymentId: input.candidate.productDeploymentId,
      });
    }
  };

  function validateCompensatedGateway(
    gateway: WfpProjectGatewayReceipt,
    input: CompensateGatewayActivationInput,
  ): void {
    validateGatewayReceipt(gateway, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    const previous = input.previousGateway;
    if (
      gateway.organizationId !== input.organizationId ||
      gateway.operationId !== input.operationId ||
      gateway.revision <= input.expectedGateway.revision ||
      (previous === undefined
        ? gateway.active
        : !gateway.active ||
          gateway.targetDeploymentId !== previous.targetDeploymentId ||
          gateway.targetScriptName !== previous.targetScriptName ||
          gateway.targetArtifactDigest !== previous.targetArtifactDigest ||
          gateway.targetProviderTag !== previous.targetProviderTag)
    )
      throw new WfpManagementContractError();
  }

  function validateCompensationInput(input: CompensateGatewayActivationInput): void {
    validateScope(input.scope);
    if (
      ![input.organizationId, input.operationId, input.claimId].every(isUlid) ||
      input.expectedGateway.organizationId !== input.organizationId
    )
      throw new WfpManagementInputError();
    validateReceipt(input.candidate, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
    validateGatewayReceipt(
      input.expectedGateway,
      input.scope,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    if (input.expectedGateway.targetDeploymentId !== input.candidate.productDeploymentId) {
      throw new WfpManagementInputError();
    }
    if (input.previousGateway !== undefined) {
      if (input.previousGateway.organizationId !== input.organizationId)
        throw new WfpManagementInputError();
      validateGatewayReceipt(
        input.previousGateway,
        input.scope,
        dependencies.bindings.WFP_DISPATCH_NAMESPACE,
      );
    }
  }

  const compensateGatewayActivation = async (
    input: CompensateGatewayActivationInput,
  ): Promise<CompensateGatewayActivationResult> => {
    validateCompensationInput(input);
    try {
      const gateway = readGatewayReceipt(
        await dependencies.gatewayRegistry.compensate({
          organizationId: input.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          operationId: input.operationId,
          claimId: input.claimId,
          expectedRevision: input.expectedGateway.revision,
        }),
      );
      validateCompensatedGateway(gateway, input);
      return Object.freeze({
        status: "compensated" as const,
        gateway,
        candidateRetained: true as const,
      });
    } catch (error) {
      if (!isUncertainProviderError(error)) throw redactProviderFailure(error);
      return Object.freeze({
        status: "reconciliation_required" as const,
        reconciliationPhase: "gateway" as const,
        currentProviderTag: error.currentProviderTag,
        currentProductDeploymentId: input.candidate.productDeploymentId,
      });
    }
  };

  const syncRuntimeSecrets = async (
    input: SyncRuntimeSecretsInput,
  ): Promise<SyncRuntimeSecretsResult> => {
    validateScope(input.scope);
    validateReceipt(
      input.expectedDeployment,
      input.scope,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const manifest = await validatedRuntimeSecretManifest(input.runtimeSecretManifest);
    try {
      return Object.freeze({
        status: "synchronized" as const,
        receipt: await dependencies.provider.syncRuntimeSecrets({
          scope: input.scope,
          deployment: input.expectedDeployment,
          manifest,
        }),
      });
    } catch (error) {
      if (error instanceof CloudflareWfpSecretSyncUncertainError) {
        return Object.freeze({
          status: "reconciliation_required" as const,
          currentSecretNames:
            error.currentSecrets === null
              ? null
              : Object.freeze(error.currentSecrets.map((secret) => secret.name).sort()),
        });
      }
      throw redactProviderFailure(error);
    }
  };

  const finalizeRemoval = async (input: FinalizeRemovalInput): Promise<FinalizeRemovalResult> => {
    validateScope(input.scope);
    if (
      ![input.deploymentId, input.organizationId, input.operationId, input.claimId].every(isUlid) ||
      input.expectedGateway.organizationId !== input.organizationId
    )
      throw new WfpManagementInputError();
    const expectedGateway = Object.freeze({
      ...input.expectedGateway,
      observedAt:
        input.expectedGateway.observedAt instanceof Date
          ? input.expectedGateway.observedAt
          : new Date(String(input.expectedGateway.observedAt)),
    });
    validateGatewayReceipt(
      expectedGateway,
      input.scope,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const internalOrigin = publicOriginForScope(
      input.scope,
      dependencies.bindings.WFP_DISPATCH_NAMESPACE,
    );
    const removeGateway = async (): Promise<
      | { readonly status: "absent"; readonly receipt: WfpProjectGatewayAbsenceReceipt }
      | Extract<FinalizeRemovalResult, { readonly status: "reconciliation_required" }>
      | null
    > => {
      try {
        const receipt = readGatewayReceipt(
          await dependencies.gatewayRegistry.remove({
            organizationId: input.organizationId,
            projectId: input.scope.projectId,
            environmentId: input.scope.environmentId,
            operationId: input.operationId,
            claimId: input.claimId,
            expectedRevision: expectedGateway.revision,
          }),
        );
        validateGatewayReceipt(receipt, input.scope, dependencies.bindings.WFP_DISPATCH_NAMESPACE);
        if (
          receipt.active ||
          receipt.organizationId !== input.organizationId ||
          receipt.revision <= expectedGateway.revision
        )
          throw new WfpManagementContractError();
        return Object.freeze({ status: "absent" as const, receipt });
      } catch (error) {
        if (isProviderConflictError(error)) {
          return Object.freeze({
            status: "reconciliation_required" as const,
            reason: "provider_conflict" as const,
            currentProviderTag: error.currentProviderTag,
          });
        }
        if (isUncertainProviderError(error)) {
          return Object.freeze({
            status: "reconciliation_required" as const,
            reason: "stale_edge" as const,
            currentProviderTag: error.currentProviderTag,
          });
        }
        throw redactProviderFailure(error);
      }
    };
    if (expectedGateway.targetDeploymentId !== input.deploymentId) {
      throw new WfpManagementInputError();
    }
    const exactCandidate: WfpDeploymentReceipt = Object.freeze({
      provider: "cloudflare-wfp" as const,
      namespace: dependencies.bindings.WFP_DISPATCH_NAMESPACE,
      scriptName: expectedGateway.targetScriptName,
      projectId: input.scope.projectId,
      environmentId: input.scope.environmentId,
      productDeploymentId: expectedGateway.targetDeploymentId,
      providerTag: expectedGateway.targetProviderTag,
      artifactDigest: expectedGateway.targetArtifactDigest,
      buildReused: false,
      deployedAt: new Date(now()),
    });
    const gatewayResult = await removeGateway();
    if (gatewayResult?.status === "reconciliation_required") {
      return gatewayResult as FinalizeRemovalResult;
    }
    await authorizeCandidateRemoval(input, exactCandidate, expectedGateway.candidateReceiptId);
    let metadata: WfpMetadataAbsenceReceipt;
    try {
      metadata = await dependencies.provider.removeCandidate({
        scope: input.scope,
        expectedDeployment: exactCandidate,
      });
    } catch (error) {
      if (isProviderConflictError(error) || isUncertainProviderError(error)) {
        return Object.freeze({
          status: "reconciliation_required" as const,
          reason: isProviderConflictError(error)
            ? ("provider_conflict" as const)
            : ("stale_edge" as const),
          currentProviderTag: error.currentProviderTag,
        });
      }
      throw redactProviderFailure(error);
    }
    let after: WfpObservation;
    try {
      after = await dependencies.provider.observeCandidate({
        scope: input.scope,
        deploymentId: exactCandidate.productDeploymentId,
        knownDeployment: exactCandidate,
      });
    } catch (error) {
      throw redactProviderFailure(error);
    }
    if (after.state !== "metadata_absent") {
      return Object.freeze({
        status: "reconciliation_required" as const,
        reason: "provider_conflict" as const,
        currentProviderTag: after.providerTag,
      });
    }
    const proof = await dispatchIsSustainablyGone(
      dependencies,
      now,
      sleep,
      pollMilliseconds,
      probeTimeoutMilliseconds,
      deadlineMilliseconds,
      internalOrigin,
    );
    if (!proof.gone) {
      // Fixed codes and numeric observations only: never log the customer origin, scope, provider identity or error text.
      console.warn("wfp-management:removal-proof-uncertain", {
        reason: proof.reason,
        samples: proof.samples,
        lastStatus: proof.lastStatus,
        transportFailures: proof.transportFailures,
      });
      return Object.freeze({
        status: "reconciliation_required" as const,
        reason: "stale_edge" as const,
        currentProviderTag: exactCandidate.providerTag,
      });
    }
    return Object.freeze({
      status: "removed" as const,
      metadata,
      gateway: gatewayResult?.status === "absent" ? gatewayResult.receipt : null,
      consecutive404s: 3 as const,
    });
  };

  async function authorizeCandidateRemoval(
    input: { organizationId: string; operationId: string; claimId: string; scope: WfpScope },
    candidate: WfpDeploymentReceipt,
    candidateReceiptId: string,
  ): Promise<void> {
    if (![input.organizationId, input.operationId, input.claimId, candidateReceiptId].every(isUlid))
      throw new WfpManagementInputError();
    const result = await dependencies.gatewayRegistry.authorizeCandidateRemoval({
      organizationId: input.organizationId,
      projectId: input.scope.projectId,
      environmentId: input.scope.environmentId,
      operationId: input.operationId,
      claimId: input.claimId,
      candidateReceiptId,
      productDeploymentId: candidate.productDeploymentId,
      scriptName: candidate.scriptName,
      providerTag: candidate.providerTag,
    });
    if (!isRecord(result) || !hasExactKeys(result, ["authorized"]) || result["authorized"] !== true)
      throw new WfpManagementInputError();
  }

  return Object.freeze({
    fetch: async (): Promise<Response> => new Response("Not Found", { status: 404 }),
    stageVerifiedArtifact,
    activateCandidate,
    observeActivation,
    compensateActivation,
    compensateGatewayActivation,
    observeCandidate,
    prepareExistingCandidate,
    removeCandidate,
    syncRuntimeSecrets,
    finalizeRemoval,
  });
}

async function validatedRuntimeSecretManifest(
  value: RuntimeSecretManifest,
): Promise<RuntimeSecretManifest> {
  const manifest = await createRuntimeSecretManifest(value?.secrets ?? []);
  if (manifest.digest !== value?.digest) throw new WfpManagementInputError();
  return manifest;
}

async function dispatchIsSustainablyGone(
  dependencies: WfpManagementDependencies,
  now: () => Date,
  sleep: (milliseconds: number) => Promise<void>,
  pollMilliseconds: number,
  probeTimeoutMilliseconds: number,
  deadlineMilliseconds: number,
  internalOrigin: string,
): Promise<RemovalProbeResult> {
  const startedAt = checkedTime(now);
  const maximumSamples = Math.max(3, Math.ceil(deadlineMilliseconds / pollMilliseconds));
  let consecutiveNotFound = 0;
  let samples = 0;
  let lastStatus: number | null = null;
  let transportFailures = 0;
  for (let sample = 0; sample < maximumSamples; sample += 1) {
    const remaining = deadlineMilliseconds - (checkedTime(now) - startedAt);
    if (remaining <= 0) break;
    samples += 1;
    try {
      const response = await dependencies.fetch(`${internalOrigin}/`, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(Math.min(probeTimeoutMilliseconds, remaining)),
      });
      lastStatus = response.status;
      await response.body?.cancel();
      if (checkedTime(now) - startedAt >= deadlineMilliseconds) break;
      consecutiveNotFound = response.status === 404 ? consecutiveNotFound + 1 : 0;
      if (consecutiveNotFound >= 3) return { gone: true };
    } catch {
      // A transport error is no absence observation. Retry inside the same deadline and require three fresh actual 404s.
      transportFailures += 1;
      lastStatus = null;
      consecutiveNotFound = 0;
    }
    const wait = Math.min(pollMilliseconds, deadlineMilliseconds - (checkedTime(now) - startedAt));
    if (wait <= 0) break;
    await sleep(wait);
  }
  return {
    gone: false,
    reason: lastStatus === null ? "transport_failure" : lastStatus === 404 ? "deadline" : "non_404",
    samples,
    lastStatus,
    transportFailures,
  };
}

async function checkArtifact(
  scope: WfpScope,
  deploymentId: string,
  artifact: VerifiedArtifactBundle,
): Promise<CheckedArtifact> {
  validateScope(scope);
  if (!isUlid(deploymentId) || !isDigest(artifact.manifestDigest)) {
    throw new WfpManagementInputError();
  }
  const manifestDigest = await digest(artifact.manifestBody);
  if (
    manifestDigest !== artifact.manifestDigest ||
    artifact.manifestBody.byteLength > MAX_MANIFEST_BYTES
  ) {
    throw new WfpManagementInputError();
  }
  let parsed: unknown;
  try {
    validateJsonComplexity(artifact.manifestBody);
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.manifestBody));
  } catch {
    throw new WfpManagementInputError();
  }
  const manifest = parseManifest(parsed, scope, deploymentId);
  validateProvenance(artifact.provenance, manifest, artifact.manifestDigest);
  if (artifact.sbomBody.byteLength > MAX_SBOM_BYTES) throw new WfpManagementInputError();
  if ((await digest(artifact.sbomBody)) !== manifest.sbom.digest)
    throw new WfpManagementInputError();
  validateSbom(artifact.sbomBody);
  const filesByPath = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const file of artifact.files) {
    validateAssetPath(file.path);
    if (filesByPath.has(file.path) || file.body.byteLength > MAX_ASSET_BYTES) {
      throw new WfpManagementInputError();
    }
    totalBytes += file.body.byteLength;
    if (totalBytes > MAX_ARTIFACT_BYTES) throw new WfpManagementInputError();
    filesByPath.set(file.path, file.body);
  }
  if (filesByPath.size !== manifest.assets.length) throw new WfpManagementInputError();
  for (const asset of manifest.assets) {
    const body = filesByPath.get(asset.path);
    if (
      body === undefined ||
      body.byteLength !== asset.size ||
      (await digest(body)) !== asset.digest
    ) {
      throw new WfpManagementInputError();
    }
  }
  const modulesByPath = new Map<string, Uint8Array>();
  for (const module of artifact.modules) {
    const data = module.contentType === "application/octet-stream";
    validateModulePath(module.path, data);
    if (
      modulesByPath.has(module.path) ||
      (data
        ? manifest.runtime?.entryWrapperVersion !== "nextjs-opennext-wrapper-v1"
        : module.contentType !==
          (module.path.endsWith(".wasm") ? "application/wasm" : "application/javascript+module")) ||
      module.body.byteLength !== module.size ||
      module.body.byteLength > MAX_MODULE_BYTES ||
      (await digest(module.body)) !== module.digest
    ) {
      throw new WfpManagementInputError();
    }
    totalBytes += module.body.byteLength;
    if (totalBytes > MAX_ARTIFACT_BYTES) throw new WfpManagementInputError();
    modulesByPath.set(module.path, module.body);
  }
  if (
    modulesByPath.size !== manifest.modules.length ||
    JSON.stringify(artifact.runtime) !== JSON.stringify(manifest.runtime)
  ) {
    throw new WfpManagementInputError();
  }
  for (const module of manifest.modules) {
    const body = modulesByPath.get(module.path);
    if (
      body === undefined ||
      body.byteLength !== module.size ||
      (await digest(body)) !== module.digest
    ) {
      throw new WfpManagementInputError();
    }
  }
  if (
    manifest.runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1" &&
    !(await hasMaximumGzipSize(modulesByPath.values(), MAX_NEXTJS_COMPRESSED_MODULE_BYTES))
  ) {
    throw new WfpManagementInputError();
  }
  const migrationsByPath = new Map<string, Uint8Array>();
  if (!Array.isArray(artifact.migrations)) throw new WfpManagementInputError();
  let migrationBytes = 0;
  for (const migration of artifact.migrations) {
    validateMigrationPath(migration.path);
    if (
      migrationsByPath.has(migration.path) ||
      migration.body.byteLength !== migration.size ||
      migration.body.byteLength > MAX_MIGRATION_BYTES ||
      (await digest(migration.body)) !== migration.digest
    ) {
      throw new WfpManagementInputError();
    }
    migrationBytes += migration.body.byteLength;
    if (migrationBytes > MAX_MIGRATION_TOTAL_BYTES) throw new WfpManagementInputError();
    migrationsByPath.set(migration.path, migration.body);
  }
  if (migrationsByPath.size !== manifest.migrations.length) {
    throw new WfpManagementInputError();
  }
  for (const migration of manifest.migrations) {
    if (migrationsByPath.get(migration.path) === undefined) throw new WfpManagementInputError();
  }
  const artifactDigestPreimage =
    manifest.runtime === null
      ? {
          applicationRoot: manifest.applicationRoot,
          frameworkPlanSchemaVersion: manifest.frameworkPlanSchemaVersion,
          runtimePolicy: manifest.runtimePolicy,
          database: manifest.database,
          auth: manifest.auth,
          storage: manifest.storage,
          ...(manifest.functions === undefined ? {} : { functions: manifest.functions }),
          ...(manifest.database.enabled ? { migrations: manifest.migrations } : {}),
          assets: manifest.assets,
        }
      : {
          applicationRoot: manifest.applicationRoot,
          frameworkPlanSchemaVersion: manifest.frameworkPlanSchemaVersion,
          runtimePolicy: manifest.runtimePolicy,
          database: manifest.database,
          auth: manifest.auth,
          storage: manifest.storage,
          ...(manifest.functions === undefined ? {} : { functions: manifest.functions }),
          ...(manifest.database.enabled ? { migrations: manifest.migrations } : {}),
          runtime: manifest.runtime,
          assets: manifest.assets,
          modules: manifest.modules,
        };
  if (
    (await digest(new TextEncoder().encode(JSON.stringify(artifactDigestPreimage)))) !==
    manifest.artifactDigest
  ) {
    throw new WfpManagementInputError();
  }
  return Object.freeze({ manifest, filesByPath, modulesByPath, migrationsByPath });
}

function healthReconciliation(receipt: WfpDeploymentReceipt): SecretSyncReconciliation {
  return Object.freeze({
    status: "reconciliation_required" as const,
    reconciliationPhase: "wfp" as const,
    currentProviderTag: receipt.providerTag,
    currentProductDeploymentId: receipt.productDeploymentId,
  });
}

function parseManifest(value: unknown, scope: WfpScope, deploymentId: string): ArtifactManifest {
  if (!isRecord(value)) throw new WfpManagementInputError();
  const migrationEnabled = isRecord(value["database"]) && value["database"]["enabled"] === true;
  const commonKeys = [
    "schemaVersion",
    "projectId",
    "environmentId",
    "deploymentId",
    "operationId",
    "buildId",
    "sourceCommit",
    "sourceDigest",
    "buildPlanDigest",
    "artifactDigest",
    "sbom",
    "assets",
    "applicationRoot",
    "frameworkPlanSchemaVersion",
    "runtimePolicy",
    "database",
    "auth",
    "storage",
    "lifecycleEvidence",
    ...(Object.hasOwn(value, "functions") ? ["functions"] : []),
    ...(migrationEnabled ? ["migrations"] : []),
  ];
  const edge = Object.hasOwn(value, "runtime") || Object.hasOwn(value, "modules");
  if (!hasExactKeys(value, edge ? [...commonKeys, "runtime", "modules"] : commonKeys)) {
    throw new WfpManagementInputError();
  }
  const sbom = value["sbom"];
  const assets = value["assets"];
  const functionsRuntime =
    isRecord(value["runtime"]) && value["runtime"]["entryWrapperVersion"] === "functions-v1";
  if (
    value["schemaVersion"] !== "ohmyhost.artifact/v3" ||
    value["projectId"] !== scope.projectId ||
    value["environmentId"] !== scope.environmentId ||
    value["deploymentId"] !== deploymentId ||
    !isUlid(value["operationId"]) ||
    typeof value["buildId"] !== "string" ||
    value["buildId"].length === 0 ||
    value["buildId"].length > 512 ||
    typeof value["sourceCommit"] !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value["sourceCommit"]) ||
    !isDigest(value["sourceDigest"]) ||
    !isDigest(value["buildPlanDigest"]) ||
    value["frameworkPlanSchemaVersion"] !== "ohmyhost.framework-plan/v5" ||
    !validApplicationRoot(value["applicationRoot"]) ||
    !validRuntimePolicy(value["runtimePolicy"]) ||
    !validDatabaseRequirement(value["database"]) ||
    !validCustomerAuthRequirement(value["auth"]) ||
    !validStorageRequirement(value["storage"]) ||
    (isRecord(value["auth"]) &&
      value["auth"]["provider"] === "better-auth" &&
      isRecord(value["database"]) &&
      value["database"]["enabled"] !== true) ||
    !isDigest(value["artifactDigest"]) ||
    !isRecord(sbom) ||
    !hasExactKeys(sbom, ["path", "digest"]) ||
    sbom["path"] !== "sbom.cdx.json" ||
    !isDigest(sbom["digest"]) ||
    !Array.isArray(assets) ||
    (assets.length === 0) !== functionsRuntime ||
    assets.length > MAX_ASSET_COUNT
  )
    throw new WfpManagementInputError();
  let previousPath = "";
  const checkedAssets = assets.map((asset) => {
    if (!isRecord(asset) || !hasExactKeys(asset, ["path", "digest", "size"])) {
      throw new WfpManagementInputError();
    }
    const path = asset["path"];
    validateAssetPath(path);
    if (
      path <= previousPath ||
      !isDigest(asset["digest"]) ||
      !Number.isSafeInteger(asset["size"]) ||
      Number(asset["size"]) < 0 ||
      Number(asset["size"]) > MAX_ASSET_BYTES
    )
      throw new WfpManagementInputError();
    previousPath = path;
    return Object.freeze({ path, digest: asset["digest"], size: Number(asset["size"]) });
  });
  const checkedMigrations = migrationEnabled
    ? parseArtifactMigrations(value["migrations"])
    : Object.freeze([]);
  const auth = parseCustomerAuthRequirement(value["auth"]);
  const storage = parseStorageRequirement(value["storage"]);
  let lifecycleEvidence: VerifiedBuildLifecycleEvidence;
  try {
    lifecycleEvidence = parseVerifiedBuildLifecycleEvidence(value["lifecycleEvidence"]);
  } catch {
    throw new WfpManagementInputError();
  }
  if (
    lifecycleEvidence.frameworkBuild.frameworkPlanSha256 !==
      String(value["buildPlanDigest"]).slice("sha256:".length) ||
    lifecycleEvidence.buildSandbox.sourceArchiveSha256 !==
      String(value["sourceDigest"]).slice("sha256:".length) ||
    lifecycleEvidence.buildSandbox.buildId !== value["buildId"]
  ) {
    throw new WfpManagementInputError();
  }
  const functions = Object.hasOwn(value, "functions")
    ? parseFunctionsRequirement(value["functions"])
    : undefined;
  let runtime: SupportedArtifactRuntime | null = null;
  let modules: readonly Omit<VerifiedArtifactModule, "body">[] = Object.freeze([]);
  if (edge) {
    runtime = parseEdgeRuntime(value["runtime"]);
    modules = parseEdgeModules(value["modules"], runtime, functions);
  }
  if (
    (runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1") !==
    (lifecycleEvidence.frameworkBuild.framework === "nextjs" &&
      lifecycleEvidence.frameworkBuild.runtime === "edge")
  )
    throw new WfpManagementInputError();
  let publicBytes = 0;
  let cacheBytes = 0;
  for (const asset of checkedAssets) {
    if (
      runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1" &&
      asset.path.startsWith("/cdn-cgi/_next_cache/")
    )
      cacheBytes += asset.size;
    else publicBytes += asset.size;
  }
  if (
    publicBytes > MAX_PUBLIC_ASSET_TOTAL_BYTES ||
    cacheBytes > (runtime?.ssgCacheMaxBytes ?? DEFAULT_SSG_CACHE_MAX_BYTES)
  )
    throw new WfpManagementInputError();
  if ((runtime?.entryWrapperVersion === "functions-v1") !== (checkedAssets.length === 0)) {
    throw new WfpManagementInputError();
  }
  if (
    auth.provider === "better-auth" &&
    (runtime === null ||
      (runtime.entryWrapperVersion === "vite-api-companion-v1" ||
      runtime.entryWrapperVersion === "functions-v1"
        ? auth.deployment !== "companion"
        : auth.deployment !== "embedded"))
  )
    throw new WfpManagementInputError();
  if (storage.enabled && runtime === null) throw new WfpManagementInputError();
  if (functions !== undefined && runtime === null) throw new WfpManagementInputError();
  return Object.freeze({
    schemaVersion: "ohmyhost.artifact/v3",
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    deploymentId,
    operationId: value["operationId"],
    buildId: value["buildId"],
    sourceCommit: value["sourceCommit"],
    sourceDigest: value["sourceDigest"],
    buildPlanDigest: value["buildPlanDigest"],
    lifecycleEvidence,
    applicationRoot: String(value["applicationRoot"]),
    frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5",
    runtimePolicy: parseRuntimePolicy(value["runtimePolicy"]),
    database: parseDatabaseRequirement(value["database"]),
    auth,
    storage,
    ...(functions === undefined ? {} : { functions }),
    artifactDigest: value["artifactDigest"],
    sbom: Object.freeze({ path: "sbom.cdx.json" as const, digest: sbom["digest"] }),
    assets: Object.freeze(checkedAssets),
    runtime,
    modules,
    migrations: checkedMigrations,
  });
}

function parseArtifactMigrations(
  value: unknown,
): readonly Omit<VerifiedArtifactMigration, "body">[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MIGRATION_COUNT) {
    throw new WfpManagementInputError();
  }
  let previous = "";
  let totalBytes = 0;
  return Object.freeze(
    value.map((candidate) => {
      if (!isRecord(candidate) || !hasExactKeys(candidate, ["path", "digest", "size"])) {
        throw new WfpManagementInputError();
      }
      validateMigrationPath(candidate["path"]);
      const size = candidate["size"];
      if (
        candidate["path"] <= previous ||
        !isDigest(candidate["digest"]) ||
        !Number.isSafeInteger(size) ||
        Number(size) < 1 ||
        Number(size) > MAX_MIGRATION_BYTES
      ) {
        throw new WfpManagementInputError();
      }
      totalBytes += Number(size);
      if (totalBytes > MAX_MIGRATION_TOTAL_BYTES) throw new WfpManagementInputError();
      previous = candidate["path"];
      return Object.freeze({
        path: candidate["path"],
        digest: candidate["digest"],
        size: Number(size),
      });
    }),
  );
}

function parseEdgeRuntime(value: unknown): SupportedArtifactRuntime {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "mainModule",
      "compatibilityDate",
      "compatibilityFlags",
      "entryWrapperVersion",
      ...(Object.hasOwn(value, "ssgCacheMaxBytes") ? ["ssgCacheMaxBytes"] : []),
      ...(Object.hasOwn(value, "nextRevalidatePath") ? ["nextRevalidatePath"] : []),
    ]) ||
    value["kind"] !== "cloudflare-worker" ||
    value["mainModule"] !== "index.js" ||
    typeof value["compatibilityDate"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value["compatibilityDate"]) ||
    (value["entryWrapperVersion"] === "nextjs-opennext-wrapper-v1"
      ? value["compatibilityDate"] < "2024-09-23"
      : value["entryWrapperVersion"] === "astro-edge-wrapper-v1"
        ? value["compatibilityDate"] < "2026-10-12"
        : value["entryWrapperVersion"] === "vite-api-companion-v1" ||
            value["entryWrapperVersion"] === "functions-v1"
          ? value["compatibilityDate"] !== "2025-01-01"
          : value["compatibilityDate"] < "2025-04-01") ||
    !Array.isArray(value["compatibilityFlags"]) ||
    value["compatibilityFlags"].length !== 1 ||
    value["compatibilityFlags"][0] !== "nodejs_compat" ||
    (value["entryWrapperVersion"] !== "astro-edge-wrapper-v1" &&
      value["entryWrapperVersion"] !== "tanstack-edge-wrapper-v1" &&
      value["entryWrapperVersion"] !== "nextjs-opennext-wrapper-v1" &&
      value["entryWrapperVersion"] !== "vite-api-companion-v1" &&
      value["entryWrapperVersion"] !== "functions-v1")
  ) {
    throw new WfpManagementInputError();
  }
  if (
    Object.hasOwn(value, "ssgCacheMaxBytes") &&
    (value["entryWrapperVersion"] !== "nextjs-opennext-wrapper-v1" ||
      !Number.isSafeInteger(value["ssgCacheMaxBytes"]) ||
      Number(value["ssgCacheMaxBytes"]) < 1024 * 1024 ||
      Number(value["ssgCacheMaxBytes"]) > 64 * 1024 * 1024 ||
      Number(value["ssgCacheMaxBytes"]) % (1024 * 1024) !== 0)
  )
    throw new WfpManagementInputError();
  if (
    Object.hasOwn(value, "nextRevalidatePath") &&
    (value["entryWrapperVersion"] !== "nextjs-opennext-wrapper-v1" ||
      value["nextRevalidatePath"] !== true)
  )
    throw new WfpManagementInputError();
  return Object.freeze({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: value["compatibilityDate"],
    compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
    entryWrapperVersion: value["entryWrapperVersion"],
    ...(Object.hasOwn(value, "ssgCacheMaxBytes")
      ? { ssgCacheMaxBytes: Number(value["ssgCacheMaxBytes"]) }
      : {}),
    ...(value["nextRevalidatePath"] === true ? { nextRevalidatePath: true as const } : {}),
  });
}

function parseEdgeModules(
  value: unknown,
  runtime: SupportedArtifactRuntime,
  functions: FunctionsRequirement | undefined,
): readonly Omit<VerifiedArtifactModule, "body">[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODULE_COUNT) {
    throw new WfpManagementInputError();
  }
  let previous = "";
  const modules = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["path", "contentType", "digest", "size"])
    ) {
      throw new WfpManagementInputError();
    }
    const path = candidate["path"];
    const data = candidate["contentType"] === "application/octet-stream";
    validateModulePath(path, data);
    if (
      path <= previous ||
      (data
        ? runtime.entryWrapperVersion !== "nextjs-opennext-wrapper-v1"
        : candidate["contentType"] !==
          (path.endsWith(".wasm") ? "application/wasm" : "application/javascript+module")) ||
      !isDigest(candidate["digest"]) ||
      !Number.isSafeInteger(candidate["size"]) ||
      Number(candidate["size"]) < (data ? 0 : 1) ||
      Number(candidate["size"]) >
        (runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1" && path === runtime.mainModule
          ? MAX_MODULE_BYTES
          : 5_242_880)
    ) {
      throw new WfpManagementInputError();
    }
    previous = path;
    return Object.freeze({
      path,
      contentType: candidate["contentType"] as VerifiedArtifactModule["contentType"],
      digest: candidate["digest"],
      size: Number(candidate["size"]),
    });
  });
  if (!modules.some((module) => module.path === runtime.mainModule)) {
    throw new WfpManagementInputError();
  }
  const workerModule = modules.some(({ path }) => path === FUNCTIONS_WORKER_MODULE);
  const frameworkWorker =
    runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1" ||
    runtime.entryWrapperVersion === "tanstack-edge-wrapper-v1" ||
    runtime.entryWrapperVersion === "astro-edge-wrapper-v1";
  if (
    (frameworkWorker ? workerModule !== (functions !== undefined) : workerModule) ||
    modules.reduce((total, module) => total + module.size, 0) >
      (runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1" ? MAX_MODULE_BYTES : 10_485_760)
  ) {
    throw new WfpManagementInputError();
  }
  return Object.freeze(modules);
}

async function hasMaximumGzipSize(
  bodies: Iterable<Uint8Array>,
  maximumBytes: number,
): Promise<boolean> {
  try {
    let byteLength = 0;
    for (const body of bodies) {
      let offset = 0;
      const inputByteLength = body.byteLength;
      // These verified views belong to the private artifact reader. A Blob would snapshot the
      // whole module again; bounded views keep only the compression stream's current input live.
      const reader = new ReadableStream<BufferSource>({
        pull(controller) {
          if (offset === inputByteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 65_536, inputByteLength);
          controller.enqueue(body.subarray(offset, end) as Uint8Array<ArrayBuffer>);
          offset = end;
        },
      })
        .pipeThrough(new CompressionStream("gzip"))
        .getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        byteLength += item.value.byteLength;
        if (byteLength > maximumBytes) {
          await reader.cancel();
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function validateModulePath(value: unknown, data = false): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 248 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    (data
      ? /\.(?:[cm]?js|wasm|node)$/iu.test(value)
      : !value.endsWith(".js") && !value.endsWith(".mjs") && !value.endsWith(".wasm")) ||
    value.toLowerCase() === EDGE_WRAPPER_MODULE ||
    value.toLowerCase().split("/").at(-1) === "metadata" ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !(data ? /^[A-Za-z0-9._@/+-]+$/u : /^[A-Za-z0-9._/-]+$/u).test(value)
  ) {
    throw new WfpManagementInputError();
  }
}

function validateMigrationPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 248 ||
    !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/u.test(value)
  ) {
    throw new WfpManagementInputError();
  }
}

function validateProvenance(
  provenance: VerifiedArtifactBundle["provenance"],
  manifest: ArtifactManifest,
  manifestDigest: `sha256:${string}`,
): void {
  const provenanceKeys = [
    "scope",
    "deploymentId",
    "buildId",
    "sourceCommit",
    "sourceDigest",
    "buildPlanDigest",
    "artifactDigest",
    "output",
    "applicationRoot",
    "frameworkPlanSchemaVersion",
    "runtimePolicy",
    "database",
    "auth",
    "storage",
    "lifecycleEvidence",
    ...(manifest.functions === undefined ? [] : ["functions"]),
  ];
  if (
    !isRecord(provenance) ||
    !hasExactKeys(provenance, provenanceKeys) ||
    !isRecord(provenance["scope"]) ||
    !hasExactKeys(provenance["scope"], ["projectId", "environmentId", "operationId"]) ||
    provenance["scope"]["projectId"] !== manifest.projectId ||
    provenance["scope"]["environmentId"] !== manifest.environmentId ||
    provenance["scope"]["operationId"] !== manifest.operationId ||
    provenance["deploymentId"] !== manifest.deploymentId ||
    provenance["buildId"] !== manifest.buildId ||
    provenance["sourceCommit"] !== manifest.sourceCommit ||
    provenance["sourceDigest"] !== manifest.sourceDigest ||
    provenance["buildPlanDigest"] !== manifest.buildPlanDigest ||
    provenance["applicationRoot"] !== manifest.applicationRoot ||
    provenance["frameworkPlanSchemaVersion"] !== "ohmyhost.framework-plan/v5" ||
    JSON.stringify(provenance["runtimePolicy"]) !== JSON.stringify(manifest.runtimePolicy) ||
    JSON.stringify(provenance["database"]) !== JSON.stringify(manifest.database) ||
    JSON.stringify(provenance["auth"]) !== JSON.stringify(manifest.auth) ||
    JSON.stringify(provenance["storage"]) !== JSON.stringify(manifest.storage) ||
    JSON.stringify(provenance["lifecycleEvidence"]) !==
      JSON.stringify(manifest.lifecycleEvidence) ||
    (manifest.functions === undefined
      ? Object.hasOwn(provenance, "functions")
      : JSON.stringify(provenance["functions"]) !== JSON.stringify(manifest.functions)) ||
    provenance["artifactDigest"] !== manifest.artifactDigest ||
    !isRecord(provenance["output"]) ||
    !hasExactKeys(provenance["output"], [
      "bucket",
      "key",
      "versionId",
      "eTag",
      "byteLength",
      "sha256",
    ]) ||
    typeof provenance["output"]["bucket"] !== "string" ||
    provenance["output"]["bucket"].length === 0 ||
    typeof provenance["output"]["key"] !== "string" ||
    provenance["output"]["key"] !==
      `runs/${manifest.projectId}/${manifest.environmentId}/${manifest.operationId}/output/bundle.tar.gz` ||
    typeof provenance["output"]["versionId"] !== "string" ||
    String(provenance["output"]["versionId"]).length === 0 ||
    typeof provenance["output"]["eTag"] !== "string" ||
    !/^"[^"\r\n]{1,256}"$/u.test(String(provenance["output"]["eTag"])) ||
    !Number.isSafeInteger(provenance["output"]["byteLength"]) ||
    Number(provenance["output"]["byteLength"]) <= 0 ||
    Number(provenance["output"]["byteLength"]) > MAX_BUNDLE_BYTES ||
    !/^[0-9a-f]{64}$/u.test(String(provenance["output"]["sha256"])) ||
    !isDigest(manifestDigest)
  ) {
    throw new WfpManagementInputError();
  }
}

function validApplicationRoot(value: unknown): value is string {
  const encoder = new TextEncoder();
  if (
    typeof value !== "string" ||
    encoder.encode(value).byteLength > 64 ||
    !/^(?:\.|[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.test(value)
  ) {
    return false;
  }
  const segments = value === "." ? [] : value.split("/");
  return (
    segments.length <= 8 && segments.every((segment) => encoder.encode(segment).byteLength <= 63)
  );
}

function validRuntimePolicy(value: unknown): value is RuntimePolicy {
  try {
    parseWfpRuntimePolicy(value);
    return true;
  } catch {
    return false;
  }
}

function parseRuntimePolicy(value: unknown): RuntimePolicy {
  try {
    return parseWfpRuntimePolicy(value);
  } catch {
    throw new WfpManagementInputError();
  }
}

function validDatabaseRequirement(value: unknown): value is DatabaseRequirement {
  if (!isRecord(value)) return false;
  if (value["enabled"] === false) return hasExactKeys(value, ["enabled"]);
  return (
    value["enabled"] === true &&
    hasExactKeys(value, ["enabled", "migrations"]) &&
    typeof value["migrations"] === "string" &&
    value["migrations"].length > 0 &&
    value["migrations"].length <= 512 &&
    !value["migrations"].startsWith("/") &&
    !/[\\:]/u.test(value["migrations"]) &&
    !value["migrations"].split("/").includes("..")
  );
}

function parseDatabaseRequirement(value: unknown): DatabaseRequirement {
  if (!validDatabaseRequirement(value)) throw new WfpManagementInputError();
  return value.enabled
    ? Object.freeze({ enabled: true as const, migrations: value.migrations })
    : Object.freeze({ enabled: false as const });
}

function validCustomerAuthRequirement(value: unknown): value is CustomerAuthRequirement {
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ["provider"]) && value["provider"] === "none") return true;
  if (value["provider"] === "omh-native")
    return (
      hasExactKeys(value, ["provider", "routePath", "bindingName"]) &&
      value["routePath"] === "/api/auth/v1" &&
      value["bindingName"] === "OHMYHOST_AUTH"
    );
  return (
    hasExactKeys(value, [
      "authSecretName",
      "databaseSchema",
      "databaseBindingName",
      "deployment",
      "provider",
      "routePath",
      "version",
    ]) &&
    value["provider"] === "better-auth" &&
    isRecordedBetterAuthVersion(value["version"]) &&
    (value["deployment"] === "embedded" || value["deployment"] === "companion") &&
    value["routePath"] === "/api/auth" &&
    value["databaseSchema"] === "auth" &&
    value["databaseBindingName"] === "OHMYHOST_DATABASE" &&
    value["authSecretName"] === "BETTER_AUTH_SECRET"
  );
}

function parseCustomerAuthRequirement(value: unknown): CustomerAuthRequirement {
  if (!validCustomerAuthRequirement(value)) throw new WfpManagementInputError();
  if (value.provider === "none") return Object.freeze({ provider: "none" as const });
  if (value.provider === "omh-native")
    return Object.freeze({
      provider: "omh-native" as const,
      routePath: "/api/auth/v1" as const,
      bindingName: "OHMYHOST_AUTH" as const,
    });
  return Object.freeze({
    provider: "better-auth" as const,
    version: value.version,
    deployment: value.deployment,
    routePath: "/api/auth" as const,
    databaseSchema: "auth" as const,
    databaseBindingName: "OHMYHOST_DATABASE" as const,
    authSecretName: "BETTER_AUTH_SECRET" as const,
  });
}

function validStorageRequirement(value: unknown): value is StorageRequirement {
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ["enabled"]) && value["enabled"] === false) return true;
  return (
    hasExactKeys(value, ["enabled", "jurisdiction", "provider", "public"]) &&
    value["enabled"] === true &&
    value["provider"] === "r2" &&
    (value["jurisdiction"] === "eu" || value["jurisdiction"] === "us") &&
    value["public"] === false
  );
}

function parseStorageRequirement(value: unknown): StorageRequirement {
  if (!validStorageRequirement(value)) throw new WfpManagementInputError();
  return value.enabled
    ? Object.freeze({
        enabled: true as const,
        provider: "r2" as const,
        jurisdiction: value.jurisdiction,
        public: false as const,
      })
    : Object.freeze({ enabled: false as const });
}

function parseFunctionsRequirement(value: unknown): FunctionsRequirement {
  if (!isRecord(value) || !hasExactKeys(value, ["crons"]) || !Array.isArray(value["crons"])) {
    throw new WfpManagementInputError();
  }
  let crons: readonly string[];
  try {
    crons = normalizeCrons(value["crons"]);
  } catch {
    throw new WfpManagementInputError();
  }
  if (JSON.stringify(crons) !== JSON.stringify(value["crons"])) {
    throw new WfpManagementInputError();
  }
  return Object.freeze({ crons });
}

function projectGatewayRuntimePolicy(
  runtimePolicy: RuntimePolicy,
  runtimeSecretManifest: RuntimeSecretManifest,
  bindings: WfpManagementBindings,
  storage: StorageRequirement,
  storageScope: WfpStorageBinding["props"] | undefined,
): RuntimePolicy {
  // Runtime policy is customer-authored; only these held-key branches may inject gateway names.
  if (
    runtimePolicy.egressAllowedOrigins.some(
      (origin) => classifyPlatformGatewayHostname(new URL(origin).hostname) !== null,
    )
  )
    throw new WfpManagementInputError();
  if (storage.enabled !== (storageScope !== undefined)) throw new WfpManagementInputError();
  const storageOrigin =
    storageScope === undefined
      ? null
      : createPinnedStorageGatewayOrigin(bindings.WFP_STORAGE_GATEWAY_ORIGIN, storageScope);
  const origins = [...runtimePolicy.egressAllowedOrigins];
  if (
    runtimeSecretManifest.secrets.some((secret) => secret.name === "OHMYHOST_MAIL_KEY") &&
    !origins.includes(bindings.WFP_MAIL_GATEWAY_ORIGIN)
  ) {
    origins.push(bindings.WFP_MAIL_GATEWAY_ORIGIN);
  }
  if (
    runtimeSecretManifest.secrets.some((secret) => secret.name === "OHMYHOST_STORAGE_KEY") &&
    storageOrigin !== null &&
    !origins.includes(storageOrigin)
  ) {
    origins.push(storageOrigin);
  }
  const r2Origin = storage.enabled
    ? `https://${bindings.WFP_ACCOUNT_ID}.${storage.jurisdiction}.r2.cloudflarestorage.com`
    : null;
  if (
    runtimeSecretManifest.secrets.some((secret) => secret.name === "OHMYHOST_STORAGE_KEY") &&
    r2Origin !== null &&
    !origins.includes(r2Origin)
  ) {
    origins.push(r2Origin);
  }
  if (
    runtimeSecretManifest.secrets.some((secret) => secret.name === AI_KEY_NAME) &&
    !origins.includes(bindings.WFP_AI_GATEWAY_ORIGIN)
  ) {
    origins.push(bindings.WFP_AI_GATEWAY_ORIGIN);
  }
  const browserOrigin =
    bindings.WFP_AI_GATEWAY_ORIGIN === AI_GATEWAY_ORIGIN_PRODUCTION
      ? BROWSER_GATEWAY_ORIGIN_PRODUCTION
      : BROWSER_GATEWAY_ORIGIN_DEVELOPMENT;
  if (
    runtimeSecretManifest.secrets.some((secret) => secret.name === BROWSER_KEY_NAME) &&
    !origins.includes(browserOrigin)
  )
    origins.push(browserOrigin);
  // The activation list holds at most 16 origins (gateway routing); fail before any provider mutation.
  if (origins.length > 16) throw new WfpManagementInputError();
  origins.sort();
  return Object.freeze({
    healthCheckPath: runtimePolicy.healthCheckPath,
    egressAllowedOrigins: Object.freeze(origins),
    ...(runtimePolicy.browser === undefined ? {} : { browser: runtimePolicy.browser }),
  });
}

async function prepareProviderArtifact(
  dependencies: WfpManagementDependencies,
  scope: WfpScope,
  deploymentId: string,
  artifact: CheckedArtifact,
  runtimeSecretManifest: RuntimeSecretManifest,
  publicOrigin: string,
  databaseRegistration: ProjectDatabaseRegistrationReceipt | null,
  storageBucketName: string | null,
  storageBinding: WfpStorageBinding | undefined,
  databaseServiceScriptName: string | null,
  nativeAuthBinding: WfpNativeAuthBinding | undefined,
  nextCacheBinding: WfpNextCacheBinding | undefined,
  trace: (phase: string) => void,
): Promise<VerifiedWfpArtifact> {
  const runtime = artifact.manifest.runtime;
  const isOpenNext = runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1";
  const isViteCompanion = runtime?.entryWrapperVersion === "vite-api-companion-v1";
  const isAstro = runtime?.entryWrapperVersion === "astro-edge-wrapper-v1";
  const isFunctions = runtime?.entryWrapperVersion === "functions-v1";
  const isServerWorker = isViteCompanion || isFunctions || isAstro;
  // Every Vite build routes in the client, so a path that matches no file answers index.html.
  // TanStack Start prerenders each route to its own file and keeps its 404 page, as Next.js does.
  const singlePageApplication =
    isViteCompanion ||
    (runtime === null && artifact.manifest.lifecycleEvidence.frameworkBuild.framework === "vite");
  const customerAuthEnabled = artifact.manifest.auth.provider === "better-auth";
  const mailEnabled = runtimeSecretManifest.secrets.some(
    (secret) => secret.name === "OHMYHOST_MAIL_KEY",
  );
  const storageEnabled = artifact.manifest.storage.enabled;
  const storageKeyEnabled = runtimeSecretManifest.secrets.some(
    (secret) => secret.name === "OHMYHOST_STORAGE_KEY",
  );
  const aiEnabled = runtimeSecretManifest.secrets.some((secret) => secret.name === AI_KEY_NAME);
  const browserEnabled = runtimeSecretManifest.secrets.some(
    (secret) => secret.name === BROWSER_KEY_NAME,
  );
  if (
    (databaseRegistration === null) !== (databaseServiceScriptName === null) ||
    (nativeAuthBinding !== undefined &&
      runtimeSecretManifest.secrets.some((secret) => secret.name === "OHMYHOST_AUTH")) ||
    (databaseRegistration !== null &&
      runtimeSecretManifest.secrets.some(
        (secret) => secret.name === "HYPERDRIVE" || secret.name === "OHMYHOST_DATABASE",
      )) ||
    storageEnabled !== (storageBucketName !== null && storageKeyEnabled) ||
    (isOpenNext &&
      runtimeSecretManifest.secrets.some(
        (secret) => secret.name === "ASSETS" || secret.name === "IMAGES",
      )) ||
    (isServerWorker &&
      runtimeSecretManifest.secrets.some(
        (secret) => secret.name === "ASSETS" || secret.name === "FILES",
      )) ||
    runtimeSecretManifest.secrets.some(
      (secret) =>
        secret.name === "OHMYHOST_CRONS" ||
        secret.name === "OHMYHOST_IMMUTABLE_SCRIPT_NAME" ||
        secret.name === "OHMYHOST_NEXT_CACHE",
    ) ||
    // A database-only project receives OHMYHOST_PROJECT_ID too since 07fa0766, so it must not be
    // able to declare a customer secret that shadows it.
    ((customerAuthEnabled ||
      mailEnabled ||
      storageEnabled ||
      aiEnabled ||
      browserEnabled ||
      databaseServiceScriptName !== null) &&
      runtimeSecretManifest.secrets.some(
        (secret) =>
          secret.name === "BETTER_AUTH_URL" ||
          secret.name === "OHMYHOST_MAIL_GATEWAY" ||
          secret.name === "OHMYHOST_MAIL_GATEWAY_URL" ||
          secret.name === "OHMYHOST_STORAGE_GATEWAY_URL" ||
          secret.name === AI_BASE_URL_NAME ||
          secret.name === BROWSER_BASE_URL_NAME ||
          secret.name === "OHMYHOST_PROJECT_ID" ||
          secret.name === "OHMYHOST_ENVIRONMENT_ID" ||
          secret.name === "STORAGE",
      ))
  ) {
    throw new WfpManagementInputError();
  }
  const scriptName = `p-${scope.projectId.toLowerCase()}`;
  const immutableScriptName = `p-${scope.projectId.toLowerCase()}-${scope.environmentName}-${deploymentId.toLowerCase()}`;
  const crons = artifact.manifest.functions?.crons ?? Object.freeze([] as string[]);
  const storageGatewayRequired = storageEnabled;
  const storageGatewayOrigin =
    storageBinding === undefined
      ? null
      : createPinnedStorageGatewayOrigin(
          dependencies.bindings.WFP_STORAGE_GATEWAY_ORIGIN,
          storageBinding.props,
        );
  const hashToBody = new Map<string, UploadedAsset>();
  const cloudflareManifest: Record<string, { readonly hash: string; readonly size: number }> = {};
  for (const asset of artifact.manifest.assets) {
    const body = artifact.filesByPath.get(asset.path);
    if (body === undefined) throw new WfpManagementInputError();
    const contentType = assetContentType(asset.path);
    // The served type is part of the asset's identity, so an asset stored untyped is re-uploaded.
    const assetHash = createHash("sha256").update(`${scriptName}\0${contentType}\0`, "utf8");
    for (let offset = 0; offset < body.byteLength; offset += 65_536) {
      assetHash.update(body.subarray(offset, Math.min(offset + 65_536, body.byteLength)));
    }
    const hash = assetHash.digest("hex").slice(0, 32);
    const existing = hashToBody.get(hash);
    if (existing === undefined) {
      hashToBody.set(hash, { body, contentType });
    } else if (
      existing.contentType !== contentType ||
      existing.body.byteLength !== body.byteLength ||
      !existing.body.every((byte, index) => byte === body[index])
    ) {
      throw new WfpManagementInputError();
    }
    cloudflareManifest[asset.path] = Object.freeze({ hash, size: body.byteLength });
  }
  let completionJwt: string | null = null;
  if (!isFunctions) {
    trace("upload-session-start");
    const session = await createUploadSession(
      dependencies,
      immutableScriptName,
      cloudflareManifest,
    );
    trace("upload-session-complete");
    completionJwt = await uploadBuckets(dependencies, session, hashToBody, trace);
  }
  const browserPolicy = browserPolicyFromAssetHeaders(artifact.filesByPath.get("/_headers"));
  const worker =
    runtime === null
      ? Object.freeze({
          mainModule: MAIN_MODULE,
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: Object.freeze([] as string[]),
          modules: Object.freeze([
            Object.freeze({
              name: MAIN_MODULE,
              contentType: "application/javascript+module",
              body: new TextEncoder().encode(STATIC_ASSET_MODULE),
            }),
          ]),
        })
      : Object.freeze({
          mainModule: EDGE_WRAPPER_MODULE,
          compatibilityDate: runtime.compatibilityDate,
          compatibilityFlags: runtime.compatibilityFlags,
          modules: Object.freeze([
            Object.freeze({
              name: EDGE_WRAPPER_MODULE,
              contentType: "application/javascript+module",
              body: new TextEncoder().encode(
                createEdgeRuntimeWrapperSource(
                  runtime,
                  artifact.manifest.modules.some(({ path }) => path === FUNCTIONS_WORKER_MODULE),
                  browserPolicy,
                ),
              ),
            }),
            ...artifact.manifest.modules.map((module) =>
              Object.freeze({
                name: module.path,
                contentType: module.contentType,
                body: artifact.modulesByPath.get(module.path) as Uint8Array,
              }),
            ),
          ]),
        });
  const databaseBinding = databaseBindingForScope(
    databaseRegistration,
    scope,
    dependencies.bindings,
  );
  return encodeWorkerMultipart(
    artifact.manifest.artifactDigest,
    deploymentId,
    scope,
    worker,
    completionJwt,
    runtimeSecretManifest,
    isOpenNext,
    isViteCompanion,
    databaseServiceScriptName,
    storageGatewayRequired
      ? storageGatewayServiceName(dependencies.bindings.WFP_DISPATCH_NAMESPACE)
      : null,
    Object.freeze([
      ...(crons.length === 0
        ? []
        : [
            { name: "OHMYHOST_CRONS", text: JSON.stringify(crons) },
            { name: "OHMYHOST_IMMUTABLE_SCRIPT_NAME", text: immutableScriptName },
          ]),
      ...(customerAuthEnabled ? [{ name: "BETTER_AUTH_URL", text: publicOrigin }] : []),
      ...(mailEnabled
        ? [
            {
              name: "OHMYHOST_MAIL_GATEWAY_URL",
              text: dependencies.bindings.WFP_MAIL_GATEWAY_ORIGIN,
            },
          ]
        : []),
      ...(aiEnabled
        ? [
            {
              name: AI_BASE_URL_NAME,
              text: aiBaseUrl(dependencies.bindings.WFP_AI_GATEWAY_ORIGIN),
            },
          ]
        : []),
      ...(browserEnabled
        ? [
            {
              name: BROWSER_BASE_URL_NAME,
              text: browserBaseUrl(
                dependencies.bindings.WFP_AI_GATEWAY_ORIGIN === AI_GATEWAY_ORIGIN_PRODUCTION
                  ? BROWSER_GATEWAY_ORIGIN_PRODUCTION
                  : BROWSER_GATEWAY_ORIGIN_DEVELOPMENT,
              ),
            },
          ]
        : []),
      ...(storageGatewayOrigin !== null
        ? [
            {
              name: "OHMYHOST_STORAGE_GATEWAY_URL",
              text: storageGatewayOrigin,
            },
            { name: "OHMYHOST_ENVIRONMENT_ID", text: scope.environmentId },
          ]
        : []),
      // The project database answers only requests that name their own project, so every
      // application that reaches one needs its project id, not just mail and storage users.
      ...(mailEnabled || storageGatewayRequired || databaseServiceScriptName !== null
        ? [{ name: "OHMYHOST_PROJECT_ID", text: scope.projectId }]
        : []),
    ]),
    Object.freeze({
      immutableScriptName,
      crons,
      ...(databaseBinding === undefined ? {} : { database: databaseBinding }),
      ...(storageBinding === undefined ? {} : { storage: storageBinding }),
      ...(nativeAuthBinding === undefined ? {} : { nativeAuth: nativeAuthBinding }),
      ...(nextCacheBinding === undefined ? {} : { nextCache: nextCacheBinding }),
    }),
    runtime === null,
    mailEnabled ? dependencies.bindings.WFP_MAIL_GATEWAY_SERVICE : null,
    singlePageApplication,
    isAstro,
    dependencies.bindings.WFP_DISPATCH_NAMESPACE,
  );
}

async function createUploadSession(
  dependencies: WfpManagementDependencies,
  scriptName: string,
  manifest: Readonly<Record<string, { readonly hash: string; readonly size: number }>>,
): Promise<AssetUploadSession> {
  let response: Response;
  try {
    response = await dependencies.fetch(
      `${apiBase(dependencies.bindings)}/dispatch/namespaces/${encodeURIComponent(dependencies.bindings.WFP_DISPATCH_NAMESPACE)}/scripts/${scriptName}/assets-upload-session`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${dependencies.bindings.WFP_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ manifest }),
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MILLISECONDS),
      },
    );
  } catch {
    throw new WfpManagementContractError();
  }
  const result = await readCloudflareResult(response);
  if (!isRecord(result) || !isJwt(result["jwt"])) throw new WfpManagementContractError();
  const rawBuckets = result["buckets"] ?? [];
  if (!Array.isArray(rawBuckets)) throw new WfpManagementContractError();
  const buckets = rawBuckets.map((bucket) => {
    if (!Array.isArray(bucket) || bucket.length === 0 || bucket.length > MAX_ASSET_COUNT) {
      throw new WfpManagementContractError();
    }
    return Object.freeze(
      bucket.map((hash) => {
        if (typeof hash !== "string" || !/^[a-f0-9]{32}$/u.test(hash)) {
          throw new WfpManagementContractError();
        }
        return hash;
      }),
    );
  });
  return Object.freeze({ jwt: result["jwt"], buckets: Object.freeze(buckets) });
}

async function uploadBuckets(
  dependencies: WfpManagementDependencies,
  session: AssetUploadSession,
  hashToBody: ReadonlyMap<string, UploadedAsset>,
  trace: (phase: string) => void,
): Promise<string> {
  if (session.buckets.length === 0) return session.jwt;
  const seen = new Set<string>();
  let completionJwt = session.jwt;
  for (const [bucketIndex, bucket] of session.buckets.entries()) {
    trace("asset-bucket-start");
    const boundary = `ohmyhost-assets-${bucketIndex}`;
    const encoder = new TextEncoder();
    let contentLength = encoder.encode(`--${boundary}--\r\n`).byteLength;
    const assets = bucket.map((hash) => {
      const asset = hashToBody.get(hash);
      if (asset === undefined || seen.has(hash)) throw new WfpManagementContractError();
      seen.add(hash);
      const header = encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${hash}"; filename="${hash}"\r\nContent-Type: ${asset.contentType}\r\n\r\n`,
      );
      contentLength += header.byteLength + 4 * Math.ceil(asset.body.byteLength / 3) + 2;
      return { asset, header };
    });
    function* parts(): Generator<Uint8Array<ArrayBuffer>> {
      for (const { asset, header } of assets) {
        yield header;
        // A multiple of three keeps each base64 chunk independently complete.
        for (let offset = 0; offset < asset.body.byteLength; offset += 65_535) {
          const length = Math.min(65_535, asset.body.byteLength - offset);
          const value = Buffer.from(
            asset.body.buffer,
            asset.body.byteOffset + offset,
            length,
          ).toString("base64");
          yield encoder.encode(value);
        }
        yield encoder.encode("\r\n");
      }
      yield encoder.encode(`--${boundary}--\r\n`);
    }
    const iterator = parts();
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        const next = iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    let response: Response;
    try {
      response = await dependencies.fetch(
        `${apiBase(dependencies.bindings)}/assets/upload?base64=true`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.jwt}`,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "content-length": String(contentLength),
          },
          body,
          signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MILLISECONDS),
        },
      );
    } catch {
      throw new WfpManagementContractError();
    }
    const finalBucket = bucketIndex === session.buckets.length - 1;
    const result = await readCloudflareResult(response, finalBucket ? 201 : 202);
    if (finalBucket) {
      if (!isRecord(result) || !isJwt(result["jwt"])) throw new WfpManagementContractError();
      completionJwt = result["jwt"];
    } else if (result !== null && (!isRecord(result) || Object.keys(result).length !== 0)) {
      throw new WfpManagementContractError();
    }
    trace("asset-bucket-complete");
  }
  return completionJwt;
}

async function encodeWorkerMultipart(
  artifactDigest: `sha256:${string}`,
  deploymentId: string,
  scope: WfpScope,
  worker: Readonly<{
    mainModule: string;
    compatibilityDate: string;
    compatibilityFlags: readonly string[];
    modules: readonly Readonly<{ name: string; contentType: string; body: Uint8Array }>[];
  }>,
  assetsJwt: string | null,
  runtimeSecretManifest?: RuntimeSecretManifest,
  isOpenNext = false,
  isViteCompanion = false,
  databaseServiceScriptName: string | null = null,
  storageGatewayServiceScriptName: string | null = null,
  plainTextBindings: readonly Readonly<{ name: string; text: string }>[] = Object.freeze([]),
  platformBindings: VerifiedWfpArtifact["platformBindings"] = Object.freeze({
    immutableScriptName: `p-${scope.projectId.toLowerCase()}-${scope.environmentName}-${deploymentId.toLowerCase()}`,
    crons: Object.freeze([] as string[]),
  }),
  isStatic = false,
  mailGatewayServiceScriptName: string | null = null,
  singlePageApplication = false,
  isAstro = false,
  namespace = "ohmyho-sandbox",
): Promise<VerifiedWfpArtifact> {
  if (
    (storageGatewayServiceScriptName === null) !== (platformBindings.storage === undefined) ||
    (platformBindings.storage !== undefined &&
      platformBindings.storage.service !== storageGatewayServiceScriptName)
  )
    throw new WfpManagementInputError();
  const cronBindingsTag =
    platformBindings.crons.length === 0
      ? null
      : `crons:${await digest(new TextEncoder().encode(JSON.stringify(platformBindings.crons)))}`;
  const databaseBindingDigest = await computeDatabaseBindingDigest(
    platformBindings.database,
    scope,
  );
  const storageBindingDigest = await computeStorageBindingDigest(
    platformBindings.storage,
    scope,
    platformBindings.database,
  );
  const nativeAuthBindingDigest = await computeNativeAuthBindingDigest(
    platformBindings.nativeAuth,
    scope,
    deploymentId,
    namespace,
  );
  const nextCacheBindingDigest = await computeNextCacheBindingDigest(
    platformBindings.nextCache,
    scope,
    deploymentId,
    namespace,
  );
  const bindingSetDigest = await computeBindingSetDigest(
    cronBindingsTag === null
      ? null
      : (cronBindingsTag.slice("crons:".length) as `sha256:${string}`),
    databaseBindingDigest,
    storageBindingDigest,
    nativeAuthBindingDigest,
    nextCacheBindingDigest,
  );
  const metadata = {
    main_module: worker.mainModule,
    logpush: true,
    ...(assetsJwt === null
      ? {}
      : {
          assets: {
            jwt: assetsJwt,
            config: {
              html_handling: "auto-trailing-slash",
              not_found_handling: singlePageApplication ? "single-page-application" : "404-page",
              ...(isOpenNext || isStatic || isViteCompanion || isAstro
                ? { run_worker_first: true }
                : {}),
            },
          },
        }),
    bindings: [
      ...(isOpenNext || isStatic || isViteCompanion || isAstro
        ? [{ type: "assets" as const, name: "ASSETS" as const }]
        : []),
      ...(platformBindings.database === undefined
        ? []
        : [
            {
              type: "service" as const,
              name: "OHMYHOST_DATABASE" as const,
              service: databaseServiceScriptName,
              entrypoint: "ProjectDatabaseService" as const,
              props: platformBindings.database.props,
            },
          ]),
      ...(platformBindings.nextCache === undefined
        ? []
        : [
            {
              type: "service" as const,
              name: "OHMYHOST_NEXT_CACHE" as const,
              service: platformBindings.nextCache.service,
              entrypoint: "NextCacheRuntime" as const,
              props: platformBindings.nextCache.props,
            },
          ]),
      ...(platformBindings.nativeAuth === undefined
        ? []
        : [
            {
              type: "service" as const,
              name: "OHMYHOST_AUTH" as const,
              service: platformBindings.nativeAuth.service,
              entrypoint: "NativeSessionService" as const,
              props: platformBindings.nativeAuth.props,
            },
          ]),
      ...(platformBindings.storage === undefined
        ? []
        : [
            {
              type: "service" as const,
              name: "OHMYHOST_STORAGE_GATEWAY" as const,
              service: platformBindings.storage.service,
              props: platformBindings.storage.props,
            },
          ]),
      ...(mailGatewayServiceScriptName === null
        ? []
        : [
            {
              type: "service" as const,
              name: "OHMYHOST_MAIL_GATEWAY" as const,
              service: mailGatewayServiceScriptName,
            },
          ]),
      ...plainTextBindings.map((binding) => ({
        type: "plain_text" as const,
        name: binding.name,
        text: binding.text,
      })),
      ...(runtimeSecretManifest?.secrets.map((secret) => ({
        type: "secret_text" as const,
        name: secret.name,
        text: secret.value,
      })) ?? []),
    ],
    tags: [
      `project:${scope.projectId}`,
      `environment:${scope.environmentId}`,
      `deployment:${deploymentId}`,
      `artifact:${artifactDigest}`,
      WFP_CANDIDATE_LAYOUT_TAG,
      ...(worker.mainModule === EDGE_WRAPPER_MODULE ? ["runtime:edge"] : []),
      ...(bindingSetDigest !== null
        ? [`bindings:${bindingSetDigest}`]
        : [
            ...(cronBindingsTag === null ? [] : [cronBindingsTag]),
            ...(databaseBindingDigest === null ? [] : [`database:${databaseBindingDigest}`]),
            ...(storageBindingDigest === null ? [] : [`storage:${storageBindingDigest}`]),
            ...(nativeAuthBindingDigest === null ? [] : [`native-auth:${nativeAuthBindingDigest}`]),
          ]),
    ],
    compatibility_date: worker.compatibilityDate,
    ...(worker.compatibilityFlags.length === 0
      ? {}
      : { compatibility_flags: worker.compatibilityFlags }),
  };
  const encoder = new TextEncoder();
  const metadataJson = JSON.stringify(metadata);
  const boundary = await multipartBoundary(metadataJson, worker.modules);
  const parts: Uint8Array[] = [
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadataJson}\r\n`,
    ),
  ];
  for (const module of worker.modules) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${module.name}"; filename="${module.name}"\r\nContent-Type: ${module.contentType}\r\n\r\n`,
      ),
      module.body,
      encoder.encode("\r\n"),
    );
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const body = concatBytes(...parts);
  return Object.freeze({
    deploymentId,
    digest: artifactDigest,
    bodyDigest: await digest(body),
    contentType: `multipart/form-data; boundary=${boundary}`,
    body,
    platformBindings,
  });
}

export function validateDatabaseOriginHost(
  requirement: DatabaseRequirement,
  value: unknown,
  registration: ProjectDatabaseRegistrationReceipt | null = null,
): string | null {
  if (!requirement.enabled) {
    if (value !== undefined) throw new WfpManagementInputError();
    return null;
  }
  // Only a PGCF registration can back a database artifact; its origin host is the one it names.
  if (registration?.provider !== "pgcf" || value !== registration.originHost)
    throw new WfpManagementInputError();
  return registration.originHost;
}

function storageBindingForScope(
  requirement: StorageRequirement,
  value: unknown,
  database: ProjectDatabaseRegistrationReceipt | null,
  organizationId: string,
  scope: WfpScope,
  bindings: WfpManagementBindings,
): WfpStorageBinding | undefined {
  if (!requirement.enabled) {
    if (value !== undefined) throw new WfpManagementInputError();
    return undefined;
  }
  if (!isUlid(value) || (database !== null && database.physicalEnvironmentId !== value))
    throw new WfpManagementInputError();
  return {
    service: storageGatewayServiceName(bindings.WFP_DISPATCH_NAMESPACE),
    props: {
      organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      dataEnvironmentId: value,
    },
  };
}

function databaseBindingForScope(
  registration: ProjectDatabaseRegistrationReceipt | null,
  scope: WfpScope,
  bindings: WfpManagementBindings,
): WfpDatabaseBinding | undefined {
  if (registration === null) return undefined;
  return {
    service:
      registration.region === "us" ? bindings.DATABASE_SERVICE_US : bindings.DATABASE_SERVICE_EU,
    props: {
      organizationId: registration.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      physicalEnvironmentId: registration.physicalEnvironmentId,
      registrationVersion: registration.registrationVersion,
      region: registration.region,
    },
  };
}

export function validateDatabaseRegistrationBinding(
  requirement: DatabaseRequirement,
  value: unknown,
  organizationId: string,
  scope: WfpScope,
): ProjectDatabaseRegistrationReceipt | null {
  if (!isUlid(organizationId)) throw new WfpManagementInputError();
  if (!requirement.enabled) {
    if (value !== undefined) throw new WfpManagementInputError();
    return null;
  }
  let registration: ProjectDatabaseRegistrationReceipt;
  try {
    registration = readDatabaseRegistrationReceipt(value);
  } catch {
    throw new WfpManagementInputError();
  }
  if (
    registration.status !== "active" ||
    registration.organizationId !== organizationId ||
    registration.projectId !== scope.projectId ||
    !registration.authorizedEnvironmentIds.includes(scope.environmentId)
  )
    throw new WfpManagementInputError();
  return registration;
}

function validateStorageBinding(
  requirement: StorageRequirement,
  value: string | undefined,
  scope: WfpScope,
): string | null {
  if (!requirement.enabled) {
    if (value !== undefined) throw new WfpManagementInputError();
    return null;
  }
  const expected = `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`;
  if (value !== expected) throw new WfpManagementInputError();
  return value;
}

interface UploadedAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

// The MIME types Wrangler's asset upload sends for these extensions (text types carry UTF-8).
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  avif: "image/avif",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  wav: "audio/wav",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
});

/** Cloudflare's upload API reads "application/null" as: serve this asset without Content-Type. */
export function assetContentType(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  const extension = dot <= 0 ? "" : filename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(ASSET_CONTENT_TYPES, extension)
    ? (ASSET_CONTENT_TYPES[extension] as string)
    : "application/null";
}

/** Only the global asset rule can opt this immutable deployment into browser media capabilities. */
export function browserPolicyFromAssetHeaders(
  value: Uint8Array | undefined,
): Readonly<{ media: boolean; microphone: boolean }> {
  if (value === undefined || value.byteLength > 65536)
    return Object.freeze({ media: false, microphone: false });
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return Object.freeze({ media: false, microphone: false });
  }
  let globalRule = false;
  let media = false;
  let microphone = false;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      globalRule = trimmed === "/*";
      continue;
    }
    if (!globalRule) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 1) continue;
    const name = trimmed.slice(0, colon).toLowerCase();
    const directives = trimmed.slice(colon + 1);
    if (name === "content-security-policy")
      media ||= directives.split(";").some((part) => part.trim() === "media-src 'self' blob:");
    if (name === "permissions-policy")
      microphone ||= directives.split(",").some((part) => part.trim() === "microphone=(self)");
  }
  return Object.freeze({ media, microphone });
}

/**
 * Platform entry of every edge script. Public requests reach the customer's fetch handler; the
 * scheduler's internal origin invokes the scheduled handler of the Worker module.
 */
export function createEdgeRuntimeWrapperSource(
  runtime: VerifiedArtifactRuntime,
  workerModule = false,
  browserPolicy: Readonly<{ media: boolean; microphone: boolean }> = {
    media: false,
    microphone: false,
  },
): string {
  const scheduledSource = workerModule ? "workerModule" : "userWorker";
  return `import userWorker from "./${runtime.mainModule}";
${workerModule ? `import workerModule from "./${FUNCTIONS_WORKER_MODULE}";\n` : ""}const appliesCspNonce = ${runtime.entryWrapperVersion === "astro-edge-wrapper-v1" || runtime.entryWrapperVersion === "tanstack-edge-wrapper-v1" || runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1"};
const buffersNextResponse = ${runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1" && runtime.nextRevalidatePath === true};
const nextResponseDeadlineMs = 30000;
const responseTasks = buffersNextResponse
  ? (globalThis[Symbol.for("ohmyhost.next.response-tasks/v1")] ??= new WeakMap())
  : null;
const browserMedia = ${browserPolicy.media === true};
const browserMicrophone = ${browserPolicy.microphone === true};
const scheduledHost = "${SCHEDULED_HOST}";
const scheduledPath = "${SCHEDULED_PATH}";
// Only public entry requests are guarded; OpenNext's direct environment.ASSETS reads stay private.
function isPrivateNextCachePath(pathname) {
  const prefix = "/cdn-cgi/_next_cache";
  let path = pathname;
  while (true) {
    const segments = [];
    for (const segment of path.replaceAll(String.fromCharCode(92), "/").split("/")) {
      if (segment === "..") segments.pop();
      else if (segment !== "" && segment !== ".") segments.push(segment);
    }
    const normalized = "/" + segments.join("/");
    if (normalized === prefix || normalized.startsWith(prefix + "/")) return true;
    const decoded = path.split("/").map((segment) => {
      try { return decodeURIComponent(segment); }
      catch { return segment; }
    }).join("/");
    if (decoded === path) return false;
    path = decoded;
  }
}
function declaredCrons(environment) {
  try {
    const crons = JSON.parse(environment.OHMYHOST_CRONS);
    return Array.isArray(crons) && crons.every((cron) => typeof cron === "string") ? crons : [];
  } catch {
    return [];
  }
}
async function runScheduled(request, environment, context) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let invocation;
  try {
    invocation = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    typeof invocation !== "object" ||
    invocation === null ||
    typeof invocation.cron !== "string" ||
    !Number.isSafeInteger(invocation.scheduledTime) ||
    typeof invocation.immutableScriptName !== "string" ||
    invocation.immutableScriptName !== environment.OHMYHOST_IMMUTABLE_SCRIPT_NAME ||
    !declaredCrons(environment).includes(invocation.cron)
  ) {
    return new Response(null, { status: 400 });
  }
  const handler = ${scheduledSource}?.scheduled;
  if (typeof handler !== "function") return new Response(null, { status: 501 });
  let retry = true;
  const controller = Object.freeze({
    cron: invocation.cron,
    scheduledTime: invocation.scheduledTime,
    type: "scheduled",
    noRetry() { retry = false; },
  });
  try {
    await handler.call(${scheduledSource}, controller, environment, context);
  } catch {
    return new Response(null, { status: retry ? 500 : 422 });
  }
  return new Response(null, { status: 204 });
}
function applyCspNonce(response, request) {
  if (!appliesCspNonce) return response;
  const nonce = request.headers.get("x-nonce");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (nonce === null || !/^[a-f0-9]{32}$/.test(nonce) || !contentType.startsWith("text/html")) return response;
  return new HTMLRewriter()
    .on("head", { element(element) { element.prepend('<meta property="csp-nonce" content="' + nonce + '">', { html: true }); } })
    .on("script", { element(element) { element.setAttribute("nonce", nonce); } })
    .on("style", { element(element) { element.setAttribute("nonce", nonce); } })
    .transform(response);
}
async function bufferedNextResponse(request, environment, context) {
  const tasks = new Set();
  const applicationContext = new Proxy(context, {
    get(target, key) {
      if (key === "waitUntil") return (promise) => {
        const task = Promise.resolve(promise);
        task.catch(() => {});
        if (typeof target.waitUntil === "function") target.waitUntil(task);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? (...args) => Reflect.apply(value, target, args) : value;
    },
  });
  responseTasks.set(applicationContext, tasks);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  const applicationRequest = new Request(request, { signal: controller.signal, ...(request.cf ? { cf: request.cf } : {}) });
  let reader;
  let timer;
  const cancelReader = () => { if (reader) void reader.cancel().catch(() => {}); };
  const completed = (async () => {
    const response = applyCspNonce(await userWorker.fetch(applicationRequest, environment, applicationContext), request);
    let bytes = new Uint8Array(0);
    let length = 0;
    let reads = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new Error("Next response chunk is invalid");
        const nextLength = length + part.value.byteLength;
        if (nextLength > 12582912) throw new Error("Next response exceeds limit");
        if (nextLength > bytes.byteLength) {
          const expanded = new Uint8Array(Math.min(12582912, Math.max(16384, bytes.byteLength * 2, nextLength)));
          expanded.set(bytes.subarray(0, length));
          bytes = expanded;
        }
        bytes.set(part.value, length);
        length = nextLength;
        // An immediately readable stream can otherwise starve the deadline timer indefinitely.
        if (++reads % 1024 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const seen = new Set();
    while (seen.size < tasks.size) {
      const pending = [...tasks].filter((task) => !seen.has(task));
      for (const task of pending) seen.add(task);
      await Promise.all(pending);
    }
    if (response.status === 101) return response;
    const body = response.body ? bytes.subarray(0, length) : null;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  })();
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Next response deadline")), nextResponseDeadlineMs); });
  try {
    return await Promise.race([completed, deadline]);
  } catch {
    abort();
    cancelReader();
    return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    responseTasks.delete(applicationContext);
  }
}
export default {
  async fetch(request, environment, context) {
    const url = new URL(request.url);
    if (isPrivateNextCachePath(url.pathname)) return new Response(null, { status: 404 });
    if (url.host === scheduledHost) {
      if (url.pathname !== scheduledPath) return new Response(null, { status: 404 });
      return runScheduled(request, environment, context);
    }
    if (typeof userWorker?.fetch !== "function") throw new TypeError("Invalid edge entrypoint");
    const response = buffersNextResponse
      ? await bufferedNextResponse(request, environment, context)
      : applyCspNonce(await userWorker.fetch(request, environment, context), request);
    const headers = new Headers(response.headers);
    if (headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
      if (browserMedia) headers.set("content-security-policy", "media-src 'self' blob:");
      if (browserMicrophone) headers.set("permissions-policy", "microphone=(self)");
    }
    headers.set("x-ohmyhost-runtime", "edge-v1");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
      ...(response.status === 101 ? { webSocket: response.webSocket } : {}),
    });
  },
};
`;
}

async function readCloudflareResult(response: Response, expectedStatus = 200): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new WfpManagementContractError();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new WfpManagementContractError();
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new WfpManagementContractError();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new WfpManagementContractError();
  }
  if (
    response.status !== expectedStatus ||
    !isRecord(envelope) ||
    envelope["success"] !== true ||
    !(envelope["errors"] === null || Array.isArray(envelope["errors"])) ||
    !(envelope["messages"] === null || Array.isArray(envelope["messages"]))
  )
    throw new WfpManagementContractError();
  return envelope["result"];
}

function validateDependencies(dependencies: WfpManagementDependencies): void {
  const bindings = dependencies.bindings;
  const namespace = resourceNamespace(bindings.WFP_DISPATCH_NAMESPACE);
  if (
    !/^[a-f0-9]{32}$/u.test(bindings.WFP_ACCOUNT_ID) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(bindings.WFP_DISPATCH_NAMESPACE) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(bindings.WFP_WORKERS_DEV_SUBDOMAIN) ||
    namespace === null ||
    bindings.DATABASE_SERVICE_US !==
      `ohmyho-project-database-${namespace === "poc-private-fullstack" ? "development" : namespace}-us` ||
    bindings.DATABASE_SERVICE_EU !==
      `ohmyho-project-database-${namespace === "poc-private-fullstack" ? "development" : namespace}-eu` ||
    bindings.WFP_MAIL_GATEWAY_SERVICE !== `ohmyho-mail-gateway-${namespace}` ||
    bindings.WFP_MAIL_GATEWAY_ORIGIN !==
      `https://ohmyho-mail-gateway-${namespace}.${bindings.WFP_WORKERS_DEV_SUBDOMAIN}.workers.dev` ||
    bindings.WFP_STORAGE_GATEWAY_ORIGIN !==
      `https://ohmyho-storage-gateway-${namespace}.${bindings.WFP_WORKERS_DEV_SUBDOMAIN}.workers.dev` ||
    bindings.WFP_AI_GATEWAY_ORIGIN !==
      (namespace === "production" ? AI_GATEWAY_ORIGIN_PRODUCTION : AI_GATEWAY_ORIGIN_DEVELOPMENT) ||
    bindings.WFP_API_TOKEN.trim().length === 0
  )
    throw new WfpManagementInputError();
}

function resourceNamespace(
  value: string,
): "sandbox" | "poc-private-fullstack" | "production" | null {
  if (value === "ohmyho-sandbox") return "sandbox";
  if (value === "ohmyho-poc-private-fullstack") return "poc-private-fullstack";
  if (value === "ohmyho-production") return "production";
  return null;
}

function storageGatewayServiceName(dispatchNamespace: string): string {
  const namespace = resourceNamespace(dispatchNamespace);
  if (namespace === null) throw new WfpManagementInputError();
  return `ohmyho-storage-gateway-${namespace}`;
}

function validatePolling(
  pollMilliseconds: number,
  deadlineMilliseconds: number,
  probeTimeoutMilliseconds: number,
): void {
  if (
    !Number.isSafeInteger(pollMilliseconds) ||
    pollMilliseconds < 1 ||
    !Number.isSafeInteger(deadlineMilliseconds) ||
    deadlineMilliseconds < pollMilliseconds * 3 ||
    !Number.isSafeInteger(probeTimeoutMilliseconds) ||
    probeTimeoutMilliseconds < 1
  )
    throw new WfpManagementInputError();
}

function validateScope(scope: WfpScope): void {
  if (
    !isUlid(scope.projectId) ||
    !isUlid(scope.environmentId) ||
    (scope.environmentName !== "dev" && scope.environmentName !== "prod") ||
    typeof scope.handle !== "string" ||
    scope.handle.length < 3 ||
    scope.handle.length > 59 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(scope.handle)
  ) {
    throw new WfpManagementInputError();
  }
}

function validateKnownDeployments(
  deployments: readonly WfpDeploymentReceipt[],
  scope: WfpScope,
  namespace: string,
): void {
  for (const deployment of deployments) validateReceipt(deployment, scope, namespace);
}

function validateReceipt(receipt: WfpDeploymentReceipt, scope: WfpScope, namespace: string): void {
  const expectedScript = `p-${scope.projectId.toLowerCase()}-${scope.environmentName}-${receipt.productDeploymentId.toLowerCase()}`;
  if (
    receipt.provider !== "cloudflare-wfp" ||
    receipt.namespace !== namespace ||
    receipt.projectId !== scope.projectId ||
    receipt.environmentId !== scope.environmentId ||
    !isUlid(receipt.productDeploymentId) ||
    receipt.scriptName !== expectedScript ||
    !/^[a-f0-9]{32}$/u.test(receipt.providerTag) ||
    !isDigest(receipt.artifactDigest) ||
    (Object.hasOwn(receipt, "bindingSetDigest") && !isDigest(receipt.bindingSetDigest))
  )
    throw new WfpManagementInputError();
}

function bindingExpectation(receipt: WfpDeploymentReceipt) {
  return Object.hasOwn(receipt, "bindingSetDigest") && receipt.bindingSetDigest !== undefined
    ? { expectedBindingSetDigest: receipt.bindingSetDigest }
    : {};
}

function validateGatewayReceipt(
  receipt: WfpProjectGatewayReceipt,
  scope: WfpScope,
  namespace: string,
): void {
  let checked: WfpProjectGatewayReceipt;
  try {
    checked = readGatewayReceipt(receipt);
  } catch {
    throw new WfpManagementInputError();
  }
  if (
    checked.projectId !== scope.projectId ||
    checked.environmentId !== scope.environmentId ||
    checked.environmentName !== scope.environmentName ||
    checked.handle !== scope.handle ||
    checked.publicOrigin !== projectGatewayPublicOrigin(scope, namespace)
  )
    throw new WfpManagementInputError();
}

function publicOriginForScope(scope: WfpScope, namespace: string): string {
  return projectGatewayPublicOrigin(scope, namespace);
}

function validateRuntimePolicy(value: WfpRuntimePolicy): void {
  parseRuntimePolicy(value);
}

function validateActivatedGateway(
  gateway: WfpProjectGatewayReceipt,
  organizationId: string,
  scope: WfpScope,
  candidate: WfpDeploymentReceipt,
  bindings: WfpManagementBindings,
): void {
  validateGatewayReceipt(gateway, scope, bindings.WFP_DISPATCH_NAMESPACE);
  if (
    gateway.organizationId !== organizationId ||
    !gateway.active ||
    gateway.targetScriptName !== candidate.scriptName ||
    gateway.targetDeploymentId !== candidate.productDeploymentId ||
    gateway.targetArtifactDigest !== candidate.artifactDigest ||
    gateway.targetProviderTag !== candidate.providerTag
  ) {
    throw new WfpManagementContractError();
  }
}

function validateAssetPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    containsControlCharacter(value)
  )
    throw new WfpManagementInputError();
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new WfpManagementInputError();
  }
  const segments = decoded.split("/");
  if (
    segments.some(
      (segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new WfpManagementInputError();
  }
}

function validateJsonComplexity(body: Uint8Array): void {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let nodes = 0;
  let separators = 0;
  for (const byte of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
    } else if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) {
      depth += 1;
      nodes += 1;
      if (depth > 64 || nodes > 16_384) throw new WfpManagementInputError();
    } else if (byte === 125 || byte === 93) depth -= 1;
    else if (byte === 44 || byte === 58) {
      separators += 1;
      if (separators > 65_536) throw new WfpManagementInputError();
    }
  }
}

function validateSbom(body: Uint8Array): void {
  let value: unknown;
  try {
    validateJsonComplexity(body);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WfpManagementInputError();
  }
  if (
    !isRecord(value) ||
    value["bomFormat"] !== "CycloneDX" ||
    typeof value["specVersion"] !== "string" ||
    !/^1\.[4-9]$/u.test(value["specVersion"]) ||
    !Number.isSafeInteger(value["version"]) ||
    Number(value["version"]) < 1
  )
    throw new WfpManagementInputError();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function checkedTime(now: () => Date): number {
  const value = new Date(now()).getTime();
  if (!Number.isFinite(value)) throw new WfpManagementInputError();
  return value;
}

function apiBase(bindings: WfpManagementBindings): string {
  return `https://api.cloudflare.com/client/v4/accounts/${bindings.WFP_ACCOUNT_ID}/workers`;
}

async function digest(body: Uint8Array): Promise<`sha256:${string}`> {
  return `sha256:${await hexDigest(body)}`;
}

async function hexDigest(body: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The upload boundary digests the exact upload content, so a customer cannot predict it while
 * choosing their bytes. A body that still contains it gets the next counter, and the upload fails
 * after the last attempt.
 */
async function multipartBoundary(
  metadataJson: string,
  modules: readonly Readonly<{ name: string; contentType: string; body: Uint8Array }>[],
): Promise<string> {
  const encoder = new TextEncoder();
  const content = [
    encoder.encode(metadataJson),
    ...modules.flatMap((module) => [
      encoder.encode(`${module.name}\n${module.contentType}\n`),
      module.body,
    ]),
  ];
  for (let attempt = 0; attempt < MULTIPART_BOUNDARY_ATTEMPTS; attempt += 1) {
    const digestHex = await hexDigest(concatBytes(encoder.encode(`${attempt}\n`), ...content));
    const boundary = `ohmyhost-${digestHex.slice(0, 32)}`;
    const marker = encoder.encode(`--${boundary}`);
    if (modules.every((module) => !containsBytes(module.body, marker))) return boundary;
  }
  throw new WfpManagementInputError();
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start + needle.byteLength <= haystack.byteLength; start += 1) {
    if (needle.every((byte, offset) => haystack[start + offset] === byte)) return true;
  }
  return false;
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Only exact old identity is sufficient for cleanup/source provenance, never execution. */
function isOutdatedCandidateObservation(
  observed: WfpObservation,
  candidate: WfpDeploymentReceipt,
): boolean {
  return (
    observed.state === "unknown" &&
    observed.reason === "candidate_bindings_outdated" &&
    observed.scriptName === candidate.scriptName &&
    observed.providerTag === candidate.providerTag &&
    observed.productDeploymentId === candidate.productDeploymentId &&
    observed.artifactDigest === candidate.artifactDigest
  );
}

function isUncertainProviderError(error: unknown): error is {
  readonly code: "cloudflare_result_uncertain";
  readonly currentProviderTag: string | null;
  readonly currentProductDeploymentId?: string | null;
  readonly reason?: unknown;
} {
  return (
    isRecord(error) &&
    error["code"] === "cloudflare_result_uncertain" &&
    (typeof error["currentProviderTag"] === "string" || error["currentProviderTag"] === null) &&
    (error["currentProductDeploymentId"] === undefined ||
      typeof error["currentProductDeploymentId"] === "string" ||
      error["currentProductDeploymentId"] === null)
  );
}

function isScriptRejectedError(error: unknown): error is {
  readonly code: "cloudflare_script_rejected";
  readonly status: number;
  readonly providerCode?: number;
} {
  return (
    isRecord(error) &&
    error["code"] === "cloudflare_script_rejected" &&
    Number.isSafeInteger(error["status"]) &&
    Number(error["status"]) >= 400 &&
    Number(error["status"]) <= 499 &&
    (error["providerCode"] === undefined ||
      (Number.isSafeInteger(error["providerCode"]) &&
        Number(error["providerCode"]) >= 1 &&
        Number(error["providerCode"]) <= 999_999))
  );
}

function isRuntimeSecretSyncUncertain(error: unknown): boolean {
  return (
    error instanceof CloudflareWfpSecretSyncUncertainError ||
    (isRecord(error) &&
      error["code"] === "cloudflare_result_uncertain" &&
      "currentSecrets" in error)
  );
}

function isProviderConflictError(error: unknown): error is {
  readonly code: "cloudflare_deployment_conflict";
  readonly currentProviderTag: string;
} {
  return (
    isRecord(error) &&
    error["code"] === "cloudflare_deployment_conflict" &&
    typeof error["currentProviderTag"] === "string"
  );
}

function redactProviderFailure(error: unknown): Error {
  if (isRecord(error) && typeof error["code"] === "string") {
    return Object.assign(new Error("WFP provider request failed"), {
      code: error["code"],
      ...(Number.isSafeInteger(error["status"]) &&
      Number(error["status"]) >= 400 &&
      Number(error["status"]) <= 599
        ? { providerStatus: Number(error["status"]) }
        : {}),
      ...(Number.isSafeInteger(error["providerCode"]) &&
      Number(error["providerCode"]) >= 1 &&
      Number(error["providerCode"]) <= 999_999
        ? { providerCode: Number(error["providerCode"]) }
        : {}),
      ...(typeof error["providerPointer"] === "string" &&
      error["providerPointer"].length <= 128 &&
      /^\/[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+){0,7}$/u.test(error["providerPointer"])
        ? { providerPointer: error["providerPointer"] }
        : {}),
    });
  }
  return new Error("WFP provider request failed");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isJwt(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{1,8192}$/u.test(value);
}

function isUlid(value: unknown): value is string {
  return typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
