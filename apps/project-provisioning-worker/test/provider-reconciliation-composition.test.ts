import type { DeploymentWorkflowServiceBindings } from "../src/bindings.js";
import type { ProductProviderReconciliationMessageV1 } from "@ohmyhost/orchestrator";
import { parseUlid } from "@ohmyhost/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  abandonLostProductCommand: vi.fn(
    async (): Promise<"abandoned" | "existing" | "changed"> => "abandoned",
  ),
  claimProductProviderMutation: vi.fn(async () => "created" as const),
  finalizeDeploymentQueueDeliveryRecovery: vi.fn(),
  finalizeProjectProvisioningQueueDeliveryRecovery: vi.fn(),
  finalizeSourceLinkQueueDeliveryRecovery: vi.fn(),
  findClaimlessProductProviderReconciliationCandidate: vi.fn(),
  findLostProductCommand: vi.fn(
    async (): Promise<
      { state: "abandoned" } | { state: "lost"; workflowId: string | null } | null
    > => null,
  ),
  findProductWorkflowReplayCandidate: vi.fn(),
  findRunlessProductDispatch: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  acceptRunlessProductDispatch: vi.fn(async () => ({})),
  findProductProviderReconciliationClaim: vi.fn(),
  prepareProductProviderReconciliation: vi.fn(),
  prepareDeploymentQueueDeliveryRecovery: vi.fn(),
  prepareProjectProvisioningQueueDeliveryRecovery: vi.fn(),
  prepareSourceLinkQueueDeliveryRecovery: vi.fn(),
  readProductProviderReconciliationAttempt: vi.fn(),
  readProductProviderReconciliationContext: vi.fn(),
  readProductWorkflowReplayAttempt: vi.fn(),
  readTerminalSourceLinkWorkflowReplayAttempt: vi.fn(),
  readClosedSourceLinkQueueDeliveryRecovery: vi.fn(),
  reconcileProductCommand: vi.fn(async () => "reconciliation_required" as const),
  recoverTerminalProductProviderReconciliationAttempt: vi.fn(async () => "recovered" as const),
  recoverTerminalProductWorkflowReplay: vi.fn(async () => "recovered" as const),
  prepareProductWorkflowReplay: vi.fn(
    async (): Promise<"prepared" | "existing" | "exhausted"> => "prepared",
  ),
}));

vi.mock("@ohmyhost/database/provisioning-persistence", () => database);

import {
  createCoreProviderReconciliationPorts,
  requestCoreProviderReconciliation,
} from "../src/provider-reconciliation-composition.js";
import {
  PROVIDER_RECONCILIATION_METHODS,
  type ProviderReconciliationRuntimeBinding,
} from "../src/provider-reconciliation-data-port.js";
import { deterministicUlid } from "../src/deterministic-ulid.js";

/** The Core capability answers every operation through the recorded persistence functions below. */
const runtime = Object.fromEntries(
  PROVIDER_RECONCILIATION_METHODS.map((method) => [
    method,
    (input: unknown) =>
      (database as unknown as Record<string, (client: unknown, input: unknown) => unknown>)[
        method
      ]?.({}, input),
  ]),
) as unknown as ProviderReconciliationRuntimeBinding;

const ids = {
  attempt: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  claim: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operation: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  event: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
} as const;

const liveQueueRecovery = {
  projectId: parseUlid("01M1D7N46SR22J3S7BF4Q3Y0DC"),
  operationId: parseUlid("01M1D7N46SR22J3S7BF4Q3Y0DE"),
  eventId: parseUlid("01M1D7N46SR22J3S7BF4Q3Y0DM"),
  deliveryAttemptId: parseUlid("01M1D7SJNB6TPD8MBPVE9F51S4"),
} as const;

const observedDeploymentQueueRecovery = {
  projectId: parseUlid("01M18XV7CYYNEDQJJ9WVY3GPDR"),
  environmentId: parseUlid("01M18XV7CYYNEDQJJ9WVY3GPDX"),
  operationId: parseUlid("01M1DKRQ52Y9KC59W3YC0Q8SGJ"),
  eventId: parseUlid("01M1DKRQ5E4NV39XW38KYETBN4"),
  deliveryAttemptId: parseUlid("01M1DM1DQJG7SDGQC1ZPPM91MZ"),
  planId: parseUlid("01M18XV7CYYNEDQJJ9WVY3GPDS"),
  deploymentId: parseUlid("01M18XV7CYYNEDQJJ9WVY3GPDT"),
} as const;

const observedSourceLinkQueueRecovery = {
  projectId: parseUlid("01M1D7N46SR22J3S7BF4Q3Y0DC"),
  environmentId: parseUlid("01M1D7N46SR22J3S7BF4Q3Y0DH"),
  operationId: parseUlid("01M1EJMS444BBRX33433XGJY6Q"),
  eventId: parseUlid("01M1EJMS4GNBEQZBNQWDMKYSBZ"),
  deliveryAttemptId: parseUlid("01M1EJMS4XZD9W4VAWZSC6HMEP"),
} as const;

const message: ProductProviderReconciliationMessageV1 = {
  version: 1,
  attemptId: parseUlid(ids.attempt),
  claimId: parseUlid(ids.claim),
  organizationId: parseUlid(ids.organization),
  projectId: parseUlid(ids.project),
  environmentId: parseUlid(ids.environment),
  operationId: parseUlid(ids.operation),
  actorId: "user:operator_1",
  idempotencySha256: `sha256:${"a".repeat(64)}`,
};
const clock = { now: () => new Date("2026-08-21T10:01:00.000Z") } as const;

function workflow(status = "running") {
  return {
    create: vi.fn(async () => ({ status: vi.fn(async () => ({ status })) })),
    get: vi.fn(async () => ({ status: vi.fn(async () => ({ status })) })),
  };
}

function bindings(): DeploymentWorkflowServiceBindings {
  return {
    PROJECT_PROVISIONING_WORKFLOW: workflow(),
    DEPLOYMENT_WORKFLOW: workflow(),
    PROVIDER_RECONCILIATION_WORKFLOW: workflow(),
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
    NEXT_CACHE_RETIREMENT: { retire: vi.fn(async () => ({ kind: "retired" })) },
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
      placeProject: vi.fn(),
      migrateProject: vi.fn(),
      readRuntimeBinding: vi.fn(),
      deleteProject: vi.fn(),
    },
    STORAGE_DATA_MANAGEMENT: {
      purgeRetiredData: vi.fn(async () => ({ status: "ready", deletedFiles: 0 })),
    },
    R2_MANAGEMENT: {
      ensureBucket: vi.fn(),
      readRuntimeBinding: vi.fn(),
      purgeAndDeleteBucket: vi.fn(),
    },
    SES_MANAGEMENT: {
      ensureMailDomain: vi.fn(),
      deleteMailProject: vi.fn(),
    },
    CLOUDFLARE_DOMAIN_MANAGEMENT: {
      ensureEnvironment: vi.fn(),
      deleteProject: vi.fn(),
    },
    WFP_MANAGEMENT: {
      removeCandidate: vi.fn(async () => ({ status: "removed", outcome: "not_found" })),
      observeCandidate: vi.fn(),
      activateCandidate: vi.fn(),
      observeActivation: vi.fn(),
      remove: vi.fn(),
      finalizeRemoval: vi.fn(),
    },
  };
}

const context = {
  ...message,
  handle: "calm-otter-builds",
  environmentName: "dev" as const,
  eventId: ids.event,
  billingEpochId: ids.project,
  logicalWorkflowId: `product-command-v1-deploy-${ids.event}-${ids.operation}`,
  eventType: "DeploymentRequestedV1" as const,
  acceptedLifecycleVersion: 1,
  originalMessage: {
    version: 1,
    eventType: "DeploymentRequestedV1",
    eventId: ids.event,
    organizationId: ids.organization,
    projectId: ids.project,
    billingEpochId: ids.project,
    environmentId: ids.environment,
    operationId: ids.operation,
    planId: ids.claim,
  },
  knownDeployments: [],
  providerHint: { phase: "build" as const },
  sourceState: "ready" as const,
  buildState: "succeeded" as const,
};

const candidate = {
  provider: "cloudflare-wfp" as const,
  namespace: "ohmyho-poc-private-fullstack",
  scriptName: `p-${ids.project.toLowerCase()}-dev-${ids.claim.toLowerCase()}`,
  projectId: ids.project,
  environmentId: ids.environment,
  productDeploymentId: ids.claim,
  providerTag: "candidate-provider-tag",
  artifactDigest: `sha256:${"c".repeat(64)}` as const,
  buildReused: false,
  deployedAt: "2026-08-21T10:00:00.000Z",
};

function wfpContext() {
  return {
    ...context,
    providerHint: {
      phase: "gateway" as const,
      expectedArtifactDigest: candidate.artifactDigest,
      currentProviderTag: candidate.providerTag,
      currentProductDeploymentId: candidate.productDeploymentId,
    },
    wfpTarget: {
      candidate,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    },
  };
}

describe("provider reconciliation composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.findClaimlessProductProviderReconciliationCandidate.mockResolvedValue(null);
    database.findProductWorkflowReplayCandidate.mockResolvedValue(null);
    database.findRunlessProductDispatch.mockResolvedValue(null);
    database.findProductProviderReconciliationClaim.mockResolvedValue(null);
    database.readProductWorkflowReplayAttempt.mockResolvedValue(null);
    database.readTerminalSourceLinkWorkflowReplayAttempt.mockResolvedValue(null);
    database.readProductProviderReconciliationContext.mockResolvedValue(context);
    database.readProductProviderReconciliationAttempt.mockResolvedValue(null);
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue(null);
    database.prepareProductProviderReconciliation.mockResolvedValue({
      outcome: "prepared",
      attemptId: ids.attempt,
      physicalWorkflowId: `product-provider-reconcile-v1-${ids.attempt}`,
      originalMessage: context.originalMessage,
    });
    database.prepareProjectProvisioningQueueDeliveryRecovery.mockResolvedValue({
      outcome: "not_applicable",
    });
    database.prepareDeploymentQueueDeliveryRecovery.mockResolvedValue({
      outcome: "not_applicable",
    });
    database.prepareSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "not_applicable",
    });
    database.finalizeProjectProvisioningQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: ids.attempt,
      operationId: ids.operation,
      state: "pending",
    });
    database.finalizeDeploymentQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: ids.attempt,
      operationId: ids.operation,
      state: "pending",
    });
    database.finalizeSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: ids.attempt,
      operationId: ids.operation,
      state: "pending",
    });
  });

  it("observes exact private provider state and prepares before starting the original command", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...context,
      knownDeployments: [
        {
          provider: "cloudflare-wfp",
          namespace: "ohmyho-sandbox",
          scriptName: `p-${ids.project.toLowerCase()}`,
          projectId: ids.project,
          environmentId: ids.environment,
          productDeploymentId: ids.claim,
          providerTag: "provider-tag-a",
          artifactDigest: `sha256:${"c".repeat(64)}`,
          buildReused: false,
          deployedAt: "2026-08-21T09:00:00.000Z",
        },
      ],
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, {
      now: () => new Date("2026-08-21T10:01:00.000Z"),
    });
    const loaded = await ports.load(message);
    expect(database.readProductProviderReconciliationContext).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: ids.organization,
        projectId: ids.project,
        environmentId: ids.environment,
        operationId: ids.operation,
        claimId: ids.claim,
      },
    );
    const observation = await ports.observe(loaded);
    const prepared = await ports.prepare({ message, context: loaded, observation });
    if (prepared.outcome !== "prepared") throw new Error("Expected retry preparation");
    await expect(
      ports.resume({
        physicalWorkflowId: prepared.physicalWorkflowId,
        originalMessage: prepared.originalMessage,
      }),
    ).resolves.toBe("pending");

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claimId: ids.claim,
        actorId: message.actorId,
        mode: "retry",
        gateway: { state: "unknown" },
        wfp: { state: "unknown" },
      }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
      id: `product-provider-reconcile-v1-${ids.attempt}`,
      params: {
        command: context.originalMessage,
        reconciliationAttemptId: ids.attempt,
      },
    });
  });

  it.each([false, true])(
    "does not trust unpublished history with a null head without abandonment proof (%s)",
    async (eligible) => {
      const env = bindings();
      const old = {
        ...candidate,
        productDeploymentId: ids.event,
        scriptName: `p-${ids.project.toLowerCase()}-dev-${ids.event.toLowerCase()}`,
      };
      const oldPolicy = {
        healthCheckPath: "/old-health",
        egressAllowedOrigins: ["https://old.example.com"],
      };
      const loaded = {
        ...wfpContext(),
        hasActiveGateway: false,
        knownDeployments: [old],
        abandonedWfpTargets: eligible
          ? [
              {
                candidateReceiptId: ids.event,
                operationId: ids.event,
                candidate: old,
                runtimePolicy: oldPolicy,
              },
            ]
          : [],
      };
      const gateway = {
        provider: "ohmyhost-shared-gateway",
        organizationId: ids.organization,
        projectId: ids.project,
        environmentId: ids.environment,
        environmentName: "dev",
        handle: loaded.handle,
        hostname: "dev-calm-otter-builds.dev.check.omh.st",
        publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
        targetScriptName: old.scriptName,
        targetDeploymentId: old.productDeploymentId,
        targetProviderTag: old.providerTag,
        targetArtifactDigest: old.artifactDigest,
        egressPolicyDigest: `sha256:${"d".repeat(64)}`,
        egressAllowedOrigins: ["https://old.example.com"],
        candidateReceiptId: ids.event,
        revision: 1,
        predecessorRevision: null,
        operationId: ids.event,
        active: true,
        observedAt: clock.now(),
      };
      vi.mocked(env.WFP_MANAGEMENT.observeActivation)
        .mockResolvedValueOnce({
          status: "reconciliation_required",
          reconciliationPhase: "gateway",
        })
        .mockResolvedValueOnce({
          status: "observed",
          candidate: old,
          gateway,
          deploymentUrl: gateway.publicOrigin,
        });
      const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
      const observed = await ports.observe(loaded);
      expect(observed).toMatchObject({
        gateway: eligible
          ? { state: "ready", providerTag: gateway.targetProviderTag }
          : { state: "unknown" },
      });
      expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenCalledTimes(eligible ? 2 : 1);
      if (eligible)
        expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenLastCalledWith(
          expect.objectContaining({ candidate: old, runtimePolicy: oldPolicy }),
        );
    },
  );

  it.each([false, true])("observes retained rollback gateway (%s)", async (sameTarget) => {
    const env = bindings();
    const retained = {
      ...candidate,
      productDeploymentId: sameTarget ? candidate.productDeploymentId : ids.event,
      scriptName: sameTarget
        ? candidate.scriptName
        : `p-${ids.project.toLowerCase()}-dev-${ids.event.toLowerCase()}`,
    };
    const retainedPolicy = {
      healthCheckPath: "/",
      egressAllowedOrigins: ["https://mail.example.com"],
    };
    const recordedGateway = {
      providerTag: retained.providerTag,
      moduleDigest: `sha256:${"d".repeat(64)}`,
    };
    const rollback = {
      ...wfpContext(),
      eventType: "DeploymentRollbackRequestedV1" as const,
      providerHint: { phase: "wfp" as const, expectedArtifactDigest: candidate.artifactDigest },
      retainedWfpTarget: {
        candidate: retained,
        runtimePolicy: retainedPolicy,
        gateway: recordedGateway,
      },
    };
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: sameTarget ? "ready" : "metadata_absent",
      scriptName: candidate.scriptName,
      providerTag: sameTarget ? candidate.providerTag : null,
      productDeploymentId: sameTarget ? candidate.productDeploymentId : null,
      artifactDigest: sameTarget ? candidate.artifactDigest : null,
      observedAt: clock.now().toISOString(),
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation)
      .mockResolvedValueOnce({
        status: "reconciliation_required",
        reconciliationPhase: "candidate",
      })
      .mockResolvedValueOnce({
        status: "activated",
        candidate: retained,
        gateway: {
          provider: "ohmyhost-shared-gateway",
          hostname: "dev-calm-otter-builds.dev.check.omh.st",
          internalOrigin: "https://dev-calm-otter-builds.your-omh-account.workers.dev",
          publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
          targetScriptName: retained.scriptName,
          targetProviderTag: retained.providerTag,
          targetDeploymentId: retained.productDeploymentId,
          targetArtifactDigest: retained.artifactDigest,
          providerTag: retained.providerTag,
          observedAt: clock.now().toISOString(),
        },
        deploymentUrl: "https://dev-calm-otter-builds.dev.check.omh.st",
        health: { status: 200, path: "/", excerpt: null, truncated: false },
      });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const observation = await ports.observe(rollback);
    expect(observation).toMatchObject({
      gateway: { state: "ready", providerTag: retained.providerTag },
      wfp: { state: sameTarget ? "ready" : "absent" },
    });
    expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidate: retained,
        runtimePolicy: retainedPolicy,
        expectedGateway: recordedGateway,
      }),
    );
    await ports.prepare({
      message,
      context: rollback,
      observation,
    });
    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: sameTarget ? "retry" : "abandon",
        wfp: expect.objectContaining({ state: sameTarget ? "ready" : "absent" }),
      }),
    );
    expect(env.WFP_MANAGEMENT.remove).not.toHaveBeenCalled();
    expect(env.WFP_MANAGEMENT.activateCandidate).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("records ready only when candidate and gateway identities match exactly", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce(wfpContext());
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: candidate.scriptName,
      providerTag: candidate.providerTag,
      productDeploymentId: candidate.productDeploymentId,
      artifactDigest: candidate.artifactDigest,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation).mockResolvedValueOnce({
      status: "unhealthy",
      candidate,
      gateway: {
        provider: "ohmyhost-shared-gateway",
        hostname: "dev-calm-otter-builds.dev.check.omh.st",
        internalOrigin: "https://dev-calm-otter-builds.your-omh-account.workers.dev",
        publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
        targetScriptName: candidate.scriptName,
        targetProviderTag: candidate.providerTag,
        targetDeploymentId: candidate.productDeploymentId,
        targetArtifactDigest: candidate.artifactDigest,
        providerTag: candidate.providerTag,
        observedAt: "2026-08-21T10:00:31.000Z",
      },
      deploymentUrl: "https://dev-calm-otter-builds.dev.check.omh.st",
      health: { status: 500, path: "/", excerpt: null, truncated: false },
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gateway: {
          state: "ready",
          providerTag: candidate.providerTag,
          observedAt: "2026-08-21T10:00:31.000Z",
        },
        wfp: {
          state: "ready",
          providerTag: candidate.providerTag,
          productDeploymentId: candidate.productDeploymentId,
          artifactDigest: candidate.artifactDigest,
          observedAt: "2026-08-21T10:00:30.000Z",
        },
      }),
    );
  });

  it("preserves the exact prior Gateway tag needed to resume a staged candidate", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce(wfpContext());
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: candidate.scriptName,
      providerTag: candidate.providerTag,
      productDeploymentId: candidate.productDeploymentId,
      artifactDigest: candidate.artifactDigest,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation).mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "gateway",
      currentProviderTag: "gateway-provider-tag",
      currentProductDeploymentId: candidate.productDeploymentId,
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gateway: { state: "unknown", providerTag: "gateway-provider-tag" },
        wfp: expect.objectContaining({ state: "ready" }),
      }),
    );
  });

  it("uses the persisted exact target when the provider hint contains only its phase", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...wfpContext(),
      providerHint: { phase: "wfp" },
    });
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: candidate.scriptName,
      providerTag: candidate.providerTag,
      productDeploymentId: candidate.productDeploymentId,
      artifactDigest: candidate.artifactDigest,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation).mockResolvedValueOnce({
      status: "observed",
      candidate,
      gateway: {
        provider: "ohmyhost-shared-gateway",
        hostname: "dev-calm-otter-builds.dev.check.omh.st",
        internalOrigin: "https://dev-calm-otter-builds.your-omh-account.workers.dev",
        publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
        targetScriptName: candidate.scriptName,
        targetProviderTag: candidate.providerTag,
        targetDeploymentId: candidate.productDeploymentId,
        targetArtifactDigest: candidate.artifactDigest,
        providerTag: candidate.providerTag,
        observedAt: "2026-08-21T10:00:31.000Z",
      },
      deploymentUrl: "https://dev-calm-otter-builds.dev.check.omh.st",
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(env.WFP_MANAGEMENT.observeCandidate).toHaveBeenCalledOnce();
    expect(env.WFP_MANAGEMENT.observeActivation).toHaveBeenCalledOnce();
    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gateway: expect.objectContaining({ state: "ready" }),
        wfp: expect.objectContaining({ state: "ready" }),
      }),
    );
  });

  it("resumes cleanup when the failed candidate is absent and the retained Gateway is exact", async () => {
    const env = bindings();
    const retained = {
      ...candidate,
      scriptName: `p-${ids.project.toLowerCase()}-dev-${ids.operation.toLowerCase()}`,
      productDeploymentId: ids.operation,
      providerTag: "retained-provider-tag",
      artifactDigest: `sha256:${"d".repeat(64)}` as const,
      deployedAt: "2026-08-21T09:00:00.000Z",
    };
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...wfpContext(),
      providerHint: { phase: "wfp", expectedArtifactDigest: candidate.artifactDigest },
      knownDeployments: [retained, candidate],
    });
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "metadata_absent",
      scriptName: candidate.scriptName,
      providerTag: null,
      productDeploymentId: null,
      artifactDigest: null,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation)
      .mockResolvedValueOnce({
        status: "reconciliation_required",
        reconciliationPhase: "candidate",
        currentProviderTag: null,
        currentProductDeploymentId: null,
      })
      .mockResolvedValueOnce({
        status: "observed",
        candidate: retained,
        gateway: {
          provider: "ohmyhost-shared-gateway",
          hostname: "dev-calm-otter-builds.dev.check.omh.st",
          internalOrigin: "https://dev-calm-otter-builds.your-omh-account.workers.dev",
          publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
          targetScriptName: retained.scriptName,
          targetProviderTag: retained.providerTag,
          targetDeploymentId: retained.productDeploymentId,
          targetArtifactDigest: retained.artifactDigest,
          providerTag: retained.providerTag,
          observedAt: "2026-08-21T10:00:31.000Z",
        },
        deploymentUrl: "https://dev-calm-otter-builds.dev.check.omh.st",
      });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gateway: {
          state: "ready",
          providerTag: retained.providerTag,
          observedAt: "2026-08-21T10:00:31.000Z",
        },
        wfp: { state: "absent", observedAt: "2026-08-21T10:00:30.000Z" },
      }),
    );
  });

  it("abandons Stay operation 01M1M16NQ0SW5G0KSZCC3F6NAG after its persisted candidate and gateway are absent", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...wfpContext(),
      providerHint: { phase: "source" },
    });
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "metadata_absent",
      scriptName: candidate.scriptName,
      providerTag: null,
      productDeploymentId: null,
      artifactDigest: null,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation).mockResolvedValueOnce({ status: "absent" });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "abandon",
        gateway: { state: "absent", observedAt: "2026-08-21T10:01:00.000Z" },
        wfp: { state: "absent", observedAt: "2026-08-21T10:00:30.000Z" },
      }),
    );
  });

  it("fails closed to unknown when the observed provider identity drifts", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce(wfpContext());
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: candidate.scriptName,
      providerTag: "drifted-provider-tag",
      productDeploymentId: candidate.productDeploymentId,
      artifactDigest: candidate.artifactDigest,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation).mockResolvedValueOnce({
      status: "reconciliation_required",
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "retry",
        gateway: { state: "unknown" },
        wfp: { state: "unknown" },
      }),
    );
  });

  it.each([
    ["queued", "pending", "pending"],
    ["running", "pending", "pending"],
    ["complete", "completed", "complete"],
    ["errored", "completed", "errored"],
    ["terminated", "completed", "terminated"],
  ] as const)(
    "G005 SourceLink queue-loss Operation 01M1EJMS444BBRX33433XGJY6Q / Event 01M1EJMS4GNBEQZBNQWDMKYSBZ persists Prepared then ensures only the original bare command for %s",
    async (workflowStatus, expectedState, expectedWorkflowOutcome) => {
      const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow(workflowStatus) };
      database.prepareSourceLinkQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly organizationId: string;
            readonly operationId: string;
            readonly reconciliationId: string;
          };
          return {
            outcome: "prepared" as const,
            reconciliationId: input.reconciliationId,
            organizationId: input.organizationId,
            projectId: observedSourceLinkQueueRecovery.projectId,
            environmentId: observedSourceLinkQueueRecovery.environmentId,
            operationId: input.operationId,
            billingEpochId: ids.project,
            requestEventId: observedSourceLinkQueueRecovery.eventId,
            deliveryAttemptId: observedSourceLinkQueueRecovery.deliveryAttemptId,
            workflowId:
              "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
            originalMessage: {
              version: 1,
              eventType: "SourceLinkRequestedV1" as const,
              eventId: observedSourceLinkQueueRecovery.eventId,
              organizationId: input.organizationId,
              projectId: observedSourceLinkQueueRecovery.projectId,
              billingEpochId: ids.project,
              environmentId: observedSourceLinkQueueRecovery.environmentId,
              operationId: input.operationId,
            },
          };
        },
      );
      database.finalizeSourceLinkQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly reconciliationId: string;
            readonly operationId: string;
            readonly workflowOutcome: "pending" | "complete" | "errored" | "terminated";
          };
          return {
            outcome: "recovered" as const,
            reconciliationId: input.reconciliationId,
            operationId: input.operationId,
            state:
              input.workflowOutcome === "pending" ? ("pending" as const) : ("completed" as const),
          };
        },
      );

      await expect(
        requestCoreProviderReconciliation(
          env,
          runtime,
          {
            organizationId: message.organizationId,
            operationId: observedSourceLinkQueueRecovery.operationId,
            actorId: message.actorId,
            idempotencySha256: message.idempotencySha256,
          },
          clock,
        ),
      ).resolves.toMatchObject({
        operationId: observedSourceLinkQueueRecovery.operationId,
        state: expectedState,
      });
      expect(database.prepareSourceLinkQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        }),
      );
      expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
        id: "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
        params: {
          version: 1,
          eventType: "SourceLinkRequestedV1",
          eventId: observedSourceLinkQueueRecovery.eventId,
          organizationId: message.organizationId,
          projectId: observedSourceLinkQueueRecovery.projectId,
          billingEpochId: ids.project,
          environmentId: observedSourceLinkQueueRecovery.environmentId,
          operationId: observedSourceLinkQueueRecovery.operationId,
        },
      });
      expect(env.DEPLOYMENT_WORKFLOW.get).toHaveBeenCalledWith(
        "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
      );
      expect(database.finalizeSourceLinkQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workflowOutcome: expectedWorkflowOutcome }),
      );
      expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
      expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
    },
  );

  it("keeps the SourceLink Prepared recovery open after a lost same-ID create response without minting a replay", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("queued") };
    database.prepareSourceLinkQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: observedSourceLinkQueueRecovery.projectId,
          environmentId: observedSourceLinkQueueRecovery.environmentId,
          operationId: input.operationId,
          billingEpochId: ids.project,
          requestEventId: observedSourceLinkQueueRecovery.eventId,
          deliveryAttemptId: observedSourceLinkQueueRecovery.deliveryAttemptId,
          workflowId:
            "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
          originalMessage: {
            version: 1,
            eventType: "SourceLinkRequestedV1" as const,
            eventId: observedSourceLinkQueueRecovery.eventId,
            organizationId: input.organizationId,
            projectId: observedSourceLinkQueueRecovery.projectId,
            billingEpochId: ids.project,
            environmentId: observedSourceLinkQueueRecovery.environmentId,
            operationId: input.operationId,
          },
        };
      },
    );
    vi.mocked(env.DEPLOYMENT_WORKFLOW.create).mockRejectedValueOnce(new TypeError("lost response"));

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });
    expect(env.DEPLOYMENT_WORKFLOW.get).toHaveBeenCalledWith(
      "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
    );
    expect(database.finalizeSourceLinkQueueDeliveryRecovery).toHaveBeenCalledOnce();
    expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
  });

  it("ends a lost rename only when no live Workflow holds it, never re-driving its stale intent", async () => {
    const reconcile = (env: DeploymentWorkflowServiceBindings) =>
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      );
    const attemptId = await deterministicUlid(
      `${message.organizationId}:${message.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    // Observed: no run was ever recorded, so no Workflow can exist and none is read or started.
    database.findLostProductCommand.mockResolvedValueOnce({ state: "lost", workflowId: null });
    const drawn: string[] = [];
    database.abandonLostProductCommand.mockImplementationOnce(async (...args: unknown[]) => {
      drawn.push(...(args[1] as { readonly eventIds: readonly string[] }).eventIds);
      return "abandoned";
    });
    let env = bindings();
    await expect(reconcile(env)).resolves.toEqual({
      attemptId,
      operationId: message.operationId,
      state: "completed",
    });
    expect(database.abandonLostProductCommand).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        workflowId: null,
        reconciliationId: attemptId,
        actorId: message.actorId,
        abandonedAt: "2026-08-21T10:01:00.000Z",
      }),
    );
    // Its operation events and audits get IDs derived from the reconciliation, so a replay matches.
    expect(drawn).toEqual(
      await Promise.all(
        [1, 2, 3, 4].map((index) => deterministicUlid(`${attemptId}:lost-command:${index}`)),
      ),
    );
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    // A recorded run whose Workflow is alive keeps the command.
    database.findLostProductCommand.mockResolvedValueOnce({ state: "lost", workflowId: "run-1" });
    env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("running") };
    await expect(reconcile(env)).resolves.toMatchObject({ state: "pending" });
    // A failed or timed-out read, or an unknown status, proves nothing: it stays uncertain.
    const unreadable = workflow();
    unreadable.get.mockRejectedValueOnce(new Error("Workflow read timed out"));
    const silent = workflow();
    silent.get.mockResolvedValueOnce({
      status: vi.fn(async () => {
        throw new Error("Workflow status timed out");
      }),
    });
    for (const deploymentWorkflow of [unreadable, silent, workflow("unknown")]) {
      database.findLostProductCommand.mockResolvedValueOnce({
        state: "lost",
        workflowId: "run-1",
      });
      env = { ...bindings(), DEPLOYMENT_WORKFLOW: deploymentWorkflow };
      await expect(reconcile(env)).resolves.toMatchObject({ state: "uncertain" });
      expect(deploymentWorkflow.create).not.toHaveBeenCalled();
    }
    expect(database.abandonLostProductCommand).toHaveBeenCalledOnce();
    // A Workflow observed errored is ended; a guard change meanwhile is not claimed as done.
    database.findLostProductCommand.mockResolvedValueOnce({ state: "lost", workflowId: "run-1" });
    env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("errored") };
    database.abandonLostProductCommand.mockResolvedValueOnce("changed");
    await expect(reconcile(env)).resolves.toMatchObject({ state: "uncertain" });
    expect(database.abandonLostProductCommand).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ workflowId: "run-1" }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    // Once ended, every later reconciliation reports it without touching anything.
    database.findLostProductCommand.mockResolvedValueOnce({ state: "abandoned" });
    await expect(reconcile(bindings())).resolves.toMatchObject({ state: "completed" });
    expect(database.abandonLostProductCommand).toHaveBeenCalledTimes(2);
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it("returns the same-key finalized SourceLink recovery without another Cloudflare call", async () => {
    const env = bindings();
    database.prepareSourceLinkQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "completed" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "completed" });
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
    expect(database.finalizeSourceLinkQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it("returns the original closed SourceLink recovery identity to a later idempotency key without Cloudflare", async () => {
    const env = bindings();
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: ids.attempt,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"b".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: ids.attempt,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.prepareSourceLinkQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
    expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
  });

  it("continues a closed SourceLink recovery only for its original key and leaves a later key provider-free", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("queued") };
    const originalAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
      continueProductWorkflowReplay: true,
    });
    database.findProductWorkflowReplayCandidate.mockResolvedValue({
      organizationId: message.organizationId,
      projectId: observedSourceLinkQueueRecovery.projectId,
      environmentId: observedSourceLinkQueueRecovery.environmentId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      eventId: observedSourceLinkQueueRecovery.eventId,
      billingEpochId: ids.project,
      logicalWorkflowId:
        "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
      eventType: "SourceLinkRequestedV1",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.findProductWorkflowReplayCandidate).toHaveBeenCalledOnce();
    expect(database.prepareSourceLinkQueueDeliveryRecovery).not.toHaveBeenCalled();

    database.findProductWorkflowReplayCandidate.mockClear();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.create).mockClear();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"b".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
  });

  it("resumes the exact active SourceLink workflow replay for its original closed recovery key", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("queued") };
    const originalAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    const originalMessage = {
      version: 1 as const,
      eventType: "SourceLinkRequestedV1" as const,
      eventId: observedSourceLinkQueueRecovery.eventId,
      organizationId: message.organizationId,
      projectId: observedSourceLinkQueueRecovery.projectId,
      billingEpochId: ids.project,
      environmentId: observedSourceLinkQueueRecovery.environmentId,
      operationId: observedSourceLinkQueueRecovery.operationId,
    };
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
      continueProductWorkflowReplay: true,
    });
    database.readProductWorkflowReplayAttempt.mockResolvedValue({
      outcome: "prepared",
      attemptId: originalAttemptId,
      physicalWorkflowId: `product-command-replay-v1-${originalAttemptId}`,
      originalMessage,
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.readProductWorkflowReplayAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: originalAttemptId }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.get).toHaveBeenCalledWith(
      `product-command-replay-v1-${originalAttemptId}`,
    );

    database.readProductWorkflowReplayAttempt.mockClear();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.create).mockClear();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"b".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.readProductWorkflowReplayAttempt).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
  });

  it("routes an exact terminal SourceLink replay A to its stored completion but keeps B provider-free", async () => {
    const env = bindings();
    const originalAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
      continueProductWorkflowReplay: true,
    });
    database.readProductWorkflowReplayAttempt.mockResolvedValue({
      outcome: "completed",
      attemptId: originalAttemptId,
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "completed",
    });
    expect(database.readProductWorkflowReplayAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: originalAttemptId }),
    );

    database.readProductWorkflowReplayAttempt.mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"b".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.readProductWorkflowReplayAttempt).not.toHaveBeenCalled();
    expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
  });

  it.each(["errored", "terminated"] as const)(
    "routes exact terminal SourceLink replay A through %s recovery",
    async (terminalStatus) => {
      const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow(terminalStatus) };
      const originalAttemptId = await deterministicUlid(
        `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
      );
      database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
        outcome: "recovered",
        reconciliationId: originalAttemptId,
        operationId: observedSourceLinkQueueRecovery.operationId,
        state: "pending",
        continueProductWorkflowReplay: true,
      });
      database.readProductWorkflowReplayAttempt.mockResolvedValue({
        outcome: "prepared",
        attemptId: originalAttemptId,
        physicalWorkflowId: `product-command-replay-v1-${originalAttemptId}`,
        originalMessage: {
          version: 1,
          eventType: "SourceLinkRequestedV1",
          eventId: observedSourceLinkQueueRecovery.eventId,
          organizationId: message.organizationId,
          projectId: observedSourceLinkQueueRecovery.projectId,
          billingEpochId: ids.project,
          environmentId: observedSourceLinkQueueRecovery.environmentId,
          operationId: observedSourceLinkQueueRecovery.operationId,
        },
      });

      await expect(
        requestCoreProviderReconciliation(
          env,
          runtime,
          {
            organizationId: message.organizationId,
            operationId: observedSourceLinkQueueRecovery.operationId,
            actorId: message.actorId,
            idempotencySha256: message.idempotencySha256,
          },
          clock,
        ),
      ).resolves.toEqual({
        attemptId: originalAttemptId,
        operationId: observedSourceLinkQueueRecovery.operationId,
        state: "completed",
      });
      expect(database.recoverTerminalProductWorkflowReplay).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          attemptId: originalAttemptId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          terminalStatus,
        }),
      );
    },
  );

  it("allows B to start bounded replay #2 only after terminal-retryable SourceLink replay A", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("terminated") };
    const originalAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    const laterIdempotencySha256 = `sha256:${"b".repeat(64)}` as const;
    const laterAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${laterIdempotencySha256}`,
    );
    const originalMessage = {
      version: 1 as const,
      eventType: "SourceLinkRequestedV1" as const,
      eventId: observedSourceLinkQueueRecovery.eventId,
      organizationId: message.organizationId,
      projectId: observedSourceLinkQueueRecovery.projectId,
      billingEpochId: ids.project,
      environmentId: observedSourceLinkQueueRecovery.environmentId,
      operationId: observedSourceLinkQueueRecovery.operationId,
    };
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
      continueProductWorkflowReplay: true,
      continueProductWorkflowReplayWithNewKey: true,
    });
    database.readProductWorkflowReplayAttempt.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as { readonly attemptId: string };
        return input.attemptId === originalAttemptId
          ? {
              outcome: "completed" as const,
              attemptId: originalAttemptId,
            }
          : null;
      },
    );
    database.findProductWorkflowReplayCandidate.mockResolvedValue({
      organizationId: message.organizationId,
      projectId: observedSourceLinkQueueRecovery.projectId,
      environmentId: observedSourceLinkQueueRecovery.environmentId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      eventId: observedSourceLinkQueueRecovery.eventId,
      billingEpochId: ids.project,
      logicalWorkflowId:
        "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
      eventType: "SourceLinkRequestedV1",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "completed",
    });
    expect(database.prepareProductWorkflowReplay).not.toHaveBeenCalled();

    database.readProductWorkflowReplayAttempt.mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: laterIdempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: laterAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.prepareProductWorkflowReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: laterAttemptId,
        physicalWorkflowId: `product-command-replay-v1-${laterAttemptId}`,
      }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
      id: `product-command-replay-v1-${laterAttemptId}`,
      params: { command: originalMessage, replayAttemptId: laterAttemptId },
    });
  });

  it("returns terminal ancestor A provider-free while B is active, then resumes only B", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("queued") };
    const originalAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    const laterIdempotencySha256 = `sha256:${"b".repeat(64)}` as const;
    const laterAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${laterIdempotencySha256}`,
    );
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
      continueProductWorkflowReplay: true,
      continueProductWorkflowReplayAttemptIds: [laterAttemptId],
      completedProductWorkflowReplayAttemptIds: [originalAttemptId],
    });
    database.readTerminalSourceLinkWorkflowReplayAttempt.mockResolvedValue({
      outcome: "completed",
      attemptId: originalAttemptId,
    });
    database.readProductWorkflowReplayAttempt.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as { readonly attemptId: string };
        return input.attemptId === laterAttemptId
          ? {
              outcome: "prepared" as const,
              attemptId: laterAttemptId,
              physicalWorkflowId: `product-command-replay-v1-${laterAttemptId}`,
              originalMessage: {
                version: 1,
                eventType: "SourceLinkRequestedV1",
                eventId: observedSourceLinkQueueRecovery.eventId,
                organizationId: message.organizationId,
                projectId: observedSourceLinkQueueRecovery.projectId,
                billingEpochId: ids.project,
                environmentId: observedSourceLinkQueueRecovery.environmentId,
                operationId: observedSourceLinkQueueRecovery.operationId,
              },
            }
          : null;
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "completed",
    });
    expect(database.readTerminalSourceLinkWorkflowReplayAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: originalAttemptId }),
    );
    expect(database.readProductWorkflowReplayAttempt).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();

    database.readProductWorkflowReplayAttempt.mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: laterIdempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: laterAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.readProductWorkflowReplayAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: laterAttemptId }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.get).toHaveBeenCalledWith(
      `product-command-replay-v1-${laterAttemptId}`,
    );

    database.readProductWorkflowReplayAttempt.mockClear();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.create).mockClear();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"c".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.readProductWorkflowReplayAttempt).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
  });

  it("does not mask a later terminal original SourceLink Workflow behind a pending Final", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("terminated") };
    const originalAttemptId = await deterministicUlid(
      `${message.organizationId}:${observedSourceLinkQueueRecovery.operationId}:${message.actorId}:${message.idempotencySha256}`,
    );
    database.readClosedSourceLinkQueueDeliveryRecovery.mockResolvedValue({
      outcome: "recovered",
      reconciliationId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
      continueProductWorkflowReplay: true,
    });
    database.findProductWorkflowReplayCandidate.mockResolvedValue({
      organizationId: message.organizationId,
      projectId: observedSourceLinkQueueRecovery.projectId,
      environmentId: observedSourceLinkQueueRecovery.environmentId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      eventId: observedSourceLinkQueueRecovery.eventId,
      billingEpochId: ids.project,
      logicalWorkflowId:
        "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
      eventType: "SourceLinkRequestedV1",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedSourceLinkQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toEqual({
      attemptId: originalAttemptId,
      operationId: observedSourceLinkQueueRecovery.operationId,
      state: "pending",
    });
    expect(database.prepareProductWorkflowReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "SourceLinkRequestedV1",
        logicalWorkflowId:
          "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
      }),
    );
  });

  it.each(["unknown", "complete", "errored", "terminated"] as const)(
    "leaves the SourceLink Prepared recovery and Outbox open for %s without matching durable evidence",
    async (workflowStatus) => {
      const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow(workflowStatus) };
      database.prepareSourceLinkQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly organizationId: string;
            readonly operationId: string;
            readonly reconciliationId: string;
          };
          return {
            outcome: "prepared" as const,
            reconciliationId: input.reconciliationId,
            organizationId: input.organizationId,
            projectId: observedSourceLinkQueueRecovery.projectId,
            environmentId: observedSourceLinkQueueRecovery.environmentId,
            operationId: input.operationId,
            billingEpochId: ids.project,
            requestEventId: observedSourceLinkQueueRecovery.eventId,
            deliveryAttemptId: observedSourceLinkQueueRecovery.deliveryAttemptId,
            workflowId:
              "product-command-v1-source-link-01M1EJMS4GNBEQZBNQWDMKYSBZ-01M1EJMS444BBRX33433XGJY6Q",
            originalMessage: {
              version: 1,
              eventType: "SourceLinkRequestedV1" as const,
              eventId: observedSourceLinkQueueRecovery.eventId,
              organizationId: input.organizationId,
              projectId: observedSourceLinkQueueRecovery.projectId,
              billingEpochId: ids.project,
              environmentId: observedSourceLinkQueueRecovery.environmentId,
              operationId: input.operationId,
            },
          };
        },
      );
      database.finalizeSourceLinkQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly reconciliationId: string;
            readonly operationId: string;
          };
          return {
            outcome: "uncertain" as const,
            reconciliationId: input.reconciliationId,
            operationId: input.operationId,
            state: "uncertain" as const,
          };
        },
      );

      await expect(
        requestCoreProviderReconciliation(
          env,
          runtime,
          {
            organizationId: message.organizationId,
            operationId: observedSourceLinkQueueRecovery.operationId,
            actorId: message.actorId,
            idempotencySha256: message.idempotencySha256,
          },
          clock,
        ),
      ).resolves.toMatchObject({ state: "uncertain" });
      if (workflowStatus === "unknown") {
        expect(database.finalizeSourceLinkQueueDeliveryRecovery).not.toHaveBeenCalled();
      } else {
        expect(database.finalizeSourceLinkQueueDeliveryRecovery).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ workflowOutcome: workflowStatus }),
        );
      }
      expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
      expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "hostname",
      {
        hostname: "dev-calm-otter-builds.attacker.example",
        publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
        deploymentUrl: "https://dev-calm-otter-builds.dev.check.omh.st",
      },
    ],
    [
      "public origin",
      {
        hostname: "dev-calm-otter-builds.dev.check.omh.st",
        publicOrigin: "https://dev-calm-otter-builds.attacker.example",
        deploymentUrl: "https://dev-calm-otter-builds.attacker.example",
      },
    ],
    [
      "deployment URL",
      {
        hostname: "dev-calm-otter-builds.dev.check.omh.st",
        publicOrigin: "https://dev-calm-otter-builds.dev.check.omh.st",
        deploymentUrl: "https://dev-calm-otter-builds.attacker.example",
      },
    ],
  ])("fails closed when the shared gateway %s drifts", async (_label, origins) => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce(wfpContext());
    vi.mocked(env.WFP_MANAGEMENT.observeCandidate).mockResolvedValueOnce({
      state: "ready",
      scriptName: candidate.scriptName,
      providerTag: candidate.providerTag,
      productDeploymentId: candidate.productDeploymentId,
      artifactDigest: candidate.artifactDigest,
      observedAt: "2026-08-21T10:00:30.000Z",
    });
    vi.mocked(env.WFP_MANAGEMENT.observeActivation).mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: {
        provider: "ohmyhost-shared-gateway",
        hostname: origins.hostname,
        publicOrigin: origins.publicOrigin,
        targetScriptName: candidate.scriptName,
        targetProviderTag: candidate.providerTag,
        targetDeploymentId: candidate.productDeploymentId,
        targetArtifactDigest: candidate.artifactDigest,
        providerTag: candidate.providerTag,
        observedAt: "2026-08-21T10:00:31.000Z",
      },
      deploymentUrl: origins.deploymentUrl,
      health: { status: 200, path: "/", excerpt: null, truncated: false },
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);
    const loaded = await ports.load(message);
    await ports.prepare({ message, context: loaded, observation: await ports.observe(loaded) });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gateway: { state: "unknown" } }),
    );
  });

  it("resumes an exact promotion after a lost provider response without entering a build path", async () => {
    const env = bindings();
    const promotionMessage = {
      version: 1 as const,
      eventType: "DeploymentPromotionRequestedV1" as const,
      eventId: ids.event,
      organizationId: ids.organization,
      projectId: ids.project,
      billingEpochId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
    };
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...context,
      environmentName: "prod",
      eventType: "DeploymentPromotionRequestedV1",
      logicalWorkflowId: `product-command-v1-promote-${ids.event}-${ids.operation}`,
      originalMessage: promotionMessage,
      providerHint: {
        phase: "wfp",
        expectedArtifactDigest: `sha256:${"c".repeat(64)}`,
        currentProviderTag: `sha256:${"d".repeat(64)}`,
        currentProductDeploymentId: ids.attempt,
      },
      knownDeployments: [],
    });
    database.prepareProductProviderReconciliation.mockResolvedValueOnce({
      outcome: "prepared",
      attemptId: ids.attempt,
      physicalWorkflowId: `product-provider-reconcile-v1-${ids.attempt}`,
      originalMessage: promotionMessage,
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, clock);

    const loaded = await ports.load(message);
    const observation = await ports.observe(loaded);
    const prepared = await ports.prepare({ message, context: loaded, observation });
    if (prepared.outcome !== "prepared") throw new Error("Expected promotion retry");
    await expect(
      ports.resume({
        physicalWorkflowId: prepared.physicalWorkflowId,
        originalMessage: prepared.originalMessage,
      }),
    ).resolves.toBe("pending");

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: "retry",
        wfp: { state: "unknown" },
      }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
      id: `product-provider-reconcile-v1-${ids.attempt}`,
      params: {
        command: promotionMessage,
        reconciliationAttemptId: ids.attempt,
      },
    });
    expect(env.SOURCE_FETCHER.acquireExact).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.startBuild).not.toHaveBeenCalled();
    expect(env.BUILD_RUNNER.readBuild).not.toHaveBeenCalled();
  });

  it("fails closed to retry when current-only WFP evidence is unavailable", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...context,
      providerHint: { phase: "wfp" },
      sourceState: "absent",
      buildState: "absent",
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, {
      now: () => new Date("2026-08-21T10:01:00.000Z"),
    });
    const loaded = await ports.load(message);
    const observation = await ports.observe(loaded);
    await ports.prepare({ message, context: loaded, observation });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "retry" }),
    );
  });

  it("retries instead of releasing the claim while source or build resources remain", async () => {
    const env = bindings();
    database.readProductProviderReconciliationContext.mockResolvedValueOnce({
      ...context,
      providerHint: { phase: "wfp" },
      sourceState: "ready",
      buildState: "succeeded",
    });
    const ports = createCoreProviderReconciliationPorts(env, runtime, {
      now: () => new Date("2026-08-21T10:01:00.000Z"),
    });
    const loaded = await ports.load(message);
    const observation = await ports.observe(loaded);
    await ports.prepare({ message, context: loaded, observation });

    expect(database.prepareProductProviderReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "retry" }),
    );
  });

  it.each([
    ["queued", "pending", "pending"],
    ["running", "pending", "pending"],
    ["paused", "pending", "pending"],
    ["waiting", "pending", "pending"],
    ["waitingForPause", "pending", "pending"],
    ["complete", "completed", "complete"],
    ["errored", "completed", "errored"],
    ["terminated", "completed", "terminated"],
  ] as const)(
    "T04-PQR-01 live Queue recovery Operation 01M1D7N46SR22J3S7BF4Q3Y0DE prepares before the deterministic Workflow and maps %s to %s",
    async (workflowStatus, expectedState, expectedWorkflowOutcome) => {
      const env = { ...bindings(), PROJECT_PROVISIONING_WORKFLOW: workflow(workflowStatus) };
      database.prepareProjectProvisioningQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly organizationId: string;
            readonly operationId: string;
            readonly reconciliationId: string;
          };
          return {
            outcome: "prepared" as const,
            reconciliationId: input.reconciliationId,
            organizationId: input.organizationId,
            projectId: liveQueueRecovery.projectId,
            operationId: input.operationId,
            requestEventId: liveQueueRecovery.eventId,
            deliveryAttemptId: liveQueueRecovery.deliveryAttemptId,
            workflowId:
              "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
            operationState: "queued" as const,
          };
        },
      );
      database.finalizeProjectProvisioningQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly reconciliationId: string;
            readonly operationId: string;
            readonly workflowOutcome: "pending" | "complete" | "errored" | "terminated";
          };
          return {
            outcome: "recovered" as const,
            reconciliationId: input.reconciliationId,
            operationId: input.operationId,
            state:
              input.workflowOutcome === "pending" ? ("pending" as const) : ("completed" as const),
          };
        },
      );

      const result = await requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: liveQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      );

      expect(result).toMatchObject({
        operationId: liveQueueRecovery.operationId,
        state: expectedState,
      });
      expect(database.prepareProjectProvisioningQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: message.organizationId,
          operationId: liveQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        }),
      );
      expect(env.PROJECT_PROVISIONING_WORKFLOW.create).toHaveBeenCalledWith({
        id: "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
        params: {
          version: 1,
          eventType: "ProjectProvisioningRequested",
          eventId: liveQueueRecovery.eventId,
          organizationId: message.organizationId,
          projectId: liveQueueRecovery.projectId,
          operationId: liveQueueRecovery.operationId,
        },
      });
      expect(database.finalizeProjectProvisioningQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workflowOutcome: expectedWorkflowOutcome }),
      );
      expect(
        vi.mocked(database.finalizeProjectProvisioningQueueDeliveryRecovery).mock.calls[0]?.[1],
      ).not.toHaveProperty("preparedAt");
      expect(database.readProductProviderReconciliationAttempt).not.toHaveBeenCalled();
      expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
    },
  );

  it.each(["complete", "errored", "terminated"] as const)(
    "returns uncertain after a %s Queue Workflow whose DB finalization remains queued, without provider fallback",
    async (workflowStatus) => {
      const env = { ...bindings(), PROJECT_PROVISIONING_WORKFLOW: workflow(workflowStatus) };
      database.prepareProjectProvisioningQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly organizationId: string;
            readonly operationId: string;
            readonly reconciliationId: string;
          };
          return {
            outcome: "prepared" as const,
            reconciliationId: input.reconciliationId,
            organizationId: input.organizationId,
            projectId: liveQueueRecovery.projectId,
            operationId: input.operationId,
            requestEventId: liveQueueRecovery.eventId,
            deliveryAttemptId: liveQueueRecovery.deliveryAttemptId,
            workflowId:
              "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
            operationState: "queued" as const,
          };
        },
      );
      database.finalizeProjectProvisioningQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly reconciliationId: string;
            readonly operationId: string;
          };
          return {
            outcome: "uncertain" as const,
            reconciliationId: input.reconciliationId,
            operationId: input.operationId,
            state: "uncertain" as const,
          };
        },
      );

      await expect(
        requestCoreProviderReconciliation(
          env,
          runtime,
          {
            organizationId: message.organizationId,
            operationId: liveQueueRecovery.operationId,
            actorId: message.actorId,
            idempotencySha256: message.idempotencySha256,
          },
          clock,
        ),
      ).resolves.toMatchObject({ state: "uncertain" });
      expect(database.finalizeProjectProvisioningQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workflowOutcome: workflowStatus }),
      );
      expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
      expect(database.readProductProviderReconciliationAttempt).not.toHaveBeenCalled();
    },
  );

  it("T04-PQR-01 resolves a lost Queue Workflow create through the same exact Workflow ID", async () => {
    const env = { ...bindings(), PROJECT_PROVISIONING_WORKFLOW: workflow("complete") };
    vi.mocked(env.PROJECT_PROVISIONING_WORKFLOW.create).mockRejectedValueOnce(
      new Error("lost create response"),
    );
    database.prepareProjectProvisioningQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: liveQueueRecovery.projectId,
          operationId: input.operationId,
          requestEventId: liveQueueRecovery.eventId,
          deliveryAttemptId: liveQueueRecovery.deliveryAttemptId,
          workflowId:
            "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
          operationState: "queued" as const,
        };
      },
    );
    database.finalizeProjectProvisioningQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
          readonly workflowOutcome: "pending" | "complete" | "errored" | "terminated";
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state:
            input.workflowOutcome === "pending" ? ("pending" as const) : ("completed" as const),
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: liveQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "completed" });
    expect(env.PROJECT_PROVISIONING_WORKFLOW.get).toHaveBeenCalledWith(
      "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
    );
  });

  it("leaves Prepared durable and the Outbox open when Queue Workflow existence is uncertain", async () => {
    const env = { ...bindings(), PROJECT_PROVISIONING_WORKFLOW: workflow("unknown") };
    database.prepareProjectProvisioningQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: liveQueueRecovery.projectId,
          operationId: input.operationId,
          requestEventId: liveQueueRecovery.eventId,
          deliveryAttemptId: liveQueueRecovery.deliveryAttemptId,
          workflowId:
            "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
          operationState: "queued" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: liveQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "uncertain" });
    expect(database.finalizeProjectProvisioningQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it("keeps a Queue recovery uncertain when neither the Workflow create nor its lookup answers", async () => {
    const unreachable = new Error("Workflows unavailable");
    const env = {
      ...bindings(),
      PROJECT_PROVISIONING_WORKFLOW: {
        create: vi.fn(async () => Promise.reject(unreachable)),
        get: vi.fn(async () => Promise.reject(unreachable)),
      },
    };
    database.prepareProjectProvisioningQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: liveQueueRecovery.projectId,
          operationId: input.operationId,
          requestEventId: liveQueueRecovery.eventId,
          deliveryAttemptId: liveQueueRecovery.deliveryAttemptId,
          workflowId:
            "project-provisioning-v1-01M1D7N46SR22J3S7BF4Q3Y0DM-01M1D7N46SR22J3S7BF4Q3Y0DE",
          operationState: "queued" as const,
        };
      },
    );
    database.finalizeProjectProvisioningQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "pending" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: liveQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "uncertain" });
    expect(database.finalizeProjectProvisioningQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it("replays a final Queue recovery byte-for-byte without another Workflow create or audit", async () => {
    const env = bindings();
    database.prepareProjectProvisioningQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "completed" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: liveQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ operationId: liveQueueRecovery.operationId, state: "completed" });
    expect(env.PROJECT_PROVISIONING_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.PROJECT_PROVISIONING_WORKFLOW.get).not.toHaveBeenCalled();
    expect(database.finalizeProjectProvisioningQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["queued", "pending", "pending"],
    ["running", "pending", "pending"],
    ["complete", "completed", "complete"],
  ] as const)(
    "T05-R1 trakkker Operation 01M1DKRQ52Y9KC59W3YC0Q8SGJ / Event 01M1DKRQ5E4NV39XW38KYETBN4 / Attempt 01M1DM1DQJG7SDGQC1ZPPM91MZ prepares the exact DeploymentRequestedV1 recovery before provider paths and maps %s",
    async (workflowStatus, expectedState, expectedWorkflowOutcome) => {
      const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow(workflowStatus) };
      database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly organizationId: string;
            readonly operationId: string;
            readonly reconciliationId: string;
          };
          return {
            outcome: "prepared" as const,
            reconciliationId: input.reconciliationId,
            organizationId: input.organizationId,
            projectId: observedDeploymentQueueRecovery.projectId,
            environmentId: observedDeploymentQueueRecovery.environmentId,
            operationId: input.operationId,
            billingEpochId: ids.project,
            requestEventId: observedDeploymentQueueRecovery.eventId,
            deliveryAttemptId: observedDeploymentQueueRecovery.deliveryAttemptId,
            planId: observedDeploymentQueueRecovery.planId,
            deploymentId: observedDeploymentQueueRecovery.deploymentId,
            workflowId:
              "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
            originalMessage: {
              version: 1,
              eventType: "DeploymentRequestedV1",
              eventId: observedDeploymentQueueRecovery.eventId,
              organizationId: input.organizationId,
              projectId: observedDeploymentQueueRecovery.projectId,
              billingEpochId: ids.project,
              environmentId: observedDeploymentQueueRecovery.environmentId,
              operationId: input.operationId,
              planId: observedDeploymentQueueRecovery.planId,
            },
          };
        },
      );
      database.finalizeDeploymentQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly reconciliationId: string;
            readonly operationId: string;
            readonly workflowOutcome: "pending" | "complete" | "errored" | "terminated";
          };
          return {
            outcome: "recovered" as const,
            reconciliationId: input.reconciliationId,
            operationId: input.operationId,
            state:
              input.workflowOutcome === "pending" ? ("pending" as const) : ("completed" as const),
          };
        },
      );

      await expect(
        requestCoreProviderReconciliation(
          env,
          runtime,
          {
            organizationId: message.organizationId,
            operationId: observedDeploymentQueueRecovery.operationId,
            actorId: message.actorId,
            idempotencySha256: message.idempotencySha256,
          },
          clock,
        ),
      ).resolves.toMatchObject({
        operationId: observedDeploymentQueueRecovery.operationId,
        state: expectedState,
      });

      expect(database.prepareDeploymentQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        }),
      );
      expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
        id: "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
        params: {
          version: 1,
          eventType: "DeploymentRequestedV1",
          eventId: observedDeploymentQueueRecovery.eventId,
          organizationId: message.organizationId,
          projectId: observedDeploymentQueueRecovery.projectId,
          billingEpochId: ids.project,
          environmentId: observedDeploymentQueueRecovery.environmentId,
          operationId: observedDeploymentQueueRecovery.operationId,
          planId: observedDeploymentQueueRecovery.planId,
        },
      });
      expect(env.DEPLOYMENT_WORKFLOW.get).toHaveBeenCalledWith(
        "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
      );
      expect(database.finalizeDeploymentQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workflowOutcome: expectedWorkflowOutcome }),
      );
      expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
      expect(database.readProductProviderReconciliationAttempt).not.toHaveBeenCalled();
      expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
    },
  );

  it("recovers a final Promotion Queue lease without rebuilding the promoted artifact", async () => {
    const promotionWorkflowId = `product-command-v1-promotion-${observedDeploymentQueueRecovery.eventId}-${observedDeploymentQueueRecovery.operationId}`;
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("queued") };
    database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: observedDeploymentQueueRecovery.projectId,
          environmentId: observedDeploymentQueueRecovery.environmentId,
          operationId: input.operationId,
          billingEpochId: ids.project,
          requestEventId: observedDeploymentQueueRecovery.eventId,
          deliveryAttemptId: observedDeploymentQueueRecovery.deliveryAttemptId,
          planId: null,
          deploymentId: observedDeploymentQueueRecovery.deploymentId,
          workflowId: promotionWorkflowId,
          originalMessage: {
            version: 1,
            eventType: "DeploymentPromotionRequestedV1" as const,
            eventId: observedDeploymentQueueRecovery.eventId,
            organizationId: input.organizationId,
            projectId: observedDeploymentQueueRecovery.projectId,
            billingEpochId: ids.project,
            environmentId: observedDeploymentQueueRecovery.environmentId,
            operationId: input.operationId,
          },
        };
      },
    );
    database.finalizeDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "pending" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({
      operationId: observedDeploymentQueueRecovery.operationId,
      state: "pending",
    });

    expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
      id: promotionWorkflowId,
      params: expect.objectContaining({ eventType: "DeploymentPromotionRequestedV1" }),
    });
    expect(database.finalizeDeploymentQueueDeliveryRecovery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "DeploymentPromotionRequestedV1", planId: null }),
    );
  });

  it("T05-R1 leaves the Deployment recovery Prepared and its Outbox open on an unknown same-ID Workflow", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("unknown") };
    database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: observedDeploymentQueueRecovery.projectId,
          environmentId: observedDeploymentQueueRecovery.environmentId,
          operationId: input.operationId,
          billingEpochId: ids.project,
          requestEventId: observedDeploymentQueueRecovery.eventId,
          deliveryAttemptId: observedDeploymentQueueRecovery.deliveryAttemptId,
          planId: observedDeploymentQueueRecovery.planId,
          deploymentId: observedDeploymentQueueRecovery.deploymentId,
          workflowId:
            "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
          originalMessage: {
            version: 1,
            eventType: "DeploymentRequestedV1",
            eventId: observedDeploymentQueueRecovery.eventId,
            organizationId: input.organizationId,
            projectId: observedDeploymentQueueRecovery.projectId,
            billingEpochId: ids.project,
            environmentId: observedDeploymentQueueRecovery.environmentId,
            operationId: input.operationId,
            planId: observedDeploymentQueueRecovery.planId,
          },
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "uncertain" });
    expect(database.finalizeDeploymentQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
    expect(database.readProductProviderReconciliationAttempt).not.toHaveBeenCalled();
  });

  it.each(["complete", "errored", "terminated"] as const)(
    "T05-R1 leaves a queued Deployment recovery uncertain when the same-ID Workflow reports %s without matching durable terminal evidence",
    async (workflowStatus) => {
      const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow(workflowStatus) };
      database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly organizationId: string;
            readonly operationId: string;
            readonly reconciliationId: string;
          };
          return {
            outcome: "prepared" as const,
            reconciliationId: input.reconciliationId,
            organizationId: input.organizationId,
            projectId: observedDeploymentQueueRecovery.projectId,
            environmentId: observedDeploymentQueueRecovery.environmentId,
            operationId: input.operationId,
            billingEpochId: ids.project,
            requestEventId: observedDeploymentQueueRecovery.eventId,
            deliveryAttemptId: observedDeploymentQueueRecovery.deliveryAttemptId,
            planId: observedDeploymentQueueRecovery.planId,
            deploymentId: observedDeploymentQueueRecovery.deploymentId,
            workflowId:
              "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
            originalMessage: {
              version: 1,
              eventType: "DeploymentRequestedV1",
              eventId: observedDeploymentQueueRecovery.eventId,
              organizationId: input.organizationId,
              projectId: observedDeploymentQueueRecovery.projectId,
              billingEpochId: ids.project,
              environmentId: observedDeploymentQueueRecovery.environmentId,
              operationId: input.operationId,
              planId: observedDeploymentQueueRecovery.planId,
            },
          };
        },
      );
      database.finalizeDeploymentQueueDeliveryRecovery.mockImplementation(
        async (_client: unknown, rawInput: unknown) => {
          const input = rawInput as {
            readonly reconciliationId: string;
            readonly operationId: string;
          };
          return {
            outcome: "uncertain" as const,
            reconciliationId: input.reconciliationId,
            operationId: input.operationId,
            state: "uncertain" as const,
          };
        },
      );

      await expect(
        requestCoreProviderReconciliation(
          env,
          runtime,
          {
            organizationId: message.organizationId,
            operationId: observedDeploymentQueueRecovery.operationId,
            actorId: message.actorId,
            idempotencySha256: message.idempotencySha256,
          },
          clock,
        ),
      ).resolves.toMatchObject({ state: "uncertain" });
      expect(database.finalizeDeploymentQueueDeliveryRecovery).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workflowOutcome: workflowStatus,
        }),
      );
      expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
      expect(database.findProductWorkflowReplayCandidate).not.toHaveBeenCalled();
    },
  );

  it("T05-R1 returns the immutable final Deployment recovery without another Cloudflare call", async () => {
    const env = bindings();
    database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "pending" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({
      operationId: observedDeploymentQueueRecovery.operationId,
      state: "pending",
    });
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
    expect(database.finalizeDeploymentQueueDeliveryRecovery).not.toHaveBeenCalled();
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it("T05-R1 resumes the existing provider-reconciliation path after a completed logical Workflow records durable reconciliation", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("complete") };
    database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: observedDeploymentQueueRecovery.projectId,
          environmentId: observedDeploymentQueueRecovery.environmentId,
          operationId: input.operationId,
          billingEpochId: ids.project,
          requestEventId: observedDeploymentQueueRecovery.eventId,
          deliveryAttemptId: observedDeploymentQueueRecovery.deliveryAttemptId,
          planId: observedDeploymentQueueRecovery.planId,
          deploymentId: observedDeploymentQueueRecovery.deploymentId,
          workflowId:
            "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
          originalMessage: {
            version: 1,
            eventType: "DeploymentRequestedV1",
            eventId: observedDeploymentQueueRecovery.eventId,
            organizationId: input.organizationId,
            projectId: observedDeploymentQueueRecovery.projectId,
            billingEpochId: ids.project,
            environmentId: observedDeploymentQueueRecovery.environmentId,
            operationId: input.operationId,
            planId: observedDeploymentQueueRecovery.planId,
          },
        };
      },
    );
    database.finalizeDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "recovered" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "pending" as const,
          continueProviderReconciliation: true as const,
        };
      },
    );
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce({
      projectId: observedDeploymentQueueRecovery.projectId,
      environmentId: observedDeploymentQueueRecovery.environmentId,
      claimId: ids.claim,
      eventId: observedDeploymentQueueRecovery.eventId,
      logicalWorkflowId:
        "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
      workflowState: "reconciliation_required",
      providerPhase: "build",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });
    expect(database.findProductProviderReconciliationClaim).toHaveBeenCalledWith(
      expect.anything(),
      {
        organizationId: message.organizationId,
        operationId: observedDeploymentQueueRecovery.operationId,
      },
    );
    expect(env.PROVIDER_RECONCILIATION_WORKFLOW.create).toHaveBeenCalledOnce();
  });

  it("T05-R1 leaves Prepared and the Outbox open when durable provider continuation context is rejected", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("complete") };
    database.prepareDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly organizationId: string;
          readonly operationId: string;
          readonly reconciliationId: string;
        };
        return {
          outcome: "prepared" as const,
          reconciliationId: input.reconciliationId,
          organizationId: input.organizationId,
          projectId: observedDeploymentQueueRecovery.projectId,
          environmentId: observedDeploymentQueueRecovery.environmentId,
          operationId: input.operationId,
          billingEpochId: ids.project,
          requestEventId: observedDeploymentQueueRecovery.eventId,
          deliveryAttemptId: observedDeploymentQueueRecovery.deliveryAttemptId,
          planId: observedDeploymentQueueRecovery.planId,
          deploymentId: observedDeploymentQueueRecovery.deploymentId,
          workflowId:
            "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
          originalMessage: {
            version: 1,
            eventType: "DeploymentRequestedV1",
            eventId: observedDeploymentQueueRecovery.eventId,
            organizationId: input.organizationId,
            projectId: observedDeploymentQueueRecovery.projectId,
            billingEpochId: ids.project,
            environmentId: observedDeploymentQueueRecovery.environmentId,
            operationId: input.operationId,
            planId: observedDeploymentQueueRecovery.planId,
          },
        };
      },
    );
    database.finalizeDeploymentQueueDeliveryRecovery.mockImplementation(
      async (_client: unknown, rawInput: unknown) => {
        const input = rawInput as {
          readonly reconciliationId: string;
          readonly operationId: string;
        };
        return {
          outcome: "uncertain" as const,
          reconciliationId: input.reconciliationId,
          operationId: input.operationId,
          state: "uncertain" as const,
        };
      },
    );

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "uncertain" });
    expect(database.finalizeDeploymentQueueDeliveryRecovery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workflowOutcome: "complete" }),
    );
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
    expect(env.PROVIDER_RECONCILIATION_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("T05-R1 leaves an ordinary acknowledged DeploymentRequestedV1 with its exact claim on the legacy provider-reconciliation path", async () => {
    const env = bindings();
    database.prepareDeploymentQueueDeliveryRecovery.mockResolvedValueOnce({
      outcome: "not_applicable",
    });
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce({
      projectId: observedDeploymentQueueRecovery.projectId,
      environmentId: observedDeploymentQueueRecovery.environmentId,
      claimId: ids.claim,
      eventId: observedDeploymentQueueRecovery.eventId,
      logicalWorkflowId:
        "product-command-v1-deploy-01M1DKRQ5E4NV39XW38KYETBN4-01M1DKRQ52Y9KC59W3YC0Q8SGJ",
      workflowState: "reconciliation_required",
      providerPhase: "build",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: observedDeploymentQueueRecovery.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.get).not.toHaveBeenCalled();
    expect(env.PROVIDER_RECONCILIATION_WORKFLOW.create).toHaveBeenCalledOnce();
  });

  it("derives one stable attempt and reconciles a lost Workflow create response through get", async () => {
    const env = bindings();
    database.findProductProviderReconciliationClaim.mockResolvedValue({
      projectId: ids.project,
      environmentId: ids.environment,
      claimId: ids.claim,
      eventId: ids.event,
      logicalWorkflowId: context.logicalWorkflowId,
    });
    vi.mocked(env.PROVIDER_RECONCILIATION_WORKFLOW.create).mockRejectedValueOnce(
      new TypeError("lost response"),
    );

    const result = await requestCoreProviderReconciliation(
      env,
      runtime,
      {
        organizationId: parseUlid(ids.organization),
        operationId: parseUlid(ids.operation),
        actorId: message.actorId,
        idempotencySha256: message.idempotencySha256,
      },
      clock,
    );

    expect(result.state).toBe("pending");
    expect(env.PROVIDER_RECONCILIATION_WORKFLOW.get).toHaveBeenCalledWith(
      `product-provider-reconciliation-v1-${result.attemptId}`,
    );
    expect(database.readProductWorkflowReplayAttempt).not.toHaveBeenCalled();
  });

  it("returns pending after an acknowledged Workflow create without an immediate status read", async () => {
    const env = bindings();
    const status = vi.fn(() => new Promise<never>(() => undefined));
    vi.mocked(env.PROVIDER_RECONCILIATION_WORKFLOW.create).mockResolvedValueOnce({ status });
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce({
      projectId: ids.project,
      environmentId: ids.environment,
      claimId: ids.claim,
      eventId: ids.event,
      logicalWorkflowId: context.logicalWorkflowId,
    });

    const result = await Promise.race([
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(result).toMatchObject({ state: "pending" });
    expect(status).not.toHaveBeenCalled();
  });

  it("reclaims a previously serialized claimless operation after the active project mutation ends", async () => {
    const env = bindings();
    database.findProductProviderReconciliationClaim
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        organizationId: ids.organization,
        projectId: ids.project,
        environmentId: ids.environment,
        operationId: ids.operation,
        claimId: ids.claim,
        eventId: ids.event,
        logicalWorkflowId: context.logicalWorkflowId,
        workflowState: "reconciliation_required",
        providerPhase: "source",
      });
    database.findClaimlessProductProviderReconciliationCandidate.mockResolvedValueOnce({
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
      eventId: ids.event,
      logicalWorkflowId: context.logicalWorkflowId,
      eventType: "DeploymentRequestedV1",
      acceptedLifecycleVersion: 3,
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"e".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });

    expect(database.claimProductProviderMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: ids.project,
        operationId: ids.operation,
        logicalWorkflowId: context.logicalWorkflowId,
      }),
    );
  });

  it("replays an acknowledged claimless deletion only after its logical Workflow is terminal", async () => {
    const env = bindings();
    const deletionWorkflowId = `product-command-v1-delete-${ids.event}-${ids.operation}`;
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockResolvedValueOnce({
      status: vi.fn(async () => ({ status: "errored" })),
    });
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce(null);
    database.findProductWorkflowReplayCandidate.mockResolvedValueOnce({
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
      eventId: ids.event,
      billingEpochId: ids.claim,
      logicalWorkflowId: deletionWorkflowId,
      eventType: "ProjectDeletionRequestedV1",
    });

    const result = await requestCoreProviderReconciliation(
      env,
      runtime,
      {
        organizationId: message.organizationId,
        operationId: message.operationId,
        actorId: message.actorId,
        idempotencySha256: `sha256:${"f".repeat(64)}`,
      },
      clock,
    );

    expect(result.state).toBe("pending");
    expect(database.prepareProductWorkflowReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        logicalWorkflowId: deletionWorkflowId,
        eventType: "ProjectDeletionRequestedV1",
      }),
    );
    expect(env.DEPLOYMENT_WORKFLOW.create).toHaveBeenCalledWith({
      id: `product-command-replay-v1-${result.attemptId}`,
      params: {
        command: {
          version: 1,
          eventType: "ProjectDeletionRequestedV1",
          eventId: ids.event,
          organizationId: ids.organization,
          projectId: ids.project,
          billingEpochId: ids.claim,
          environmentId: ids.environment,
          operationId: ids.operation,
        },
        replayAttemptId: result.attemptId,
      },
    });
    expect(database.claimProductProviderMutation).not.toHaveBeenCalled();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockResolvedValueOnce({
      status: vi.fn(async () => ({ status: "errored" })),
    });
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce(null);
    database.findProductWorkflowReplayCandidate.mockResolvedValueOnce({
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
      eventId: ids.event,
      billingEpochId: ids.claim,
      logicalWorkflowId: deletionWorkflowId,
      eventType: "ProjectDeletionRequestedV1",
    });
    database.prepareProductWorkflowReplay.mockResolvedValueOnce("exhausted");
    vi.mocked(env.DEPLOYMENT_WORKFLOW.create).mockClear();
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"e".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toMatchObject({ operationId: ids.operation, state: "exhausted" });
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(database.claimProductProviderMutation).not.toHaveBeenCalled();
  });

  it("does not duplicate a claimless command while its logical Workflow is still live", async () => {
    const env = bindings();
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce(null);
    database.findProductWorkflowReplayCandidate.mockResolvedValueOnce({
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
      eventId: ids.event,
      billingEpochId: ids.claim,
      logicalWorkflowId: `product-command-v1-delete-${ids.event}-${ids.operation}`,
      eventType: "ProjectDeletionRequestedV1",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: `sha256:${"9".repeat(64)}`,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });
    expect(database.prepareProductWorkflowReplay).not.toHaveBeenCalled();
    expect(env.DEPLOYMENT_WORKFLOW.create).not.toHaveBeenCalled();
  });

  it("releases only the exact terminal physical replay before a new idempotency key", async () => {
    const env = bindings();
    const physicalWorkflowId = `product-command-replay-v1-${ids.attempt}`;
    database.readProductWorkflowReplayAttempt.mockResolvedValueOnce({
      outcome: "prepared",
      attemptId: ids.attempt,
      physicalWorkflowId,
      originalMessage: {
        version: 1,
        eventType: "ProjectDeletionRequestedV1",
        eventId: ids.event,
        organizationId: ids.organization,
        projectId: ids.project,
        billingEpochId: ids.claim,
        environmentId: ids.environment,
        operationId: ids.operation,
      },
    });
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockResolvedValueOnce({
      status: vi.fn(async () => ({ status: "terminated" })),
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "completed" });
    expect(database.recoverTerminalProductWorkflowReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: ids.attempt,
        operationId: ids.operation,
        terminalStatus: "terminated",
      }),
    );
    expect(database.findProductProviderReconciliationClaim).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: ids.organization, operationId: ids.operation },
    );
  });

  it("recovers a terminal logical Workflow that crashed before reconciliation evidence persisted", async () => {
    const env = bindings();
    vi.mocked(env.DEPLOYMENT_WORKFLOW.get).mockResolvedValueOnce({
      status: vi.fn(async () => ({ status: "errored" })),
    });
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce({
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
      claimId: ids.claim,
      eventId: ids.event,
      logicalWorkflowId: context.logicalWorkflowId,
      workflowState: "queued",
      providerPhase: "database",
    });

    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        {
          organizationId: message.organizationId,
          operationId: message.operationId,
          actorId: message.actorId,
          idempotencySha256: message.idempotencySha256,
        },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });

    expect(database.reconcileProductCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workflowId: context.logicalWorkflowId,
        errorCode: "WORKFLOW_TERMINAL_BEFORE_RECONCILIATION",
        providerReconciliation: expect.objectContaining({ hint: { phase: "database" } }),
      }),
    );
    expect(env.PROVIDER_RECONCILIATION_WORKFLOW.create).toHaveBeenCalledOnce();
  });

  it("replays a prepared attempt directly and returns a completed attempt after claim release", async () => {
    const env = bindings();
    database.readProductProviderReconciliationAttempt.mockResolvedValueOnce({
      outcome: "prepared",
      attemptId: message.attemptId,
      claimId: message.claimId,
      physicalWorkflowId: `product-provider-reconcile-v1-${message.attemptId}`,
      originalMessage: context.originalMessage,
    });
    const input = {
      organizationId: message.organizationId,
      operationId: message.operationId,
      actorId: message.actorId,
      idempotencySha256: message.idempotencySha256,
    } as const;

    await expect(
      requestCoreProviderReconciliation(env, runtime, input, clock),
    ).resolves.toMatchObject({ state: "pending" });
    expect(env.DEPLOYMENT_WORKFLOW.get).toHaveBeenCalledWith(
      `product-provider-reconcile-v1-${message.attemptId}`,
    );
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();

    database.readProductProviderReconciliationAttempt.mockResolvedValueOnce({
      outcome: "completed",
      attemptId: message.attemptId,
    });
    await expect(
      requestCoreProviderReconciliation(env, runtime, input, clock),
    ).resolves.toMatchObject({ state: "completed" });
    expect(database.findProductProviderReconciliationClaim).not.toHaveBeenCalled();
  });

  it("recovers an exact terminal physical attempt before allowing a new operator attempt", async () => {
    const env = { ...bindings(), DEPLOYMENT_WORKFLOW: workflow("errored") };
    database.readProductProviderReconciliationAttempt.mockResolvedValueOnce({
      outcome: "prepared",
      attemptId: message.attemptId,
      claimId: message.claimId,
      physicalWorkflowId: `product-provider-reconcile-v1-${message.attemptId}`,
      originalMessage: context.originalMessage,
    });
    const input = {
      organizationId: message.organizationId,
      operationId: message.operationId,
      actorId: message.actorId,
      idempotencySha256: message.idempotencySha256,
    } as const;

    await expect(
      requestCoreProviderReconciliation(env, runtime, input, clock),
    ).resolves.toMatchObject({ state: "completed" });
    expect(database.recoverTerminalProductProviderReconciliationAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: message.attemptId,
        terminalStatus: "errored",
        actorId: message.actorId,
      }),
    );

    database.readProductProviderReconciliationAttempt.mockResolvedValueOnce(null);
    database.findProductProviderReconciliationClaim.mockResolvedValueOnce({
      projectId: ids.project,
      environmentId: ids.environment,
      claimId: ids.claim,
      eventId: ids.event,
      logicalWorkflowId: context.logicalWorkflowId,
    });
    await expect(
      requestCoreProviderReconciliation(
        env,
        runtime,
        { ...input, idempotencySha256: `sha256:${"d".repeat(64)}` },
        clock,
      ),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("accepts a deletion exhausted before its Workflow run existed, so its handoff can follow", async () => {
    const env = bindings();
    database.findRunlessProductDispatch.mockResolvedValueOnce({
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      operationId: ids.operation,
      eventId: ids.event,
      attemptId: ids.attempt,
      billingEpochId: ids.claim,
      eventType: "ProjectDeletionRequestedV1",
      planId: null,
      requestedHandle: null,
      dataChange: null,
    });

    const result = await requestCoreProviderReconciliation(
      env,
      runtime,
      {
        organizationId: message.organizationId,
        operationId: message.operationId,
        actorId: message.actorId,
        idempotencySha256: `sha256:${"1".repeat(64)}`,
      },
      clock,
    );

    expect(result.state).toBe("pending");
    expect(database.acceptRunlessProductDispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ids.organization,
        projectId: ids.project,
        environmentId: ids.environment,
        operationId: ids.operation,
        eventId: ids.event,
        attemptId: ids.attempt,
        workflowId: `product-command-v1-delete-${ids.event}-${ids.operation}`,
      }),
    );
  });

  it("answers unmatched when no recovery is pending for the operation, without a retryable failure", async () => {
    const env = bindings();

    const result = await requestCoreProviderReconciliation(
      env,
      runtime,
      {
        organizationId: message.organizationId,
        operationId: message.operationId,
        actorId: message.actorId,
        idempotencySha256: `sha256:${"2".repeat(64)}`,
      },
      clock,
    );

    expect(result.state).toBe("unmatched");
    expect(database.acceptRunlessProductDispatch).not.toHaveBeenCalled();
  });
});
