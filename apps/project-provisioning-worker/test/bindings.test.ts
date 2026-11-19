import { describe, expect, it, vi } from "vitest";

import { readDeploymentWorkflowServices } from "../src/bindings.js";

const valid = () => ({
  PROJECT_PROVISIONING_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  DEPLOYMENT_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  PROVIDER_RECONCILIATION_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  SOURCE_FETCHER: {
    managedGit: vi.fn(async () => null),
    managedBlob: vi.fn(async () => null),
    acquireExact: vi.fn(),
    inspectExact: vi.fn(),
    validateRepositoryLink: vi.fn(),
  },
  BUILD_RUNNER: {
    startBuild: vi.fn(),
    readBuild: vi.fn(),
    readBuildArtifact: vi.fn(),
    removeBuildArtifact: vi.fn(),
    removeBuildArtifactObject: vi.fn(),
    removeArchive: vi.fn(),
  },
  RECOVERY_INVOKER: {
    async invokeRecovery(): Promise<unknown> {
      throw new Error("Unexpected recovery call");
    },
  },
  NEXT_CACHE_RETIREMENT: { retire: vi.fn() },
  RUNTIME_SECRET_DELIVERY: {
    ensureCustomerAuthSecret: vi.fn(),
    ensureMailGatewayKey: vi.fn(),
    ensureStorageGatewayKey: vi.fn(),
    ensureAiGatewayKey: vi.fn(),
    ensureBrowserGatewayKey: vi.fn(),
    stageCandidate: vi.fn(),
    stagePromotionCandidate: vi.fn(),
    recordStagedCandidate: vi.fn(),
    recordActivatedCandidate: vi.fn(),
    prepareExistingCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    observeActivation: vi.fn(),
    compensateActivation: vi.fn(),
    compensateGatewayActivation: vi.fn(),
    removeCandidate: vi.fn(),
    removePersistedCandidate: vi.fn(),
    reconcileRuntimeSecrets: vi.fn(),
  },
  NATIVE_AUTH_RESOURCE_RUNTIME: {
    readProvisioningPolicy: vi.fn(),
    readPendingNativePolicySync: vi.fn(),
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
    placeProject: vi.fn(),
    migrateProject: vi.fn(),
    readRuntimeBinding: vi.fn(),
    deleteProject: vi.fn(),
    reauthorizeDataEnvironment: vi.fn(),
    revokeDataChangeAccess: vi.fn(),
  },
  R2_MANAGEMENT: {
    ensureBucket: vi.fn(),
    readRuntimeBinding: vi.fn(),
    purgeAndDeleteBucket: vi.fn(),
  },
  STORAGE_DATA_MANAGEMENT: { purgeRetiredData: vi.fn() },
  SES_MANAGEMENT: {
    ensureTenant: vi.fn(),
    ensureMailDomain: vi.fn(),
    deleteMailProject: vi.fn(),
  },
  CLOUDFLARE_DOMAIN_MANAGEMENT: {
    ensureEnvironment: vi.fn(),
    deleteProject: vi.fn(),
  },
  WFP_MANAGEMENT: {
    observeCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    observeActivation: vi.fn(),
    remove: vi.fn(),
    finalizeRemoval: vi.fn(),
    removeCandidate: vi.fn(),
  },
});

describe("project provisioning Worker bindings", () => {
  it("accepts the complete private Service Binding and Workflow inventory", () => {
    expect(readDeploymentWorkflowServices(valid())).toMatchObject({
      PROJECT_PROVISIONING_WORKFLOW: { create: expect.any(Function), get: expect.any(Function) },
      SOURCE_FETCHER: { validateRepositoryLink: expect.any(Function) },
      BUILD_RUNNER: {
        readBuildArtifact: expect.any(Function),
        removeBuildArtifact: expect.any(Function),
        removeBuildArtifactObject: expect.any(Function),
        removeArchive: expect.any(Function),
      },
      RECOVERY_INVOKER: { invokeRecovery: expect.any(Function) },
      RUNTIME_SECRET_DELIVERY: {
        ensureCustomerAuthSecret: expect.any(Function),
        ensureMailGatewayKey: expect.any(Function),
        ensureStorageGatewayKey: expect.any(Function),
        ensureAiGatewayKey: expect.any(Function),
        stageCandidate: expect.any(Function),
        recordStagedCandidate: expect.any(Function),
        recordActivatedCandidate: expect.any(Function),
        prepareExistingCandidate: expect.any(Function),
        activateCandidate: expect.any(Function),
        observeActivation: expect.any(Function),
        compensateActivation: expect.any(Function),
        compensateGatewayActivation: expect.any(Function),
        removeCandidate: expect.any(Function),
        removePersistedCandidate: expect.any(Function),
      },
      NEON_MANAGEMENT: {
        placeProject: expect.any(Function),
        migrateProject: expect.any(Function),
        readRuntimeBinding: expect.any(Function),
      },
      R2_MANAGEMENT: {
        ensureBucket: expect.any(Function),
        readRuntimeBinding: expect.any(Function),
      },
      SES_MANAGEMENT: {
        ensureTenant: expect.any(Function),
        ensureMailDomain: expect.any(Function),
        deleteMailProject: expect.any(Function),
      },
      CLOUDFLARE_DOMAIN_MANAGEMENT: {
        ensureEnvironment: expect.any(Function),
        deleteProject: expect.any(Function),
      },
      WFP_MANAGEMENT: {
        observeCandidate: expect.any(Function),
        activateCandidate: expect.any(Function),
        observeActivation: expect.any(Function),
        remove: expect.any(Function),
        finalizeRemoval: expect.any(Function),
      },
    });
  });

  it.each([
    ["workflow", { ...valid(), DEPLOYMENT_WORKFLOW: {} }],
    ["source", { ...valid(), SOURCE_FETCHER: {} }],
    ["build", { ...valid(), BUILD_RUNNER: { startBuild: vi.fn() } }],
    ["recovery", { ...valid(), RECOVERY_INVOKER: {} }],
    ["runtime-secrets", { ...valid(), RUNTIME_SECRET_DELIVERY: {} }],
    ["r2", { ...valid(), R2_MANAGEMENT: {} }],
    ["ses", { ...valid(), SES_MANAGEMENT: {} }],
    ["domains", { ...valid(), CLOUDFLARE_DOMAIN_MANAGEMENT: {} }],
    ["wfp", { ...valid(), WFP_MANAGEMENT: { observeCandidate: vi.fn() } }],
  ])("rejects an invalid DeploymentWorkflow %s binding", (_name, input) => {
    expect(() => readDeploymentWorkflowServices(input)).toThrow(TypeError);
  });
});
