import { describe, expect, it, vi } from "vitest";
import { normalizeBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";

import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
} from "./product-command.js";
import {
  PRODUCT_WORKFLOW_STEP_CONFIG,
  PRODUCT_BUILD_OBSERVATION_STEP_CONFIG,
  runProductCommandWorkflow,
  type ProductCommandWorkflowPorts,
  type ProductWorkflowStepPort,
} from "./deployment-workflow.js";

const base = {
  version: 1,
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
} as const;

const defaultActivationRuntimePolicy = {
  healthCheckPath: "/",
  egressAllowedOrigins: [],
} as const;

const command = (eventType: string) =>
  parseProductCommandMessageV1({
    ...base,
    eventType,
    ...(eventType === "DeploymentRequestedV1" ? { planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1" } : {}),
    ...(eventType === "ProjectHandleChangeRequestedV1" ? { requestedHandle: "acme-shop" } : {}),
  });

const step = (): ProductWorkflowStepPort => ({
  do: async (_name, _config, run) => run(),
  sleep: vi.fn(async () => undefined),
});

const applied = async () => "applied" as const;

const ports = (): ProductCommandWorkflowPorts => ({
  persistence: {
    authorizeActivation: vi.fn(async () => ({ allowed: true as const })),
    recordCandidate: vi.fn(async () => ({
      persistence: "applied" as const,
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
    })),
    finalizeCandidate: vi.fn(applied),
    finishBindingRefresh: vi.fn(applied),
    readGatewayAddressMoves: vi.fn(async () => [
      {
        environmentId: base.environmentId,
        environmentName: "dev" as const,
        handle: "calm-otter-waves",
        publicOrigin: "https://dev-calm-otter-waves.check.omh.st",
      },
      {
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
        environmentName: "prod" as const,
        handle: "calm-otter-waves",
        publicOrigin: "https://calm-otter-waves.check.omh.st",
      },
    ]),
    finalizeHandleChange: vi.fn(applied),
    finalizeRollback: vi.fn(applied),
    markCandidateSuperseded: vi.fn(applied),
    prepareCandidateCleanup: vi.fn(async ({ candidate, supersededById }) => ({
      claimId: "claim-1",
      candidateReceiptId: "candidate-persistence-1",
      cleanupReceiptId: "cleanup-1",
      candidate,
      supersededById,
      expectedResources: [],
    })),
    claimCandidateCleanup: vi.fn(async () => null),
    recordCandidateCleanup: vi.fn(applied),
    complete: vi.fn(applied),
    fail: vi.fn(applied),
    recordHealthFailure: vi.fn(applied),
    requireReconciliation: vi.fn(applied),
    retainDeletionTombstone: vi.fn(applied),
    readPromotionStaleness: vi.fn(async () => null),
  },
  source: {
    observeLink: vi.fn(async () => ({
      status: "observed" as const,
      evidence: { sourceConnectionId: "source-1" },
    })),
    fetchExactArchive: vi.fn(async () => ({
      status: "observed" as const,
      archive: "archive-1",
    })),
  },
  build: {
    readBindingRefresh: vi.fn(async () => null),
    start: vi.fn(async () => ({ status: "started" as const, receipt: "build-1" })),
    observe: vi.fn(async () => ({
      status: "observed" as const,
      artifact: "artifact-1",
      artifactDigest: "sha256:artifact-a",
    })),
  },
  database: {
    ensure: vi.fn(async () => ({ status: "ready" as const, receipt: null })),
  },
  wfp: {
    moveGatewayAddress: vi.fn(async (_command, environment, handle) => ({
      status: "moved" as const,
      publicOrigin:
        environment.environmentName === "dev"
          ? `https://dev-${handle}.check.omh.st`
          : `https://${handle}.check.omh.st`,
      gateway: { handle },
    })),
    prepareRollback: vi.fn(async () => ({
      status: "replayed" as const,
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
      operationId: base.operationId,
      receipt: "rollback-candidate-1",
      previousGateway: "gateway-1",
      runtimePolicy: "runtime-policy-rollback",
      runtimeSecretDeliveryStage: "secret-stage-rollback",
      deploymentUrl: "https://example.test/p/project",
      artifactDigest: "sha256:artifact-rollback",
    })),
    stage: vi.fn(async () => ({
      status: "staged" as const,
      candidateReceiptId: null,
      operationId: base.operationId,
      receipt: "candidate-1",
      previousGateway: "gateway-0",
      runtimePolicy: defaultActivationRuntimePolicy,
      runtimeSecretDeliveryStage: "secret-stage-1",
      deploymentUrl: "https://example.test/p/project",
      artifactDigest: "sha256:artifact-a",
    })),
    recordStagedCandidate: vi.fn(async () => ({
      status: "recorded" as const,
      runtimeSecretDeliveryStage: "secret-stage-recorded-1",
    })),
    recordActivatedCandidate: vi.fn(async () => ({ status: "activated" as const })),
    activate: vi.fn(async () => ({
      status: "activated" as const,
      candidateReceipt: "candidate-1",
      gateway: "gateway-1",
      deploymentUrl: "https://example.test/p/project",
    })),
    observeActivation: vi.fn(async () => ({
      status: "activated" as const,
      candidateReceipt: "candidate-1",
      gateway: "gateway-1",
      deploymentUrl: "https://example.test/p/project",
    })),
    compensate: vi.fn(async () => ({
      status: "compensated" as const,
      outcome: "removed" as const,
      candidateAbsence: "candidate-absence-1",
      gateway: "gateway-0",
      operationResources: "operation-resources-1",
    })),
    restoreGateway: vi.fn(async () => ({
      status: "restored" as const,
      gateway: "gateway-1",
    })),
    removeCandidate: vi.fn(async () => ({
      status: "removed" as const,
      outcome: "removed" as const,
      candidateAbsence: "candidate-absence-1",
      gateway: null,
      operationResources: "operation-resources-1",
    })),
    removeClaimedCandidate: vi.fn(async () => ({
      status: "removed" as const,
      outcome: "removed" as const,
      candidateAbsence: "candidate-absence-1",
      gateway: null,
    })),
    tombstone: vi.fn(async () => ({
      status: "observed" as const,
      tombstoneReceiptId: "tombstone-1",
      consecutive404s: 3,
    })),
    cleanupInventory: vi.fn(async () => ({ status: "observed" as const, inventoryClean: true })),
    observeRoute404: vi.fn(async () => ({ status: "observed" as const, consecutive404s: 3 })),
    finalizeRemoval: vi.fn(async () => ({
      status: "observed" as const,
      consecutive404s: 3,
      gatewayAbsence: "gateway-absence-1",
    })),
  },
  cleanup: {
    removeOperationArtifacts: vi.fn(async () => ({
      status: "removed" as const,
      evidence: "operation-resources-1",
    })),
  },
  schedules: {
    remove: vi.fn(async () => ({ removed: 0 })),
  },
});

describe("product command workflow", () => {
  it("rejects revoked authorization with observed candidate/activation custody and preserves uncertain cleanup", async () => {
    for (const phase of ["source", "preactivation", "finalization"] as const) {
      const dependencies = ports();
      const denied = Object.assign(
        new Error("Queued operation authorization or source generation changed"),
        { code: "operation_authorization_changed" },
      );
      const rejection = vi.fn(async () => ({
        status: "failed" as const,
        persistence: "applied" as const,
      }));
      dependencies.persistence.rejectAuthorization = rejection;
      if (phase === "source")
        vi.mocked(dependencies.source.fetchExactArchive).mockRejectedValue(denied);
      if (phase === "preactivation")
        vi.mocked(dependencies.persistence.authorizeActivation).mockImplementation(
          async (_command, candidate) => {
            if (candidate !== undefined) throw denied;
            return { allowed: true as const };
          },
        );
      if (phase === "finalization")
        vi.mocked(dependencies.persistence.finalizeCandidate).mockRejectedValue(denied);
      expect(
        await runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
      ).toEqual({ status: "failed", persistence: "applied" });
      expect(rejection).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate:
            phase === "source"
              ? null
              : expect.objectContaining({ candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC1" }),
          activation:
            phase === "finalization"
              ? expect.objectContaining({ deploymentUrl: expect.any(String) })
              : null,
          activationAttempted: phase === "finalization",
        }),
      );
      expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
      if (phase !== "finalization") expect(dependencies.wfp.activate).not.toHaveBeenCalled();
    }
    const dependencies = ports();
    vi.mocked(dependencies.source.fetchExactArchive).mockRejectedValue(
      Object.assign(new Error("authorization"), { code: "operation_authorization_changed" }),
    );
    dependencies.persistence.rejectAuthorization = async () => ({
      status: "uncertain",
      providerHint: {
        phase: "wfp",
        expectedArtifactDigest: null,
        currentProviderTag: null,
        currentProductDeploymentId: null,
      },
    });
    expect(
      await runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).toMatchObject({ status: "reconciliation_required" });
    expect(dependencies.persistence.fail).not.toHaveBeenCalled();
  });
  it("reuses the privately accepted current artifact without source/build charges and resumes its published head", async () => {
    for (const mode of ["prepared", "published", "completed"]) {
      const published = mode === "published";
      const dependencies = ports();
      vi.mocked(dependencies.build.readBindingRefresh).mockResolvedValueOnce(
        mode === "completed"
          ? { completed: true }
          : { artifact: "existing-artifact", artifactDigest: "sha256:artifact-a", published },
      );
      vi.mocked(dependencies.persistence.finalizeCandidate).mockResolvedValueOnce({
        status: "binding_refresh_pending",
      } as never);
      await expect(
        runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
      ).resolves.toEqual({
        status: "succeeded",
        persistence: mode === "completed" ? "duplicate" : "applied",
      });
      expect(dependencies.source.fetchExactArchive).not.toHaveBeenCalled();
      expect(dependencies.build.start).not.toHaveBeenCalled();
      expect(dependencies.build.observe).not.toHaveBeenCalled();
      expect(dependencies.database.ensure).not.toHaveBeenCalled();
      if (mode === "completed")
        expect(dependencies.persistence.finishBindingRefresh).not.toHaveBeenCalled();
      else
        expect(dependencies.persistence.finishBindingRefresh).toHaveBeenCalledWith(
          expect.objectContaining({ artifact: "existing-artifact" }),
        );
      if (published || mode === "completed") expect(dependencies.wfp.stage).not.toHaveBeenCalled();
      else
        expect(dependencies.wfp.stage).toHaveBeenCalledWith(
          command("DeploymentRequestedV1"),
          "existing-artifact",
        );
    }
  });
  it("changes data assignments in the safe order without copying or deleting Prod data", async () => {
    for (const change of [
      "isolate_prod_keeps_data",
      "isolate_dev_keeps_data",
      "share_prod_keeps_data",
      "reset_dev",
    ] as const) {
      const calls: string[] = [];
      const dependencies = ports();
      const retiring = change === "share_prod_keeps_data" || change === "reset_dev";
      const direction = change === "share_prod_keeps_data" ? "widen" : "narrow";
      const data = "01ARZ3NDEKTSV4RRFFQ69G5FC9";
      Object.assign(dependencies, {
        dataChange: {
          readPlan: async () => ({
            dataModeAfter: change === "share_prod_keeps_data" ? "shared" : "isolated",
            redeployEnvironments: [change === "isolate_dev_keeps_data" ? "prod" : "dev"],
            removeDevDeployment: retiring,
            retiredDataEnvironmentIds: retiring ? [data] : [],
            reauthorizations: retiring
              ? [
                  { dataEnvironmentId: data, direction: "narrow" },
                  ...(change === "share_prod_keeps_data"
                    ? [{ dataEnvironmentId: data, direction: "widen" }]
                    : []),
                ]
              : [{ dataEnvironmentId: data, direction }],
          }),
          revokeDatabaseAccess: async () => {
            calls.push("revoke");
            return { status: "ready" };
          },
          reauthorize: async (_command: unknown, _id: string, phase: string) => {
            calls.push(phase);
            return { status: "ready" };
          },
          removeDevDeployment: async () => {
            calls.push("remove-dev");
            return { status: "ready" };
          },
          switchAssignments: async () => {
            calls.push("switch");
            return "applied";
          },
          purgeFiles: async () => {
            calls.push("purge-files");
            return { status: "ready", deletedFiles: 2 };
          },
          retireDatabase: async () => {
            calls.push("retire-database");
            return { status: "ready", deletedDatabase: true };
          },
        },
      });
      const message = parseProductCommandMessageV1({
        ...base,
        eventType: "ProjectDataChangeRequestedV1",
        dataChange: change,
      });
      await expect(runProductCommandWorkflow(message, step(), dependencies)).resolves.toEqual({
        status: "succeeded",
        persistence: "applied",
      });
      expect(calls).toEqual(
        change === "reset_dev"
          ? ["revoke", "narrow", "remove-dev", "switch", "purge-files", "retire-database"]
          : change === "share_prod_keeps_data"
            ? [
                "revoke",
                "narrow",
                "remove-dev",
                "switch",
                "widen",
                "purge-files",
                "retire-database",
              ]
            : ["revoke", "narrow", "switch"],
      );
      expect(dependencies.persistence.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: {
            schemaVersion: "ohmyhost.operation-data-change-result/v1",
            operationId: base.operationId,
            change,
            data_mode: change === "share_prod_keeps_data" ? "shared" : "isolated",
            redeploy_environments: [change === "isolate_dev_keeps_data" ? "prod" : "dev"],
            deleted_database: retiring,
            deleted_files: retiring ? 2 : 0,
          },
        }),
      );
      expect(dependencies.build.start).not.toHaveBeenCalled();
      expect(dependencies.wfp.tombstone).not.toHaveBeenCalled();
      expect(dependencies.persistence.claimCandidateCleanup).not.toHaveBeenCalled();
    }
  });

  it("waits for old upload capabilities and retains uncertain data changes for reconciliation", async () => {
    for (const uncertain of [false, true]) {
      const dependencies = ports();
      const durable = step();
      const retirement = vi.fn(async () => ({ status: "ready", deletedDatabase: true }));
      let reads = 0;
      Object.assign(dependencies, {
        dataChange: {
          readPlan: async () => ({
            dataModeAfter: "isolated",
            redeployEnvironments: ["dev"],
            removeDevDeployment: true,
            retiredDataEnvironmentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FC9"],
            reauthorizations: [],
          }),
          revokeDatabaseAccess: async () => ({ status: "ready" }),
          removeDevDeployment: async () => ({ status: "ready" }),
          reauthorize: async () => ({ status: "ready" }),
          switchAssignments: async () => "applied",
          purgeFiles: async () => {
            const observation = reads++;
            if (observation < 6) return { status: "pending", retryAfterSeconds: 60 };
            if (observation < 9)
              return { status: "pending", retryAfterSeconds: 1, progress: "page_completed" };
            return uncertain ? { status: "uncertain" } : { status: "ready", deletedFiles: 3001 };
          },
          retireDatabase: retirement,
        },
      });
      const message = parseProductCommandMessageV1({
        ...base,
        eventType: "ProjectDataChangeRequestedV1",
        dataChange: "reset_dev",
      });
      await expect(
        runProductCommandWorkflow(message, durable, dependencies),
      ).resolves.toMatchObject({ status: uncertain ? "reconciliation_required" : "succeeded" });
      expect(durable.sleep).toHaveBeenCalledTimes(6);
      expect(reads).toBe(10);
      if (uncertain) {
        expect(retirement).not.toHaveBeenCalled();
        expect(dependencies.persistence.complete).not.toHaveBeenCalled();
      } else expect(retirement).toHaveBeenCalledOnce();
    }
  });

  it("links a source only after the provider observation is durable", async () => {
    const dependencies = ports();
    await expect(
      runProductCommandWorkflow(command("SourceLinkRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(dependencies.persistence.complete).toHaveBeenCalledOnce();
  });

  it("deploys through exact archive, staged candidate, fenced gateway activation, and final CAS", async () => {
    const dependencies = ports();
    let activationRetryLimit: number | undefined;
    const durableStep: ProductWorkflowStepPort = {
      do: async (name, config, run) => {
        if (name === "activate-project-gateway-candidate") {
          activationRetryLimit = config.retries.limit;
        }
        return run();
      },
      sleep: vi.fn(async () => undefined),
    };
    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), durableStep, dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(dependencies.source.fetchExactArchive).toHaveBeenCalledOnce();
    expect(dependencies.build.start).toHaveBeenCalledWith(expect.anything(), "archive-1");
    expect(dependencies.wfp.stage).toHaveBeenCalledWith(expect.anything(), "artifact-1");
    expect(dependencies.persistence.recordCandidate).toHaveBeenCalledOnce();
    expect(dependencies.wfp.recordStagedCandidate).toHaveBeenCalledOnce();
    expect(dependencies.persistence.authorizeActivation).toHaveBeenCalledTimes(2);
    expect(dependencies.wfp.activate).toHaveBeenCalledOnce();
    expect(dependencies.persistence.finalizeCandidate).toHaveBeenCalledOnce();
    expect(dependencies.wfp.recordActivatedCandidate).toHaveBeenCalledOnce();
    expect(activationRetryLimit).toBe(5);
    expect(
      vi.mocked(dependencies.persistence.recordCandidate).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(dependencies.wfp.recordStagedCandidate).mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      vi.mocked(dependencies.wfp.recordActivatedCandidate).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(dependencies.persistence.finalizeCandidate).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never publishes a build superseded by a newer GitHub push after build observation", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.persistence.authorizeActivation).mockResolvedValue({
      allowed: false,
      supersededById: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "superseded", persistence: "applied" });

    expect(dependencies.build.observe).toHaveBeenCalled();
    expect(dependencies.wfp.stage).toHaveBeenCalledOnce();
    expect(dependencies.wfp.activate).not.toHaveBeenCalled();
    expect(dependencies.wfp.removeCandidate).toHaveBeenCalledOnce();
    expect(dependencies.persistence.markCandidateSuperseded).toHaveBeenCalledOnce();
  });

  it("compensates the exact gateway when a newer push wins after activation", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.persistence.authorizeActivation)
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({
        allowed: false,
        supersededById: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
      });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "superseded", persistence: "applied" });

    expect(dependencies.wfp.activate).toHaveBeenCalledOnce();
    expect(dependencies.wfp.compensate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claimId: "claim-1",
        candidate: expect.objectContaining({ receipt: "candidate-1" }),
      }),
      expect.objectContaining({ gateway: "gateway-1" }),
    );
    expect(dependencies.cleanup.removeOperationArtifacts).toHaveBeenCalledOnce();
    expect(dependencies.persistence.finalizeCandidate).not.toHaveBeenCalled();
  });

  it("retains an activated candidate for reconciliation after a finalization conflict", async () => {
    const dependencies = ports();
    const activationRuntimePolicy = {
      healthCheckPath: "/api/health",
      browser: normalizeBrowserPolicy({
        connect: ["wss://live.example.test"],
        styles: ["https://cdn.example.test"],
      }),
      egressAllowedOrigins: [
        "https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com",
        "https://ohmyho-mail-gateway-poc-private-fullstack.your-omh-account.workers.dev",
        "https://ohmyho-storage-gateway-poc-private-fullstack.your-omh-account.workers.dev",
      ],
    } as const;
    vi.mocked(dependencies.wfp.stage).mockResolvedValueOnce({
      status: "staged",
      candidateReceiptId: null,
      operationId: base.operationId,
      receipt: "candidate-1",
      previousGateway: "gateway-0",
      runtimePolicy: activationRuntimePolicy,
      runtimeSecretDeliveryStage: "secret-stage-1",
      deploymentUrl: "https://example.test/p/project",
      artifactDigest: "sha256:artifact-a",
    });
    vi.mocked(dependencies.persistence.finalizeCandidate).mockResolvedValueOnce({
      status: "conflict",
      reason: "Environment deployment head changed",
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.wfp.compensate).not.toHaveBeenCalled();
    expect(dependencies.persistence.prepareCandidateCleanup).not.toHaveBeenCalled();
    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerHint: {
          phase: "wfp",
          expectedArtifactDigest: "sha256:artifact-a",
          currentProviderTag: null,
          currentProductDeploymentId: null,
          activationRuntimePolicy,
        },
      }),
    );
  });

  it("retains Trakkker 01M1DKRQ52Y9KC59W3YC0Q8SGJ enriched WFP policy after terminal domain finalization loss", async () => {
    const dependencies = ports();
    const activationRuntimePolicy = {
      healthCheckPath: "/api/health",
      egressAllowedOrigins: [
        "https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com",
        "https://ohmyho-mail-gateway-poc-private-fullstack.your-omh-account.workers.dev",
        "https://ohmyho-storage-gateway-poc-private-fullstack.your-omh-account.workers.dev",
      ],
    } as const;
    vi.mocked(dependencies.wfp.stage).mockResolvedValueOnce({
      status: "staged",
      candidateReceiptId: null,
      operationId: base.operationId,
      receipt: "candidate-1",
      previousGateway: "gateway-0",
      runtimePolicy: activationRuntimePolicy,
      runtimeSecretDeliveryStage: "secret-stage-1",
      deploymentUrl: "https://example.test/p/project",
      artifactDigest: "sha256:artifact-a",
    });
    vi.mocked(dependencies.persistence.finalizeCandidate).mockRejectedValueOnce(
      new Error("CloudflareDomainReconciliationUnavailableError"),
    );

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.wfp.activate).toHaveBeenCalledOnce();
    expect(dependencies.wfp.recordActivatedCandidate).toHaveBeenCalledOnce();
    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerHint: {
          phase: "wfp",
          expectedArtifactDigest: "sha256:artifact-a",
          currentProviderTag: null,
          currentProductDeploymentId: null,
          activationRuntimePolicy,
        },
      }),
    );
  });

  it("adopts an exact activation after the provider response is lost", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.activate).mockResolvedValueOnce({
      status: "uncertain",
      providerHint: {
        phase: "gateway",
        expectedArtifactDigest: "sha256:artifact-a",
        currentProviderTag: null,
        currentProductDeploymentId: null,
      },
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });

    expect(dependencies.wfp.observeActivation).toHaveBeenCalledOnce();
    expect(dependencies.persistence.finalizeCandidate).toHaveBeenCalledOnce();

    const replay = ports();
    const replayCommand = command("DeploymentRequestedV1");
    await expect(
      runProductCommandWorkflow(
        replayCommand,
        step(),
        replay,
        deterministicProductCommandWorkflowId(replayCommand),
        "product-provider-reconcile-v1-01ARZ3NDEKTSV4RRFFQ69G5FC2",
      ),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(replay.wfp.observeActivation).toHaveBeenCalledOnce();
    expect(replay.wfp.activate).not.toHaveBeenCalled();
    expect(replay.wfp.recordActivatedCandidate).toHaveBeenCalledOnce();
  });

  it("advances a replayed candidate from its exact previous gateway", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.observeActivation).mockResolvedValueOnce({
      status: "uncertain",
      providerHint: {
        phase: "gateway",
        expectedArtifactDigest: "sha256:artifact-a",
        currentProviderTag: "sha256:gateway-0",
        currentProductDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      },
    });
    const replayCommand = command("DeploymentRequestedV1");

    await expect(
      runProductCommandWorkflow(
        replayCommand,
        step(),
        dependencies,
        deterministicProductCommandWorkflowId(replayCommand),
        "product-provider-reconcile-v1-01ARZ3NDEKTSV4RRFFQ69G5FC2",
      ),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });

    expect(dependencies.wfp.observeActivation).toHaveBeenCalledOnce();
    expect(dependencies.wfp.activate).toHaveBeenCalledOnce();
  });

  it("removes an unactivated candidate before recording reconciliation", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.activate).mockResolvedValueOnce({
      status: "uncertain",
      providerHint: {
        phase: "gateway",
        expectedArtifactDigest: "sha256:artifact-a",
        currentProviderTag: null,
        currentProductDeploymentId: null,
      },
    });
    vi.mocked(dependencies.wfp.observeActivation).mockResolvedValueOnce({ status: "absent" });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.prepareCandidateCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "failed", supersededById: null }),
    );
    expect(dependencies.wfp.removeCandidate).toHaveBeenCalledOnce();
    expect(dependencies.persistence.recordCandidateCleanup).toHaveBeenCalledOnce();
    expect(
      vi.mocked(dependencies.persistence.recordCandidateCleanup).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(dependencies.persistence.requireReconciliation).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("retains the candidate when compensation is uncertain", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.persistence.authorizeActivation)
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({
        allowed: false,
        supersededById: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
      });
    vi.mocked(dependencies.wfp.compensate).mockResolvedValueOnce({
      status: "uncertain",
      providerHint: {
        phase: "gateway",
        expectedArtifactDigest: "sha256:artifact-a",
        currentProviderTag: "gateway-1",
        currentProductDeploymentId: base.operationId,
      },
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.recordCandidateCleanup).not.toHaveBeenCalled();
    expect(dependencies.persistence.markCandidateSuperseded).not.toHaveBeenCalled();
  });

  it("terminalizes a deploy after its crash-resumed candidate cleanup", async () => {
    const dependencies = ports();
    const pendingCandidate = {
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
      operationId: base.operationId,
      receipt: "candidate-1",
      previousGateway: "gateway-0",
      runtimePolicy: "runtime-policy-1",
      runtimeSecretDeliveryStage: null,
      deploymentUrl: "https://example.test/p/project",
      artifactDigest: "sha256:artifact-a",
    } as const;
    const claim = {
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
      candidateReceiptId: pendingCandidate.candidateReceiptId,
      cleanupReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
      candidate: pendingCandidate,
      supersededById: "01ARZ3NDEKTSV4RRFFQ69G5FC5",
      expectedResources: [],
    } as const;
    vi.mocked(dependencies.persistence.claimCandidateCleanup).mockResolvedValue(claim);
    vi.mocked(dependencies.wfp.removeClaimedCandidate)
      .mockResolvedValueOnce({
        status: "uncertain",
        providerHint: {
          phase: "runtime-secrets",
          expectedArtifactDigest: pendingCandidate.artifactDigest,
          currentProviderTag: null,
          currentProductDeploymentId: null,
        },
      })
      .mockResolvedValueOnce({
        status: "not_found",
        outcome: "not_found",
        candidateAbsence: "candidate-absence-1",
        gateway: null,
      });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });
    expect(dependencies.persistence.recordCandidateCleanup).not.toHaveBeenCalled();

    vi.mocked(dependencies.persistence.claimCandidateCleanup).mockResolvedValueOnce(claim);
    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });
    expect(dependencies.wfp.removeClaimedCandidate).toHaveBeenCalledTimes(2);
    expect(dependencies.persistence.recordCandidateCleanup).toHaveBeenCalledOnce();
    expect(dependencies.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "RUNTIME_CANDIDATE_FAILED" }),
    );
    expect(dependencies.source.fetchExactArchive).not.toHaveBeenCalled();
  });

  // Sebmer Prod operation 01M3C6QP35V682DK0J5KGNY6AA (2026-09-25) drained the pending cleanup of
  // the Dev operation's unhealthy candidate. That candidate is not this deployment's: it is removed
  // and recorded, and this deployment then builds its own candidate instead of failing for it.
  it("continues a deployment after cleaning another operation's pending candidate", async () => {
    const dependencies = ports();
    const devCandidate = {
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FC6",
      receipt: "dev-candidate-1",
      previousGateway: null,
      runtimePolicy: "runtime-policy-dev",
      runtimeSecretDeliveryStage: null,
      deploymentUrl: "https://example.test/p/dev-project",
      artifactDigest: "sha256:artifact-dev",
    } as const;
    vi.mocked(dependencies.persistence.claimCandidateCleanup).mockResolvedValueOnce({
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
      candidateReceiptId: devCandidate.candidateReceiptId,
      cleanupReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
      candidate: devCandidate,
      supersededById: null,
      expectedResources: [],
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });

    expect(dependencies.wfp.removeClaimedCandidate).toHaveBeenCalledOnce();
    expect(dependencies.cleanup.removeOperationArtifacts).toHaveBeenCalledOnce();
    expect(dependencies.persistence.recordCandidateCleanup).toHaveBeenCalledOnce();
    expect(dependencies.persistence.fail).not.toHaveBeenCalled();
    expect(dependencies.source.fetchExactArchive).toHaveBeenCalledOnce();
    expect(dependencies.persistence.finalizeCandidate).toHaveBeenCalledOnce();
  });

  it("fails the deployment terminally when the runtime rejects the staged candidate", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.stage).mockResolvedValueOnce({
      status: "failed",
      errorCode: "RUNTIME_CANDIDATE_REJECTED",
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });

    expect(dependencies.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "RUNTIME_CANDIDATE_REJECTED" }),
    );
    expect(dependencies.persistence.recordCandidate).not.toHaveBeenCalled();
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    expect(dependencies.wfp.activate).not.toHaveBeenCalled();
  });

  it("fails the deployment terminally when the storage target conflicts with durable state", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.database.ensure).mockResolvedValueOnce({
      status: "failed",
      errorCode: "STORAGE_JURISDICTION_CONFLICT",
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });

    expect(dependencies.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "STORAGE_JURISDICTION_CONFLICT" }),
    );
    expect(dependencies.wfp.stage).not.toHaveBeenCalled();
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  it("fails a deployment whose candidate never became healthy", async () => {
    const health = { status: 500, path: "/", excerpt: "boom", truncated: false };
    for (const eventType of ["DeploymentRequestedV1", "DeploymentPromotionRequestedV1"] as const) {
      const dependencies = ports();
      vi.mocked(dependencies.wfp.activate).mockResolvedValue({
        status: "unhealthy" as const,
        candidateReceipt: "candidate-1",
        gateway: "gateway-1",
        deploymentUrl: "https://example.test/p/project",
        health,
      });

      await expect(
        runProductCommandWorkflow(command(eventType), step(), dependencies),
      ).resolves.toEqual({ status: "failed", persistence: "applied" });

      expect(dependencies.persistence.recordHealthFailure).toHaveBeenCalledWith(
        expect.objectContaining({ health }),
      );
      expect(dependencies.wfp.compensate).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(dependencies.persistence.recordHealthFailure).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(dependencies.wfp.compensate).mock.invocationCallOrder[0] ?? 0);
      expect(dependencies.persistence.fail).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "RUNTIME_CANDIDATE_FAILED", health }),
      );
      expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    }
  });

  // Sebmer Dev operation 01M3C5PEP52T5E3YCM26VWPKXW (2026-09-25): the candidate answered its health
  // check unhealthy, compensation then failed four times, and the verdict was never stored. It is
  // stored before compensation, so a compensation failure can no longer erase it.
  it("keeps the health verdict when compensating an unhealthy candidate fails", async () => {
    const dependencies = ports();
    const health = { status: 503, path: "/", excerpt: null, truncated: false };
    vi.mocked(dependencies.wfp.activate).mockResolvedValue({
      status: "unhealthy" as const,
      candidateReceipt: "candidate-1",
      gateway: "gateway-1",
      deploymentUrl: "https://example.test/p/project",
      health,
    });
    vi.mocked(dependencies.wfp.compensate).mockRejectedValue(
      new TypeError("Runtime secret delivery input is invalid"),
    );

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.recordHealthFailure).toHaveBeenCalledOnce();
    expect(dependencies.persistence.recordHealthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.objectContaining(base), health }),
    );
    expect(dependencies.persistence.fail).not.toHaveBeenCalled();
  });

  it("replays deterministically after a crash between gateway switch and finalization", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.persistence.finalizeCandidate)
      .mockRejectedValueOnce(new Error("control database unavailable"))
      .mockResolvedValueOnce("applied");
    vi.mocked(dependencies.wfp.stage)
      .mockResolvedValueOnce({
        status: "staged",
        candidateReceiptId: null,
        operationId: base.operationId,
        receipt: "candidate-1",
        previousGateway: "gateway-0",
        runtimePolicy: defaultActivationRuntimePolicy,
        runtimeSecretDeliveryStage: "secret-stage-1",
        deploymentUrl: "https://example.test/p/project",
        artifactDigest: "sha256:artifact-a",
      })
      .mockResolvedValueOnce({
        status: "replayed",
        candidateReceiptId: null,
        operationId: base.operationId,
        receipt: "candidate-1",
        previousGateway: "gateway-0",
        runtimePolicy: defaultActivationRuntimePolicy,
        runtimeSecretDeliveryStage: "secret-stage-1",
        deploymentUrl: "https://example.test/p/project",
        artifactDigest: "sha256:artifact-a",
      });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });
    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });

    expect(dependencies.persistence.recordCandidate).toHaveBeenCalledTimes(2);
    expect(dependencies.wfp.compensate).not.toHaveBeenCalled();
  });

  it("waits for known mail verification and resumes the same build or promotion without rebuilding", async () => {
    for (const kind of ["DeploymentRequestedV1", "DeploymentPromotionRequestedV1"]) {
      const dependencies = ports(),
        durableStep = step();
      vi.mocked(dependencies.database.ensure)
        .mockResolvedValueOnce({ status: "verification_pending" })
        .mockResolvedValueOnce({ status: "ready", receipt: null });
      const result = await runProductCommandWorkflow(command(kind), durableStep, dependencies);
      expect(result.status).toBe("succeeded");
      expect(dependencies.database.ensure).toHaveBeenCalledTimes(2);
      expect(durableStep.sleep).toHaveBeenCalledWith(
        kind === "DeploymentRequestedV1"
          ? "wait-for-mail-verification-1"
          : "wait-for-promotion-mail-verification-1",
        "1 minute",
      );
      expect(dependencies.build.start).toHaveBeenCalledTimes(
        kind === "DeploymentRequestedV1" ? 1 : 0,
      );
      expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    }
    const pending = ports(),
      waiting = step();
    vi.mocked(pending.database.ensure).mockResolvedValue({ status: "verification_pending" });
    expect(
      (await runProductCommandWorkflow(command("DeploymentRequestedV1"), waiting, pending)).status,
    ).toBe("reconciliation_required");
    expect(pending.database.ensure).toHaveBeenCalledTimes(73);
    expect(waiting.sleep).toHaveBeenCalledTimes(72);
    expect(
      vi
        .mocked(waiting.sleep)
        .mock.calls.slice(0, 10)
        .every(([, delay]) => delay === "1 minute"),
    ).toBe(true);
    expect(
      vi
        .mocked(waiting.sleep)
        .mock.calls.slice(10)
        .every(([, delay]) => delay === "1 hour"),
    ).toBe(true);
    expect(pending.build.start).toHaveBeenCalledOnce();
    const expired = ports();
    vi.mocked(expired.database.ensure)
      .mockResolvedValueOnce({ status: "verification_pending" })
      .mockResolvedValueOnce({ status: "failed", errorCode: "PAID_PLAN_REQUIRED" });
    expect(
      (await runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), expired)).status,
    ).toBe("failed");
    expect(expired.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "PAID_PLAN_REQUIRED" }),
    );
    for (const kind of ["DeploymentRequestedV1", "DeploymentPromotionRequestedV1"]) {
      const dependencies = ports(),
        durableStep = step();
      vi.mocked(dependencies.database.ensure)
        .mockResolvedValueOnce({ status: "provisioning_pending" } as never)
        .mockResolvedValueOnce({ status: "ready", receipt: null });
      expect(
        (await runProductCommandWorkflow(command(kind), durableStep, dependencies)).status,
      ).toBe("succeeded");
      expect(durableStep.sleep).toHaveBeenCalledWith(
        kind === "DeploymentRequestedV1"
          ? "wait-for-database-provisioning-1"
          : "wait-for-promotion-database-provisioning-1",
        "10 seconds",
      );
      expect(dependencies.database.ensure).toHaveBeenCalledTimes(2);
      expect(dependencies.build.start).toHaveBeenCalledTimes(
        kind === "DeploymentRequestedV1" ? 1 : 0,
      );
      expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    }
    const stillProvisioning = ports(),
      provisionWait = step();
    vi.mocked(stillProvisioning.database.ensure).mockResolvedValue({
      status: "provisioning_pending",
    } as never);
    expect(
      (
        await runProductCommandWorkflow(
          command("DeploymentRequestedV1"),
          provisionWait,
          stillProvisioning,
        )
      ).status,
    ).toBe("reconciliation_required");
    expect(stillProvisioning.database.ensure).toHaveBeenCalledTimes(19);
    expect(provisionWait.sleep).toHaveBeenCalledTimes(18);
  });

  it("terminalizes a permanent database migration failure without WFP mutation", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.database.ensure).mockResolvedValueOnce({
      status: "failed",
      errorCode: "DATABASE_MIGRATION_FAILED",
      migration: { reason: "ledger_conflict", path: "20260928090000_add_flag.sql" },
    } as never);

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });
    expect(dependencies.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "DATABASE_MIGRATION_FAILED",
        migration: { reason: "ledger_conflict", path: "20260928090000_add_flag.sql" },
      }),
    );
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    expect(dependencies.wfp.stage).not.toHaveBeenCalled();
  });

  it("terminalizes a definitive provider build failure instead of requiring reconciliation", async () => {
    const dependencies = ports();
    const failure = { excerpt: "npm ERR! missing script: build", truncated: false };
    vi.mocked(dependencies.build.observe).mockResolvedValueOnce({
      status: "failed",
      errorCode: "BUILD_FAILED",
      failure,
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });
    expect(dependencies.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "BUILD_FAILED", failure }),
    );
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    expect(dependencies.database.ensure).not.toHaveBeenCalled();
    expect(dependencies.wfp.stage).not.toHaveBeenCalled();
  });

  it("terminalizes an observed absent build start without source replay", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.build.start).mockResolvedValueOnce({
      status: "failed",
      errorCode: "BUILD_NOT_STARTED",
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });
    expect(dependencies.build.observe).not.toHaveBeenCalled();
    expect(dependencies.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "BUILD_NOT_STARTED" }),
    );
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  it("keeps thrown build uncertainty retryable long enough to cross the reservation lease", async () => {
    const dependencies = ports();
    const uncertainty = new Error("build_broker_result_uncertain");
    vi.mocked(dependencies.build.start)
      .mockRejectedValueOnce(uncertainty)
      .mockRejectedValueOnce(uncertainty)
      .mockRejectedValueOnce(uncertainty);
    const retryDelays = [5_000, 10_000, 20_000] as const;
    let elapsedMilliseconds = 0;
    const durableStep: ProductWorkflowStepPort = {
      sleep: vi.fn(async () => undefined),
      do: async (name, config, run) => {
        if (name !== "start-isolated-build") return run();
        expect(config).toBe(PRODUCT_WORKFLOW_STEP_CONFIG);
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await run();
          } catch (error) {
            const delay = retryDelays[attempt];
            if (delay === undefined) throw error;
            elapsedMilliseconds += delay;
          }
        }
      },
    };

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), durableStep, dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(dependencies.build.start).toHaveBeenCalledTimes(4);
    expect(elapsedMilliseconds).toBe(35_000);
    expect(elapsedMilliseconds).toBeGreaterThan(30_000);
    expect(elapsedMilliseconds).toBeLessThan(4 * 60_000);
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  it("waits for a running isolated build before reading and publishing its artifact", async () => {
    const dependencies = ports();
    const durableStep = step();
    vi.mocked(dependencies.build.observe)
      .mockResolvedValueOnce({ status: "running" } as never)
      .mockResolvedValueOnce({ status: "running" } as never);

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), durableStep, dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(dependencies.build.observe).toHaveBeenCalledTimes(3);
    expect(PRODUCT_BUILD_OBSERVATION_STEP_CONFIG.timeout).toBe("15 minutes");
    expect(durableStep.sleep).toHaveBeenNthCalledWith(1, "wait-for-build-1", "10 seconds");
    expect(durableStep.sleep).toHaveBeenNthCalledWith(2, "wait-for-build-2", "10 seconds");
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  it("bounds running-build observation before requiring reconciliation", async () => {
    const dependencies = ports();
    const durableStep = step();
    vi.mocked(dependencies.build.observe).mockResolvedValue({ status: "running" } as never);

    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), durableStep, dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });
    expect(dependencies.build.observe).toHaveBeenCalledTimes(78);
    expect(durableStep.sleep).toHaveBeenCalledTimes(77);
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it("rolls back by immutable artifact without source or build work", async () => {
    const dependencies = ports();
    await expect(
      runProductCommandWorkflow(command("DeploymentRollbackRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(dependencies.source.fetchExactArchive).not.toHaveBeenCalled();
    expect(dependencies.build.start).not.toHaveBeenCalled();
    expect(dependencies.build.observe).not.toHaveBeenCalled();
    expect(dependencies.wfp.prepareRollback).toHaveBeenCalledOnce();
    expect(dependencies.wfp.activate).toHaveBeenCalledOnce();
    expect(dependencies.wfp.stage).not.toHaveBeenCalled();
    expect(
      vi.mocked(dependencies.wfp.recordActivatedCandidate).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(dependencies.persistence.finalizeRollback).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("promotes the persisted Dev artifact after preparing Prod resources without source or build work", async () => {
    const dependencies = ports();

    await expect(
      runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });

    expect(dependencies.wfp.stage).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "DeploymentPromotionRequestedV1" }),
      undefined,
    );
    expect(dependencies.persistence.finalizeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          buildReused: true,
          artifactDigest: "sha256:artifact-a",
          wfp: "candidate-1",
          gateway: "gateway-1",
        }),
      }),
    );
    expect(dependencies.source.observeLink).not.toHaveBeenCalled();
    expect(dependencies.source.fetchExactArchive).not.toHaveBeenCalled();
    expect(dependencies.build.start).not.toHaveBeenCalled();
    expect(dependencies.build.observe).not.toHaveBeenCalled();
    expect(dependencies.database.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "DeploymentPromotionRequestedV1" }),
    );
    expect(dependencies.wfp.tombstone).not.toHaveBeenCalled();
    expect(dependencies.wfp.cleanupInventory).not.toHaveBeenCalled();
    expect(dependencies.wfp.observeRoute404).not.toHaveBeenCalled();
    expect(dependencies.wfp.finalizeRemoval).not.toHaveBeenCalled();

    const failed = ports();
    vi.mocked(failed.database.ensure).mockResolvedValueOnce({
      status: "failed",
      errorCode: "DATABASE_MIGRATION_FAILED",
    });
    await expect(
      runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), failed),
    ).resolves.toEqual({ status: "failed", persistence: "applied" });
    expect(failed.persistence.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ eventType: "DeploymentPromotionRequestedV1" }),
        errorCode: "DATABASE_MIGRATION_FAILED",
      }),
    );
    expect(failed.wfp.stage).not.toHaveBeenCalled();
    expect(failed.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  // A promotion accepted while a Dev deployment still ran lost its exact context once that
  // deployment moved the Dev head, and ended in reconciliation or abandonment, never in a failure
  // naming the moved head. It now ends typed before any cleanup, claim or provider work.
  it.each([
    ["source", "PROMOTION_SOURCE_STALE"],
    ["target", "PROMOTION_TARGET_STALE"],
  ] as const)(
    "fails a promotion whose %s head moved before any provider work",
    async (moved, code) => {
      const dependencies = ports();
      vi.mocked(dependencies.persistence.readPromotionStaleness).mockResolvedValueOnce(moved);

      await expect(
        runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), dependencies),
      ).resolves.toEqual({ status: "failed", persistence: "applied" });
      expect(dependencies.persistence.fail).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({ eventType: "DeploymentPromotionRequestedV1" }),
          errorCode: code,
        }),
      );
      expect(dependencies.persistence.claimCandidateCleanup).not.toHaveBeenCalled();
      expect(dependencies.database.ensure).not.toHaveBeenCalled();
      expect(dependencies.wfp.stage).not.toHaveBeenCalled();
      expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
    },
  );

  it("requires WFP reconciliation with the exact promotion hint after promotion uncertainty", async () => {
    const dependencies = ports();
    const providerHint = {
      phase: "wfp" as const,
      expectedArtifactDigest: "sha256:artifact-a",
      currentProviderTag: "promotion-provider-tag",
      currentProductDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    };
    vi.mocked(dependencies.wfp.stage).mockResolvedValueOnce({
      status: "uncertain",
      providerHint,
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ providerHint }),
    );
    expect(dependencies.wfp.activate).not.toHaveBeenCalled();
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it("preserves an exact storage reconciliation hint during promotion", async () => {
    const dependencies = ports();
    const providerHint = {
      phase: "storage" as const,
      expectedArtifactDigest: "sha256:artifact-a",
      currentProviderTag: "r2-promotion-receipt",
      currentProductDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    };
    vi.mocked(dependencies.wfp.stage).mockResolvedValueOnce({
      status: "uncertain",
      providerHint,
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ providerHint }),
    );
    expect(dependencies.database.ensure).toHaveBeenCalledOnce();
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it("requires WFP reconciliation with the promotion artifact digest after observation uncertainty", async () => {
    const dependencies = ports();
    const gatewayHint = {
      phase: "gateway" as const,
      expectedArtifactDigest: "sha256:artifact-a",
      currentProviderTag: null,
      currentProductDeploymentId: null,
    };
    vi.mocked(dependencies.wfp.activate).mockResolvedValueOnce({
      status: "uncertain",
      providerHint: gatewayHint,
    });
    vi.mocked(dependencies.wfp.observeActivation).mockResolvedValueOnce({
      status: "uncertain",
      providerHint: gatewayHint,
    });

    await expect(
      runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerHint: gatewayHint,
      }),
    );
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it("classifies a thrown promotion outcome as WFP uncertainty after Prod resource preparation", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.stage).mockRejectedValueOnce(new Error("response lost"));

    await expect(
      runProductCommandWorkflow(command("DeploymentPromotionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });

    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerHint: {
          phase: "wfp",
          expectedArtifactDigest: null,
          currentProviderTag: null,
          currentProductDeploymentId: null,
        },
      }),
    );
    expect(dependencies.source.fetchExactArchive).not.toHaveBeenCalled();
    expect(dependencies.build.start).not.toHaveBeenCalled();
    expect(dependencies.database.ensure).toHaveBeenCalledOnce();
  });

  it("observes uncertain rollback and restores the previous gateway on unhealthy or conflicting outcomes", async () => {
    for (const outcome of ["observed", "unhealthy", "conflict"] as const) {
      const dependencies = ports();
      const activation = {
        status: "activated" as const,
        candidateReceipt: "rollback-candidate-1",
        gateway: "rollback-gateway",
        deploymentUrl: "https://example.test/p/project",
      };
      let restores = 0;
      const wfp = {
        ...dependencies.wfp,
        async activate() {
          return outcome === "observed"
            ? {
                status: "uncertain" as const,
                providerHint: {
                  phase: "gateway" as const,
                  expectedArtifactDigest: "sha256:artifact-rollback",
                  currentProviderTag: null,
                  currentProductDeploymentId: null,
                },
              }
            : outcome === "unhealthy"
              ? {
                  ...activation,
                  status: "unhealthy" as const,
                  health: { status: 500, path: "/", excerpt: null, truncated: false },
                }
              : { ...activation, status: "activated" as const };
        },
        async observeActivation() {
          return activation;
        },
        async restoreGateway() {
          restores += 1;
          return { status: "restored" as const, gateway: "gateway-1" };
        },
      };
      const persistence = {
        ...dependencies.persistence,
        async finalizeRollback() {
          return outcome === "conflict" ? ("conflict" as const) : ("applied" as const);
        },
      };
      const result = await runProductCommandWorkflow(
        command("DeploymentRollbackRequestedV1"),
        step(),
        { ...dependencies, wfp, persistence },
      );
      // An unhealthy rollback candidate is a verdict on the customer's application and the previous
      // gateway is back, so it fails and names the cause. Only a conflicting provider outcome is
      // genuinely uncertain and still belongs to an operator.
      expect(result).toEqual(
        outcome === "observed"
          ? { status: "succeeded", persistence: "applied" }
          : outcome === "unhealthy"
            ? { status: "failed", persistence: "applied" }
            : { status: "reconciliation_required" },
      );
      expect(restores).toBe(outcome === "observed" ? 0 : 1);
      expect(dependencies.persistence.recordHealthFailure).toHaveBeenCalledTimes(
        outcome === "unhealthy" ? 1 : 0,
      );
      expect(dependencies.build.start).not.toHaveBeenCalled();
      expect(dependencies.wfp.stage).not.toHaveBeenCalled();
    }
  });

  it("removes project function schedules before any provider deletion", async () => {
    const dependencies = ports();
    await runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), step(), dependencies);
    expect(dependencies.schedules.remove).toHaveBeenCalledOnce();
    expect(vi.mocked(dependencies.schedules.remove).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.wfp.tombstone).mock.invocationCallOrder[0] ?? 0,
    );
  });

  // A cleanup request left by an abandoned deployment (the leftover Sebmer drained in operation
  // 01M3GHSSBVVWZFYBHXNYHKBN0Z) cannot be drained on a deleting project: its claim authorizes a
  // removal only while the project is active, so every retry went to reconciliation before the
  // tombstone. The tombstone removes each uncleaned candidate under the deletion's own authority.
  it("deletes a project past a leftover candidate cleanup without draining it", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.persistence.claimCandidateCleanup).mockResolvedValue({
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
      candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
      cleanupReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
      candidate: {
        candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FC6",
        receipt: "abandoned-candidate-1",
        previousGateway: null,
        runtimePolicy: "runtime-policy-abandoned",
        runtimeSecretDeliveryStage: null,
        deploymentUrl: "https://example.test/p/project",
        artifactDigest: "sha256:artifact-abandoned",
      },
      supersededById: null,
      expectedResources: [],
    });
    vi.mocked(dependencies.wfp.removeClaimedCandidate).mockRejectedValue(
      new Error("WFP management input is invalid"),
    );

    await expect(
      runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(dependencies.persistence.claimCandidateCleanup).not.toHaveBeenCalled();
    expect(dependencies.wfp.removeClaimedCandidate).not.toHaveBeenCalled();
    expect(dependencies.wfp.tombstone).toHaveBeenCalledOnce();
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  it("replays schedule removal on a repeated deletion", async () => {
    const dependencies = ports();
    await runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), step(), dependencies);
    await runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), step(), dependencies);
    expect(dependencies.schedules.remove).toHaveBeenCalledTimes(2);
  });

  it("retains deletion tombstone and reconciliation until cleanup and sustained 404 are proven", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.cleanupInventory).mockResolvedValue({
      status: "observed",
      inventoryClean: false,
    });
    vi.mocked(dependencies.wfp.observeRoute404).mockResolvedValue({
      status: "observed",
      consecutive404s: 2,
    });
    await expect(
      runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required", tombstoneRetained: true });
    expect(dependencies.persistence.retainDeletionTombstone).toHaveBeenCalledOnce();
    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledOnce();
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it("completes deletion only after the durable tombstone delay, final removal, and post-delete 404s", async () => {
    const dependencies = ports();
    const stepNames: string[] = [];
    const durableStep: ProductWorkflowStepPort = {
      do: async (name, _config, run) => {
        stepNames.push(name);
        return run();
      },
      sleep: vi.fn(async () => undefined),
    };
    await expect(
      runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), durableStep, dependencies),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(stepNames).toEqual([
      "remove-project-function-schedules",
      "publish-deletion-tombstone",
      "retain-deletion-tombstone",
      "cleanup-run-inventory",
      "observe-sustained-route-404",
      "finalize-deletion-tombstone",
      "persist-product-command-completion",
    ]);
    expect(dependencies.persistence.retainDeletionTombstone).toHaveBeenCalledOnce();
    expect(dependencies.persistence.complete).toHaveBeenCalledOnce();
    expect(dependencies.wfp.tombstone).toHaveBeenCalledOnce();
    expect(durableStep.sleep).toHaveBeenCalledWith("wait-for-tombstone-propagation", "10 minutes");
    expect(dependencies.wfp.finalizeRemoval).toHaveBeenCalledOnce();
    expect(dependencies.persistence.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: {
          tombstoneReceiptId: "tombstone-1",
          inventoryClean: true,
          consecutive404s: 3,
          gatewayAbsence: "gateway-absence-1",
        },
      }),
    );
  });

  it("keeps the tombstone and requires reconciliation when final removal is uncertain", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.wfp.finalizeRemoval).mockResolvedValue({ status: "uncertain" });

    await expect(
      runProductCommandWorkflow(command("ProjectDeletionRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required", tombstoneRetained: true });
    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledOnce();
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it.each([
    [
      "source",
      () => ({
        ...ports(),
        source: {
          ...ports().source,
          fetchExactArchive: vi.fn(async () => ({ status: "uncertain" as const })),
        },
      }),
    ],
    [
      "build",
      () => ({
        ...ports(),
        build: { ...ports().build, observe: vi.fn(async () => ({ status: "uncertain" as const })) },
      }),
    ],
    [
      "candidate staging",
      () => ({
        ...ports(),
        wfp: {
          ...ports().wfp,
          stage: vi.fn(async () => ({
            status: "uncertain" as const,
            providerHint: {
              phase: "wfp" as const,
              expectedArtifactDigest: "sha256:artifact-a",
              currentProviderTag: "provider-a",
              currentProductDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
            },
          })),
        },
      }),
    ],
    [
      "activation observation",
      () => ({
        ...ports(),
        wfp: {
          ...ports().wfp,
          activate: vi.fn(async () => ({
            status: "uncertain" as const,
            providerHint: {
              phase: "gateway" as const,
              expectedArtifactDigest: "sha256:artifact-a",
              currentProviderTag: null,
              currentProductDeploymentId: null,
            },
          })),
          observeActivation: vi.fn(async () => ({
            status: "uncertain" as const,
            providerHint: {
              phase: "gateway" as const,
              expectedArtifactDigest: "sha256:artifact-a",
              currentProviderTag: null,
              currentProductDeploymentId: null,
            },
          })),
        },
      }),
    ],
  ])("never declares deployment success after %s uncertainty", async (_name, factory) => {
    const dependencies = factory();
    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), dependencies),
    ).resolves.toEqual({ status: "reconciliation_required" });
    expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledOnce();
    expect(dependencies.persistence.complete).not.toHaveBeenCalled();
  });

  it("durably requires reconciliation when a provider step throws", async () => {
    for (const eventType of [
      "DeploymentRequestedV1",
      "SourceLinkRequestedV1",
      "ProjectDeletionRequestedV1",
    ] as const) {
      const dependencies = ports();
      vi.mocked(dependencies.source.fetchExactArchive).mockRejectedValue(new Error("redacted"));
      vi.mocked(dependencies.source.observeLink).mockRejectedValue(new Error("redacted"));
      vi.mocked(dependencies.wfp.tombstone).mockRejectedValue(
        new Error("WFP management input is invalid"),
      );
      await expect(
        runProductCommandWorkflow(command(eventType), step(), dependencies),
      ).resolves.toEqual({ status: "reconciliation_required" });
      expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledOnce();
      expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledWith(
        expect.objectContaining({
          providerHint:
            eventType === "DeploymentRequestedV1"
              ? expect.objectContaining({ phase: "source" })
              : null,
        }),
      );
      expect(dependencies.persistence.complete).not.toHaveBeenCalled();
    }
  });

  it("does not hide a persistence failure behind reconciliation", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.persistence.complete).mockRejectedValue(new Error("database failed"));
    await expect(
      runProductCommandWorkflow(command("SourceLinkRequestedV1"), step(), dependencies),
    ).rejects.toThrow("database failed");
    expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Workflow instance identity", async () => {
    await expect(
      runProductCommandWorkflow(command("DeploymentRequestedV1"), step(), ports(), "wrong"),
    ).rejects.toThrow("instance ID");
  });
});

describe("project address change", () => {
  const rename = () => command("ProjectHandleChangeRequestedV1");

  it("moves every published gateway before it stores the address", async () => {
    const workflowPorts = ports();
    const result = await runProductCommandWorkflow(rename(), step(), workflowPorts);

    expect(result).toEqual({ status: "succeeded", persistence: "applied" });
    // Both environments move, Dev first, and each is asked for its own address.
    expect(workflowPorts.wfp.moveGatewayAddress).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(workflowPorts.wfp.moveGatewayAddress)
        .mock.calls.map(([, environment]) => environment.environmentName),
    ).toEqual(["dev", "prod"]);
    expect(workflowPorts.persistence.finalizeHandleChange).toHaveBeenCalledWith(
      expect.objectContaining({
        moved: [
          { environmentId: base.environmentId, publicOrigin: "https://dev-acme-shop.check.omh.st" },
          {
            environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
            publicOrigin: "https://acme-shop.check.omh.st",
          },
        ],
      }),
    );
  });

  it("never stores the address when a gateway did not move", async () => {
    const workflowPorts = ports();
    type MoveResult = Awaited<ReturnType<ProductCommandWorkflowPorts["wfp"]["moveGatewayAddress"]>>;
    const stuckProd = async (
      _command: Parameters<ProductCommandWorkflowPorts["wfp"]["moveGatewayAddress"]>[0],
      environment: Parameters<ProductCommandWorkflowPorts["wfp"]["moveGatewayAddress"]>[1],
    ): Promise<MoveResult> => {
      if (environment.environmentName === "prod") {
        return {
          status: "uncertain",
          providerHint: {
            phase: "wfp",
            expectedArtifactDigest: null,
            currentProviderTag: null,
            currentProductDeploymentId: null,
          },
        };
      }
      return { status: "moved", publicOrigin: "https://dev-acme-shop.check.omh.st", gateway: {} };
    };
    workflowPorts.wfp.moveGatewayAddress = vi.fn(stuckProd);

    const result = await runProductCommandWorkflow(rename(), step(), workflowPorts);

    expect(result).toEqual({ status: "reconciliation_required" });
    expect(workflowPorts.persistence.finalizeHandleChange).not.toHaveBeenCalled();
    expect(workflowPorts.persistence.requireReconciliation).toHaveBeenCalled();
  });

  it("ends the rename when the address was taken while the gateways moved", async () => {
    const workflowPorts = ports();
    workflowPorts.persistence.finalizeHandleChange = vi.fn(async () => ({
      status: "conflict" as const,
      reason: "taken" as const,
    }));

    const result = await runProductCommandWorkflow(rename(), step(), workflowPorts);

    expect(result).toEqual({ status: "failed", persistence: "applied" });
    // The Control transaction compensated both routes before reporting the taken address.
    expect(
      vi
        .mocked(workflowPorts.wfp.moveGatewayAddress)
        .mock.calls.map(([, environment, handle]) => `${environment.environmentName}:${handle}`),
    ).toEqual(["dev:acme-shop", "prod:acme-shop"]);
    expect(workflowPorts.persistence.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: { requestedHandle: "acme-shop", outcome: "project_handle_taken" },
      }),
    );
  });

  it("retries the workflow when transactional route compensation is uncertain", async () => {
    const workflowPorts = ports();
    workflowPorts.persistence.finalizeHandleChange = vi.fn(async () => {
      throw new Error("rename compensation uncertain");
    });

    await expect(runProductCommandWorkflow(rename(), step(), workflowPorts)).rejects.toThrow(
      "rename compensation uncertain",
    );
    expect(workflowPorts.persistence.complete).not.toHaveBeenCalled();
    expect(workflowPorts.persistence.requireReconciliation).not.toHaveBeenCalled();
  });
});

it("terminally rejects the exact authorization error serialized by a real Workflow step over RPC", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { Miniflare } = createRequire(require.resolve("../../control-store/package.json"))(
    "miniflare",
  ) as {
    Miniflare: new (options: unknown) => {
      getWorker(
        name: string,
      ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
      dispose(): Promise<void>;
    };
  };
  const harness = new Miniflare({
    workers: [
      {
        name: "denied",
        modules: true,
        compatibilityDate: "2026-08-06",
        script: `import{WorkerEntrypoint}from"cloudflare:workers";
        class CommandConflictError extends Error{constructor(code,message){super(message);this.code=code;}}
        export class Denied extends WorkerEntrypoint{fail(){const error=new CommandConflictError("operation_authorization_changed","Queued operation authorization or source generation changed");error.name="OperationAuthorizationConflictError";throw error;}}
        export default{};`,
      },
      {
        name: "workflow",
        modules: true,
        compatibilityDate: "2026-08-06",
        workflows: {
          AUTH: { name: "native-authorization-regression", className: "AuthorizationWorkflow" },
        },
        serviceBindings: { DENIED: { name: "denied", entrypoint: "Denied" } },
        script: `import{WorkflowEntrypoint}from"cloudflare:workers";
        export class AuthorizationWorkflow extends WorkflowEntrypoint{async run(event,step){try{await step.do("denied",{retries:{limit:0,delay:"1 second"},timeout:"10 seconds"},()=>this.env.DENIED.fail());return{unexpected:true};}catch(error){return{name:error.name,message:error.message};}}}
        export default{async fetch(request,env){if(request.method==="POST"){await env.AUTH.create({id:"native-denial",params:{}});return Response.json({created:true});}return Response.json(await(await env.AUTH.get("native-denial")).status());}};`,
      },
    ],
  });
  try {
    const worker = await harness.getWorker("workflow");
    await worker.fetch("https://workflow.internal/", { method: "POST" });
    let observed: { status?: string; output?: { name: string; message: string } } = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      observed = (await (
        await worker.fetch("https://workflow.internal/")
      ).json()) as typeof observed;
      if (observed.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(observed.output).toEqual({
      name: "Error",
      message:
        "OperationAuthorizationConflictError: Queued operation authorization or source generation changed",
    });
    const denied = Object.assign(new Error(observed.output?.message), {
      name: observed.output?.name,
    });
    for (const eventType of [
      "DeploymentRequestedV1",
      "DeploymentRollbackRequestedV1",
      "DeploymentPromotionRequestedV1",
    ]) {
      const dependencies = ports();
      const rejected = vi.fn(async () => ({
        status: "failed" as const,
        persistence: "applied" as const,
      }));
      dependencies.persistence.rejectAuthorization = rejected;
      if (eventType === "DeploymentRequestedV1")
        vi.mocked(dependencies.source.fetchExactArchive).mockRejectedValue(denied);
      else if (eventType === "DeploymentRollbackRequestedV1")
        vi.mocked(dependencies.wfp.prepareRollback).mockRejectedValue(denied);
      else vi.mocked(dependencies.database.ensure).mockRejectedValue(denied);
      expect(await runProductCommandWorkflow(command(eventType), step(), dependencies)).toEqual({
        status: "failed",
        persistence: "applied",
      });
      expect(rejected).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: null, activation: null, activationAttempted: false }),
      );
      expect(dependencies.persistence.requireReconciliation).not.toHaveBeenCalled();
      expect(dependencies.wfp.activate).not.toHaveBeenCalled();
    }
    for (const message of [
      "OperationAuthorizationConflictError: another provider error",
      `prefix ${observed.output?.message}`,
      `${observed.output?.message} trailing`,
    ]) {
      const dependencies = ports();
      const rejected = vi.fn(async () => ({
        status: "failed" as const,
        persistence: "applied" as const,
      }));
      dependencies.persistence.rejectAuthorization = rejected;
      vi.mocked(dependencies.wfp.prepareRollback).mockRejectedValue(new Error(message));
      expect(
        await runProductCommandWorkflow(
          command("DeploymentRollbackRequestedV1"),
          step(),
          dependencies,
        ),
      ).toEqual({ status: "reconciliation_required" });
      expect(rejected).not.toHaveBeenCalled();
      expect(dependencies.persistence.requireReconciliation).toHaveBeenCalledOnce();
    }
  } finally {
    await harness.dispose();
  }
}, 30_000);
