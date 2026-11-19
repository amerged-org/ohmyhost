import { WFP_DISPATCH_LIMITS } from "@ohmyhost/contracts/wfp-dispatch";
import { parseSharedGatewayReceipt } from "@ohmyhost/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPolicyOutboundWorker } from "../../wfp-dispatch/src/outbound.js";
import { workerBindings } from "./worker-fixtures.js";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));

// The action runner is the seam behind which Workers for Platforms is reached; these tests pin
// what the private RPC surface accepts, forwards and returns around it.
const invokeWfp = vi.hoisted(() =>
  vi.fn(async (event: unknown): Promise<unknown> => {
    void event;
    return undefined;
  }),
);

vi.mock("../src/wfp-actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/wfp-actions.js")>()),
  createWfpActionRunner: () => invokeWfp,
}));

const dispatchFetch = vi.fn(async (request: Request) => {
  void request;
  return new Response(null, { status: 204 });
});
const probeRequests: unknown[] = [];
let probeAvailable = true;
const bindings = workerBindings({
  WFP_DISPATCH: { get: vi.fn(() => ({ fetch: dispatchFetch })) },
  RUNTIME_PROBES: {
    async beginProbe(input: unknown) {
      if (!probeAvailable) throw new Error("Runtime probe accounting is unavailable");
      probeRequests.push(input);
      return { expiresAt: new Date(Date.now() + 180000).toISOString() };
    },
  },
}) as ReturnType<typeof workerBindings> & {
  WFP_DISPATCH: { get: ReturnType<typeof vi.fn> };
};

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROD_ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const DEPLOYMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const OPERATION = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const DATABASE_REGISTRATION = Object.freeze({
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  physicalEnvironmentId: ENVIRONMENT,
  registrationVersion: 1,
  region: "us" as const,
  provider: "pgcf" as const,
  providerProjectId: "pgcf-project",
  databaseId: "a".repeat(20),
  originHost: "sql.pgcf.example",
  originDatabase: "a".repeat(20),
  originUser: `ohmyho_rw_${ENVIRONMENT.toLowerCase()}`,
  authorizedEnvironmentIds: [ENVIRONMENT, PROD_ENVIRONMENT],
  status: "active" as const,
});
const STORAGE_BUCKET = `ohmyho-${PROJECT.toLowerCase()}-${ENVIRONMENT.toLowerCase()}`;
const GATEWAY_OBSERVED_AT = new Date("2026-08-21T12:00:00.000Z");
const mutationContext = {
  organizationId: ORGANIZATION,
  operationId: OPERATION,
  claimId: OPERATION,
};
const activationContext = {
  operationId: OPERATION,
  claimId: OPERATION,
  candidateReceiptId: OPERATION,
};
const gatewayReceipt = parseSharedGatewayReceipt({
  provider: "ohmyhost-shared-gateway",
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  environmentName: "dev",
  handle: "calm-river-studio",
  hostname: "dev-calm-river-studio.dev.check.omh.st",
  publicOrigin: "https://dev-calm-river-studio.dev.check.omh.st",
  targetScriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
  targetDeploymentId: DEPLOYMENT,
  targetArtifactDigest: `sha256:${"3".repeat(64)}`,
  targetProviderTag: "44e2244f9dec426aa7330ba66b44ebf0",
  egressPolicyDigest: `sha256:${"e".repeat(64)}`,
  egressAllowedOrigins: [],
  candidateReceiptId: OPERATION,
  operationId: OPERATION,
  revision: 1,
  predecessorRevision: null,
  active: true,
  observedAt: GATEWAY_OBSERVED_AT,
});
const removedGateway = parseSharedGatewayReceipt({
  ...gatewayReceipt,
  active: false,
  revision: 2,
  predecessorRevision: 1,
});

function candidateReceipt() {
  return {
    provider: "cloudflare-wfp" as const,
    namespace: "ohmyho-sandbox",
    scriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    productDeploymentId: DEPLOYMENT,
    providerTag: "44e2244f9dec426aa7330ba66b44ebf0",
    artifactDigest: `sha256:${"3".repeat(64)}` as const,
    buildReused: false,
    deployedAt: new Date("2026-08-21T12:00:00.000Z"),
  };
}

const runtimeSecretManifest = async () => {
  const { createRuntimeSecretManifest } = await import("@ohmyhost/provider-cloudflare");
  const value = "runtime-only-secret";
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return createRuntimeSecretManifest([
    {
      name: "API_TOKEN",
      value,
      revision: 1,
      valueSha256: `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    },
  ]);
};

describe("WFP management Worker entrypoints", () => {
  beforeEach(() => {
    probeRequests.length = 0;
    probeAvailable = true;
    invokeWfp.mockClear();
    invokeWfp.mockImplementation(async (raw) => {
      const event = raw as { action: string; input: Record<string, unknown> };
      const candidate = candidateReceipt();
      if (event.action === "stage-candidate") {
        return {
          status: "staged",
          candidate,
          priorGateway: gatewayReceipt,
          activationRuntimePolicy: {
            healthCheckPath: "/",
            egressAllowedOrigins: ["https://api.example.test"],
          },
          deploymentUrl: gatewayReceipt.publicOrigin,
          runtimeSecretManifestDigest: `sha256:${"5".repeat(64)}`,
        };
      }
      if (event.action === "activate-candidate") {
        return {
          status: "activated",
          candidate,
          gateway: gatewayReceipt,
          deploymentUrl: gatewayReceipt.publicOrigin,
        };
      }
      if (event.action === "observe-activation") {
        return {
          status: "observed",
          candidate,
          gateway: gatewayReceipt,
          deploymentUrl: gatewayReceipt.publicOrigin,
        };
      }
      if (event.action === "compensate-gateway-activation") {
        return { status: "compensated", gateway: removedGateway, candidateRetained: true };
      }
      if (event.action === "compensate-activation") {
        return {
          status: "compensated",
          gateway: removedGateway,
          candidate: {
            state: "metadata_absent",
            namespace: candidate.namespace,
            scriptName: candidate.scriptName,
            projectId: candidate.projectId,
            environmentId: candidate.environmentId,
            expectedProviderTag: candidate.providerTag,
            observedAt: candidate.deployedAt,
          },
        };
      }
      if (event.action === "observe-candidate") {
        return {
          state: "ready",
          scriptName: candidate.scriptName,
          providerTag: candidate.providerTag,
          productDeploymentId: candidate.productDeploymentId,
          artifactDigest: candidate.artifactDigest,
          observedAt: candidate.deployedAt,
        };
      }
      if (event.action === "finalize-removal") {
        return {
          status: "removed",
          metadata: {
            state: "metadata_absent",
            namespace: candidate.namespace,
            scriptName: candidate.scriptName,
            projectId: candidate.projectId,
            environmentId: candidate.environmentId,
            expectedProviderTag: candidate.providerTag,
            observedAt: candidate.deployedAt,
          },
          gateway: removedGateway,
          consecutive404s: 3,
        };
      }
      if (event.action === "sync-secrets") {
        const input = event.input;
        const deployment = input["expectedDeployment"] as typeof candidate;
        const manifest = input["runtimeSecretManifest"] as { digest: string; secrets: unknown[] };
        return {
          status: "synchronized",
          receipt: {
            provider: "cloudflare-wfp",
            namespace: deployment.namespace,
            scriptName: deployment.scriptName,
            projectId: deployment.projectId,
            environmentId: deployment.environmentId,
            manifestDigest: manifest.digest,
            secretNames: [],
            providerTag: "55e2244f9dec426aa7330ba66b44ebf0",
            observedAt: GATEWAY_OBSERVED_AT,
          },
        };
      }
      throw new Error("unexpected_action");
    });
    dispatchFetch.mockClear();
    workerState.env = bindings;
  });

  it("keeps the default fetch entrypoint private", async () => {
    const { default: worker } = await import("../src/worker-main.js");
    await expect(worker.fetch()).resolves.toMatchObject({ status: 404 });
  });

  it("exposes only narrow named RPC methods backed by exact runtime bindings", async () => {
    const { WfpManagementService, createWfpManagementRuntime } = await import(
      "../src/worker-main.js"
    );
    expect(Object.keys(createWfpManagementRuntime(bindings))).toEqual([
      "stageVerifiedArtifact",
      "activateCandidate",
      "observeActivation",
      "compensateActivation",
      "compensateGatewayActivation",
      "prepareExistingCandidate",
      "removeCandidate",
      "observeCandidate",
      "syncRuntimeSecrets",
      "finalizeRemoval",
    ]);
    const service = new WfpManagementService({} as never, bindings as never);
    const invalid = {
      scope: { projectId: "bad", environmentId: "bad" },
      deploymentId: "bad",
      artifact: {
        manifestDigest: "sha256:bad",
        manifestBody: new Uint8Array(),
        sbomBody: new Uint8Array(),
        files: [],
      },
      knownDeployments: [],
    };
    await expect(service.stageVerifiedArtifact(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.prepareExistingCandidate(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.prepareExistingCandidate(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.observeCandidate(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.observeCandidate(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.syncRuntimeSecrets(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.removeCandidate(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    await expect(service.finalizeRemoval(invalid as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    expect(invokeWfp).not.toHaveBeenCalled();
  });

  it("asks Core to authorize the exact runtime-secret names and revisions before a provider action", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    const manifest = await runtimeSecretManifest();
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const candidate = candidateReceipt();
    const authorized = {
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      secrets: [{ name: "API_TOKEN", revision: 1 }],
    };

    await service.syncRuntimeSecrets({
      organizationId: ORGANIZATION,
      scope,
      expectedDeployment: candidate,
      runtimeSecretManifest: manifest,
    });
    expect(bindings.RUNTIME_SECRET_AUTHORITY.authorizeManifest).toHaveBeenLastCalledWith(
      authorized,
    );
    expect(invokeWfp).toHaveBeenLastCalledWith({
      action: "sync-secrets",
      input: { scope, expectedDeployment: candidate, runtimeSecretManifest: manifest },
    });
  });

  it("refuses a manifest that Core does not authorize, before either provider action", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const refusedAuthority = {
      authorizeManifest: vi.fn(async () => {
        throw Object.assign(new Error("runtime_secret_manifest"), {
          code: "runtime_secret_manifest",
        });
      }),
    };
    workerState.env = { ...bindings, RUNTIME_SECRET_AUTHORITY: refusedAuthority };
    const service = new WfpManagementService({} as never, workerState.env as never);
    const manifest = await runtimeSecretManifest();
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const candidate = candidateReceipt();
    invokeWfp.mockClear();

    await expect(
      service.syncRuntimeSecrets({
        organizationId: ORGANIZATION,
        scope,
        expectedDeployment: candidate,
        runtimeSecretManifest: manifest,
      }),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    await expect(
      service.prepareExistingCandidate({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope,
        candidate,
        artifact: { provenance: {} },
        runtimeSecretManifest: manifest,
      } as never),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    expect(refusedAuthority.authorizeManifest).toHaveBeenCalledTimes(2);
    expect(invokeWfp).not.toHaveBeenCalled();
  });

  it("passes only strict provenance and runtime-secret manifest data to the action runner", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    const artifact = {
      manifestDigest: `sha256:${"9".repeat(64)}`,
      manifestBody: new Uint8Array([1, 2, 3]),
      sbomBody: new Uint8Array([4, 5, 6]),
      files: [{ path: "/index.html", body: new Uint8Array([7, 8, 9]) }],
      provenance: {
        scope: { projectId: PROJECT, environmentId: ENVIRONMENT, operationId: OPERATION },
        deploymentId: DEPLOYMENT,
        buildId: "ohmyho-sandbox:build-1",
        sourceCommit: "c".repeat(40),
        sourceDigest: `sha256:${"1".repeat(64)}`,
        buildPlanDigest: `sha256:${"2".repeat(64)}`,
        artifactDigest: `sha256:${"3".repeat(64)}`,
        lifecycleEvidence: {
          configurationDigest: "0".repeat(64),
          frozenInstall: {
            packageManager: "pnpm",
            packageManagerVersion: "10.28.2",
            lockfile: "pnpm-lock.yaml",
            lockfileSha256: "5".repeat(64),
            installCommandSha256: "6".repeat(64),
            dependencyInventorySha256: "7".repeat(64),
          },
          frameworkBuild: {
            framework: "vite",
            runtime: "edge",
            buildCommandSha256: "8".repeat(64),
            frameworkPlanSha256: "2".repeat(64),
            buildOutputSha256: "9".repeat(64),
          },
          buildSandbox: {
            buildId: "ohmyho-sandbox:build-1",
            projectName: "ohmyho-sandbox-build",
            buildInputFingerprint: "a".repeat(64),
            sourceArchiveSha256: "1".repeat(64),
            terminalStatus: "SUCCEEDED",
          },
          credentialScan: {
            scannerSha256: "b".repeat(64),
            rulesSha256: "c".repeat(64),
            findingsCount: 0,
          },
        },
        applicationRoot: ".",
        frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v5",
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: true, migrations: "supabase/migrations" },
        auth: { provider: "none" },
        storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false },
        output: {
          bucket: "ohmyho-builds-development",
          key: `runs/${PROJECT}/${ENVIRONMENT}/${OPERATION}/output/bundle.tar.gz`,
          versionId: "version-1",
          eTag: '"etag"',
          byteLength: 1234,
          sha256: "4".repeat(64),
        },
      },
    };

    const manifest = await runtimeSecretManifest();
    const stageInput = {
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      artifact,
      knownDeployments: [],
      previousGateway: gatewayReceipt,
      runtimeSecretManifest: manifest,
      databaseRegistration: DATABASE_REGISTRATION,
      databaseOriginHost: DATABASE_REGISTRATION.originHost,
      storageBucketName: STORAGE_BUCKET,
      storageDataEnvironmentId: ENVIRONMENT,
    };
    await service.stageVerifiedArtifact(stageInput as never);

    expect(invokeWfp).toHaveBeenCalledOnce();
    expect(invokeWfp).toHaveBeenCalledWith({
      action: "stage-candidate",
      input: {
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        artifactProvenance: artifact.provenance,
        knownDeployments: [],
        previousGateway: gatewayReceipt,
        runtimeSecretManifest: manifest,
        databaseRegistration: DATABASE_REGISTRATION,
        databaseOriginHost: DATABASE_REGISTRATION.originHost,
        storageBucketName: STORAGE_BUCKET,
        storageDataEnvironmentId: ENVIRONMENT,
      },
    });
    const serialized = JSON.stringify(invokeWfp.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("manifestBody");
    expect(serialized).not.toContain("sbomBody");
    expect(serialized).not.toContain("index.html");
    expect(serialized).toContain("runtime-only-secret");

    const browser = {
      connect: ["https://browser.example.test", "wss://browser.example.test"],
      scripts: ["https://browser.example.test"],
      styles: ["https://browser.example.test"],
      images: ["https://browser.example.test"],
      fonts: ["https://fonts.example.test"],
      frames: ["https://browser.example.test"],
      frameAncestors: ["https://client.example.test"],
      workers: { self: true, blob: false },
      cors: { origins: ["https://client.example.test"], credentials: true },
    };
    const runtimePolicy = { ...artifact.provenance.runtimePolicy, browser };
    const browserArtifact = {
      ...artifact,
      provenance: { ...artifact.provenance, runtimePolicy },
    };
    const browserStageInput = { ...stageInput, artifact: browserArtifact };
    const browserCandidate = candidateReceipt();
    const stagedResult = {
      status: "staged",
      candidate: browserCandidate,
      priorGateway: gatewayReceipt,
      activationRuntimePolicy: runtimePolicy,
      deploymentUrl: gatewayReceipt.publicOrigin,
      runtimeSecretManifestDigest: manifest.digest,
    };
    invokeWfp.mockResolvedValueOnce(stagedResult);
    const staged = await service.stageVerifiedArtifact(browserStageInput as never);
    expect(staged).toEqual(stagedResult);
    const stagedPolicy = (staged as typeof stagedResult).activationRuntimePolicy;
    expect(Object.isFrozen(stagedPolicy.browser)).toBe(true);
    expect(Object.isFrozen(stagedPolicy.browser.cors)).toBe(true);
    expect(Object.isFrozen(stagedPolicy.browser.connect)).toBe(true);

    const prepareInput = {
      artifactSourceDeploymentId: DEPLOYMENT,
      organizationId: ORGANIZATION,
      scope: stageInput.scope,
      candidate: browserCandidate,
      artifact: browserArtifact,
      runtimeSecretManifest: manifest,
      databaseRegistration: DATABASE_REGISTRATION,
      storageBucketName: STORAGE_BUCKET,
      storageDataEnvironmentId: ENVIRONMENT,
    };
    const preparedResult = {
      status: "prepared",
      candidate: browserCandidate,
      activationRuntimePolicy: runtimePolicy,
      runtimeSecretManifestDigest: manifest.digest,
    };
    invokeWfp.mockResolvedValueOnce(preparedResult);
    await expect(service.prepareExistingCandidate(prepareInput as never)).resolves.toEqual(
      preparedResult,
    );
    expect(bindings.RUNTIME_SECRET_AUTHORITY.authorizeManifest).toHaveBeenLastCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      secrets: [{ name: "API_TOKEN", revision: 1 }],
    });

    const browserGateway = parseSharedGatewayReceipt({ ...gatewayReceipt, browserPolicy: browser });
    const outdated = {
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: browserCandidate.providerTag,
      currentProductDeploymentId: browserCandidate.productDeploymentId,
      reason: "candidate_bindings_outdated",
    };
    const activationInput = {
      organizationId: ORGANIZATION,
      scope: stageInput.scope,
      candidate: browserCandidate,
      runtimePolicy,
    };
    const reconcileCalls = [
      () => service.stageVerifiedArtifact(browserStageInput as never),
      () => service.prepareExistingCandidate(prepareInput as never),
      () => service.activateCandidate({ ...activationContext, ...activationInput } as never),
      () => service.observeActivation(activationInput as never),
    ];
    dispatchFetch.mockClear();
    for (const call of reconcileCalls) {
      invokeWfp.mockResolvedValueOnce(outdated);
      await expect(call()).resolves.toEqual(outdated);
      for (const invalid of [
        { ...outdated, reason: undefined },
        { ...outdated, reason: "provider secret text" },
        { ...outdated, reconciliationPhase: "gateway" },
        { ...outdated, reconciliationPhase: "secrets" },
      ]) {
        invokeWfp.mockResolvedValueOnce(invalid);
        await expect(call()).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
      }
    }
    invokeWfp.mockResolvedValueOnce({ ...outdated, gateway: browserGateway });
    await expect(service.observeActivation(activationInput as never)).resolves.toEqual({
      ...outdated,
      gateway: browserGateway,
    });
    expect(dispatchFetch).not.toHaveBeenCalled();
    invokeWfp.mockResolvedValueOnce({ ...stagedResult, reason: outdated.reason });
    await expect(service.stageVerifiedArtifact(browserStageInput as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });
    const observedOutdated = {
      state: "unknown",
      scriptName: browserCandidate.scriptName,
      providerTag: browserCandidate.providerTag,
      productDeploymentId: browserCandidate.productDeploymentId,
      artifactDigest: browserCandidate.artifactDigest,
      observedAt: browserCandidate.deployedAt,
      reason: outdated.reason,
    };
    invokeWfp.mockResolvedValueOnce(observedOutdated);
    await expect(
      service.observeCandidate({ scope: stageInput.scope, candidate: browserCandidate } as never),
    ).resolves.toEqual(observedOutdated);
    for (const invalid of [
      { ...observedOutdated, state: "ready" },
      { ...observedOutdated, reason: undefined },
      { ...observedOutdated, reason: "secret provider detail" },
      { ...observedOutdated, productDeploymentId: PROD_ENVIRONMENT },
    ]) {
      invokeWfp.mockResolvedValueOnce(invalid);
      await expect(
        service.observeCandidate({ scope: stageInput.scope, candidate: browserCandidate } as never),
      ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    }
    invokeWfp.mockResolvedValueOnce(outdated);
    await expect(
      service.compensateGatewayActivation({
        ...mutationContext,
        scope: stageInput.scope,
        candidate: browserCandidate,
        expectedGateway: browserGateway,
      } as never),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    dispatchFetch.mockResolvedValue(new Response(null, { status: 204 }));
    for (const action of ["activate-candidate", "observe-activation"] as const) {
      invokeWfp.mockResolvedValueOnce({
        status: action === "activate-candidate" ? "activated" : "observed",
        candidate: browserCandidate,
        gateway: browserGateway,
        deploymentUrl: browserGateway.publicOrigin,
      });
      const input = {
        organizationId: ORGANIZATION,
        scope: stageInput.scope,
        candidate: browserCandidate,
        runtimePolicy,
      };
      const result =
        action === "activate-candidate"
          ? await service.activateCandidate({ ...activationContext, ...input } as never)
          : await service.observeActivation({ ...input, expectedGateway: browserGateway } as never);
      expect(result).toMatchObject({ status: "activated", gateway: browserGateway });
      expect(invokeWfp.mock.calls.at(-1)?.[0]).toMatchObject({ action, input: { runtimePolicy } });
    }

    for (const invalidPolicy of [
      { ...runtimePolicy, extra: true },
      { ...runtimePolicy, egressAllowedOrigins: ["https://intranet"] },
      { ...runtimePolicy, egressAllowedOrigins: ["https://app.localhost"] },
      { ...runtimePolicy, egressAllowedOrigins: ["https://api.example.test:8443"] },
      { ...runtimePolicy, browser: undefined },
      { ...runtimePolicy, browser: null },
      { ...runtimePolicy, browser: {} },
      { ...runtimePolicy, browser: { ...browser, extra: true } },
      { ...runtimePolicy, browser: { ...browser, connect: ["http://browser.example.test"] } },
      { ...runtimePolicy, browser: { ...browser, scripts: ["wss://browser.example.test"] } },
      {
        ...runtimePolicy,
        browser: {
          ...browser,
          connect: ["wss://browser.example.test", "https://browser.example.test"],
        },
      },
      {
        ...runtimePolicy,
        browser: {
          ...browser,
          cors: { origins: ["https://client.example.test"], credentials: "true" },
        },
      },
      {
        ...runtimePolicy,
        browser: { ...browser, workers: { ...browser.workers, extra: true } },
      },
    ]) {
      for (const action of ["stage", "prepare"] as const) {
        invokeWfp.mockResolvedValueOnce({
          ...(action === "stage" ? stagedResult : preparedResult),
          activationRuntimePolicy: invalidPolicy,
        });
        await expect(
          action === "stage"
            ? service.stageVerifiedArtifact(browserStageInput as never)
            : service.prepareExistingCandidate(prepareInput as never),
        ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
      }
    }

    // A provider rejection passes through with its numeric facts only.
    invokeWfp.mockResolvedValueOnce({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
    });
    await expect(service.stageVerifiedArtifact(stageInput as never)).resolves.toEqual({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
    });
    invokeWfp.mockResolvedValueOnce({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
      message: "secret provider body",
    });
    const widened = await service
      .stageVerifiedArtifact(stageInput as never)
      .catch((error: unknown) => error);
    expect(widened).toMatchObject({ code: "invalid_wfp_management_input" });
    expect(String(widened)).not.toContain("secret provider body");
    invokeWfp.mockResolvedValueOnce({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 500,
      providerCode: null,
    });
    await expect(service.stageVerifiedArtifact(stageInput as never)).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });

    invokeWfp.mockClear();
    const candidate = {
      provider: "cloudflare-wfp" as const,
      namespace: "ohmyho-sandbox",
      scriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      productDeploymentId: DEPLOYMENT,
      providerTag: "44e2244f9dec426aa7330ba66b44ebf0",
      artifactDigest: artifact.provenance.artifactDigest as `sha256:${string}`,
      buildReused: false,
      deployedAt: new Date("2026-08-20T12:00:00.000Z"),
    };
    await service.observeCandidate({
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      candidate,
    });
    expect(invokeWfp).toHaveBeenCalledWith({
      action: "observe-candidate",
      input: {
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate,
      },
    });

    invokeWfp.mockClear();
    await service.finalizeRemoval({
      ...mutationContext,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      deploymentId: DEPLOYMENT,
      expectedGateway: gatewayReceipt,
    });
    const synchronized = await service.syncRuntimeSecrets({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      expectedDeployment: candidate,
      runtimeSecretManifest: manifest,
    });
    expect(synchronized).toMatchObject({
      status: "synchronized",
      receipt: { providerTag: "55e2244f9dec426aa7330ba66b44ebf0" },
    });
    expect(invokeWfp).toHaveBeenCalledWith({
      action: "finalize-removal",
      input: {
        ...mutationContext,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        deploymentId: DEPLOYMENT,
        expectedGateway: gatewayReceipt,
      },
    });
  });

  it("rejects retired database-only removal without invoking a provider", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    await expect(
      service.finalizeRemoval({
        ...mutationContext,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        databaseRegistration: DATABASE_REGISTRATION,
      }),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    expect(invokeWfp).not.toHaveBeenCalled();
  });

  it("serializes activation and both compensation modes through current RPC actions", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    const candidate = {
      provider: "cloudflare-wfp" as const,
      namespace: "ohmyho-sandbox",
      scriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      productDeploymentId: DEPLOYMENT,
      providerTag: "44e2244f9dec426aa7330ba66b44ebf0",
      artifactDigest: `sha256:${"3".repeat(64)}` as const,
      buildReused: false,
      deployedAt: new Date("2026-08-21T12:00:00.000Z"),
    };
    invokeWfp.mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    } as never);
    await service.activateCandidate({
      ...activationContext,
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      candidate,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    });
    expect(bindings.WFP_DISPATCH.get).toHaveBeenCalledWith(
      candidate.scriptName,
      {},
      expect.objectContaining({ limits: WFP_DISPATCH_LIMITS }),
    );
    expect(dispatchFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://candidate.internal/" }),
    );
    await service.compensateGatewayActivation({
      ...mutationContext,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      candidate,
      expectedGateway: gatewayReceipt,
    });
    await service.compensateActivation({
      ...mutationContext,
      cleanupClaimId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: "calm-river-studio",
      },
      candidate,
      expectedGateway: gatewayReceipt,
    });
    expect(invokeWfp.mock.calls.map(([event]) => (event as { action: string }).action)).toEqual([
      "activate-candidate",
      "compensate-gateway-activation",
      "compensate-activation",
    ]);
  });

  it("runs the deploy health probe under the gateway's limits and the project's egress policy", async () => {
    // The probe runs customer code on the dispatch binding before the gateway routes to it. It
    // must not be a path without limits or an Outbound Worker context: the same one source of
    // truth as live traffic, with the project and the origins the activation declared.
    const { createWfpManagementRuntime } = await import("../src/worker-main.js");
    const observations: unknown[] = [];
    const service = createWfpManagementRuntime(bindings, {
      reportHealth: (event) => observations.push(event),
    });
    const bindingSetDigest: `sha256:${string}` = `sha256:${"a".repeat(64)}`;
    const candidate = { ...candidateReceipt(), bindingSetDigest };
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const origins = ["https://api.example.com", "https://hooks.example.org"];
    const input = {
      organizationId: ORGANIZATION,
      scope,
      candidate,
      runtimePolicy: { healthCheckPath: "/healthz", egressAllowedOrigins: origins },
    };
    const proven = {
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    };
    bindings.WFP_DISPATCH.get.mockClear();
    dispatchFetch.mockClear();
    dispatchFetch.mockImplementation(async () => new Response(null, { status: 204 }));
    invokeWfp.mockResolvedValueOnce({ status: "activated", ...proven });
    await service.activateCandidate({ ...activationContext, ...input });
    invokeWfp.mockResolvedValueOnce({ status: "observed", ...proven });
    await service.observeActivation(input);
    expect(invokeWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "activate-candidate",
        input: expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: candidate.bindingSetDigest }),
        }),
      }),
    );
    expect(invokeWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "observe-activation",
        input: expect.objectContaining({
          candidate: expect.objectContaining({ bindingSetDigest: candidate.bindingSetDigest }),
        }),
      }),
    );

    const context = { version: 1, projectId: PROJECT, allowedOrigins: origins };
    expect(bindings.WFP_DISPATCH.get.mock.calls).toEqual([
      [
        candidate.scriptName,
        {},
        { limits: WFP_DISPATCH_LIMITS, outbound: { EGRESS_CONTEXT: context } },
      ],
      [
        candidate.scriptName,
        {},
        { limits: WFP_DISPATCH_LIMITS, outbound: { EGRESS_CONTEXT: context } },
      ],
    ]);
    // The very constant the gateway reads, not a copy, and a closed context only the dispatcher sets.
    const [[, , options]] = bindings.WFP_DISPATCH.get.mock.calls as unknown as [
      [string, unknown, { limits: unknown; outbound: { EGRESS_CONTEXT: unknown } }],
    ];
    expect(options.limits).toBe(WFP_DISPATCH_LIMITS);
    expect(Object.isFrozen(options.outbound.EGRESS_CONTEXT)).toBe(true);
    expect(dispatchFetch).toHaveBeenCalledTimes(2);
    expect(observations).toHaveLength(2);
    for (const observation of observations)
      expect(observation).toMatchObject({
        candidate_receipt_id: OPERATION,
        organization_id: ORGANIZATION,
        project_id: PROJECT,
        environment_id: ENVIRONMENT,
        deployment_id: DEPLOYMENT,
        health_status: "passed",
        http_status: 204,
      });
    expect(JSON.stringify(observations)).not.toContain("/healthz");

    // The recorded context is what the real policy Worker parses: a declared origin passes, any
    // other is denied by policy, and neither is the fail-closed "policy unavailable" answer that a
    // context the parser rejects would give. A change of either side fails here.
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response("declared", { status: 200 });
    });
    const outbound = createPolicyOutboundWorker({ fetch: upstream });
    const environment = { EGRESS_CONTEXT: options.outbound.EGRESS_CONTEXT };
    const declared = await outbound.fetch(new Request(`${origins[0]}/health`), environment);
    expect([declared.status, await declared.text()]).toEqual([200, "declared"]);
    const undeclared = await outbound.fetch(new Request("https://other.example.net/"), environment);
    expect(undeclared.status).toBe(403);
    expect(await undeclared.text()).toContain("is not listed in runtime.egress.allow");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects widened results and distinguishes unhealthy from unknown private probes", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    const candidate = candidateReceipt();
    const input = {
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    };
    invokeWfp.mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
      providerSecret: "must-not-cross",
    });
    await expect(
      service.activateCandidate({ ...activationContext, ...input }),
    ).rejects.toMatchObject({
      code: "invalid_wfp_management_input",
    });

    invokeWfp.mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    });
    dispatchFetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      service.activateCandidate({ ...activationContext, ...input }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      gateway: gatewayReceipt,
      health: { status: 503, path: "/", excerpt: null, truncated: false },
    });
    expect(dispatchFetch).toHaveBeenCalledTimes(4);

    // The verdict quotes only the body, without control characters, and never a header; the probe
    // is a cookieless GET that does not follow a redirect, so a 307 is unhealthy by its status alone.
    for (const [answer, health] of [
      [
        () =>
          new Response("Error: boom\u0000\u001b[31m at fetch\u0007\n", {
            status: 500,
            headers: { "set-cookie": "session=header-secret", "x-api-key": "header-secret" },
          }),
        { status: 500, path: "/", excerpt: "Error: boom[31m at fetch", truncated: false },
      ],
      [
        () =>
          new Response(null, {
            status: 307,
            headers: { location: "https://login.example/?token=header-secret" },
          }),
        { status: 307, path: "/", excerpt: null, truncated: false },
      ],
    ] as const) {
      dispatchFetch.mockClear();
      dispatchFetch.mockImplementation(async () => answer());
      invokeWfp.mockResolvedValueOnce({
        status: "activated",
        candidate,
        gateway: gatewayReceipt,
        deploymentUrl: gatewayReceipt.publicOrigin,
      });
      const verdict = await service.activateCandidate({ ...activationContext, ...input });
      expect(verdict).toMatchObject({ status: "unhealthy", health });
      expect(JSON.stringify(verdict)).not.toContain("header-secret");
      const probe = dispatchFetch.mock.calls[0]?.[0] as Request;
      expect([probe.method, probe.redirect, probe.headers.get("cookie")]).toEqual([
        "GET",
        "manual",
        null,
      ]);
    }

    dispatchFetch.mockClear();
    invokeWfp.mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    });
    dispatchFetch.mockRejectedValue(new Error("private body"));
    const result = await service.activateCandidate({ ...activationContext, ...input });
    expect(result).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "health",
    });
    expect(JSON.stringify(result)).not.toContain("private body");
    expect(dispatchFetch).toHaveBeenCalledTimes(4);

    // A CPU-limit exception is deterministic and the gateway explains it with the same sentence,
    // so the verdict is the explained unhealthy one, not an unknown that needs reconciliation.
    dispatchFetch.mockClear();
    invokeWfp.mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    });
    dispatchFetch.mockRejectedValue(new Error("Worker exceeded CPU time limit."));
    await expect(
      service.activateCandidate({ ...activationContext, ...input }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      gateway: gatewayReceipt,
      health: {
        status: 429,
        path: "/",
        excerpt:
          "Runtime limit exceeded: this request used more than 50 ms of CPU time. This is not a rate limit; reduce the work per request.",
        truncated: false,
      },
    });
    expect(dispatchFetch).toHaveBeenCalledTimes(4);

    invokeWfp.mockRejectedValueOnce(new Error("provider secret body"));
    const invocationError = await service
      .activateCandidate({ ...activationContext, ...input })
      .catch((error: unknown) => error);
    expect(invocationError).toMatchObject({ code: "invalid_wfp_management_input" });
    expect(String(invocationError)).not.toContain("provider secret body");

    invokeWfp.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "gateway",
      currentProviderTag: gatewayReceipt.targetProviderTag,
      currentProductDeploymentId: candidate.productDeploymentId,
    });
    await expect(
      service.compensateGatewayActivation({
        ...mutationContext,
        scope: input.scope,
        candidate,
        expectedGateway: gatewayReceipt,
      }),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      currentProductDeploymentId: candidate.productDeploymentId,
    });
  });

  it("adopts an exact activation only after private candidate health succeeds", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    const candidate = candidateReceipt();
    const input = {
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev" as const,
        handle: "calm-river-studio",
      },
      candidate,
      runtimePolicy: { healthCheckPath: "/ready", egressAllowedOrigins: [] },
      expectedGateway: gatewayReceipt,
    };

    const healthyResponse = new Response("healthy", { status: 200 });
    const healthyBody = healthyResponse.body;
    if (healthyBody === null) throw new Error("Expected probe response body");
    const cancelHealthyBody = vi.spyOn(healthyBody, "cancel");
    dispatchFetch.mockResolvedValue(healthyResponse);
    await expect(service.observeActivation(input)).resolves.toEqual({
      status: "activated",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
      health: { status: 200, path: "/ready", excerpt: null, truncated: false },
    });
    expect(invokeWfp).toHaveBeenCalledWith({
      action: "observe-activation",
      input: {
        organizationId: ORGANIZATION,
        scope: input.scope,
        candidate,
        runtimePolicy: input.runtimePolicy,
        expectedGateway: gatewayReceipt,
      },
    });
    expect(bindings.WFP_DISPATCH.get).toHaveBeenCalledWith(
      candidate.scriptName,
      {},
      {
        limits: WFP_DISPATCH_LIMITS,
        outbound: {
          EGRESS_CONTEXT: {
            version: 1,
            projectId: PROJECT,
            allowedOrigins: input.runtimePolicy.egressAllowedOrigins,
          },
        },
      },
    );
    expect(dispatchFetch.mock.calls[0]?.[0].url).toBe("https://candidate.internal/ready");
    expect(cancelHealthyBody).not.toHaveBeenCalled();
    expect(healthyResponse.bodyUsed).toBe(true);
    expect(probeRequests[0]).toEqual({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      deploymentId: DEPLOYMENT,
    });

    const callsBeforeInvalid = invokeWfp.mock.calls.length;
    await expect(
      service.observeActivation({ ...input, knownDeployments: [candidate] } as never),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    expect(invokeWfp).toHaveBeenCalledTimes(callsBeforeInvalid);

    invokeWfp.mockResolvedValueOnce({
      status: "observed",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    });
    dispatchFetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(service.observeActivation(input)).resolves.toEqual({
      status: "unhealthy",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
      health: { status: 503, path: "/ready", excerpt: null, truncated: false },
    });

    invokeWfp.mockResolvedValueOnce({
      status: "observed",
      candidate,
      gateway: gatewayReceipt,
      deploymentUrl: gatewayReceipt.publicOrigin,
    });
    dispatchFetch.mockRejectedValue(new TypeError("transport unavailable"));
    await expect(service.observeActivation(input)).resolves.toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "health",
      gateway: gatewayReceipt,
    });
    probeAvailable = false;
    const callsBeforeAccountingFailure = invokeWfp.mock.calls.length;
    await expect(
      service.activateCandidate({
        ...activationContext,
        organizationId: input.organizationId,
        scope: input.scope,
        candidate: input.candidate,
        runtimePolicy: input.runtimePolicy,
      }),
    ).rejects.toThrow("Runtime probe accounting is unavailable");
    expect(invokeWfp).toHaveBeenCalledTimes(callsBeforeAccountingFailure);
  });

  it.each([
    { status: 200, declared: true },
    { status: 503, declared: true },
    { status: 200, declared: false },
    { status: 503, declared: false },
  ])(
    "preserves HTTP $status with a bounded oversized body (declared=$declared)",
    async ({ status, declared }) => {
      const { WfpManagementService } = await import("../src/worker-main.js");
      const service = new WfpManagementService({} as never, bindings as never);
      const cancel = vi.fn();
      const chunk = new Uint8Array(declared ? 183_786 : 8 * 1024).fill(0x78);
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(chunk);
      });
      dispatchFetch.mockImplementation(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
            status,
            ...(declared ? { headers: { "content-length": String(chunk.byteLength) } } : {}),
          }),
      );
      const decode = vi.spyOn(TextDecoder.prototype, "decode");
      try {
        const result = await service.observeActivation({
          organizationId: ORGANIZATION,
          scope: {
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            environmentName: "dev",
            handle: "calm-river-studio",
          },
          candidate: candidateReceipt(),
          runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        });
        expect(result).toMatchObject({
          status: status === 200 ? "activated" : "unhealthy",
          gateway: gatewayReceipt,
          health: {
            status,
            excerpt: status === 200 ? null : "x".repeat(4096),
            truncated: status !== 200,
          },
        });
        const attempts = status === 200 ? 1 : 4;
        expect(dispatchFetch).toHaveBeenCalledTimes(attempts);
        expect(pull).toHaveBeenCalledTimes(attempts * (declared ? 1 : 8));
        expect(cancel).toHaveBeenCalledTimes(attempts);
        expect(decode.mock.calls.length).toBeGreaterThan(0);
        expect(decode.mock.calls.every(([bytes]) => (bytes?.byteLength ?? 0) <= 16 * 1024)).toBe(
          true,
        );
      } finally {
        decode.mockRestore();
      }
    },
  );

  it.each(["malformed-length", "read-error"])(
    "keeps %s probe responses uncertain",
    async (failure) => {
      const { WfpManagementService } = await import("../src/worker-main.js");
      const service = new WfpManagementService({} as never, bindings as never);
      const cancel = vi.fn();
      dispatchFetch.mockImplementation(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  controller.error(new Error("private body read failed"));
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
            {
              status: 200,
              ...(failure === "malformed-length"
                ? { headers: { "content-length": "invalid" } }
                : {}),
            },
          ),
      );
      const result = await service.observeActivation({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: "calm-river-studio",
        },
        candidate: candidateReceipt(),
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      });
      expect(result).toMatchObject({
        status: "reconciliation_required",
        reconciliationPhase: "health",
      });
      expect(JSON.stringify(result)).not.toContain("private body read failed");
      expect(dispatchFetch).toHaveBeenCalledTimes(4);
      if (failure === "malformed-length") expect(cancel).toHaveBeenCalledTimes(4);
    },
  );

  it("rejects object and raw-secret payloads in every result class", async () => {
    const { WfpManagementService } = await import("../src/worker-main.js");
    const service = new WfpManagementService({} as never, bindings as never);
    const candidate = candidateReceipt();
    const scope = {
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      environmentName: "dev" as const,
      handle: "calm-river-studio",
    };
    const activation = () =>
      service.activateCandidate({
        ...activationContext,
        organizationId: ORGANIZATION,
        scope,
        candidate,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      });
    const cases: readonly [unknown, () => Promise<unknown>][] = [
      [
        {
          status: "reconciliation_required",
          reconciliationPhase: "gateway",
          currentProviderTag: { secret: "raw" },
          currentProductDeploymentId: candidate.productDeploymentId,
        },
        activation,
      ],
      [
        {
          state: "ready",
          scriptName: candidate.scriptName,
          providerTag: { secret: "raw" },
          productDeploymentId: candidate.productDeploymentId,
          artifactDigest: candidate.artifactDigest,
          observedAt: candidate.deployedAt,
        },
        () => service.observeCandidate({ scope, candidate }),
      ],
      [
        { status: "reconciliation_required", currentSecretNames: [{ secret: "raw" }] },
        async () =>
          service.syncRuntimeSecrets({
            organizationId: ORGANIZATION,
            scope,
            expectedDeployment: candidate,
            runtimeSecretManifest: await runtimeSecretManifest(),
          }),
      ],
      [
        {
          status: "reconciliation_required",
          reason: { secret: "raw" },
          currentProviderTag: gatewayReceipt.targetProviderTag,
        },
        () =>
          service.finalizeRemoval({
            ...mutationContext,
            scope,
            deploymentId: DEPLOYMENT,
            expectedGateway: gatewayReceipt,
          }),
      ],
    ];
    for (const [response, call] of cases) {
      invokeWfp.mockResolvedValueOnce(response);
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_wfp_management_input" });
      expect(JSON.stringify(error)).not.toContain("raw");
    }

    invokeWfp.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "gateway",
      currentProviderTag: gatewayReceipt.targetProviderTag,
      currentProductDeploymentId: PROD_ENVIRONMENT,
    });
    await expect(activation()).rejects.toMatchObject({ code: "invalid_wfp_management_input" });

    const manifest = await runtimeSecretManifest();
    invokeWfp.mockResolvedValueOnce({
      status: "synchronized",
      receipt: {
        provider: "cloudflare-wfp",
        namespace: "foreign-namespace",
        scriptName: candidate.scriptName,
        projectId: candidate.projectId,
        environmentId: candidate.environmentId,
        manifestDigest: manifest.digest,
        secretNames: ["API_TOKEN"],
        providerTag: candidate.providerTag,
        observedAt: candidate.deployedAt,
      },
    });
    await expect(
      service.syncRuntimeSecrets({
        organizationId: ORGANIZATION,
        scope,
        expectedDeployment: candidate,
        runtimeSecretManifest: manifest,
      }),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });

    invokeWfp.mockResolvedValueOnce({
      status: "compensated",
      gateway: {
        ...removedGateway,
        publicOrigin: "https://dev-other-canonical.dev.check.omh.st",
        hostname: "dev-other-canonical.dev.check.omh.st",
      },
      candidateRetained: true,
    });
    await expect(
      service.compensateGatewayActivation({
        ...mutationContext,
        scope,
        candidate,
        expectedGateway: gatewayReceipt,
      }),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
  });
});
