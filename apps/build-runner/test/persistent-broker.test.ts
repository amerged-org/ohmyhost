import { describe, expect, it, vi } from "vitest";

import {
  BuildBrokerCapacityError,
  BuildBrokerConflictError,
  BuildBrokerTransportError,
  BuildBrokerUncertainError,
  fingerprintBuildStartInput,
  type BuildReceipt,
  type RecoverableBuildBroker,
} from "@ohmyhost/build-broker";

import {
  BuildStartAbsentError,
  createPersistingBuildBroker,
  type BuildReceiptPersistence,
  type PersistingBuildBrokerOptions,
} from "../src/persistent-broker.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const START_ALLOWED_UNTIL = new Date(NOW.getTime() + 4 * 60_000);
const LEASE_EXPIRES_AT = new Date(NOW.getTime() + 60_000);
const CLAIM_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
] as const;

const scope = Object.freeze({
  projectId: "01J00000000000000000000001",
  environmentId: "01J00000000000000000000002",
  operationId: "01J00000000000000000000003",
});
const receipt: BuildReceipt = Object.freeze({
  buildId: "fixed-project:build-1",
  projectName: "fixed-project",
  scope,
});
const usage = Object.freeze({
  runner: "cloudflare-build-sandbox" as const,
  instanceType: "standard-3",
  status: "SUCCEEDED" as const,
  startedAt: NOW.toISOString(),
  provisioningStartedAt: new Date(NOW.getTime() + 800).toISOString(),
  completedAt: new Date(NOW.getTime() + 117_286).toISOString(),
});
const frameworkPlan = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: ".",
  adapter: "vite-static",
  runtime: "static",
  installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
  buildCommand: "pnpm run build",
  outputDirectory: "dist",
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
} as unknown as Parameters<RecoverableBuildBroker["startBuild"]>[0]["frameworkPlan"];
const input: Parameters<RecoverableBuildBroker["startBuild"]>[0] = {
  scope,
  archive: {
    bucket: "bucket",
    key: `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/input/source.tar.gz`,
    versionId: "version",
    eTag: '"object"',
    byteLength: 3,
    scope,
    sourceSha256: "b".repeat(64),
  },
  commitSha: "c".repeat(40),
  deploymentId: "01J00000000000000000000004",
  buildPlanSha256: "61530b251355acd239d65eea44adecfa6f808412316cafa538f360ee962a2b6f",
  frameworkPlan,
};

function setup(
  overrides: Partial<BuildReceiptPersistence> = {},
  optionOverrides: Partial<PersistingBuildBrokerOptions> = {},
) {
  const broker: RecoverableBuildBroker = {
    beginArchive: vi.fn(async () => ({ bucket: "bucket", key: "key", uploadId: "upload", scope })),
    uploadArchivePart: vi.fn(async () => ({
      partNumber: 1,
      eTag: '"part"',
      checksumSha256: "a".repeat(64),
    })),
    completeArchive: vi.fn(async () => ({
      bucket: "bucket",
      key: "key",
      versionId: "version",
      eTag: '"object"',
      byteLength: 3,
      scope,
      sourceSha256: "b".repeat(64),
    })),
    abortArchive: vi.fn(async () => undefined),
    observeArchive: vi.fn(async () => null),
    removeArchive: vi.fn(async () => ({
      state: "absent" as const,
      scope,
      key: "runs/source",
      versionId: "version",
    })),
    startBuild: vi.fn(async () => receipt),
    observeBuildStart: vi.fn(async () => ({ state: "absent" as const })),
    readBuild: vi.fn(async () => ({
      ...receipt,
      status: "succeeded" as const,
      usage,
      failure: null,
    })),
    stopBuild: vi.fn(async () => undefined),
    observeBuildArtifact: vi.fn(async () => null),
    readBuildArtifact: vi.fn(async () => {
      throw new Error("not used");
    }),
    removeBuildArtifact: vi.fn(async () => ({
      state: "absent" as const,
      scope,
      key: "runs/output",
      versionId: "version",
    })),
    removeBuildArtifactObject: vi.fn(async () => ({
      state: "absent" as const,
      scope,
      key: "runs/output",
      versionId: "version",
    })),
  };
  const persistence: BuildReceiptPersistence = {
    claimBuildInput: vi.fn(async () => ({
      status: "claimed" as const,
      mode: "start" as const,
      attemptNumber: 1,
      reservationCreatedAt: NOW,
      startAllowedUntil: START_ALLOWED_UNTIL,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    })),
    authorizeBuildStart: vi.fn(async () => true),
    putBuildReceipt: vi.fn(async () => undefined),
    putBuildUsage: vi.fn(async () => undefined),
    ...overrides,
  };
  let claimIndex = 0;
  const options: PersistingBuildBrokerOptions = {
    buildProject: "fixed-project",
    claimIds: {
      next: () => CLAIM_IDS[claimIndex++] ?? "00000000-0000-4000-8000-ffffffffffff",
    },
    leaseMilliseconds: 60_000,
    ...optionOverrides,
  };
  return {
    broker,
    persistence,
    options,
    wrapped: createPersistingBuildBroker(broker, persistence, options),
  };
}

function leasedPersistence(
  clock: { now: Date },
  options: Readonly<{ failFirstPut?: boolean }> = {},
) {
  let reservation:
    | {
        fingerprint: `sha256:${string}`;
        claimId: string;
        mode: "start" | "observe";
        attemptNumber: number;
        reservationCreatedAt: Date;
        startAllowedUntil: Date;
        leaseExpiresAt: Date;
        envelope?: Parameters<BuildReceiptPersistence["putBuildReceipt"]>[0];
      }
    | undefined;
  let failNextPut = options.failFirstPut ?? false;
  const persistence: BuildReceiptPersistence = {
    putBuildUsage: vi.fn(async () => undefined),
    claimBuildInput: vi.fn(async (claim) => {
      if (reservation !== undefined && reservation.fingerprint !== claim.inputFingerprint) {
        throw Object.assign(new Error("conflict"), { code: "build_input_conflict" });
      }
      if (reservation?.envelope !== undefined) {
        return { status: "completed" as const, envelope: reservation.envelope };
      }
      if (
        reservation === undefined ||
        clock.now.getTime() >= reservation.leaseExpiresAt.getTime()
      ) {
        reservation =
          reservation === undefined
            ? {
                fingerprint: claim.inputFingerprint,
                claimId: claim.claimId,
                mode: "start",
                attemptNumber: 1,
                reservationCreatedAt: new Date(clock.now),
                startAllowedUntil: new Date(clock.now.getTime() + 4 * 60_000),
                leaseExpiresAt: new Date(clock.now.getTime() + claim.leaseMilliseconds),
              }
            : {
                ...reservation,
                claimId: claim.claimId,
                mode:
                  reservation.mode === "observe" ||
                  clock.now.getTime() >= reservation.startAllowedUntil.getTime()
                    ? "observe"
                    : "start",
                attemptNumber: reservation.attemptNumber + 1,
                leaseExpiresAt: new Date(clock.now.getTime() + claim.leaseMilliseconds),
              };
        return {
          status: "claimed" as const,
          mode: reservation.mode,
          attemptNumber: reservation.attemptNumber,
          reservationCreatedAt: reservation.reservationCreatedAt,
          startAllowedUntil: reservation.startAllowedUntil,
          leaseExpiresAt: reservation.leaseExpiresAt,
        };
      }
      return {
        status: "pending" as const,
        leaseExpiresAt: reservation.leaseExpiresAt,
        startAllowedUntil: reservation.startAllowedUntil,
      };
    }),
    authorizeBuildStart: vi.fn(
      async (authorizationScope, claimId) =>
        reservation !== undefined &&
        authorizationScope === scope &&
        reservation.claimId === claimId &&
        reservation.mode === "start" &&
        clock.now.getTime() < reservation.leaseExpiresAt.getTime() &&
        clock.now.getTime() < reservation.startAllowedUntil.getTime() &&
        reservation.envelope === undefined,
    ),
    putBuildReceipt: vi.fn(async (envelope) => {
      if (
        reservation === undefined ||
        reservation.fingerprint !== envelope.inputFingerprint ||
        reservation.claimId !== envelope.claimId
      ) {
        throw Object.assign(new Error("stale claim"), { code: "build_input_conflict" });
      }
      if (failNextPut) {
        failNextPut = false;
        throw new Error("commit response lost");
      }
      reservation.envelope = envelope;
    }),
  };
  return persistence;
}

describe("persisting build broker", () => {
  it("uses a UUID claim and a 30 second production lease by default", async () => {
    const { broker, persistence } = setup();
    const wrapped = createPersistingBuildBroker(broker, persistence, {
      buildProject: "fixed-project",
    });

    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    const claim = vi.mocked(persistence.claimBuildInput).mock.calls[0]?.[0];
    if (claim === undefined) throw new Error("production claim was not persisted");
    expect(claim.claimId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(claim.leaseMilliseconds).toBe(30_000);
  });

  it("delegates storage and observation operations without changing receipts", async () => {
    const { wrapped, persistence } = setup();
    const upload = await wrapped.beginArchive({ scope });
    const part = await wrapped.uploadArchivePart({
      upload,
      partNumber: 1,
      body: new Uint8Array([1, 2, 3]),
      checksumSha256: "a".repeat(64),
    });
    await expect(
      wrapped.completeArchive({
        upload,
        parts: [part],
        byteLength: 3,
        sourceSha256: "b".repeat(64),
      }),
    ).resolves.toMatchObject({ versionId: "version" });
    await expect(wrapped.abortArchive(upload)).resolves.toBeUndefined();
    await expect(
      wrapped.observeArchive({ scope, sourceSha256: "b".repeat(64) }),
    ).resolves.toBeNull();
    await expect(wrapped.removeArchive({} as never)).resolves.toMatchObject({ state: "absent" });
    await expect(wrapped.readBuild(receipt)).resolves.toMatchObject({ status: "succeeded" });
    expect(persistence.putBuildUsage).toHaveBeenCalledWith({ receipt, usage });
    vi.mocked(persistence.putBuildUsage).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(wrapped.readBuild(receipt)).rejects.toMatchObject({
      code: "build_broker_result_uncertain",
    });
    await expect(wrapped.stopBuild(receipt)).resolves.toBeUndefined();
    await expect(
      wrapped.observeBuildArtifact({
        receipt,
        deploymentId: "01J00000000000000000000004",
        commitSha: "c".repeat(40),
        sourceSha256: "b".repeat(64),
        buildPlanSha256: "d".repeat(64),
        frameworkPlan,
      }),
    ).resolves.toBeNull();
    await expect(wrapped.readBuildArtifact({} as never)).rejects.toThrow("not used");
    await expect(wrapped.removeBuildArtifact({} as never)).resolves.toMatchObject({
      state: "absent",
    });
    await expect(wrapped.removeBuildArtifactObject({} as never)).resolves.toMatchObject({
      state: "absent",
    });
    await expect(wrapped.observeBuildStart(input, NOW)).resolves.toEqual({ state: "absent" });
  });

  it("persists a successful build receipt and replays it without another build", async () => {
    const { broker, persistence, wrapped } = setup();
    const inputFingerprint = await fingerprintBuildStartInput(input);
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    expect(persistence.putBuildReceipt).toHaveBeenCalledWith({
      receipt,
      inputFingerprint,
      claimId: CLAIM_IDS[0],
    });

    vi.mocked(persistence.claimBuildInput).mockResolvedValueOnce({
      status: "completed",
      envelope: { receipt, inputFingerprint, claimId: CLAIM_IDS[0] },
    });
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    expect(broker.startBuild).toHaveBeenCalledTimes(1);
  });

  it("fails closed before mutation when persistence cannot be read", async () => {
    const { broker, wrapped } = setup({
      claimBuildInput: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerTransportError);
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("reports uncertainty when a successful build receipt cannot be persisted", async () => {
    const { wrapped } = setup({
      putBuildReceipt: vi.fn(async () => {
        throw new Error("commit response lost");
      }),
    });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
  });

  it("refuses a new build with the capacity code when the organization is full", async () => {
    const { wrapped, broker } = setup({
      claimBuildInput: vi.fn(async () => {
        throw Object.assign(new Error("capacity"), { code: "build_capacity_reached" });
      }),
    });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerCapacityError);
    await expect(wrapped.startBuild(input)).rejects.toMatchObject({
      code: "build_capacity_reached",
    });
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("rejects conflicting persisted receipts and invalid persistence configuration", async () => {
    const inputFingerprint = await fingerprintBuildStartInput(input);
    const { wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "completed" as const,
        envelope: {
          receipt: { ...receipt, projectName: "other-project" },
          inputFingerprint,
          claimId: CLAIM_IDS[0],
        },
      })),
    });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    const invalidClaim = setup({
      claimBuildInput: vi.fn(async () => ({ status: "claimed", extra: true }) as never),
    });
    await expect(invalidClaim.wrapped.startBuild(input)).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
    expect(invalidClaim.broker.startBuild).not.toHaveBeenCalled();
    expect(() => createPersistingBuildBroker({} as never, {} as never, {} as never)).toThrow(
      "build_runner_configuration_invalid",
    );
    const valid = setup();
    expect(() =>
      createPersistingBuildBroker(
        { ...valid.broker, observeBuildStart: undefined } as never,
        valid.persistence,
        valid.options,
      ),
    ).toThrow("build_runner_configuration_invalid");
    expect(() => setup({}, { leaseMilliseconds: 300_000 })).toThrow(
      "build_runner_configuration_invalid",
    );
    const invalidClaimId = setup({}, { claimIds: { next: () => "not-a-uuid" } });
    await expect(invalidClaimId.wrapped.startBuild(input)).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
    const invalidDate = setup({
      claimBuildInput: vi.fn(
        async () =>
          ({
            status: "claimed",
            mode: "start",
            attemptNumber: 1,
            reservationCreatedAt: new Date(Number.NaN),
            startAllowedUntil: START_ALLOWED_UNTIL,
            leaseExpiresAt: LEASE_EXPIRES_AT,
          }) as const,
      ),
    });
    await expect(invalidDate.wrapped.startBuild(input)).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("rejects replay when root, plan, archive, or digest identity changes", async () => {
    const inputFingerprint = await fingerprintBuildStartInput(input);
    const { broker, persistence, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "completed" as const,
        envelope: { receipt, inputFingerprint, claimId: CLAIM_IDS[0] },
      })),
    });
    const sitePlan = {
      ...frameworkPlan,
      applicationRoot: "site",
    } as unknown as typeof frameworkPlan;
    const changedCommandPlan = {
      ...frameworkPlan,
      installCommand: "npm ci --ignore-scripts",
      buildCommand: "npm run build",
    } as unknown as typeof frameworkPlan;
    const variants = [
      {
        ...input,
        frameworkPlan: sitePlan,
        buildPlanSha256: "812d2dcf80cf510050dd211aaede19ad2b95aac35ea7fcd24fb0467e07f60222",
      },
      {
        ...input,
        frameworkPlan: changedCommandPlan,
        buildPlanSha256: "0b1ca9c6e2c2712435ee872e1846dad0e8cd9dda5214636369ba7907aef0943f",
      },
      { ...input, archive: { ...input.archive, versionId: "other-version" } },
      { ...input, archive: { ...input.archive, sourceSha256: "e".repeat(64) } },
    ];
    for (const variant of variants) {
      await expect(wrapped.startBuild(variant)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    }
    expect(persistence.claimBuildInput).toHaveBeenCalledTimes(variants.length);
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("returns uncertainty for an identical pending claim without starting another build", async () => {
    const { broker, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "pending" as const,
        leaseExpiresAt: LEASE_EXPIRES_AT,
        startAllowedUntil: START_ALLOWED_UNTIL,
      })),
    });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("atomically prevents same- and different-input concurrent duplicate builds", async () => {
    let resolveFirst: ((value: BuildReceipt) => void) | undefined;
    const firstBuild = new Promise<BuildReceipt>((resolve) => {
      resolveFirst = resolve;
    });
    let reservedFingerprint: string | undefined;
    const claimBuildInput = vi.fn(async (claim) => {
      if (reservedFingerprint === undefined) {
        reservedFingerprint = claim.inputFingerprint;
        return {
          status: "claimed" as const,
          mode: "start" as const,
          attemptNumber: 1,
          reservationCreatedAt: NOW,
          startAllowedUntil: START_ALLOWED_UNTIL,
          leaseExpiresAt: LEASE_EXPIRES_AT,
        };
      }
      if (reservedFingerprint === claim.inputFingerprint) {
        return {
          status: "pending" as const,
          leaseExpiresAt: LEASE_EXPIRES_AT,
          startAllowedUntil: START_ALLOWED_UNTIL,
        };
      }
      throw Object.assign(new Error("conflict"), { code: "build_input_conflict" });
    });
    const { broker, persistence, wrapped } = setup({ claimBuildInput });
    vi.mocked(broker.startBuild).mockReturnValueOnce(firstBuild);

    const first = wrapped.startBuild(input);
    await vi.waitFor(() => expect(broker.startBuild).toHaveBeenCalledTimes(1));
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    const different = {
      ...input,
      archive: { ...input.archive, versionId: "concurrent-other-version" },
    };
    await expect(wrapped.startBuild(different)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(broker.startBuild).toHaveBeenCalledTimes(1);
    expect(claimBuildInput).toHaveBeenCalledTimes(3);

    if (resolveFirst === undefined) throw new Error("first build resolver is unavailable");
    resolveFirst(receipt);
    await expect(first).resolves.toBe(receipt);
    expect(persistence.putBuildReceipt).toHaveBeenCalledOnce();
  });

  it.each([
    ["definitive pre-provider failure", new BuildBrokerTransportError()],
    ["lost provider response", new BuildBrokerUncertainError()],
  ])("reclaims an expired lease after %s", async (_name, firstError) => {
    const clock = { now: new Date(NOW) };
    const persistence = leasedPersistence(clock);
    const { broker, wrapped } = setup(persistence);
    vi.mocked(broker.startBuild).mockRejectedValueOnce(firstError);

    await expect(wrapped.startBuild(input)).rejects.toBe(firstError);
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(broker.startBuild).toHaveBeenCalledOnce();

    clock.now = new Date(NOW.getTime() + 60_000);
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    expect(broker.startBuild).toHaveBeenCalledTimes(2);
    expect(broker.observeBuildStart).toHaveBeenCalledWith(input, NOW);
  });

  it("recovers a receipt persistence failure by observing the exact provider build", async () => {
    const clock = { now: new Date(NOW) };
    const persistence = leasedPersistence(clock, { failFirstPut: true });
    const { broker, wrapped } = setup(persistence);

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    clock.now = new Date(NOW.getTime() + 60_000);
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "found", receipt });
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    expect(broker.startBuild).toHaveBeenCalledOnce();
    expect(persistence.putBuildReceipt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.putBuildReceipt).mock.calls[0]?.[0].receipt).toBe(receipt);
    expect(vi.mocked(persistence.putBuildReceipt).mock.calls[1]?.[0].receipt).toBe(receipt);
  });

  it("prevents a stale first claim from finalizing after an expired reclaim", async () => {
    const clock = { now: new Date(NOW) };
    const persistence = leasedPersistence(clock);
    const { broker, wrapped } = setup(persistence);
    let resolveFirst: ((value: BuildReceipt) => void) | undefined;
    const firstBuild = new Promise<BuildReceipt>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(broker.startBuild).mockReturnValueOnce(firstBuild);

    const first = wrapped.startBuild(input);
    await vi.waitFor(() => expect(broker.startBuild).toHaveBeenCalledOnce());
    clock.now = new Date(NOW.getTime() + 60_000);
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    if (resolveFirst === undefined) throw new Error("first build resolver is unavailable");
    resolveFirst(receipt);
    await expect(first).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(persistence.putBuildReceipt).toHaveBeenCalledTimes(2);
    expect(broker.startBuild).toHaveBeenCalledTimes(2);

    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    expect(broker.startBuild).toHaveBeenCalledTimes(2);
  });

  it("keeps a different fingerprint conflicting after the original lease expires", async () => {
    const clock = { now: new Date(NOW) };
    const persistence = leasedPersistence(clock);
    const { broker, wrapped } = setup(persistence);
    vi.mocked(broker.startBuild).mockRejectedValueOnce(new BuildBrokerTransportError());
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerTransportError);
    clock.now = new Date(NOW.getTime() + 120_000);
    await expect(
      wrapped.startBuild({
        ...input,
        archive: { ...input.archive, versionId: "different-forever" },
      }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(broker.startBuild).toHaveBeenCalledOnce();
  });

  it("authorizes the first claim immediately before the only provider mutation", async () => {
    const { broker, persistence, wrapped } = setup();

    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);

    expect(broker.observeBuildStart).not.toHaveBeenCalled();
    expect(persistence.authorizeBuildStart).toHaveBeenCalledWith(scope, CLAIM_IDS[0]);
    expect(vi.mocked(persistence.authorizeBuildStart).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(broker.startBuild).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    [
      Object.assign(new Error("conflict"), { code: "build_input_conflict" }),
      BuildBrokerConflictError,
    ],
    [new Error("database unavailable"), BuildBrokerTransportError],
  ])("fails closed when start authorization fails", async (failure, expectedError) => {
    const { broker, wrapped } = setup({
      authorizeBuildStart: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(expectedError);
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean persistence authorization result", async () => {
    const { broker, wrapped } = setup({
      authorizeBuildStart: vi.fn(async () => "yes" as never),
    });

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("does not mutate when observation crosses the start deadline", async () => {
    const { broker, persistence, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "claimed" as const,
        mode: "start" as const,
        attemptNumber: 2,
        reservationCreatedAt: NOW,
        startAllowedUntil: START_ALLOWED_UNTIL,
        leaseExpiresAt: new Date(START_ALLOWED_UNTIL.getTime() + 30_000),
      })),
      authorizeBuildStart: vi.fn(async () => false),
    });
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "absent" });

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(broker.observeBuildStart).toHaveBeenCalledWith(input, NOW);
    expect(persistence.authorizeBuildStart).toHaveBeenCalledOnce();
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("terminalizes an observe-only recovery after exact provider absence", async () => {
    const { broker, persistence, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "claimed" as const,
        mode: "observe" as const,
        attemptNumber: 5,
        reservationCreatedAt: NOW,
        startAllowedUntil: START_ALLOWED_UNTIL,
        leaseExpiresAt: new Date(START_ALLOWED_UNTIL.getTime() + 60_000),
      })),
    });
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "absent" });

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildStartAbsentError);
    expect(persistence.authorizeBuildStart).not.toHaveBeenCalled();
    expect(broker.startBuild).not.toHaveBeenCalled();
    expect(persistence.putBuildReceipt).not.toHaveBeenCalled();
  });

  it("keeps an observe-only recovery uncertain when provider observation is unknown", async () => {
    const { broker, persistence, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "claimed" as const,
        mode: "observe" as const,
        attemptNumber: 5,
        reservationCreatedAt: NOW,
        startAllowedUntil: START_ALLOWED_UNTIL,
        leaseExpiresAt: new Date(START_ALLOWED_UNTIL.getTime() + 60_000),
      })),
    });
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "unknown" });

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(persistence.authorizeBuildStart).not.toHaveBeenCalled();
    expect(broker.startBuild).not.toHaveBeenCalled();
    expect(persistence.putBuildReceipt).not.toHaveBeenCalled();
  });

  it("persists and replays an exact observed build without starting another", async () => {
    const inputFingerprint = await fingerprintBuildStartInput(input);
    const claimBuildInput = vi
      .fn<BuildReceiptPersistence["claimBuildInput"]>()
      .mockResolvedValueOnce({
        status: "claimed" as const,
        mode: "observe" as const,
        attemptNumber: 6,
        reservationCreatedAt: NOW,
        startAllowedUntil: START_ALLOWED_UNTIL,
        leaseExpiresAt: new Date(START_ALLOWED_UNTIL.getTime() + 60_000),
      })
      .mockResolvedValueOnce({
        status: "completed",
        envelope: { receipt, inputFingerprint, claimId: CLAIM_IDS[0] },
      });
    const { broker, persistence, wrapped } = setup({
      claimBuildInput,
    });
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "found", receipt });

    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);
    expect(persistence.putBuildReceipt).toHaveBeenCalledWith({
      receipt,
      inputFingerprint,
      claimId: CLAIM_IDS[0],
    });
    expect(persistence.authorizeBuildStart).not.toHaveBeenCalled();
    expect(broker.startBuild).not.toHaveBeenCalled();
    expect(broker.observeBuildStart).toHaveBeenCalledOnce();
  });

  it("reports uncertainty when a stale recovered claim cannot persist its observed receipt", async () => {
    const { broker, persistence, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "claimed" as const,
        mode: "observe" as const,
        attemptNumber: 4,
        reservationCreatedAt: NOW,
        startAllowedUntil: START_ALLOWED_UNTIL,
        leaseExpiresAt: new Date(START_ALLOWED_UNTIL.getTime() + 60_000),
      })),
      putBuildReceipt: vi.fn(async () => {
        throw Object.assign(new Error("stale claim"), { code: "build_input_conflict" });
      }),
    });
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "found", receipt });

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(persistence.authorizeBuildStart).not.toHaveBeenCalled();
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it("recovers a lost provider response only after an exact later observation", async () => {
    const clock = { now: new Date(NOW) };
    const persistence = leasedPersistence(clock);
    const { broker, wrapped } = setup(persistence);
    vi.mocked(broker.startBuild)
      .mockRejectedValueOnce(new BuildBrokerUncertainError())
      .mockRejectedValueOnce(new BuildBrokerUncertainError());

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    clock.now = new Date(NOW.getTime() + 60_000);
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "absent" });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    clock.now = new Date(NOW.getTime() + 120_000);
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce({ state: "found", receipt });
    await expect(wrapped.startBuild(input)).resolves.toBe(receipt);

    expect(broker.startBuild).toHaveBeenCalledTimes(2);
    expect(broker.observeBuildStart).toHaveBeenCalledTimes(2);
    expect(persistence.putBuildReceipt).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { state: "found", receipt, extra: true },
    { state: "found", receipt: { ...receipt, projectName: "wrong-project" } },
    { state: "unknown", extra: true },
  ])("rejects malformed provider observations", async (observation) => {
    const { broker, persistence, wrapped } = setup({
      claimBuildInput: vi.fn(async () => ({
        status: "claimed" as const,
        mode: "observe" as const,
        attemptNumber: 2,
        reservationCreatedAt: NOW,
        startAllowedUntil: START_ALLOWED_UNTIL,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      })),
    });
    vi.mocked(broker.observeBuildStart).mockResolvedValueOnce(observation as never);

    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(persistence.putBuildReceipt).not.toHaveBeenCalled();
    expect(broker.startBuild).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "claimed",
      mode: "invalid",
      attemptNumber: 2,
      reservationCreatedAt: NOW,
      startAllowedUntil: START_ALLOWED_UNTIL,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    },
    {
      status: "claimed",
      mode: "observe",
      attemptNumber: 1,
      reservationCreatedAt: NOW,
      startAllowedUntil: START_ALLOWED_UNTIL,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    },
    {
      status: "pending",
      startAllowedUntil: START_ALLOWED_UNTIL,
      leaseExpiresAt: new Date(Number.NaN),
    },
  ])("rejects malformed persistence claim results", async (claim) => {
    const { broker, wrapped } = setup({
      claimBuildInput: vi.fn(async () => claim as never),
    });
    await expect(wrapped.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(broker.observeBuildStart).not.toHaveBeenCalled();
    expect(broker.startBuild).not.toHaveBeenCalled();
  });
});
