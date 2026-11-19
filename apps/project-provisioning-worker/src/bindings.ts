import type { CloudflareWorkflowBinding } from "./runtime-types.js";
import type {
  ProjectProvisioningMessageV1,
  ProductProviderReconciliationMessageV1,
} from "@ohmyhost/orchestrator";

export interface ManagedSourceProcessorBinding {
  process(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  }): Promise<{ readonly state: "staging" | "committed" | "failed" }>;
  initialize(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  }): Promise<{
    readonly state: "pending" | "initialized" | "failed";
    readonly childOperationId?: string;
  }>;
}

/** The private Service Bindings and Workflow bindings of the Deployment Workflow Worker. */
export interface DeploymentWorkflowServiceBindings {
  readonly PROJECT_PROVISIONING_WORKFLOW: CloudflareWorkflowBinding<ProjectProvisioningMessageV1>;
  readonly DEPLOYMENT_WORKFLOW: CloudflareWorkflowBinding<unknown>;
  readonly PROVIDER_RECONCILIATION_WORKFLOW: CloudflareWorkflowBinding<ProductProviderReconciliationMessageV1>;
  readonly SOURCE_FETCHER: SourceFetcherBinding;
  readonly BUILD_RUNNER: BuildRunnerBinding;
  readonly RECOVERY_INVOKER: RecoveryInvokerBinding;
  readonly RUNTIME_SECRET_DELIVERY: RuntimeSecretDeliveryBinding;
  readonly NEXT_CACHE_RETIREMENT: { retire(input: unknown): Promise<unknown> };
  readonly NEON_MANAGEMENT: NeonManagementBinding;
  readonly NATIVE_AUTH_RESOURCE_RUNTIME: NativeAuthResourceBinding;
  readonly NATIVE_AUTH_ADMIN_US: NativeAuthAdminBinding;
  readonly NATIVE_AUTH_ADMIN_EU: NativeAuthAdminBinding;
  readonly R2_MANAGEMENT: R2ManagementBinding;
  readonly STORAGE_DATA_MANAGEMENT: StorageDataManagementBinding;
  readonly SES_MANAGEMENT: SesManagementBinding;
  readonly CLOUDFLARE_DOMAIN_MANAGEMENT: CloudflareDomainManagementBinding;
  readonly WFP_MANAGEMENT: WfpManagementBinding;
}

interface SourceFetcherBinding {
  acquireExact(input: unknown): Promise<unknown>;
  inspectExact(input: unknown): Promise<unknown>;
  validateRepositoryLink(input: unknown): Promise<unknown>;
  managedGit(method: string, input: unknown): Promise<unknown>;
  managedBlob(method: string, input: unknown): Promise<unknown>;
}

interface RecoveryInvokerBinding {
  invokeRecovery(input: unknown): Promise<unknown>;
}

interface BuildRunnerBinding {
  startBuild(input: unknown): Promise<unknown>;
  readBuild(input: unknown): Promise<unknown>;
  readBuildArtifact(input: unknown): Promise<unknown>;
  removeBuildArtifact(input: unknown): Promise<unknown>;
  removeBuildArtifactObject(input: unknown): Promise<unknown>;
  removeArchive(input: unknown): Promise<unknown>;
}

export interface WfpManagementBinding {
  observeCandidate(input: unknown): Promise<unknown>;
  activateCandidate(input: unknown): Promise<unknown>;
  observeActivation(input: unknown): Promise<unknown>;
  remove(input: unknown): Promise<unknown>;
  finalizeRemoval(input: unknown): Promise<unknown>;
  removeCandidate(input: unknown): Promise<unknown>;
}

interface RuntimeSecretDeliveryBinding {
  ensureCustomerAuthSecret(input: unknown): Promise<unknown>;
  ensureMailGatewayKey(input: unknown): Promise<unknown>;
  ensureStorageGatewayKey(input: unknown): Promise<unknown>;
  ensureAiGatewayKey(input: unknown): Promise<unknown>;
  ensureBrowserGatewayKey(input: unknown): Promise<unknown>;
  stageCandidate(input: unknown): Promise<unknown>;
  stagePromotionCandidate(input: unknown): Promise<unknown>;
  recordStagedCandidate(input: unknown): Promise<unknown>;
  recordActivatedCandidate(input: unknown): Promise<unknown>;
  prepareExistingCandidate(input: unknown): Promise<unknown>;
  activateCandidate(input: unknown): Promise<unknown>;
  observeActivation(input: unknown): Promise<unknown>;
  compensateActivation(input: unknown): Promise<unknown>;
  compensateGatewayActivation(input: unknown): Promise<unknown>;
  removeCandidate(input: unknown): Promise<unknown>;
  removePersistedCandidate(input: unknown): Promise<unknown>;
  reconcileRuntimeSecrets(input: unknown): Promise<unknown>;
}

interface NeonManagementBinding {
  placeNativeAuthDatabase(input: unknown): Promise<unknown>;
  prepareNativeAuthRealm(input: unknown): Promise<unknown>;
  placeProject(input: unknown): Promise<unknown>;
  migrateProject(input: unknown): Promise<unknown>;
  readRuntimeBinding(input: unknown): Promise<unknown>;
  deleteProject(input: unknown): Promise<unknown>;
  deleteNativeAuthProject(input: unknown): Promise<unknown>;
  reauthorizeDataEnvironment(input: unknown): Promise<unknown>;
  revokeDataChangeAccess(input: unknown): Promise<unknown>;
}
interface NativeAuthResourceBinding {
  readProvisioningPolicy(input: unknown): Promise<unknown>;
  readPendingNativePolicySync(input: unknown): Promise<unknown>;
  readDomainPolicySync(input: unknown): Promise<unknown>;
  ackDomainPolicySync(input: unknown): Promise<unknown>;
  beginHandleDomainRecovery(input: unknown): Promise<unknown>;
  completeHandleDomainRecovery(input: unknown): Promise<unknown>;
  completeNativePolicySync(input: unknown): Promise<unknown>;
}
interface NativeAuthAdminBinding {
  applyRealmPolicy(input: unknown): Promise<unknown>;
}

interface StorageDataManagementBinding {
  purgeRetiredData(input: unknown): Promise<unknown>;
}

interface R2ManagementBinding {
  ensureBucket(input: unknown): Promise<unknown>;
  readRuntimeBinding(input: unknown): Promise<unknown>;
  purgeAndDeleteBucket(input: unknown): Promise<unknown>;
}

interface SesManagementBinding {
  ensureMailDomain(input: unknown): Promise<unknown>;
  deleteMailProject(input: unknown): Promise<unknown>;
}

interface CloudflareDomainManagementBinding {
  ensureEnvironment(input: unknown): Promise<unknown>;
  deleteProject(input: unknown): Promise<unknown>;
}

/** Every private binding of the Deployment Workflow must expose its exact method inventory. */
export function readDeploymentWorkflowServices(
  bindings: Readonly<Record<string, unknown>>,
): Readonly<DeploymentWorkflowServiceBindings> {
  return Object.freeze({
    PROJECT_PROVISIONING_WORKFLOW: requireWorkflow<ProjectProvisioningMessageV1>(
      bindings["PROJECT_PROVISIONING_WORKFLOW"],
    ),
    DEPLOYMENT_WORKFLOW: requireWorkflow<unknown>(bindings["DEPLOYMENT_WORKFLOW"]),
    PROVIDER_RECONCILIATION_WORKFLOW: requireWorkflow<ProductProviderReconciliationMessageV1>(
      bindings["PROVIDER_RECONCILIATION_WORKFLOW"],
    ),
    SOURCE_FETCHER: requireMethods<SourceFetcherBinding>(bindings["SOURCE_FETCHER"], [
      "acquireExact",
      "inspectExact",
      "validateRepositoryLink",
      "managedGit",
      "managedBlob",
    ]),
    BUILD_RUNNER: requireMethods<BuildRunnerBinding>(bindings["BUILD_RUNNER"], [
      "startBuild",
      "readBuild",
      "readBuildArtifact",
      "removeBuildArtifact",
      "removeBuildArtifactObject",
      "removeArchive",
    ]),
    RECOVERY_INVOKER: requireMethods<RecoveryInvokerBinding>(bindings["RECOVERY_INVOKER"], [
      "invokeRecovery",
    ]),
    RUNTIME_SECRET_DELIVERY: requireMethods<RuntimeSecretDeliveryBinding>(
      bindings["RUNTIME_SECRET_DELIVERY"],
      [
        "ensureCustomerAuthSecret",
        "ensureMailGatewayKey",
        "ensureStorageGatewayKey",
        "ensureAiGatewayKey",
        "ensureBrowserGatewayKey",
        "stageCandidate",
        "stagePromotionCandidate",
        "recordStagedCandidate",
        "recordActivatedCandidate",
        "prepareExistingCandidate",
        "activateCandidate",
        "observeActivation",
        "compensateActivation",
        "compensateGatewayActivation",
        "removeCandidate",
        "removePersistedCandidate",
        "reconcileRuntimeSecrets",
      ],
    ),
    NEXT_CACHE_RETIREMENT: requireMethods<{ retire(input: unknown): Promise<unknown> }>(
      bindings["NEXT_CACHE_RETIREMENT"],
      ["retire"],
    ),
    NEON_MANAGEMENT: requireMethods<NeonManagementBinding>(bindings["NEON_MANAGEMENT"], [
      "placeNativeAuthDatabase",
      "prepareNativeAuthRealm",
      "placeProject",
      "migrateProject",
      "readRuntimeBinding",
      "deleteProject",
      "deleteNativeAuthProject",
      "reauthorizeDataEnvironment",
      "revokeDataChangeAccess",
    ]),
    NATIVE_AUTH_RESOURCE_RUNTIME: requireMethods<NativeAuthResourceBinding>(
      bindings["NATIVE_AUTH_RESOURCE_RUNTIME"],
      [
        "readProvisioningPolicy",
        "readPendingNativePolicySync",
        "completeNativePolicySync",
        "readDomainPolicySync",
        "ackDomainPolicySync",
        "beginHandleDomainRecovery",
        "completeHandleDomainRecovery",
      ],
    ),
    NATIVE_AUTH_ADMIN_US: requireMethods<NativeAuthAdminBinding>(bindings["NATIVE_AUTH_ADMIN_US"], [
      "applyRealmPolicy",
    ]),
    NATIVE_AUTH_ADMIN_EU: requireMethods<NativeAuthAdminBinding>(bindings["NATIVE_AUTH_ADMIN_EU"], [
      "applyRealmPolicy",
    ]),
    R2_MANAGEMENT: requireMethods<R2ManagementBinding>(bindings["R2_MANAGEMENT"], [
      "ensureBucket",
      "readRuntimeBinding",
      "purgeAndDeleteBucket",
    ]),
    STORAGE_DATA_MANAGEMENT: requireMethods<StorageDataManagementBinding>(
      bindings["STORAGE_DATA_MANAGEMENT"],
      ["purgeRetiredData"],
    ),
    SES_MANAGEMENT: requireMethods<SesManagementBinding>(bindings["SES_MANAGEMENT"], [
      "ensureMailDomain",
      "deleteMailProject",
    ]),
    CLOUDFLARE_DOMAIN_MANAGEMENT: requireMethods<CloudflareDomainManagementBinding>(
      bindings["CLOUDFLARE_DOMAIN_MANAGEMENT"],
      ["ensureEnvironment", "deleteProject"],
    ),
    WFP_MANAGEMENT: requireMethods<WfpManagementBinding>(bindings["WFP_MANAGEMENT"], [
      "observeCandidate",
      "activateCandidate",
      "observeActivation",
      "remove",
      "finalizeRemoval",
      "removeCandidate",
    ]),
  });
}

function requireMethods<T>(value: unknown, methods: readonly string[]): T {
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError("Deployment Workflow requires its private Service Binding inventory");
  }
  return value as T;
}

function requireWorkflow<Message>(value: unknown): CloudflareWorkflowBinding<Message> {
  if (
    !isRecord(value) ||
    typeof value["create"] !== "function" ||
    typeof value["get"] !== "function"
  ) {
    throw new TypeError("Project provisioning Worker requires its Workflow binding");
  }
  return value as unknown as CloudflareWorkflowBinding<Message>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
