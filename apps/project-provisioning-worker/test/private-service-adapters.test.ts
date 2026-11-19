import { describe, expect, it, vi } from "vitest";

import { createPrivateDeploymentServices } from "../src/private-service-adapters.js";

const bindings = () => ({
  PROJECT_PROVISIONING_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  DEPLOYMENT_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  PROVIDER_RECONCILIATION_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  SOURCE_FETCHER: {
    managedGit: vi.fn(async () => null),
    managedBlob: vi.fn(async () => null),
    acquireExact: vi.fn(async () => ({ archiveId: "archive-1" })),
    inspectExact: vi.fn(async () => ({ status: "available" })),
    validateRepositoryLink: vi.fn(async () => ({ status: "valid" })),
  },
  BUILD_RUNNER: {
    startBuild: vi.fn(async () => ({ buildId: "build-1" })),
    readBuild: vi.fn(async () => ({ status: "succeeded" })),
    readBuildArtifact: vi.fn(async () => ({ manifestDigest: "sha256:artifact" })),
    removeBuildArtifact: vi.fn(async () => ({ state: "absent" })),
    removeBuildArtifactObject: vi.fn(async () => ({ state: "absent" })),
    removeArchive: vi.fn(async () => ({ state: "absent" })),
  },
  RECOVERY_INVOKER: {
    invokeRecovery: vi.fn(async () => ({ status: "absent" })),
  },
  NEXT_CACHE_RETIREMENT: { retire: vi.fn(async () => ({ kind: "retired" })) },
  RUNTIME_SECRET_DELIVERY: {
    ensureCustomerAuthSecret: vi.fn(),
    ensureMailGatewayKey: vi.fn(async () => ({ name: "OHMYHOST_MAIL_KEY" })),
    ensureStorageGatewayKey: vi.fn(async () => ({ name: "OHMYHOST_STORAGE_KEY" })),
    ensureAiGatewayKey: vi.fn(async () => ({ name: "OHMYHOST_AI_KEY" })),
    ensureBrowserGatewayKey: vi.fn(async () => ({ name: "OHMYHOST_BROWSER_KEY" })),
    stageCandidate: vi.fn(async () => ({ status: "staged" })),
    stagePromotionCandidate: vi.fn(async () => ({ status: "staged" })),
    recordStagedCandidate: vi.fn(async () => ({ status: "recorded" })),
    recordActivatedCandidate: vi.fn(async () => ({ status: "activated" })),
    prepareExistingCandidate: vi.fn(async () => ({ status: "prepared" })),
    activateCandidate: vi.fn(async () => ({ status: "activated" })),
    observeActivation: vi.fn(async () => ({ status: "activated" })),
    compensateActivation: vi.fn(async () => ({ status: "compensated" })),
    compensateGatewayActivation: vi.fn(async () => ({ status: "compensated" })),
    removeCandidate: vi.fn(async () => ({ status: "absent" })),
    removePersistedCandidate: vi.fn(async () => ({ status: "removed", outcome: "not_found" })),
    reconcileRuntimeSecrets: vi.fn(async () => ({ status: "synchronized" })),
  },
  NATIVE_AUTH_RESOURCE_RUNTIME: {
    readProvisioningPolicy: vi.fn(),
    readPendingNativePolicySync: vi.fn(async () => null),
    completeNativePolicySync: vi.fn(),
    readDomainPolicySync: vi.fn(),
    ackDomainPolicySync: vi.fn(),
    beginHandleDomainRecovery: vi.fn(async () => null),
    completeHandleDomainRecovery: vi.fn(),
  },
  NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: vi.fn() },
  NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: vi.fn() },
  NEON_MANAGEMENT: {
    deleteNativeAuthProject: vi.fn(),
    placeNativeAuthDatabase: vi.fn(),
    prepareNativeAuthRealm: vi.fn(),
    reauthorizeDataEnvironment: vi.fn(async () => ({ status: "ready" })),
    revokeDataChangeAccess: vi.fn(async () => ({ status: "completed", revoked: 0 })),
    placeProject: vi.fn(async () => ({ status: "ready" })),
    migrateProject: vi.fn(async () => ({ status: "ready" })),
    readRuntimeBinding: vi.fn(async () => ({ status: "ready" })),
    deleteProject: vi.fn(async () => ({ status: "ready" })),
  },
  STORAGE_DATA_MANAGEMENT: {
    purgeRetiredData: vi.fn(async () => ({ status: "ready", deletedFiles: 0 })),
  },
  R2_MANAGEMENT: {
    ensureBucket: vi.fn(async () => ({ status: "ready" })),
    readRuntimeBinding: vi.fn(async () => ({ status: "ready", bucketName: "bucket-1" })),
    purgeAndDeleteBucket: vi.fn(async () => ({ status: "absent" })),
  },
  SES_MANAGEMENT: {
    ensureTenant: vi.fn(async () => ({ status: "ready" })),
    ensureMailDomain: vi.fn(async () => ({ status: "ready" })),
    deleteMailProject: vi.fn(async () => ({ status: "deleted" })),
  },
  CLOUDFLARE_DOMAIN_MANAGEMENT: {
    ensureEnvironment: vi.fn(async () => ({ status: "ready" })),
    deleteProject: vi.fn(async () => ({ outcome: "deleted" })),
  },
  WFP_MANAGEMENT: {
    removeCandidate: vi.fn(async () => ({ status: "removed", outcome: "not_found" })),
    observeCandidate: vi.fn(async () => ({ state: "ready" })),
    activateCandidate: vi.fn(async () => ({ status: "activated" })),
    observeActivation: vi.fn(async () => ({ status: "activated" })),
    remove: vi.fn(async () => ({ status: "tombstoned" })),
    finalizeRemoval: vi.fn(async () => ({ status: "removed", consecutive404s: 3 })),
  },
});

describe("private deployment Service Binding adapters", () => {
  it("forwards only the named RPC methods without exposing provider credentials", async () => {
    const env = bindings();
    const services = createPrivateDeploymentServices(env);
    const input = { locator: "opaque" };
    await expect(services.source.acquireExact(input)).resolves.toEqual({ archiveId: "archive-1" });
    await expect(services.source.inspectExact(input)).resolves.toEqual({ status: "available" });
    await expect(services.source.validateRepositoryLink(input)).resolves.toEqual({
      status: "valid",
    });
    const sourceScope = {
      organizationId: "org",
      projectId: "project",
      operationId: "deletion",
      repository: { namespace: "managed", repositoryName: "repo" },
    };
    await expect(services.source.removeManagedRepository(sourceScope)).resolves.toBeUndefined();
    expect(env.SOURCE_FETCHER.managedGit).toHaveBeenCalledWith("deleteRepository", sourceScope);
    const blobs = {
      organizationId: "org",
      projectId: "project",
      operationId: "origin",
      region: "us" as const,
      blobs: [],
    };
    await expect(services.source.removeManagedBlobOperation(blobs)).resolves.toBeUndefined();
    expect(env.SOURCE_FETCHER.managedBlob).toHaveBeenCalledWith("deleteOperation", blobs);
    await expect(services.build.startBuild(input)).resolves.toEqual({ buildId: "build-1" });
    await expect(services.build.readBuild(input)).resolves.toEqual({ status: "succeeded" });
    await expect(services.build.readBuildArtifact(input)).resolves.toEqual({
      manifestDigest: "sha256:artifact",
    });
    await expect(services.build.removeBuildArtifact(input)).resolves.toEqual({ state: "absent" });
    await expect(services.build.removeBuildArtifactObject(input)).resolves.toEqual({
      state: "absent",
    });
    await expect(services.build.removeArchive(input)).resolves.toEqual({ state: "absent" });
    await expect(services.recovery.invokeRecovery(input)).resolves.toEqual({ status: "absent" });
    expect(env.RECOVERY_INVOKER.invokeRecovery).toHaveBeenCalledWith(input);
    await expect(services.runtimeSecrets.removePersistedCandidate(input)).resolves.toEqual({
      status: "removed",
      outcome: "not_found",
    });
    await expect(services.runtimeSecrets.stageCandidate(input)).resolves.toEqual({
      status: "staged",
    });
    await expect(services.runtimeSecrets.stagePromotionCandidate(input)).resolves.toEqual({
      status: "staged",
    });
    await expect(services.runtimeSecrets.recordStagedCandidate(input)).resolves.toEqual({
      status: "recorded",
    });
    await expect(services.runtimeSecrets.recordActivatedCandidate(input)).resolves.toEqual({
      status: "activated",
    });
    await expect(services.runtimeSecrets.prepareExistingCandidate(input)).resolves.toEqual({
      status: "prepared",
    });
    await expect(services.runtimeSecrets.activateCandidate(input)).resolves.toEqual({
      status: "activated",
    });
    await expect(services.runtimeSecrets.observeActivation(input)).resolves.toEqual({
      status: "activated",
    });
    await expect(services.runtimeSecrets.compensateActivation(input)).resolves.toEqual({
      status: "compensated",
    });
    await expect(services.runtimeSecrets.compensateGatewayActivation(input)).resolves.toEqual({
      status: "compensated",
    });
    await expect(services.runtimeSecrets.removeCandidate(input)).resolves.toEqual({
      status: "absent",
    });
    await expect(services.neon.placeProject(input)).resolves.toEqual({ status: "ready" });
    await expect(services.neon.migrateProject(input)).resolves.toEqual({ status: "ready" });
    await expect(services.neon.reauthorizeDataEnvironment(input)).resolves.toEqual({
      status: "ready",
    });
    await expect(services.neon.revokeDataChangeAccess(input)).resolves.toEqual({
      status: "completed",
      revoked: 0,
    });
    await expect(services.storageData.purgeRetiredData(input)).resolves.toEqual({
      status: "ready",
      deletedFiles: 0,
    });
    await expect(services.r2.ensureBucket(input)).resolves.toEqual({ status: "ready" });
    await expect(services.r2.readRuntimeBinding(input)).resolves.toEqual({
      status: "ready",
      bucketName: "bucket-1",
    });
    await expect(services.ses.ensureMailDomain(input)).resolves.toEqual({ status: "ready" });
    await expect(services.ses.deleteMailProject(input)).resolves.toEqual({ status: "deleted" });
    expect(Object.keys(services.domains).sort()).toEqual(["deleteProject", "ensureEnvironment"]);
    await expect(services.domains.ensureEnvironment(input)).resolves.toEqual({ status: "ready" });
    await expect(services.domains.deleteProject(input)).resolves.toEqual({ outcome: "deleted" });
    await expect(services.runtimeSecrets.ensureMailGatewayKey(input)).resolves.toEqual({
      name: "OHMYHOST_MAIL_KEY",
    });
    await expect(services.runtimeSecrets.ensureStorageGatewayKey(input)).resolves.toEqual({
      name: "OHMYHOST_STORAGE_KEY",
    });
    await expect(services.runtimeSecrets.ensureAiGatewayKey(input)).resolves.toEqual({
      name: "OHMYHOST_AI_KEY",
    });
    await expect(services.wfp.observe(input)).resolves.toEqual({ state: "ready" });
    await expect(services.wfp.activateCandidate(input)).resolves.toEqual({ status: "activated" });
    await expect(services.wfp.observeActivation(input)).resolves.toEqual({ status: "activated" });
    await expect(services.wfp.remove(input)).resolves.toEqual({ status: "tombstoned" });
    await expect(services.wfp.finalizeRemoval(input)).resolves.toEqual({
      status: "removed",
      consecutive404s: 3,
    });
    await expect(services.wfp.removeCandidate(input)).resolves.toEqual({
      status: "removed",
      outcome: "not_found",
    });
  });
});
