import type { DeploymentWorkflowServiceBindings } from "./bindings.js";
import type { ManagedSourceBlob } from "@ohmyhost/database";

export function createPrivateDeploymentServices(bindings: DeploymentWorkflowServiceBindings) {
  return Object.freeze({
    source: Object.freeze({
      acquireExact: (input: unknown) => bindings.SOURCE_FETCHER.acquireExact(input),
      inspectExact: (input: unknown) => bindings.SOURCE_FETCHER.inspectExact(input),
      validateRepositoryLink: (input: unknown) =>
        bindings.SOURCE_FETCHER.validateRepositoryLink(input),
      async removeManagedRepository(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly operationId: string;
        readonly repository: { readonly namespace: string; readonly repositoryName: string };
      }): Promise<void> {
        if ((await bindings.SOURCE_FETCHER.managedGit("deleteRepository", input)) !== null)
          throw new TypeError("Managed repository absence receipt is invalid");
      },
      async removeManagedBlobOperation(input: {
        readonly organizationId: string;
        readonly projectId: string;
        readonly operationId: string;
        readonly region: "us" | "eu";
        readonly blobs: readonly ManagedSourceBlob[];
      }): Promise<void> {
        if ((await bindings.SOURCE_FETCHER.managedBlob("deleteOperation", input)) !== null)
          throw new TypeError("Managed staging absence receipt is invalid");
      },
    }),
    build: Object.freeze({
      startBuild: (input: unknown) => bindings.BUILD_RUNNER.startBuild(input),
      readBuild: (input: unknown) => bindings.BUILD_RUNNER.readBuild(input),
      readBuildArtifact: (input: unknown) => bindings.BUILD_RUNNER.readBuildArtifact(input),
      removeBuildArtifact: (input: unknown) => bindings.BUILD_RUNNER.removeBuildArtifact(input),
      removeBuildArtifactObject: (input: unknown) =>
        bindings.BUILD_RUNNER.removeBuildArtifactObject(input),
      removeArchive: (input: unknown) => bindings.BUILD_RUNNER.removeArchive(input),
    }),
    recovery: Object.freeze({
      invokeRecovery: (input: unknown) => bindings.RECOVERY_INVOKER.invokeRecovery(input),
    }),
    runtimeSecrets: Object.freeze({
      ensureCustomerAuthSecret: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.ensureCustomerAuthSecret(input),
      ensureMailGatewayKey: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.ensureMailGatewayKey(input),
      ensureStorageGatewayKey: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.ensureStorageGatewayKey(input),
      ensureAiGatewayKey: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.ensureAiGatewayKey(input),
      ensureBrowserGatewayKey: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.ensureBrowserGatewayKey(input),
      stageCandidate: (input: unknown) => bindings.RUNTIME_SECRET_DELIVERY.stageCandidate(input),
      stagePromotionCandidate: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.stagePromotionCandidate(input),
      recordStagedCandidate: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.recordStagedCandidate(input),
      recordActivatedCandidate: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.recordActivatedCandidate(input),
      prepareExistingCandidate: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.prepareExistingCandidate(input),
      activateCandidate: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.activateCandidate(input),
      observeActivation: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.observeActivation(input),
      compensateActivation: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.compensateActivation(input),
      compensateGatewayActivation: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.compensateGatewayActivation(input),
      removeCandidate: (input: unknown) => bindings.RUNTIME_SECRET_DELIVERY.removeCandidate(input),
      removePersistedCandidate: (input: unknown) =>
        bindings.RUNTIME_SECRET_DELIVERY.removePersistedCandidate(input),
    }),
    neon: Object.freeze({
      placeNativeAuthDatabase: (input: unknown) =>
        bindings.NEON_MANAGEMENT.placeNativeAuthDatabase(input),
      prepareNativeAuthRealm: (input: unknown) =>
        bindings.NEON_MANAGEMENT.prepareNativeAuthRealm(input),
      placeProject: (input: unknown) => bindings.NEON_MANAGEMENT.placeProject(input),
      migrateProject: (input: unknown) => bindings.NEON_MANAGEMENT.migrateProject(input),
      readRuntimeBinding: (input: unknown) => bindings.NEON_MANAGEMENT.readRuntimeBinding(input),
      deleteProject: (input: unknown) => bindings.NEON_MANAGEMENT.deleteProject(input),
      deleteNativeAuthProject: (input: unknown) =>
        bindings.NEON_MANAGEMENT.deleteNativeAuthProject(input),
      reauthorizeDataEnvironment: (input: unknown) =>
        bindings.NEON_MANAGEMENT.reauthorizeDataEnvironment(input),
      revokeDataChangeAccess: (input: unknown) =>
        bindings.NEON_MANAGEMENT.revokeDataChangeAccess(input),
    }),
    r2: Object.freeze({
      ensureBucket: (input: unknown) => bindings.R2_MANAGEMENT.ensureBucket(input),
      readRuntimeBinding: (input: unknown) => bindings.R2_MANAGEMENT.readRuntimeBinding(input),
      purgeAndDeleteBucket: (input: unknown) => bindings.R2_MANAGEMENT.purgeAndDeleteBucket(input),
    }),
    storageData: Object.freeze({
      purgeRetiredData: (input: unknown) =>
        bindings.STORAGE_DATA_MANAGEMENT.purgeRetiredData(input),
    }),
    ses: Object.freeze({
      ensureMailDomain: (input: unknown) => bindings.SES_MANAGEMENT.ensureMailDomain(input),
      deleteMailProject: (input: unknown) => bindings.SES_MANAGEMENT.deleteMailProject(input),
    }),
    domains: Object.freeze({
      ensureEnvironment: (input: unknown) =>
        bindings.CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment(input),
      deleteProject: (input: unknown) => bindings.CLOUDFLARE_DOMAIN_MANAGEMENT.deleteProject(input),
    }),
    wfp: Object.freeze({
      observe: (input: unknown) => bindings.WFP_MANAGEMENT.observeCandidate(input),
      activateCandidate: (input: unknown) => bindings.WFP_MANAGEMENT.activateCandidate(input),
      observeActivation: (input: unknown) => bindings.WFP_MANAGEMENT.observeActivation(input),
      remove: (input: unknown) => bindings.WFP_MANAGEMENT.remove(input),
      finalizeRemoval: (input: unknown) => bindings.WFP_MANAGEMENT.finalizeRemoval(input),
      removeCandidate: (input: unknown) => bindings.WFP_MANAGEMENT.removeCandidate(input),
    }),
  });
}
