import { createHash } from "node:crypto";

import { normalizeBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeSecretDelivery } from "../src/runtime.js";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROD_ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const OPERATION = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const DEPLOYMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const LEASE = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const STAGE_RECEIPT = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const CANDIDATE_RECEIPT = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const CLAIM = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const CLEANUP_CLAIM = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
const HANDLE = "calm-otter-waves";
const ENVIRONMENT_NAME = "dev" as const;
const NOW = new Date("2026-08-21T00:00:00.000Z");

const scope = {
  organizationId: ORGANIZATION,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  operationId: OPERATION,
};
const wfpScope = { ...scope, environmentName: ENVIRONMENT_NAME, handle: HANDLE };

function candidateReceipt(extra: Record<string, unknown> = {}) {
  return {
    provider: "cloudflare-wfp",
    namespace: "ohmyho-sandbox",
    scriptName: `p-${PROJECT.toLowerCase()}-dev-${DEPLOYMENT.toLowerCase()}`,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    productDeploymentId: DEPLOYMENT,
    providerTag: "c".repeat(32),
    artifactDigest: `sha256:${"a".repeat(64)}`,
    buildReused: true,
    deployedAt: NOW,
    ...extra,
  };
}

function gatewayReceipt(extra: Record<string, unknown> = {}) {
  return {
    provider: "ohmyhost-shared-gateway",
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    environmentName: "dev",
    handle: HANDLE,
    hostname: `dev-${HANDLE}.dev.check.omh.st`,
    publicOrigin: `https://dev-${HANDLE}.dev.check.omh.st`,
    targetScriptName: candidateReceipt().scriptName,
    targetDeploymentId: DEPLOYMENT,
    targetArtifactDigest: candidateReceipt().artifactDigest,
    targetProviderTag: candidateReceipt().providerTag,
    candidateReceiptId: CANDIDATE_RECEIPT,
    operationId: OPERATION,
    revision: 1,
    predecessorRevision: null,
    active: true,
    egressPolicyDigest: `sha256:${"d".repeat(64)}`,
    egressAllowedOrigins: [],
    observedAt: NOW,
    ...extra,
  };
}
function activeWfpTarget() {
  return {
    deployment: candidateReceipt(),
    candidateReceiptId: CANDIDATE_RECEIPT,
    operationId: OPERATION,
    gateway: gatewayReceipt(),
  };
}
function gatewayAbsence() {
  return gatewayReceipt({ active: false, revision: 2, predecessorRevision: 1 });
}

function candidateAbsence() {
  const candidate = candidateReceipt();
  return {
    state: "metadata_absent",
    namespace: candidate.namespace,
    scriptName: candidate.scriptName,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    expectedProviderTag: candidate.providerTag,
    observedAt: NOW,
  };
}

function runtimePolicy() {
  return { healthCheckPath: "/", egressAllowedOrigins: ["https://api.example.test"] };
}

function recordedStage(extra: Record<string, unknown> = {}) {
  return {
    stageReceiptId: STAGE_RECEIPT,
    candidateReceiptId: CANDIDATE_RECEIPT,
    operationId: OPERATION,
    productDeploymentId: DEPLOYMENT,
    leaseId: LEASE,
    generation: 3,
    releaseSequence: 1,
    trigger: "deploy",
    providerTag: candidateReceipt().providerTag,
    appliedSecretNames: ["DATABASE_URL"],
    manifestDigest: `sha256:${"9".repeat(64)}`,
    manifestSecretCount: 1,
    stagedAt: NOW.toISOString(),
    outcome: "staged",
    ...extra,
  };
}

function requireRecordForTest(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function harness(overrides: Record<string, unknown> = {}) {
  const claim = vi.fn(
    async (input: {
      trigger: "deploy" | "promotion" | "rollback" | "reconcile";
      environmentId: string;
    }) => {
      const value =
        input.environmentId === PROD_ENVIRONMENT
          ? "postgres://prod-runtime-only"
          : "postgres://runtime-only";
      return {
        outcome: "claimed" as const,
        generation: 3,
        releaseSequence: 1,
        trigger: input.trigger,
        runtimeProvider: "wfp" as const,
        leaseId: LEASE,
        leaseExpiresAt: "2026-08-21T00:01:00.000Z",
        providerTag: "c".repeat(32),
        appliedSecretNames: ["RETIRED_SECRET"],
        secrets: [
          {
            organizationId: ORGANIZATION,
            projectId: PROJECT,
            environmentId: input.environmentId,
            name: "DATABASE_URL",
            revision: 2,
            keyVersion: 1,
            ciphertext: new Uint8Array(
              input.environmentId === PROD_ENVIRONMENT ? [9, 8, 7] : [1, 2, 3],
            ),
            nonce: new Uint8Array(12).fill(4),
            valueSha256: new Uint8Array(createHash("sha256").update(value).digest()),
          },
        ],
      };
    },
  );
  const fail = vi.fn(async () => "failed" as const);
  const release = vi.fn(async () => "released" as const);
  const stageWfp = vi.fn(async () => ({ outcome: "staged" as const, stageReceiptId: LEASE }));
  const activateWfp = vi.fn(async () => ({
    outcome: "activated" as const,
    activationReceiptId: STAGE_RECEIPT,
    activatedAt: NOW.toISOString(),
  }));
  const compensateWfp = vi.fn(async () => ({
    outcome: "compensated" as const,
    compensationReceiptId: STAGE_RECEIPT,
    compensatedAt: NOW.toISOString(),
  }));
  const readActiveWfpTarget = vi.fn(async () => activeWfpTarget());
  const readRecordedWfpStage = vi.fn(async () => recordedStage({ outcome: "existing" }));
  const installPlatform = vi.fn(async () => ({
    name: "DATABASE_URL",
    revision: 1,
    keyVersion: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }));
  const ensurePlatform = vi.fn(async () => ({
    name: "BETTER_AUTH_SECRET",
    revision: 1,
    keyVersion: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }));
  const ensureMailGateway = vi.fn(async () => ({
    name: "OHMYHOST_MAIL_KEY",
    revision: 1,
    keyVersion: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }));
  const readPromotionMailGatewaySource = vi.fn(async () => null);
  const ensureStorageGateway = vi.fn(async () => ({
    name: "OHMYHOST_STORAGE_KEY",
    revision: 1,
    keyVersion: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }));
  const ensureAiGateway = vi.fn(async () => ({
    name: "OHMYHOST_AI_KEY",
    revision: 1,
    keyVersion: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }));
  const stageVerifiedArtifact = vi.fn(async (input: unknown) => {
    const value = input as { runtimeSecretManifest: { digest: string } };
    return {
      status: "staged",
      candidate: candidateReceipt(),
      priorGateway: null,
      activationRuntimePolicy: runtimePolicy(),
      deploymentUrl: `https://dev-${HANDLE}.dev.check.omh.st`,
      runtimeSecretManifestDigest: value.runtimeSecretManifest.digest,
    };
  });
  const prepareExistingCandidate = vi.fn(async (input: unknown) => {
    const value = input as { candidate: unknown; runtimeSecretManifest: { digest: string } };
    return {
      status: "prepared",
      candidate: value.candidate,
      activationRuntimePolicy: runtimePolicy(),
      runtimeSecretManifestDigest: value.runtimeSecretManifest.digest,
    };
  });
  const activateCandidate = vi.fn(async (input: unknown) => ({
    status: "activated",
    candidate: (input as { candidate: unknown }).candidate,
    gateway: gatewayReceipt(),
    deploymentUrl: `https://dev-${HANDLE}.dev.check.omh.st`,
  }));
  const compensateActivation = vi.fn(async () => ({
    status: "compensated",
    gateway: gatewayAbsence(),
    candidate: candidateAbsence(),
  }));
  const compensateGatewayActivation = vi.fn(async () => ({
    status: "compensated",
    gateway: gatewayAbsence(),
    candidateRetained: true,
  }));
  const removeCandidate = vi.fn(async () => ({
    status: "removed",
    outcome: "removed",
    receipt: candidateAbsence(),
  }));
  const observeActivation = vi.fn(async () => ({
    status: "activated",
    candidate: candidateReceipt(),
    gateway: gatewayReceipt(),
    deploymentUrl: `https://dev-${HANDLE}.dev.check.omh.st`,
    health: { status: 200, path: "/", excerpt: null, truncated: false },
  }));
  const persistence = {
    claim,
    fail,
    release,
    readPending: vi.fn(async () => []),
    recordPendingAttempt: vi.fn(async () => undefined),
    readState: vi.fn(async () => ({ runtimeProvider: "wfp" })),
    stageWfp,
    activateWfp,
    compensateWfp,
    readActiveWfpTarget,
    readRecordedWfpStage,
    installPlatform,
    ensurePlatform,
    ensureMailGateway,
    readPromotionMailGatewaySource,
    ensureStorageGateway,
    ensureAiGateway,
  };
  const runtime = createRuntimeSecretDelivery({
    persistence,
    cipher: {
      encrypt: vi.fn(async () => ({
        ciphertext: new Uint8Array(17).fill(1),
        nonce: new Uint8Array(12).fill(2),
        valueSha256: new Uint8Array(32).fill(3),
        keyVersion: 1,
      })),
      openEnvironmentSecret: vi.fn(async (secret: { environmentId: string }) =>
        secret.environmentId === PROD_ENVIRONMENT
          ? "postgres://prod-runtime-only"
          : "postgres://runtime-only",
      ),
    },
    wfp: {
      stageVerifiedArtifact,
      prepareExistingCandidate,
      activateCandidate,
      compensateGatewayActivation,
      compensateActivation,
      removeCandidate,
      observeActivation,
      syncRuntimeSecrets: vi.fn(),
    },
    ids: { next: () => LEASE },
    clock: { now: () => NOW },
    entropy: { fill: (destination: Uint8Array) => destination.fill(7) },
    ...overrides,
  } as never);
  return {
    runtime,
    persistence,
    claim,
    fail,
    release,
    stageWfp,
    activateWfp,
    compensateWfp,
    readActiveWfpTarget,
    readRecordedWfpStage,
    installPlatform,
    ensurePlatform,
    ensureMailGateway,
    readPromotionMailGatewaySource,
    ensureStorageGateway,
    ensureAiGateway,
    stageVerifiedArtifact,
    prepareExistingCandidate,
    activateCandidate,
    compensateGatewayActivation,
    compensateActivation,
    removeCandidate,
    observeActivation,
  };
}

describe("private runtime secret delivery", () => {
  it("encrypts a provider DATABASE_URL and persists no plaintext", async () => {
    const { runtime, installPlatform } = harness();

    await expect(
      runtime.installPlatformSecret({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        operationId: OPERATION,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        name: "DATABASE_URL",
        value: "postgres://runtime-secret",
      }),
    ).resolves.toMatchObject({ name: "DATABASE_URL", revision: 1 });
    expect(installPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DATABASE_URL",
        keyVersion: 1,
        ciphertext: expect.any(Uint8Array),
      }),
    );
    expect(JSON.stringify(installPlatform.mock.calls)).not.toContain("runtime-secret");
  });

  it("generates and atomically installs one high-entropy Better Auth secret", async () => {
    const encryptedValues: string[] = [];
    const { runtime, ensurePlatform } = harness({
      cipher: {
        encrypt: vi.fn(async ({ value }: { value: string }) => {
          encryptedValues.push(value);
          return {
            ciphertext: new Uint8Array(59).fill(1),
            nonce: new Uint8Array(12).fill(2),
            valueSha256: new Uint8Array(32).fill(3),
            keyVersion: 1,
          };
        }),
        openEnvironmentSecret: vi.fn(),
      },
    });

    await expect(
      runtime.ensureCustomerAuthSecret({
        ...scope,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      }),
    ).resolves.toMatchObject({
      name: "BETTER_AUTH_SECRET",
      revision: 1,
    });
    expect(encryptedValues).toHaveLength(1);
    expect(encryptedValues[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ensurePlatform).toHaveBeenCalledWith(
      expect.objectContaining({ name: "BETTER_AUTH_SECRET", ciphertext: expect.any(Uint8Array) }),
    );
    expect(JSON.stringify(ensurePlatform.mock.calls)).not.toContain(encryptedValues[0]);
  });

  it("generates and atomically binds one high-entropy mail gateway key", async () => {
    const encryptedValues: string[] = [];
    const { runtime, ensureMailGateway, readPromotionMailGatewaySource } = harness({
      cipher: {
        encrypt: vi.fn(async ({ value }: { value: string }) => {
          encryptedValues.push(value);
          return {
            ciphertext: new Uint8Array(59).fill(1),
            nonce: new Uint8Array(12).fill(2),
            valueSha256: new Uint8Array(32).fill(3),
            keyVersion: 1,
          };
        }),
        openEnvironmentSecret: vi.fn(async () => "reused-mail-key"),
      },
    });
    await expect(
      runtime.ensureMailGatewayKey({
        ...scope,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      }),
    ).resolves.toMatchObject({ name: "OHMYHOST_MAIL_KEY", revision: 1 });
    expect(encryptedValues[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ensureMailGateway).toHaveBeenCalledWith(
      expect.objectContaining({ name: "OHMYHOST_MAIL_KEY", valueSha256: expect.any(Uint8Array) }),
    );
    expect(JSON.stringify(ensureMailGateway.mock.calls)).not.toContain(encryptedValues[0]);

    const sourceCiphertext = new Uint8Array(17).fill(9);
    readPromotionMailGatewaySource.mockResolvedValueOnce({
      environmentId: PROD_ENVIRONMENT,
      ciphertext: sourceCiphertext,
      nonce: new Uint8Array(12).fill(8),
      valueSha256: new Uint8Array(32).fill(7),
      keyVersion: 1,
    } as never);
    await runtime.ensureMailGatewayKey({
      ...scope,
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    });
    expect(encryptedValues).toHaveLength(2);
    expect(encryptedValues[1]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(readPromotionMailGatewaySource).not.toHaveBeenCalled();
    expect(ensureMailGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "OHMYHOST_MAIL_KEY" }),
    );
  });

  it("generates and atomically binds one high-entropy storage gateway key", async () => {
    const encryptedValues: string[] = [];
    const { runtime, ensureStorageGateway } = harness({
      cipher: {
        encrypt: vi.fn(async ({ value }: { value: string }) => {
          encryptedValues.push(value);
          return {
            ciphertext: new Uint8Array(59).fill(1),
            nonce: new Uint8Array(12).fill(2),
            valueSha256: new Uint8Array(32).fill(3),
            keyVersion: 1,
          };
        }),
        openEnvironmentSecret: vi.fn(),
      },
    });
    await expect(
      runtime.ensureStorageGatewayKey({
        ...scope,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      }),
    ).resolves.toMatchObject({ name: "OHMYHOST_STORAGE_KEY", revision: 1 });
    expect(encryptedValues[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ensureStorageGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "OHMYHOST_STORAGE_KEY",
        valueSha256: expect.any(Uint8Array),
      }),
    );
    expect(JSON.stringify(ensureStorageGateway.mock.calls)).not.toContain(encryptedValues[0]);
  });

  it("generates and atomically binds one high-entropy AI gateway key", async () => {
    const encryptedValues: string[] = [];
    const { runtime, ensureAiGateway } = harness({
      entropy: {
        fill: (destination: Uint8Array) => globalThis.crypto.getRandomValues(destination),
      },
      cipher: {
        encrypt: vi.fn(async ({ value }: { value: string }) => {
          encryptedValues.push(value);
          return {
            ciphertext: new Uint8Array(80).fill(1),
            nonce: new Uint8Array(12).fill(2),
            valueSha256: new Uint8Array(32).fill(3),
            keyVersion: 1,
          };
        }),
        openEnvironmentSecret: vi.fn(),
      },
    });
    await expect(
      runtime.ensureAiGatewayKey({
        ...scope,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      }),
    ).resolves.toMatchObject({ name: "OHMYHOST_AI_KEY", revision: 1 });
    expect(encryptedValues[0]).toMatch(new RegExp(`^omh_ai_${PROJECT}_[A-Za-z0-9_-]{43}$`, "u"));
    expect(ensureAiGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "OHMYHOST_AI_KEY",
        projectId: PROJECT,
        valueSha256: expect.any(Uint8Array),
      }),
    );
    expect(JSON.stringify(ensureAiGateway.mock.calls)).not.toContain(encryptedValues[0]);

    await runtime.ensureAiGatewayKey({
      ...scope,
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    });
    expect(encryptedValues).toHaveLength(2);
    expect(encryptedValues[1]).not.toBe(encryptedValues[0]);
  });

  it("refuses to generate an AI gateway key without its cipher or persistence", async () => {
    const withoutCipher = harness({ cipher: { openEnvironmentSecret: vi.fn() } });
    await expect(
      withoutCipher.runtime.ensureAiGatewayKey({
        ...scope,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      }),
    ).rejects.toThrow("AI gateway key installation is unavailable");
    expect(withoutCipher.ensureAiGateway).not.toHaveBeenCalled();

    const withoutPersistence = harness();
    Reflect.deleteProperty(withoutPersistence.persistence, "ensureAiGateway");
    await expect(
      withoutPersistence.runtime.ensureAiGatewayKey({
        ...scope,
        claimId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      }),
    ).rejects.toThrow("AI gateway key installation is unavailable");
  });

  it("forwards private binding refresh only through an ordinary authenticated deploy claim", async () => {
    const { runtime, claim, stageVerifiedArtifact } = harness();
    await runtime.stageCandidate({
      scope: wfpScope,
      deploymentId: DEPLOYMENT,
      artifact: { provenance: { artifactDigest: `sha256:${"1".repeat(64)}` } },
      artifactReuse: "binding-refresh",
      knownDeployments: [],
      previousGateway: { active: true },
    });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ trigger: "deploy" }));
    expect(stageVerifiedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactReuse: "binding-refresh",
        previousGateway: { active: true },
        runtimeSecretManifest: expect.objectContaining({ secrets: expect.any(Array) }),
      }),
    );
    const rejected = harness();
    await expect(
      rejected.runtime.stagePromotionCandidate({
        scope: wfpScope,
        deploymentId: DEPLOYMENT,
        artifact: {},
        artifactReuse: "binding-refresh",
        knownDeployments: [],
      }),
    ).rejects.toThrow("input is invalid");
    expect(rejected.claim).not.toHaveBeenCalled();
  });

  it("decrypts only while staging the exact immutable candidate", async () => {
    const { runtime, claim, stageVerifiedArtifact, stageWfp } = harness();

    const result = await runtime.stageCandidate({
      scope: wfpScope,
      deploymentId: DEPLOYMENT,
      artifact: { provenance: { artifactDigest: `sha256:${"1".repeat(64)}` } },
      knownDeployments: [],
      databaseRegistration: { registrationVersion: 1 },
      databaseOriginHost: "ep-runtime.c-5.us-east-2.aws.neon.tech",
      storageDataEnvironmentId: ENVIRONMENT,
    });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        operationId: OPERATION,
        leaseId: LEASE,
        trigger: "deploy",
      }),
    );
    expect(stageVerifiedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: ENVIRONMENT_NAME,
          handle: HANDLE,
        },
        databaseRegistration: { registrationVersion: 1 },
        databaseOriginHost: "ep-runtime.c-5.us-east-2.aws.neon.tech",
        storageDataEnvironmentId: ENVIRONMENT,
        runtimeSecretManifest: {
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          secrets: [
            expect.objectContaining({
              name: "DATABASE_URL",
              value: "postgres://runtime-only",
              revision: 2,
            }),
          ],
        },
      }),
    );
    expect(stageWfp).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "staged",
      candidate: { productDeploymentId: DEPLOYMENT },
      runtimeSecretDelivery: {
        generation: 3,
        secretCount: 1,
        manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      runtimeSecretDeliveryStage: { generation: 3, manifestSecretCount: 1 },
    });
    const staged = await runtime.recordStagedCandidate({
      scope: wfpScope,
      candidate: candidateReceipt(),
      candidateReceiptId: CANDIDATE_RECEIPT,
      runtimeSecretDeliveryStage: requireRecordForTest(result)["runtimeSecretDeliveryStage"],
    });
    expect(staged).toMatchObject({
      status: "recorded",
      runtimeSecretDeliveryStage: { candidateReceiptId: CANDIDATE_RECEIPT },
    });
    expect(stageWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateReceiptId: CANDIDATE_RECEIPT,
        generation: 3,
        appliedSecretNames: ["DATABASE_URL"],
      }),
    );
    expect(JSON.stringify(result)).not.toContain("postgres://runtime-only");
  });

  it("refuses a health-check path that backtracks, in bounded time, as an invalid runtime policy", async () => {
    const { runtime, stageVerifiedArtifact } = harness();
    const stageProvider = stageVerifiedArtifact.getMockImplementation();
    if (stageProvider === undefined) throw new Error("Stage fixture is missing");
    stageVerifiedArtifact.mockImplementation(async (input) => ({
      ...(await stageProvider(input)),
      activationRuntimePolicy: {
        healthCheckPath: `/${"a".repeat(30)}^`,
        egressAllowedOrigins: ["https://api.example.test"],
      },
    }));

    const started = performance.now();
    await expect(
      runtime.stageCandidate({
        scope: wfpScope,
        deploymentId: DEPLOYMENT,
        artifact: {},
        knownDeployments: [],
      }),
    ).rejects.toMatchObject({ code: "runtime_secret_delivery_failed" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([
    "https://intranet",
    "https://api.example.test:8443",
    "https://example.test.",
    "https://my_api.example.test",
  ])(
    "refuses the egress origin %s that the shared DNS rule refuses as an invalid runtime policy",
    async (origin) => {
      const { runtime, stageVerifiedArtifact } = harness();
      const stageProvider = stageVerifiedArtifact.getMockImplementation();
      if (stageProvider === undefined) throw new Error("Stage fixture is missing");
      stageVerifiedArtifact.mockImplementation(async (input) => ({
        ...(await stageProvider(input)),
        activationRuntimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [origin] },
      }));

      await expect(
        runtime.stageCandidate({
          scope: wfpScope,
          deploymentId: DEPLOYMENT,
          artifact: {},
          knownDeployments: [],
        }),
      ).rejects.toMatchObject({ code: "runtime_secret_delivery_failed" });
    },
  );

  it("preserves declared browser capabilities through staging, rollback, activation and observation", async () => {
    const browser = normalizeBrowserPolicy({
      connect: ["https://peer.example.test", "wss://peer.example.test"],
      scripts: ["https://peer.example.test"],
      styles: ["https://peer.example.test"],
      images: ["https://peer.example.test"],
      frames: ["https://peer.example.test"],
      workers: { self: true, blob: false },
      cors: { origins: ["https://app.example.test"], credentials: false },
    });
    const policy = { ...runtimePolicy(), browser };
    const {
      runtime,
      fail,
      stageVerifiedArtifact,
      prepareExistingCandidate,
      activateCandidate,
      observeActivation,
    } = harness();
    const stageProvider = stageVerifiedArtifact.getMockImplementation();
    if (stageProvider === undefined) throw new Error("Stage fixture is missing");
    stageVerifiedArtifact.mockImplementation(async (input) => ({
      ...(await stageProvider(input)),
      activationRuntimePolicy: policy,
    }));
    const prepareProvider = prepareExistingCandidate.getMockImplementation();
    if (prepareProvider === undefined) throw new Error("Preparation fixture is missing");
    prepareExistingCandidate.mockImplementation(async (input) => ({
      ...(await prepareProvider(input)),
      activationRuntimePolicy: policy,
    }));
    const activateProvider = activateCandidate.getMockImplementation();
    if (activateProvider === undefined) throw new Error("Activation fixture is missing");
    activateCandidate.mockImplementation(async (input) => ({
      ...(await activateProvider(input)),
      gateway: gatewayReceipt({ browserPolicy: browser }),
    }));
    const observeProvider = observeActivation.getMockImplementation();
    if (observeProvider === undefined) throw new Error("Observation fixture is missing");
    observeActivation.mockImplementation(async () => ({
      ...(await observeProvider()),
      gateway: gatewayReceipt({ browserPolicy: browser }),
    }));

    const staged = await runtime.stageCandidate({
      scope: wfpScope,
      deploymentId: DEPLOYMENT,
      artifact: {},
      knownDeployments: [],
    });
    expect(staged).toMatchObject({ status: "staged", activationRuntimePolicy: policy });
    const prepared = await runtime.prepareExistingCandidate({
      artifactSourceDeploymentId: DEPLOYMENT,
      scope: wfpScope,
      candidate: candidateReceipt(),
      artifact: {},
    });
    expect(prepared).toMatchObject({ status: "prepared", activationRuntimePolicy: policy });
    await expect(
      runtime.activateCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate: candidateReceipt(),
        runtimePolicy: requireRecordForTest(staged)["activationRuntimePolicy"],
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({ status: "activated" });
    expect(activateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION,
        candidateReceiptId: CANDIDATE_RECEIPT,
        runtimePolicy: policy,
      }),
    );
    await expect(
      runtime.observeActivation({
        scope: wfpScope,
        candidate: candidateReceipt(),
        runtimePolicy: requireRecordForTest(prepared)["activationRuntimePolicy"],
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({ status: "activated", health: { status: 200 } });
    expect(observeActivation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION, runtimePolicy: policy }),
    );
    expect(fail).not.toHaveBeenCalled();
    expect(JSON.stringify([staged, prepared])).not.toContain("postgres://runtime-only");
  });

  it("rejects incomplete or noncanonical browser capabilities without activating a candidate", async () => {
    const browser = normalizeBrowserPolicy({
      connect: ["https://peer.example.test", "wss://peer.example.test"],
      workers: { self: true, blob: false },
    });
    for (const invalid of [
      undefined,
      null,
      { connect: browser.connect },
      { ...browser, unknown: true },
      { ...browser, connect: ["http://peer.example.test"] },
      { ...browser, connect: ["https://peer.example.test/path"] },
      { ...browser, scripts: ["wss://peer.example.test"] },
      { ...browser, connect: ["wss://peer.example.test", "https://peer.example.test"] },
      { ...browser, connect: ["https://peer.example.test", "https://peer.example.test"] },
      { ...browser, workers: { self: true } },
      { ...browser, cors: { ...browser.cors, unknown: true } },
    ]) {
      const policy = { ...runtimePolicy(), browser: invalid };
      const { runtime, fail, stageWfp, stageVerifiedArtifact, activateCandidate } = harness();
      const stageProvider = stageVerifiedArtifact.getMockImplementation();
      if (stageProvider === undefined) throw new Error("Stage fixture is missing");
      stageVerifiedArtifact.mockImplementation(async (input) => ({
        ...(await stageProvider(input)),
        activationRuntimePolicy: policy,
      }));
      await expect(
        runtime.stageCandidate({
          scope: wfpScope,
          deploymentId: DEPLOYMENT,
          artifact: {},
          knownDeployments: [],
        }),
      ).rejects.toMatchObject({ code: "runtime_secret_delivery_failed" });
      expect(stageVerifiedArtifact).toHaveBeenCalledOnce();
      expect(stageWfp).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith(
        expect.objectContaining({ code: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN" }),
      );
      await expect(
        runtime.activateCandidate({
          claimId: CLAIM,
          scope: wfpScope,
          candidate: candidateReceipt(),
          runtimePolicy: policy,
          runtimeSecretDeliveryStage: recordedStage(),
        }),
      ).rejects.toThrow();
      expect(activateCandidate).not.toHaveBeenCalled();
    }
    for (const invalidGateway of [
      gatewayReceipt({
        browserPolicy: { ...browser, cors: { origins: [], credentials: "must-not-escape" } },
      }),
      gatewayReceipt({ browserPolicy: { ...browser, password: "must-not-escape" } }),
      gatewayReceipt({ browserPolicy: browser, credential: "must-not-escape" }),
    ]) {
      const { runtime, activateCandidate } = harness();
      activateCandidate.mockResolvedValueOnce({
        status: "activated",
        candidate: candidateReceipt(),
        gateway: invalidGateway,
        deploymentUrl: `https://dev-${HANDLE}.dev.check.omh.st`,
      });
      const error = await runtime
        .activateCandidate({
          claimId: CLAIM,
          scope: wfpScope,
          candidate: candidateReceipt(),
          runtimePolicy: { ...runtimePolicy(), browser },
          runtimeSecretDeliveryStage: recordedStage(),
        })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: "runtime_secret_delivery_failed" });
      expect(String(error)).not.toContain("must-not-escape");
    }
  });

  it("stages promotion secrets under the exact promotion claim and DB trigger", async () => {
    const { runtime, claim, stageWfp, stageVerifiedArtifact } = harness();
    const promoted = await runtime.stagePromotionCandidate({
      scope: wfpScope,
      deploymentId: DEPLOYMENT,
      artifact: { provenance: { artifactDigest: `sha256:${"1".repeat(64)}` } },
      artifactReuse: "promotion",
      knownDeployments: [],
    });
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "promotion", operationId: OPERATION }),
    );
    const pending = requireRecordForTest(promoted)["runtimeSecretDeliveryStage"];
    expect(pending).toMatchObject({ trigger: "promotion" });
    expect(stageVerifiedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifactReuse: "promotion" }),
    );

    await runtime.recordStagedCandidate({
      scope: wfpScope,
      candidate: candidateReceipt(),
      candidateReceiptId: CANDIDATE_RECEIPT,
      runtimeSecretDeliveryStage: pending,
    });
    expect(stageWfp).toHaveBeenCalledWith(expect.objectContaining({ trigger: "promotion" }));
  });

  it("rejects incomplete or cross-scope candidates before provider calls", async () => {
    const { runtime, claim, stageVerifiedArtifact, activateCandidate } = harness();
    const secretMarker = "secret-marker.example";

    for (const invalidScope of [
      {
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        operationId: OPERATION,
      },
      { ...wfpScope, environmentName: "stage" },
      { ...wfpScope, handle: `calm-${secretMarker}-waves` },
      { ...wfpScope, extra: true },
    ]) {
      const error = await runtime
        .stageCandidate({
          scope: invalidScope,
          deploymentId: DEPLOYMENT,
          artifact: {},
          knownDeployments: [],
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toBe("TypeError: Runtime secret delivery scope is invalid");
      expect(String(error)).not.toContain(secretMarker);
    }
    expect(claim).not.toHaveBeenCalled();
    expect(stageVerifiedArtifact).not.toHaveBeenCalled();

    await expect(
      runtime.activateCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate: candidateReceipt({ projectId: "01ARZ3NDEKTSV4RRFFQ69G5FC0" }),
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).rejects.toThrow("candidate receipt is invalid");
    expect(activateCandidate).not.toHaveBeenCalled();

    await expect(
      runtime.compensateGatewayActivation({
        claimId: CLAIM,
        scope: wfpScope,
        candidate: candidateReceipt(),
        expectedGateway: gatewayReceipt({ targetProviderTag: "different" }),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).rejects.toThrow("gateway target is invalid");
  });

  it("records uncertain stage state without returning plaintext", async () => {
    const stageVerifiedArtifact = vi.fn(async () => ({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: "postgres://must-not-escape",
      currentProductDeploymentId: "secret-deployment",
    }));
    const { runtime, fail } = harness({
      wfp: {
        stageVerifiedArtifact,
        prepareExistingCandidate: vi.fn(),
        activateCandidate: vi.fn(),
        compensateGatewayActivation: vi.fn(),
        compensateActivation: vi.fn(),
        removeCandidate: vi.fn(),
        observeActivation: vi.fn(),
        syncRuntimeSecrets: vi.fn(),
      },
    });

    const result = await runtime.stageCandidate({
      scope: wfpScope,
      deploymentId: DEPLOYMENT,
      artifact: {},
      knownDeployments: [],
    });

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: LEASE,
        generation: 3,
        code: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("postgres://runtime-only");
    expect(result).toMatchObject({
      currentProviderTag: null,
      currentProductDeploymentId: null,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("releases the claim without a failure code when the provider rejects the candidate", async () => {
    const stageVerifiedArtifact = vi.fn(async () => ({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
    }));
    const { runtime, fail, release } = harness({
      wfp: {
        stageVerifiedArtifact,
        prepareExistingCandidate: vi.fn(),
        activateCandidate: vi.fn(),
        compensateGatewayActivation: vi.fn(),
        compensateActivation: vi.fn(),
        removeCandidate: vi.fn(),
        observeActivation: vi.fn(),
        syncRuntimeSecrets: vi.fn(),
      },
    });

    const result = await runtime.stageCandidate({
      scope: wfpScope,
      deploymentId: DEPLOYMENT,
      artifact: {},
      knownDeployments: [],
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "script_rejected",
      providerStatus: 400,
      providerCode: 10021,
    });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: LEASE, generation: 3, releaseSequence: 1 }),
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("keeps activation, compensation, observation, and removal credential-free", async () => {
    const candidate = candidateReceipt();
    const gateway = gatewayReceipt();
    const {
      runtime,
      activateCandidate,
      compensateActivation,
      compensateGatewayActivation,
      removeCandidate,
      observeActivation,
      activateWfp,
      compensateWfp,
    } = harness();

    await expect(
      runtime.activateCandidate({
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).rejects.toThrow("input is invalid");
    expect(activateCandidate).not.toHaveBeenCalled();
    const activated = await runtime.activateCandidate({
      claimId: CLAIM,
      scope: wfpScope,
      candidate,
      runtimePolicy: runtimePolicy(),
      runtimeSecretDeliveryStage: recordedStage(),
    });
    expect(activated).toMatchObject({ status: "activated" });
    expect(activateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION,
        operationId: OPERATION,
        claimId: CLAIM,
        candidateReceiptId: CANDIDATE_RECEIPT,
      }),
    );
    expect(activateWfp).not.toHaveBeenCalled();
    activateCandidate.mockResolvedValueOnce({
      status: "unhealthy",
      candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
      health: { status: 500, path: "/", excerpt: null, truncated: false },
    } as never);
    await expect(
      runtime.activateCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
      health: { status: 500, path: "/", excerpt: null, truncated: false },
    });
    await expect(
      runtime.recordActivatedCandidate({
        scope: wfpScope,
        candidate,
        gateway,
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({ status: "activated" });
    expect(activateWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        stageReceiptId: STAGE_RECEIPT,
        candidateReceiptId: CANDIDATE_RECEIPT,
        gateway,
        candidateScriptName: candidate.scriptName,
        candidateProviderTag: candidate.providerTag,
        candidateArtifactDigest: expect.any(Uint8Array),
      }),
    );
    await expect(
      runtime.observeActivation({
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({
      status: "activated",
      deploymentUrl: `https://dev-${HANDLE}.dev.check.omh.st`,
    });
    expect(observeActivation).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: HANDLE,
      },
      candidate,
      runtimePolicy: runtimePolicy(),
    });
    observeActivation.mockResolvedValueOnce({
      status: "unhealthy",
      candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
      health: { status: 500, path: "/", excerpt: null, truncated: false },
    });
    await expect(
      runtime.observeActivation({
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      candidate,
      gateway,
      deploymentUrl: gateway.publicOrigin,
      health: { status: 500, path: "/", excerpt: null, truncated: false },
    });
    observeActivation.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: candidate.providerTag,
      currentProductDeploymentId: candidate.productDeploymentId,
    } as never);
    await expect(
      runtime.observeActivation({
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: candidate.providerTag,
      currentProductDeploymentId: candidate.productDeploymentId,
    });
    // The route is restored under the operation's claim and the candidate removed under its cleanup
    // claim; WFP management authorizes each against its own record, so neither may be missing.
    await expect(
      runtime.compensateActivation({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        expectedGateway: gateway,
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).rejects.toThrow("Runtime secret delivery input is invalid");
    expect(compensateActivation).not.toHaveBeenCalled();
    await expect(
      runtime.compensateActivation({
        claimId: CLAIM,
        cleanupClaimId: CLEANUP_CLAIM,
        scope: wfpScope,
        candidate,
        expectedGateway: gateway,
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({ status: "compensated" });
    expect(compensateActivation).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: CLAIM, cleanupClaimId: CLEANUP_CLAIM }),
    );
    expect(compensateWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        stageReceiptId: STAGE_RECEIPT,
        candidateReceiptId: CANDIDATE_RECEIPT,
        failureCode: "ACTIVATION_COMPENSATED",
      }),
    );
    await expect(
      runtime.compensateGatewayActivation({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        expectedGateway: gateway,
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({ status: "compensated" });
    await expect(
      runtime.removeCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        runtimeSecretDeliveryStage: recordedStage(),
      }),
    ).resolves.toMatchObject({ state: "metadata_absent" });
    const calls = JSON.stringify([
      activateCandidate.mock.calls,
      compensateActivation.mock.calls,
      compensateGatewayActivation.mock.calls,
      removeCandidate.mock.calls,
      observeActivation.mock.calls,
    ]);
    expect(calls).not.toMatch(/runtime-only|runtimeSecretManifest|DATABASE_URL/u);
  });

  it("rejects extra receipt/result keys and allowlists provider error codes", async () => {
    const candidate = candidateReceipt();
    const { runtime, activateCandidate } = harness();

    const inputError = await runtime
      .activateCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate: { ...candidate, harmless: "postgres://must-not-escape" },
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      })
      .catch((error: unknown) => error);
    expect(inputError).toBeInstanceOf(TypeError);
    expect(String(inputError)).not.toContain("must-not-escape");
    expect(activateCandidate).not.toHaveBeenCalled();

    activateCandidate.mockResolvedValueOnce({
      status: "activated",
      candidate,
      gateway: gatewayReceipt(),
      deploymentUrl: `https://dev-${HANDLE}.dev.check.omh.st`,
      note: [{ token: "postgres://must-not-escape" }],
    } as never);
    const resultError = await runtime
      .activateCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      })
      .catch((error: unknown) => error);
    expect(resultError).toMatchObject({ code: "runtime_secret_delivery_failed" });
    expect(String(resultError)).not.toContain("must-not-escape");

    activateCandidate.mockRejectedValueOnce(
      Object.assign(new Error("secret"), { code: "postgres://secret-in-code" }),
    );
    const codeError = await runtime
      .activateCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        runtimePolicy: runtimePolicy(),
        runtimeSecretDeliveryStage: recordedStage(),
      })
      .catch((error: unknown) => error);
    expect(codeError).toMatchObject({ code: "runtime_secret_delivery_failed" });
    expect(JSON.stringify(codeError)).not.toContain("secret-in-code");
  });

  it("canonicalizes credential-free activation reconciliation", async () => {
    const { runtime, activateCandidate } = harness();
    activateCandidate.mockResolvedValueOnce({
      status: "reconciliation_required",
      reconciliationPhase: "health",
      currentProviderTag: gatewayReceipt().targetProviderTag,
      currentProductDeploymentId: DEPLOYMENT,
      gateway: null,
    } as never);
    const healthReconciliation = await runtime.activateCandidate({
      claimId: CLAIM,
      scope: wfpScope,
      candidate: candidateReceipt(),
      runtimePolicy: runtimePolicy(),
      runtimeSecretDeliveryStage: recordedStage(),
    });
    expect(healthReconciliation).toMatchObject({
      status: "reconciliation_required",
      reconciliationPhase: "health",
      currentProductDeploymentId: DEPLOYMENT,
      gateway: null,
    });
    expect(healthReconciliation).not.toHaveProperty("reason");

    const outdated = {
      status: "reconciliation_required",
      reconciliationPhase: "candidate",
      currentProviderTag: candidateReceipt().providerTag,
      currentProductDeploymentId: DEPLOYMENT,
      reason: "candidate_bindings_outdated",
    };
    const actions = [
      {
        provider: "stageVerifiedArtifact",
        consumer: "stageCandidate",
        input: { scope: wfpScope, deploymentId: DEPLOYMENT, artifact: {}, knownDeployments: [] },
      },
      {
        provider: "prepareExistingCandidate",
        consumer: "prepareExistingCandidate",
        input: {
          scope: wfpScope,
          candidate: candidateReceipt(),
          artifact: {},
          artifactSourceDeploymentId: DEPLOYMENT,
        },
      },
      {
        provider: "activateCandidate",
        consumer: "activateCandidate",
        input: {
          claimId: CLAIM,
          scope: wfpScope,
          candidate: candidateReceipt(),
          runtimePolicy: runtimePolicy(),
          runtimeSecretDeliveryStage: recordedStage(),
        },
      },
      {
        provider: "observeActivation",
        consumer: "observeActivation",
        input: {
          scope: wfpScope,
          candidate: candidateReceipt(),
          runtimePolicy: runtimePolicy(),
          runtimeSecretDeliveryStage: recordedStage(),
        },
      },
    ] as const;
    for (const action of actions) {
      const accepted = harness();
      accepted[action.provider].mockResolvedValueOnce(outdated as never);
      await expect(accepted.runtime[action.consumer](action.input)).resolves.toMatchObject({
        ...outdated,
      });
      expect(accepted.stageWfp).not.toHaveBeenCalled();
      expect(accepted.activateWfp).not.toHaveBeenCalled();
      expect(accepted.compensateWfp).not.toHaveBeenCalled();

      for (const invalid of [
        { ...outdated, reason: undefined },
        { ...outdated, reason: null },
        { ...outdated, reason: "postgres://must-not-escape" },
        { ...outdated, reconciliationPhase: "secrets" },
        { ...outdated, reconciliationPhase: "database" },
        { ...outdated, reconciliationPhase: "gateway" },
        { ...outdated, reconciliationPhase: "health" },
      ]) {
        const rejected = harness();
        rejected[action.provider].mockResolvedValueOnce(invalid as never);
        const error = await rejected.runtime[action.consumer](action.input).catch((value) => value);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain("must-not-escape");
        expect(rejected.stageWfp).not.toHaveBeenCalled();
        expect(rejected.activateWfp).not.toHaveBeenCalled();
        expect(rejected.compensateWfp).not.toHaveBeenCalled();
      }
      for (const reason of [undefined, "candidate_bindings_outdated"]) {
        const rejected = harness();
        const original = rejected[action.provider].getMockImplementation();
        if (original === undefined) throw new Error("Provider fixture is missing");
        rejected[action.provider].mockImplementationOnce((async (input: unknown) => ({
          ...(await original(input)),
          reason,
        })) as never);
        await expect(rejected.runtime[action.consumer](action.input)).rejects.toBeInstanceOf(Error);
      }
    }

    for (const action of ["activateCandidate", "observeActivation"] as const) {
      const accepted = harness();
      accepted[action].mockResolvedValueOnce({ ...outdated, gateway: gatewayReceipt() } as never);
      await expect(
        accepted.runtime[action]({
          ...(action === "activateCandidate" ? { claimId: CLAIM } : {}),
          scope: wfpScope,
          candidate: candidateReceipt(),
          runtimePolicy: runtimePolicy(),
          runtimeSecretDeliveryStage: recordedStage(),
        }),
      ).resolves.toMatchObject({ reason: outdated.reason, gateway: gatewayReceipt() });
      for (const gateway of [
        gatewayReceipt({ projectId: ORGANIZATION }),
        gatewayReceipt({ targetProviderTag: "d".repeat(32) }),
      ]) {
        const rejected = harness();
        rejected[action].mockResolvedValueOnce({ ...outdated, gateway } as never);
        await expect(
          rejected.runtime[action]({
            ...(action === "activateCandidate" ? { claimId: CLAIM } : {}),
            scope: wfpScope,
            candidate: candidateReceipt(),
            runtimePolicy: runtimePolicy(),
            runtimeSecretDeliveryStage: recordedStage(),
          }),
        ).rejects.toBeInstanceOf(Error);
      }
    }
    for (const action of [
      "compensateActivation",
      "compensateGatewayActivation",
      "removeCandidate",
    ] as const) {
      const rejected = harness();
      rejected[action].mockResolvedValueOnce(outdated as never);
      await expect(
        rejected.runtime[action]({
          claimId: CLAIM,
          ...(action === "compensateActivation" ? { cleanupClaimId: CLEANUP_CLAIM } : {}),
          ...(action === "removeCandidate" ? {} : { expectedGateway: gatewayReceipt() }),
          scope: wfpScope,
          candidate: candidateReceipt(),
          runtimeSecretDeliveryStage: recordedStage(),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(rejected.compensateWfp).not.toHaveBeenCalled();
    }
  });

  it("removes a persisted staged candidate and requeues secrets across crash replay", async () => {
    const candidate = candidateReceipt();
    const { runtime, readRecordedWfpStage, removeCandidate, compensateWfp } = harness();

    await expect(
      runtime.removePersistedCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        candidateReceiptId: CANDIDATE_RECEIPT,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      outcome: "removed",
      state: "metadata_absent",
      runtimeSecretDeliveryCompensation: { outcome: "compensated" },
    });
    expect(readRecordedWfpStage).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentName: "dev",
      candidateReceiptId: CANDIDATE_RECEIPT,
    });
    expect(removeCandidate).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      operationId: OPERATION,
      claimId: CLAIM,
      candidateReceiptId: CANDIDATE_RECEIPT,
      scope: {
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        environmentName: "dev",
        handle: HANDLE,
      },
      candidate,
    });
    expect(compensateWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        stageReceiptId: STAGE_RECEIPT,
        candidateReceiptId: CANDIDATE_RECEIPT,
        failureCode: "CANDIDATE_REMOVED",
      }),
    );

    vi.mocked(compensateWfp).mockResolvedValueOnce({
      outcome: "existing",
      compensationReceiptId: STAGE_RECEIPT,
      compensatedAt: "2026-08-21T00:00:01.000Z",
    } as never);
    await expect(
      runtime.removePersistedCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        candidateReceiptId: CANDIDATE_RECEIPT,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      runtimeSecretDeliveryCompensation: {
        outcome: "existing",
        compensatedAt: "2026-08-21T00:00:01.000Z",
      },
    });

    vi.mocked(readRecordedWfpStage).mockResolvedValueOnce(
      recordedStage({ candidateReceiptId: "01ARZ3NDEKTSV4RRFFQ69G5FC4", outcome: "existing" }),
    );
    const before = vi.mocked(removeCandidate).mock.calls.length;
    await expect(
      runtime.removePersistedCandidate({
        claimId: CLAIM,
        scope: wfpScope,
        candidate,
        candidateReceiptId: CANDIDATE_RECEIPT,
      }),
    ).rejects.toThrow("stage is invalid");
    expect(removeCandidate).toHaveBeenCalledTimes(before);
  });

  it("prepares an existing rollback candidate with current secrets without uploading code", async () => {
    for (const artifactSourceDeploymentId of [undefined, "invalid"]) {
      const rejected = harness();
      await expect(
        rejected.runtime.prepareExistingCandidate({
          scope: wfpScope,
          candidate: candidateReceipt(),
          artifact: { provenance: { deploymentId: DEPLOYMENT } },
          artifactSourceDeploymentId,
        }),
      ).rejects.toThrow();
      expect(rejected.claim).not.toHaveBeenCalled();
    }
    const { runtime, claim, prepareExistingCandidate, stageWfp } = harness();
    const result = await runtime.prepareExistingCandidate({
      artifactSourceDeploymentId: DEPLOYMENT,
      scope: wfpScope,
      candidate: candidateReceipt(),
      artifact: { provenance: { deploymentId: DEPLOYMENT } },
      storageDataEnvironmentId: ENVIRONMENT,
    });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "rollback", operationId: OPERATION }),
    );
    expect(prepareExistingCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactSourceDeploymentId: DEPLOYMENT,
        organizationId: ORGANIZATION,
        scope: {
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: "dev",
          handle: HANDLE,
        },
        candidate: candidateReceipt(),
        storageDataEnvironmentId: ENVIRONMENT,
        runtimeSecretManifest: expect.objectContaining({
          secrets: [expect.objectContaining({ value: "postgres://runtime-only" })],
        }),
      }),
    );
    expect(result).toMatchObject({
      status: "prepared",
      candidate: { productDeploymentId: DEPLOYMENT },
      runtimeSecretDelivery: {
        generation: 3,
        secretCount: 1,
        manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
      runtimeSecretDeliveryStage: { generation: 3, manifestSecretCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("postgres://runtime-only");
    expect(stageWfp).not.toHaveBeenCalled();
  });

  it("redacts stage provider failures after recording durable reconciliation state", async () => {
    const { runtime, fail } = harness({
      wfp: {
        stageVerifiedArtifact: vi.fn(async () => {
          throw Object.assign(new Error("postgres://runtime-only"), {
            code: "cloudflare_request_failed",
          });
        }),
        prepareExistingCandidate: vi.fn(),
        activateCandidate: vi.fn(),
        compensateGatewayActivation: vi.fn(),
        compensateActivation: vi.fn(),
        removeCandidate: vi.fn(),
        observeActivation: vi.fn(),
        syncRuntimeSecrets: vi.fn(),
      },
    });

    const error = await runtime
      .stageCandidate({
        scope: wfpScope,
        deploymentId: DEPLOYMENT,
        artifact: {},
        knownDeployments: [],
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "cloudflare_request_failed" });
    expect(String(error)).not.toContain("postgres://runtime-only");
    expect(fail).toHaveBeenCalledOnce();
  });

  it("processes a bounded scheduled batch and completes WFP through Stage/Activation", async () => {
    // A user secret's stored digest is keyed, so the manifest must take its digest from the plaintext.
    const encrypted = {
      name: "DATABASE_URL",
      revision: 2,
      keyVersion: 1,
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12).fill(2),
      valueSha256: new Uint8Array(32).fill(9),
    };
    const plainDigest = createHash("sha256").update("postgres://runtime-only").digest("hex");
    const manifestSha256 = new Uint8Array(
      createHash("sha256")
        .update(`ohmyhost-runtime-secret-manifest-v1\nDATABASE_URL\t2\tsha256:${plainDigest}\n`)
        .digest(),
    );
    const readPending = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: PROD_ENVIRONMENT,
          environmentName: "prod",
          handle: HANDLE,
          desiredGeneration: 0,
          appliedGeneration: 0,
        },
        {
          organizationId: ORGANIZATION,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          environmentName: ENVIRONMENT_NAME,
          handle: HANDLE,
          desiredGeneration: 4,
          appliedGeneration: 3,
          runtimeProvider: "wfp" as const,
        },
      ]);
    const claimed = {
      outcome: "claimed" as const,
      generation: 4,
      releaseSequence: 4,
      trigger: "reconcile" as const,
      runtimeProvider: "wfp" as const,
      leaseId: LEASE,
      leaseExpiresAt: "2026-08-21T00:01:00.000Z",
      providerTag: "c".repeat(32),
      appliedSecretNames: ["RETIRED_SECRET"],
      secrets: [encrypted],
    };
    const claim = vi.fn(async (input: unknown) => {
      void input;
      return claimed;
    });
    const stageWfp = vi.fn(async () => ({ outcome: "staged" as const, stageReceiptId: LEASE }));
    const activateWfp = vi.fn(async () => ({
      outcome: "activated" as const,
      activationReceiptId: LEASE,
      activatedAt: NOW.toISOString(),
    }));
    const syncRuntimeSecrets = vi.fn(async (input: unknown) => {
      const value = input as { runtimeSecretManifest: { digest: string } };
      return {
        status: "synchronized",
        receipt: {
          manifestDigest: value.runtimeSecretManifest.digest,
          secretNames: ["DATABASE_URL"],
          providerTag: "c".repeat(32),
        },
      };
    });
    const runtime = createRuntimeSecretDelivery({
      persistence: {
        claim,
        fail: vi.fn(),
        release: vi.fn(async () => "released" as const),
        readPending,
        recordPendingAttempt: vi.fn(async () => undefined),
        readState: vi.fn(async (input: { environmentId: string }) =>
          input.environmentId === PROD_ENVIRONMENT
            ? undefined
            : {
                runtimeProvider: "wfp",
                providerTag: "c".repeat(32),
                manifestSha256,
                manifestSecretCount: 1,
                appliedSecretNames: ["DATABASE_URL"],
              },
        ),
        stageWfp,
        activateWfp,
        compensateWfp: vi.fn(),
        readActiveWfpTarget: vi.fn(async () => activeWfpTarget()),
      },
      cipher: { openEnvironmentSecret: vi.fn(async () => "postgres://runtime-only") },
      wfp: {
        stageVerifiedArtifact: vi.fn(),
        prepareExistingCandidate: vi.fn(),
        activateCandidate: vi.fn(),
        compensateGatewayActivation: vi.fn(),
        compensateActivation: vi.fn(),
        removeCandidate: vi.fn(),
        observeActivation: vi.fn(),
        syncRuntimeSecrets,
      },
      ids: { next: () => LEASE },
      clock: { now: () => new Date("2026-08-21T00:00:00.000Z") },
      entropy: { fill: (destination: Uint8Array) => destination.fill(7) },
    } as never);

    await expect(runtime.syncPendingOne()).resolves.toEqual({ status: "idle" });
    await expect(runtime.syncPendingOne()).resolves.toEqual({
      status: "processed",
      attempted: 2,
      synchronized: 1,
      deferred: 1,
      failed: 0,
    });
    expect(readPending).toHaveBeenLastCalledWith({
      now: "2026-08-21T00:00:00.000Z",
      limit: 10,
    });
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ trigger: "reconcile" }));
    expect(claim.mock.calls[0]?.[0]).not.toHaveProperty("operationId");
    expect(syncRuntimeSecrets).not.toHaveBeenCalled();
    expect(stageWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 4,
        trigger: "reconcile",
        candidateReceiptId: CANDIDATE_RECEIPT,
      }),
    );
    expect(activateWfp).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateReceiptId: CANDIDATE_RECEIPT,
        gateway: expect.objectContaining({ targetScriptName: candidateReceipt().scriptName }),
      }),
    );
  });

  it("rotates WFP secrets only against an exact active immutable receipt", async () => {
    const syncRuntimeSecrets = vi
      .fn(async (input: unknown) => {
        const value = input as { runtimeSecretManifest: { digest: string } };
        return {
          status: "synchronized",
          receipt: {
            manifestDigest: value.runtimeSecretManifest.digest,
            secretNames: ["DATABASE_URL"],
            providerTag: "d".repeat(32),
          },
        };
      })
      .mockRejectedValueOnce(new Error("provider uncertain"));
    const { runtime, claim, fail, stageWfp, activateWfp, readActiveWfpTarget } = harness({
      wfp: {
        stageVerifiedArtifact: vi.fn(),
        prepareExistingCandidate: vi.fn(),
        activateCandidate: vi.fn(),
        compensateGatewayActivation: vi.fn(),
        compensateActivation: vi.fn(),
        removeCandidate: vi.fn(),
        observeActivation: vi.fn(),
        syncRuntimeSecrets,
      },
    });
    // A rollback routes the original candidate under the rollback operation's receipt.
    readActiveWfpTarget.mockResolvedValue({
      ...activeWfpTarget(),
      gateway: gatewayReceipt({ operationId: "00000000000000000000000009" }),
    });

    await expect(
      runtime.reconcileRuntimeSecrets({
        scope: wfpScope,
        expectedDeployment: candidateReceipt(),
      }),
    ).rejects.toThrow("Runtime secret delivery failed");
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "WFP_RUNTIME_SECRET_RESULT_UNCERTAIN" }),
    );

    await expect(
      runtime.reconcileRuntimeSecrets({
        scope: wfpScope,
        expectedDeployment: candidateReceipt(),
      }),
    ).resolves.toMatchObject({ status: "synchronized", generation: 3, secretCount: 1 });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "reconcile",
        force: true,
        runtimeProvider: "wfp",
      }),
    );
    expect(claim.mock.calls[0]?.[0]).not.toHaveProperty("operationId");
    expect(syncRuntimeSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION,
        expectedDeployment: candidateReceipt(),
      }),
    );
    expect(stageWfp).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerTag: "d".repeat(32) }),
    );
    expect(activateWfp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateProviderTag: "d".repeat(32),
        gateway: expect.objectContaining({ targetProviderTag: candidateReceipt().providerTag }),
      }),
    );
    await expect(
      runtime.reconcileRuntimeSecrets({
        scope: wfpScope,
        expectedDeployment: candidateReceipt(),
        extra: true,
      }),
    ).rejects.toThrow("input is invalid");
  });
});

describe("pending batch isolation", () => {
  it("skips a pending row whose scope cannot be read and still syncs the rows behind it", async () => {
    const pendingScope = (
      environmentId: string,
      environmentName: "dev" | "prod",
      handle: string,
    ) => ({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId,
      environmentName,
      handle,
      desiredGeneration: 1,
      appliedGeneration: 0,
    });
    const recordPendingAttempt = vi.fn(async () => undefined);
    const runtime = createRuntimeSecretDelivery({
      persistence: {
        claim: vi.fn(),
        fail: vi.fn(),
        release: vi.fn(),
        // The first row cannot be read at all; the second is a scope without a runtime, which only defers.
        readPending: vi.fn(async () => [
          pendingScope(ENVIRONMENT, ENVIRONMENT_NAME, "Not A Handle"),
          pendingScope(PROD_ENVIRONMENT, "prod", HANDLE),
        ]),
        recordPendingAttempt,
        readState: vi.fn(async () => undefined),
        readActiveWfpTarget: vi.fn(),
      },
      cipher: { openEnvironmentSecret: vi.fn() },
      wfp: {
        stageVerifiedArtifact: vi.fn(),
        prepareExistingCandidate: vi.fn(),
        activateCandidate: vi.fn(),
        compensateGatewayActivation: vi.fn(),
        compensateActivation: vi.fn(),
        removeCandidate: vi.fn(),
        observeActivation: vi.fn(),
        syncRuntimeSecrets: vi.fn(),
      },
      ids: { next: () => LEASE },
      clock: { now: () => NOW },
      entropy: { fill: (destination: Uint8Array) => destination.fill(7) },
    } as never);

    await expect(runtime.syncPendingOne()).resolves.toEqual({
      status: "processed",
      attempted: 2,
      synchronized: 0,
      deferred: 1,
      failed: 1,
    });
    expect(recordPendingAttempt).toHaveBeenCalledWith({
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: PROD_ENVIRONMENT,
      now: NOW.toISOString(),
    });
  });
});

describe("pending attempt stamp isolation", () => {
  it("keeps a delivery's outcome when recording its attempt fails, and logs the failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const runtime = createRuntimeSecretDelivery({
        persistence: {
          claim: vi.fn(),
          fail: vi.fn(),
          release: vi.fn(),
          readPending: vi.fn(async () => [
            {
              organizationId: ORGANIZATION,
              projectId: PROJECT,
              environmentId: PROD_ENVIRONMENT,
              environmentName: "prod",
              handle: HANDLE,
              desiredGeneration: 1,
              appliedGeneration: 0,
            },
          ]),
          recordPendingAttempt: vi.fn(async () => {
            throw new Error("stamp unavailable");
          }),
          readState: vi.fn(async () => undefined),
          readActiveWfpTarget: vi.fn(),
        },
        cipher: { openEnvironmentSecret: vi.fn() },
        wfp: {
          stageVerifiedArtifact: vi.fn(),
          prepareExistingCandidate: vi.fn(),
          activateCandidate: vi.fn(),
          compensateGatewayActivation: vi.fn(),
          compensateActivation: vi.fn(),
          removeCandidate: vi.fn(),
          observeActivation: vi.fn(),
          syncRuntimeSecrets: vi.fn(),
        },
        ids: { next: () => LEASE },
        clock: { now: () => NOW },
        entropy: { fill: (destination: Uint8Array) => destination.fill(7) },
      } as never);

      // The scope has no provider runtime, so the attempt defers it; a failed stamp must not turn that into a failure.
      await expect(runtime.syncPendingOne()).resolves.toEqual({
        status: "processed",
        attempted: 1,
        synchronized: 0,
        deferred: 1,
        failed: 0,
      });
      expect(errors).toHaveBeenCalledWith("runtime_secret_attempt_unrecorded", "stamp unavailable");
    } finally {
      errors.mockRestore();
    }
  });
});
