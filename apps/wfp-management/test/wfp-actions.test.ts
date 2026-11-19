import { parseSharedGatewayReceipt } from "@ohmyhost/platform";
import {
  CloudflareWfpProvider,
  WFP_CANDIDATE_LAYOUT_TAG,
  createRuntimeSecretManifest,
} from "@ohmyhost/provider-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = Object.freeze({});
  },
}));

import { parseWfpAction } from "../src/wfp-actions.js";
import { createWfpManagementRuntime } from "../src/worker-main.js";
import {
  artifactProvenance,
  cloudflareEnvelope,
  DEPLOYMENT,
  ENVIRONMENT,
  DATABASE_REGISTRATION,
  ORGANIZATION,
  OPERATION,
  PROD_ENVIRONMENT,
  PROJECT,
  scope,
  STORAGE_BUCKET,
  workerBindings,
} from "./worker-fixtures.js";

const NOW = new Date("2026-08-25T12:00:00.000Z");
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

const receipt = {
  provider: "cloudflare-wfp",
  namespace: "ohmyho-sandbox",
  scriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  productDeploymentId: DEPLOYMENT,
  providerTag: "44e2244f9dec426aa7330ba66b44ebf0",
  artifactDigest: `sha256:${"3".repeat(64)}`,
  buildReused: false,
  deployedAt: "2026-08-20T12:00:00.000Z",
} as const;
const candidate = { ...receipt, deployedAt: new Date(receipt.deployedAt) };

const databaseProvenance = {
  ...artifactProvenance,
  database: { enabled: true, migrations: "supabase/migrations" },
} as const;
const storageProvenance = {
  ...artifactProvenance,
  storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false },
} as const;
const functionsProvenance = {
  ...artifactProvenance,
  functions: { crons: ["*/5 * * * *"] },
} as const;

const runtimeSecretManifest = {
  digest: `sha256:${"5".repeat(64)}`,
  secrets: [
    {
      name: "API_TOKEN",
      value: "runtime-only-secret",
      revision: 1,
      valueSha256: `sha256:${"6".repeat(64)}`,
    },
  ],
} as const;

const gatewayReceipt = parseSharedGatewayReceipt({
  provider: "ohmyhost-shared-gateway",
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  environmentName: "dev",
  handle: "calm-river-studio",
  hostname: "dev-calm-river-studio.dev.check.omh.st",
  publicOrigin: "https://dev-calm-river-studio.dev.check.omh.st",
  targetScriptName: receipt.scriptName,
  targetDeploymentId: DEPLOYMENT,
  targetArtifactDigest: receipt.artifactDigest,
  targetProviderTag: receipt.providerTag,
  egressPolicyDigest: `sha256:${"e".repeat(64)}`,
  egressAllowedOrigins: [],
  candidateReceiptId: OPERATION,
  operationId: OPERATION,
  revision: 1,
  predecessorRevision: null,
  active: true,
  observedAt: "2026-08-21T12:00:00.000Z",
});
const gateway = gatewayReceipt;
const removedGateway = parseSharedGatewayReceipt({
  ...gateway,
  active: false,
  revision: 2,
  predecessorRevision: 1,
});

const stage = (provenance: unknown, extra: Record<string, unknown> = {}) => ({
  action: "stage-candidate" as const,
  input: {
    organizationId: ORGANIZATION,
    scope,
    deploymentId: DEPLOYMENT,
    artifactProvenance: provenance,
    knownDeployments: [],
    runtimeSecretManifest,
    ...extra,
  },
});

describe("Workers for Platforms action input", () => {
  it("preserves declared cron provenance and rejects a widened cron", () => {
    const event = stage(functionsProvenance);
    expect(parseWfpAction(event)).toMatchObject({
      action: "stage-candidate",
      input: { artifactProvenance: { functions: functionsProvenance.functions } },
    });
    expect(() =>
      parseWfpAction(stage({ ...functionsProvenance, functions: { crons: ["* * * * *"] } })),
    ).toThrow("invalid_wfp_action_input");
  });

  it("requires the persisted PGCF registration and its own origin host only for database artifacts", () => {
    const binding = {
      databaseRegistration: DATABASE_REGISTRATION,
      databaseOriginHost: DATABASE_REGISTRATION.originHost,
    };
    expect(parseWfpAction(stage(databaseProvenance, binding))).toMatchObject({ input: binding });
    for (const databaseOriginHost of [
      undefined,
      "",
      "user:password@host",
      "localhost",
      "127.0.0.1",
      "other.pgcf.example",
      `${DATABASE_REGISTRATION.originHost}:5432`,
      `https://${DATABASE_REGISTRATION.originHost}`,
      `${DATABASE_REGISTRATION.originHost}/other`,
    ]) {
      expect(() =>
        parseWfpAction(stage(databaseProvenance, { ...binding, databaseOriginHost })),
      ).toThrow("invalid_wfp_action_input");
    }
    // A Neon registration cannot back a database artifact, even with its own canonical host.
    const {
      provider: _provider,
      databaseId: _databaseId,
      ...physicalRegistration
    } = binding.databaseRegistration;
    void _provider;
    void _databaseId;
    const neonRegistration = {
      ...physicalRegistration,
      providerProjectId: "neon-project",
      branchId: "br-runtime",
      originHost: "ep-runtime-pooler.c-5.us-east-2.aws.neon.tech",
      originDatabase: "neondb" as const,
    };
    expect(() =>
      parseWfpAction(
        stage(databaseProvenance, {
          databaseRegistration: neonRegistration,
          databaseOriginHost: neonRegistration.originHost,
        }),
      ),
    ).toThrow("invalid_wfp_action_input");
    expect(() => parseWfpAction(stage(databaseProvenance))).toThrow("invalid_wfp_action_input");
    expect(() => parseWfpAction(stage(functionsProvenance, binding))).toThrow(
      "invalid_wfp_action_input",
    );
  });

  it("requires the exact project R2 bucket only for storage artifacts", () => {
    expect(
      parseWfpAction(
        stage(storageProvenance, {
          storageBucketName: STORAGE_BUCKET,
          storageDataEnvironmentId: ENVIRONMENT,
        }),
      ),
    ).toMatchObject({
      input: { storageBucketName: STORAGE_BUCKET, storageDataEnvironmentId: ENVIRONMENT },
    });
    expect(() =>
      parseWfpAction(stage(storageProvenance, { storageBucketName: "foreign" })),
    ).toThrow("invalid_wfp_action_input");
    expect(() =>
      parseWfpAction(stage(artifactProvenance, { storageBucketName: STORAGE_BUCKET })),
    ).toThrow("invalid_wfp_action_input");
    for (const storageDataEnvironmentId of [undefined, "", "not-a-data-area"]) {
      expect(() =>
        parseWfpAction(
          stage(storageProvenance, { storageBucketName: STORAGE_BUCKET, storageDataEnvironmentId }),
        ),
      ).toThrow("invalid_wfp_action_input");
    }
    expect(() =>
      parseWfpAction(stage(artifactProvenance, { storageDataEnvironmentId: ENVIRONMENT })),
    ).toThrow("invalid_wfp_action_input");
    const databaseStorageProvenance = { ...databaseProvenance, storage: storageProvenance.storage };
    const databaseStorageBinding = {
      databaseRegistration: DATABASE_REGISTRATION,
      databaseOriginHost: DATABASE_REGISTRATION.originHost,
      storageBucketName: STORAGE_BUCKET,
      storageDataEnvironmentId: ENVIRONMENT,
    };
    expect(parseWfpAction(stage(databaseStorageProvenance, databaseStorageBinding))).toMatchObject({
      input: databaseStorageBinding,
    });
    expect(() =>
      parseWfpAction(
        stage(databaseStorageProvenance, {
          ...databaseStorageBinding,
          storageDataEnvironmentId: PROD_ENVIRONMENT,
        }),
      ),
    ).toThrow("invalid_wfp_action_input");
  });

  it("binds a candidate to its own build and a promotion to another environment's build", () => {
    const prodScope = { ...scope, environmentName: "prod", environmentId: PROD_ENVIRONMENT };
    const promotedDeployment = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
    expect(
      parseWfpAction({
        action: "stage-candidate",
        input: {
          ...stage(artifactProvenance, { artifactReuse: "promotion" }).input,
          scope: prodScope,
          deploymentId: promotedDeployment,
        },
      }),
    ).toMatchObject({ input: { artifactReuse: "promotion", deploymentId: promotedDeployment } });
    const refreshed = stage(artifactProvenance, {
      artifactReuse: "binding-refresh",
      deploymentId: promotedDeployment,
      knownDeployments: [receipt],
      previousGateway: gateway,
    });
    expect(parseWfpAction(refreshed)).toMatchObject({
      input: { artifactReuse: "binding-refresh", deploymentId: promotedDeployment },
    });
    for (const input of [
      { ...refreshed.input, knownDeployments: [] },
      { ...refreshed.input, previousGateway: undefined },
      { ...refreshed.input, deploymentId: DEPLOYMENT },
    ])
      expect(() => parseWfpAction({ ...refreshed, input })).toThrow("invalid_wfp_action_input");
    for (const event of [
      // A promotion must target Prod, another environment and another deployment.
      stage(artifactProvenance, { artifactReuse: "promotion" }),
      // An ordinary candidate must carry the provenance of its own deployment and project.
      stage({ ...artifactProvenance, deploymentId: promotedDeployment }),
      stage({
        ...artifactProvenance,
        scope: { ...artifactProvenance.scope, projectId: ORGANIZATION },
      }),
      stage({
        ...artifactProvenance,
        lifecycleEvidence: {
          ...artifactProvenance.lifecycleEvidence,
          buildSandbox: {
            ...artifactProvenance.lifecycleEvidence.buildSandbox,
            buildId: "ohmyho-sandbox-build:another-operation",
          },
        },
      }),
      stage({ ...artifactProvenance, output: { ...artifactProvenance.output, eTag: "etag" } }),
    ]) {
      expect(() => parseWfpAction(event)).toThrow("invalid_wfp_action_input");
    }
  });

  it("round-trips exact candidate observation and deletion while denying cross scope", () => {
    for (const action of ["observe-candidate", "remove-candidate"] as const) {
      const input = {
        ...(action === "remove-candidate"
          ? { ...mutationContext, candidateReceiptId: OPERATION }
          : {}),
        scope,
        candidate: receipt,
      };
      expect(
        parseWfpAction({
          action,
          input,
        }),
      ).toMatchObject({
        action,
      });
      const bindingSetDigest = `sha256:${"a".repeat(64)}`;
      expect(
        parseWfpAction({
          action,
          input: { ...input, candidate: { ...receipt, bindingSetDigest } },
        }),
      ).toMatchObject({
        input: { candidate: { bindingSetDigest } },
      });
      for (const invalid of [undefined, null, "sha256:bad", `sha256:${"A".repeat(64)}`])
        expect(() =>
          parseWfpAction({
            action,
            input: { ...input, candidate: { ...receipt, bindingSetDigest: invalid } },
          }),
        ).toThrow("invalid_wfp_action_input");
    }
    expect(() =>
      parseWfpAction({
        action: "remove-candidate",
        input: {
          ...mutationContext,
          candidateReceiptId: OPERATION,
          scope: { ...scope, environmentId: PROD_ENVIRONMENT },
          candidate: receipt,
        },
      }),
    ).toThrow("invalid_wfp_action_input");
  });

  it("binds secret synchronization to the exact candidate receipt", () => {
    expect(
      parseWfpAction({
        action: "sync-secrets",
        input: { scope, expectedDeployment: receipt, runtimeSecretManifest },
      }),
    ).toMatchObject({ input: { expectedDeployment: { productDeploymentId: DEPLOYMENT } } });
  });

  it("accepts exact gateway compensation and final cleanup envelopes", () => {
    const policyEvent = (origins: unknown[]) => ({
      action: "activate-candidate",
      input: {
        ...activationContext,
        organizationId: ORGANIZATION,
        scope,
        candidate: receipt,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: origins },
      },
    });
    expect(
      parseWfpAction(policyEvent(["https://api.example.test", "https://auth.example.test"])),
    ).toMatchObject({
      input: {
        runtimePolicy: {
          egressAllowedOrigins: ["https://api.example.test", "https://auth.example.test"],
        },
      },
    });
    for (const origins of [
      ["http://api.example.test"],
      [42],
      ["https://auth.example.test", "https://api.example.test"],
      ["https://api.example.test", "https://api.example.test"],
    ]) {
      expect(() => parseWfpAction(policyEvent(origins))).toThrow("invalid_wfp_action_input");
    }
    expect(parseWfpAction(policyEvent([]))).toMatchObject({ action: "activate-candidate" });
    expect(
      parseWfpAction({
        action: "observe-activation",
        input: {
          organizationId: ORGANIZATION,
          scope,
          candidate: receipt,
          runtimePolicy: policyEvent([]).input.runtimePolicy,
        },
      }),
    ).toMatchObject({ action: "observe-activation" });
    expect(
      parseWfpAction({
        action: "prepare-existing-candidate",
        input: {
          artifactSourceDeploymentId: DEPLOYMENT,
          organizationId: ORGANIZATION,
          scope,
          candidate: receipt,
          artifactProvenance: databaseProvenance,
          runtimeSecretManifest,
          databaseRegistration: DATABASE_REGISTRATION,
        },
      }),
    ).toMatchObject({ action: "prepare-existing-candidate" });
    expect(
      parseWfpAction({
        action: "compensate-gateway-activation",
        input: { ...mutationContext, scope, candidate: receipt, expectedGateway: gatewayReceipt },
      }),
    ).toMatchObject({ action: "compensate-gateway-activation" });
    expect(
      parseWfpAction({
        action: "finalize-removal",
        input: {
          ...mutationContext,
          scope,
          deploymentId: DEPLOYMENT,
          expectedGateway: gatewayReceipt,
        },
      }),
    ).toMatchObject({ action: "finalize-removal" });
    expect(() =>
      parseWfpAction({
        action: "finalize-removal",
        input: { scope, databaseRegistration: DATABASE_REGISTRATION },
      }),
    ).toThrow("invalid_wfp_action_input");
    expect(() =>
      parseWfpAction({
        action: "finalize-removal",
        input: { scope, databaseHyperdriveId: "foreign" },
      }),
    ).toThrow("invalid_wfp_action_input");
    expect(() =>
      parseWfpAction({
        action: "compensate-gateway-activation",
        input: {
          ...mutationContext,
          scope,
          candidate: receipt,
          expectedGateway: {
            ...gatewayReceipt,
            publicOrigin: "https://dev-calm-river-studio.your-omh-account.workers.dev",
          },
        },
      }),
    ).toThrow("invalid_wfp_action_input");
  });

  it("rejects legacy and excess-field actions", () => {
    expect(() => parseWfpAction({ action: "publish", input: {} })).toThrow(
      "invalid_wfp_action_input",
    );
    expect(() =>
      parseWfpAction({
        action: "remove-candidate",
        input: { scope, candidate: receipt, secret: "x" },
      }),
    ).toThrow("invalid_wfp_action_input");
  });
});

describe("Workers for Platforms actions inside the private Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects an excess-field action before any provider request or object read", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const bindings = workerBindings();
    const runtime = createWfpManagementRuntime(bindings, { fetch });

    await expect(
      (async () =>
        runtime.removeCandidate({
          ...mutationContext,
          candidateReceiptId: OPERATION,
          scope,
          candidate,
          secret: "x",
        } as never))(),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    await expect(
      runtime.observeCandidate({
        scope: { ...scope, environmentId: PROD_ENVIRONMENT },
        candidate,
      }),
    ).rejects.toMatchObject({ code: "invalid_wfp_management_input" });
    expect(fetch).not.toHaveBeenCalled();
    expect(bindings.BUILD_OBJECTS_US.get).not.toHaveBeenCalled();
  });

  it("observes a candidate over the platform transport with the Worker's own token and never reads the build bucket", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      cloudflareEnvelope({
        dispatch_namespace: "ohmyho-sandbox",
        created_on: "2026-08-20T12:00:00.000Z",
        modified_on: "2026-08-20T12:00:00.000Z",
        script: null,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const bindings = workerBindings();
    const runtime = createWfpManagementRuntime(bindings, { now: () => NOW });

    await expect(runtime.observeCandidate({ scope, candidate })).resolves.toMatchObject({
      state: "metadata_absent",
      scriptName: candidate.scriptName,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      `/accounts/00000000000000000000000000000001/workers/dispatch/namespaces/ohmyho-sandbox/scripts/${candidate.scriptName}`,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer narrow-cloudflare-token");
    expect(bindings.BUILD_OBJECTS_US.get).not.toHaveBeenCalled();
  });

  it("synchronizes one exact candidate through the real provider adapter without returning plaintext", async () => {
    const valueDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("runtime-only-secret")),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const validManifest = await createRuntimeSecretManifest([
      {
        name: "API_TOKEN",
        value: "runtime-only-secret",
        revision: 1,
        valueSha256: `sha256:${valueDigest}`,
      },
    ]);
    const candidateDetails = () =>
      cloudflareEnvelope({
        modified_on: "2026-08-25T12:00:00.000Z",
        script: {
          id: receipt.scriptName,
          tag: receipt.providerTag,
          deployment_id: receipt.providerTag,
          tags: [
            `project:${PROJECT}`,
            `environment:${ENVIRONMENT}`,
            `deployment:${DEPLOYMENT}`,
            `artifact:${receipt.artifactDigest}`,
          ],
        },
      });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(candidateDetails())
      .mockResolvedValueOnce(cloudflareEnvelope([{ name: "RETIRED_SECRET", type: "secret_text" }]))
      .mockResolvedValueOnce(cloudflareEnvelope([{ name: "API_TOKEN", type: "secret_text" }]))
      .mockResolvedValueOnce(cloudflareEnvelope([{ name: "API_TOKEN", type: "secret_text" }]))
      .mockResolvedValueOnce(candidateDetails());
    const runtime = createWfpManagementRuntime(workerBindings(), { fetch, now: () => NOW });

    const result = await runtime.syncRuntimeSecrets({
      organizationId: ORGANIZATION,
      scope,
      expectedDeployment: candidate,
      runtimeSecretManifest: validManifest,
    });

    expect(result).toMatchObject({
      status: "synchronized",
      receipt: { secretNames: ["API_TOKEN"] },
    });
    expect(JSON.stringify(result)).not.toContain("runtime-only-secret");
    expect(String(fetch.mock.calls[2]?.[0])).toContain(`${receipt.scriptName}/secrets`);
  });

  it("activates, observes and compensates one exact gateway through the provider boundary", async () => {
    const bindings = workerBindings();
    const activate = bindings.GATEWAY_REGISTRY.activate.mockResolvedValue(gateway);
    const observeCandidate = vi
      .spyOn(CloudflareWfpProvider.prototype, "observeCandidate")
      .mockResolvedValue({
        state: "ready",
        scriptName: receipt.scriptName,
        providerTag: receipt.providerTag,
        productDeploymentId: receipt.productDeploymentId,
        artifactDigest: receipt.artifactDigest,
        observedAt: NOW,
      });
    const observeGateway = bindings.GATEWAY_REGISTRY.observe.mockResolvedValue(gateway);
    const compensate = bindings.GATEWAY_REGISTRY.compensate.mockResolvedValue(removedGateway);
    const runtime = createWfpManagementRuntime(bindings, {
      fetch: vi.fn<typeof globalThis.fetch>(),
      now: () => NOW,
    });
    const runtimePolicy = { healthCheckPath: "/", egressAllowedOrigins: [] };

    await expect(
      runtime.activateCandidate({
        ...activationContext,
        organizationId: ORGANIZATION,
        scope,
        candidate,
        runtimePolicy,
      }),
    ).resolves.toMatchObject({ status: "activated", gateway: { targetDeploymentId: DEPLOYMENT } });
    expect(activate).toHaveBeenCalledWith({
      ...mutationContext,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      candidateReceiptId: OPERATION,
      expectedRevision: null,
      egressAllowedOrigins: [],
    });

    await expect(
      runtime.observeActivation({ organizationId: ORGANIZATION, scope, candidate, runtimePolicy }),
    ).resolves.toMatchObject({
      status: "activated",
      candidate: { productDeploymentId: DEPLOYMENT },
      gateway: { targetDeploymentId: DEPLOYMENT },
      health: { status: 200, path: "/", excerpt: null, truncated: false },
    });
    expect(observeCandidate).toHaveBeenCalledWith({
      scope,
      deploymentId: DEPLOYMENT,
      knownDeployment: candidate,
    });
    expect(observeGateway).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
    });

    await expect(
      runtime.compensateGatewayActivation({
        ...mutationContext,
        scope,
        candidate,
        expectedGateway: gateway,
      }),
    ).resolves.toMatchObject({ status: "compensated", candidateRetained: true });
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(bindings.BUILD_OBJECTS_US.get).not.toHaveBeenCalled();
  });

  // A rename republishes each published route at the chosen address: the scope names the new
  // handle while the route it replaces still carries the old one. That pair was refused, so no
  // deployed project could be renamed; the previous route is matched by project and environment.
  it("moves a published gateway to a renamed address through the real service", async () => {
    const bindings = workerBindings();
    const renamedScope = { ...scope, handle: "quiet-lake-works" };
    const moved = parseSharedGatewayReceipt({
      ...gateway,
      handle: "quiet-lake-works",
      hostname: "dev-quiet-lake-works.dev.check.omh.st",
      publicOrigin: "https://dev-quiet-lake-works.dev.check.omh.st",
      revision: 2,
      predecessorRevision: 1,
    });
    const activate = bindings.GATEWAY_REGISTRY.activate.mockResolvedValue(moved);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      cloudflareEnvelope({
        modified_on: NOW.toISOString(),
        script: {
          id: candidate.scriptName,
          tag: candidate.providerTag,
          deployment_id: candidate.providerTag,
          tags: [
            `project:${PROJECT}`,
            `environment:${ENVIRONMENT}`,
            `deployment:${DEPLOYMENT}`,
            `artifact:${candidate.artifactDigest}`,
            WFP_CANDIDATE_LAYOUT_TAG,
          ],
        },
      }),
    );
    const runtime = createWfpManagementRuntime(bindings, {
      fetch,
      now: () => NOW,
    });
    const move = {
      ...activationContext,
      organizationId: ORGANIZATION,
      scope: renamedScope,
      candidate,
      previousGateway: gateway,
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    };

    await expect(runtime.activateCandidate(move)).resolves.toMatchObject({
      status: "activated",
      gateway: { handle: "quiet-lake-works", revision: 2 },
      deploymentUrl: "https://dev-quiet-lake-works.dev.check.omh.st",
    });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`/scripts/${candidate.scriptName}`);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");

    // The replaced route still has to be this environment's own route.
    activate.mockClear();
    await expect(
      runtime.activateCandidate({
        ...move,
        previousGateway: parseSharedGatewayReceipt({
          ...gateway,
          environmentId: PROD_ENVIRONMENT,
          environmentName: "prod",
          hostname: "calm-river-studio.dev.check.omh.st",
          publicOrigin: "https://calm-river-studio.dev.check.omh.st",
          targetScriptName: `p-${PROJECT.toLowerCase()}-prod-${DEPLOYMENT.toLowerCase()}`,
        }),
      }),
    ).rejects.toThrow();
    expect(activate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("removes a candidate and compensates an activation down to candidate absence", async () => {
    const absence = {
      state: "metadata_absent" as const,
      namespace: "ohmyho-sandbox",
      scriptName: receipt.scriptName,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      expectedProviderTag: receipt.providerTag,
      observedAt: NOW,
    };
    const removeCandidate = vi
      .spyOn(CloudflareWfpProvider.prototype, "removeCandidate")
      .mockResolvedValue(absence);
    const observed = {
      scriptName: receipt.scriptName,
      productDeploymentId: receipt.productDeploymentId,
      artifactDigest: receipt.artifactDigest,
      observedAt: NOW,
    };
    const absent = {
      state: "metadata_absent" as const,
      scriptName: receipt.scriptName,
      providerTag: null,
      productDeploymentId: null,
      artifactDigest: null,
      observedAt: NOW,
    };
    vi.spyOn(CloudflareWfpProvider.prototype, "observeCandidate")
      .mockResolvedValueOnce({ state: "ready", providerTag: receipt.providerTag, ...observed })
      .mockResolvedValueOnce(absent)
      .mockResolvedValueOnce({ state: "ready", providerTag: receipt.providerTag, ...observed })
      .mockResolvedValueOnce(absent);
    const bindings = workerBindings();
    bindings.GATEWAY_REGISTRY.compensate.mockResolvedValue(removedGateway);
    const runtime = createWfpManagementRuntime(bindings, {
      fetch: vi.fn<typeof globalThis.fetch>(),
      now: () => NOW,
    });

    await expect(
      runtime.removeCandidate({
        ...mutationContext,
        candidateReceiptId: OPERATION,
        scope,
        candidate,
      }),
    ).resolves.toEqual({
      status: "removed",
      outcome: "removed",
      receipt: absence,
    });
    await expect(
      runtime.compensateActivation({
        ...mutationContext,
        cleanupClaimId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
        scope,
        candidate,
        expectedGateway: gateway,
      }),
    ).resolves.toMatchObject({
      status: "compensated",
      gateway: { active: false, revision: 2 },
      candidate: { state: "metadata_absent" },
    });
    expect(removeCandidate).toHaveBeenCalledWith({ scope, expectedDeployment: candidate });
  });

  it("finalizes exact gateway and candidate removal through the provider boundary", async () => {
    const bindings = workerBindings();
    const removeGateway = bindings.GATEWAY_REGISTRY.remove.mockResolvedValue(removedGateway);
    const removeCandidate = vi
      .spyOn(CloudflareWfpProvider.prototype, "removeCandidate")
      .mockResolvedValue({
        state: "metadata_absent",
        namespace: "ohmyho-sandbox",
        scriptName: receipt.scriptName,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        expectedProviderTag: receipt.providerTag,
        observedAt: NOW,
      });
    const observeCandidate = vi
      .spyOn(CloudflareWfpProvider.prototype, "observeCandidate")
      .mockResolvedValue({
        state: "metadata_absent",
        scriptName: receipt.scriptName,
        providerTag: null,
        productDeploymentId: null,
        artifactDigest: null,
        observedAt: NOW,
      });
    const runtime = createWfpManagementRuntime(bindings, {
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => new Response(null, { status: 404 })),
      now: () => NOW,
    });

    // The three public 404 proofs are one second apart on the platform clock.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const removal = runtime.finalizeRemoval({
      ...mutationContext,
      scope,
      deploymentId: DEPLOYMENT,
      expectedGateway: gateway,
    });
    let settled = false;
    void removal.finally(() => {
      settled = true;
    });
    while (!settled) await vi.advanceTimersByTimeAsync(1_000);
    await expect(removal).resolves.toMatchObject({ status: "removed", consecutive404s: 3 });
    expect(removeGateway).toHaveBeenCalledWith({
      ...mutationContext,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      expectedRevision: 1,
    });
    expect(removeCandidate).toHaveBeenCalledWith({
      scope,
      expectedDeployment: expect.objectContaining({ productDeploymentId: DEPLOYMENT }),
    });
    expect(observeCandidate).toHaveBeenCalledWith({
      scope,
      deploymentId: DEPLOYMENT,
      knownDeployment: expect.objectContaining({ productDeploymentId: DEPLOYMENT }),
    });
    expect(bindings.BUILD_OBJECTS_US.get).not.toHaveBeenCalled();
  });

  it("rejects the retired database-only finalize RPC before provider access", () => {
    const runtime = createWfpManagementRuntime(workerBindings(), {
      fetch: vi.fn<typeof globalThis.fetch>(),
      now: () => NOW,
    });
    expect(() =>
      runtime.finalizeRemoval({
        ...mutationContext,
        scope,
        databaseRegistration: DATABASE_REGISTRATION,
      }),
    ).toThrow("WFP management input is invalid");
  });

  it("answers a failure without its detail and logs only the action and a fixed code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(CloudflareWfpProvider.prototype, "observeCandidate")
      .mockRejectedValueOnce(new Error("provider body with narrow-cloudflare-token"))
      .mockRejectedValueOnce(Object.assign(new Error("detail"), { code: "cloudflare_timeout" }));
    const runtime = createWfpManagementRuntime(workerBindings(), {
      fetch: vi.fn<typeof globalThis.fetch>(),
    });

    for (const code of ["unclassified", "cloudflare_timeout"]) {
      const error = await runtime
        .observeCandidate({ scope, candidate })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "invalid_wfp_management_input" });
      expect(String(error)).not.toContain("narrow-cloudflare-token");
      expect(logged).toHaveBeenLastCalledWith(
        "wfp-management:action-failed",
        "observe-candidate",
        code,
      );
    }
    expect(JSON.stringify(logged.mock.calls)).not.toContain("narrow-cloudflare-token");
  });
});
