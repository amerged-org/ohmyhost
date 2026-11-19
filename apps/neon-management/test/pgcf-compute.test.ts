import { createUlidFactory, DeterministicEntropy, type Ulid } from "@ohmyhost/platform";
import { PgcfProviderError, type PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPgcfComputeChanges, type PgcfComputePersistence } from "../src/pgcf-compute.js";

const ACCEPTED = new Date("2026-10-31T10:00:00.000Z");
const MINUTE = 60_000;
const ids = createUlidFactory({
  clock: { now: () => ACCEPTED },
  entropy: new DeterministicEntropy(7),
});
const operationId = ids.next();
const PROJECT_ID = "01H0000000000000000000A002" as Ulid;
const PROVIDER_PROJECT_ID = "prj_abcdefghij0123456789";
const KNOWN_PROVIDER_OPERATION_ID = "op_abcdefghij0123456789";
const DATABASE_ID = "db_0000000000000000000000";

type Completion = { success?: boolean; failureCode?: string };
type Observation = { databaseId: string; providerOperationId: string | null; state: string };

/**
 * Real PGCF 409 and 5xx answers reach the service as PgcfProviderError (pgcf-provider.ts:221).
 * The fake persistence refuses an observation that drops a stored provider operation id, as
 * planRecordDatabaseProviderOperation does against D1.
 */
function fixture(
  failure: PgcfProviderError,
  providerOperationId: string | null = null,
  jobFlags: { mutationPermitted?: boolean; providerDispatchStarted?: boolean } = {},
  database: ReturnType<typeof pgcfDatabase> | null = null,
  providerOperation: ReturnType<typeof pgcfOperation> | null = null,
) {
  const recorded: Completion[] = [];
  const observations: Observation[] = [];
  const job = {
    operationId,
    organizationId: "01H0000000000000000000A001",
    projectId: PROJECT_ID,
    environmentId: "01H0000000000000000000A003",
    physicalEnvironmentId: "01H0000000000000000000A004",
    billingEpochId: "01H0000000000000000000A005",
    providerProjectId: PROVIDER_PROJECT_ID,
    databaseId: "db_0000000000000000000000",
    targetVersion: 1,
    memoryMiB: 1024,
    sizeClassId: "pgcf-1024",
    completedAt: null,
    claimId: null,
    claimExpiresAt: null,
    state: "queued" as const,
    mutationPermitted: true,
    providerDispatchStarted: false,
    ...jobFlags,
  };
  const operation = {
    organizationId: job.organizationId,
    projectId: PROJECT_ID,
    operationId,
    claimId: "01H0000000000000000000A006",
    physicalEnvironmentId: job.physicalEnvironmentId,
    step: "database.resize",
    idempotencyKey: "idem-key",
    providerProjectId: PROVIDER_PROJECT_ID,
    requestBody: {},
    providerOperationId,
    databaseId: null,
    state: "reserved" as const,
  };
  const persistence = {
    claim: async () => job,
    reserve: async () => operation,
    begin: async () => "dispatch" as const,
    release: async () => true,
    record: async (stored: typeof operation, observation: Observation, completion?: Completion) => {
      if (stored.providerOperationId !== null && observation.providerOperationId === null)
        throw new Error("Database provider scope or durable identity conflicts");
      observations.push(observation);
      if (completion) recorded.push(completion);
    },
    complete: async (completion: Completion) => {
      recorded.push(completion);
    },
  } as unknown as PgcfComputePersistence;
  const provider = {
    projectId: PROVIDER_PROJECT_ID,
    changeDatabase: async () => {
      throw failure;
    },
    readDatabase: async () => {
      if (database === null) throw failure;
      return database;
    },
    readOperation: async () => {
      if (providerOperation === null) throw failure;
      return providerOperation;
    },
  } as unknown as PgcfProjectProvider;
  return {
    recorded,
    observations,
    service: (now: { current: Date }) =>
      createPgcfComputeChanges({
        persistence,
        provider,
        clock: { now: () => new Date(now.current) },
        ids,
      }),
  };
}

const run = (service: ReturnType<ReturnType<typeof fixture>["service"]>) =>
  service.run({
    organizationId: "01H0000000000000000000A001",
    projectId: PROJECT_ID,
    operationId,
  });

/** PGCF's own reading of the job's database: settled at the job's target size unless a field says otherwise. */
function pgcfDatabase(overrides: { sizeClassId?: string; observedGeneration?: number } = {}) {
  return {
    id: DATABASE_ID,
    projectId: PROVIDER_PROJECT_ID,
    regionId: "eu-central-1",
    name: "ohmyho-compute-test",
    sizeClassId: "pgcf-1024",
    resources: { memoryMiB: 1024, cpuMillicores: 500, storageMiB: 2048 },
    desiredState: "running" as const,
    observedState: "ready" as const,
    generation: 2,
    observedGeneration: 2,
    sleepAfterSeconds: null,
    ...overrides,
  };
}

/** PGCF's own reading of the accepted resize; its generation matches the database's unless a test overrides it. */
function pgcfOperation(
  overrides: { status?: "pending" | "running" | "succeeded" | "failed" } = {},
) {
  return {
    id: KNOWN_PROVIDER_OPERATION_ID,
    projectId: PROVIDER_PROJECT_ID,
    databaseId: DATABASE_ID,
    generation: 2,
    kind: "database.resize",
    status: "running" as "pending" | "running" | "succeeded" | "failed",
    errorCode: null,
    ...overrides,
  };
}

describe("PGCF compute change refusals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails the job when PGCF refuses the mutation with a permanent 409 reason", async () => {
    const fx = fixture(new PgcfProviderError("rejected", 409, false, "database_deleted"));
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    await expect(run(fx.service(now))).resolves.toEqual({ status: "failed" });
    expect(fx.recorded).toEqual([expect.objectContaining({ success: false })]);
  });

  it("keeps the job running while PGCF reports a retryable 409 reason", async () => {
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    for (const reason of ["idempotency_in_progress", "generation_changed"]) {
      const fx = fixture(new PgcfProviderError("rejected", 409, false, reason));

      await expect(run(fx.service(now))).resolves.toEqual({ status: "running" });
      expect(fx.recorded).toEqual([]);
    }
  });

  it("ends a dispatch retry at the deadline and never abandons a known provider operation", async () => {
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    const dispatch = fixture(new PgcfProviderError("rejected", 503, true));
    const dispatchService = dispatch.service(now);
    await expect(run(dispatchService)).resolves.toEqual({ status: "running" });
    expect(dispatch.recorded).toEqual([]);

    now.current = new Date(ACCEPTED.getTime() + 20 * MINUTE);
    await expect(run(dispatchService)).resolves.toEqual({ status: "failed" });
    expect(dispatch.recorded).toEqual([expect.objectContaining({ success: false })]);

    now.current = new Date(ACCEPTED.getTime() + 21 * MINUTE);
    const timeout = fixture(new PgcfProviderError("timeout"), KNOWN_PROVIDER_OPERATION_ID);
    await expect(run(timeout.service(now))).resolves.toEqual({ status: "running" });
    expect(timeout.recorded).toEqual([]);

    const unavailable = fixture(
      new PgcfProviderError("rejected", 503, false),
      KNOWN_PROVIDER_OPERATION_ID,
    );
    await expect(run(unavailable.service(now))).resolves.toEqual({ status: "running" });
    expect(unavailable.observations).toEqual([]);
    expect(unavailable.recorded).toEqual([]);
  });

  it("ends an uncertain dispatch at the deadline only when PGCF's database still has its previous size", async () => {
    const uncertainJob = { mutationPermitted: false, providerDispatchStarted: true };
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    // Before the deadline the dispatch may still reach PGCF, so the database is not decided yet.
    const early = fixture(new PgcfProviderError("timeout"), null, uncertainJob, pgcfDatabase());
    await expect(run(early.service(now))).resolves.toEqual({ status: "running" });
    expect(early.observations).toEqual([]);
    expect(early.recorded).toEqual([]);

    // After the deadline, with Paid coverage gone, a database still at its previous size means the resize never applied.
    now.current = new Date(ACCEPTED.getTime() + 21 * MINUTE);
    const previous = fixture(
      new PgcfProviderError("timeout"),
      null,
      uncertainJob,
      pgcfDatabase({ sizeClassId: "pgcf-512" }),
    );
    await expect(run(previous.service(now))).resolves.toEqual({ status: "failed" });
    expect(previous.recorded).toEqual([expect.objectContaining({ success: false })]);
  });

  it("keeps an uncertain dispatch running at the deadline while PGCF cannot be read", async () => {
    const now = { current: new Date(ACCEPTED.getTime() + 21 * MINUTE) };
    const unreadable = fixture(new PgcfProviderError("timeout"), null, {
      mutationPermitted: false,
      providerDispatchStarted: true,
    });

    await expect(run(unreadable.service(now))).resolves.toEqual({ status: "running" });
    expect(unreadable.observations).toEqual([]);
    expect(unreadable.recorded).toEqual([]);
  });

  it("completes an uncertain dispatch whose database has the target size and waits while PGCF applies it", async () => {
    const uncertainJob = { mutationPermitted: false, providerDispatchStarted: true };
    const now = { current: new Date(ACCEPTED.getTime() + 21 * MINUTE) };

    const applying = fixture(
      new PgcfProviderError("timeout"),
      null,
      uncertainJob,
      pgcfDatabase({ observedGeneration: 1 }),
    );
    await expect(run(applying.service(now))).resolves.toEqual({ status: "running" });
    expect(applying.observations).toEqual([
      expect.objectContaining({
        databaseId: DATABASE_ID,
        providerOperationId: null,
        state: "pending",
      }),
    ]);
    expect(applying.recorded).toEqual([]);

    const applied = fixture(new PgcfProviderError("timeout"), null, uncertainJob, pgcfDatabase());
    await expect(run(applied.service(now))).resolves.toEqual({ status: "succeeded" });
    expect(applied.observations).toEqual([
      expect.objectContaining({
        databaseId: DATABASE_ID,
        providerOperationId: null,
        state: "succeeded",
      }),
    ]);
    expect(applied.recorded).toEqual([expect.objectContaining({ success: true })]);
  });

  it("fails an accepted resize whose status reads keep failing past the observation ceiling, and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const read = fixture(
      new PgcfProviderError("rejected", 503, false),
      KNOWN_PROVIDER_OPERATION_ID,
    );
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    await expect(run(read.service(now))).resolves.toEqual({ status: "running" });
    expect(logged).not.toHaveBeenCalled();
    expect(read.recorded).toEqual([]);

    now.current = new Date(ACCEPTED.getTime() + 25 * 60 * MINUTE);
    await expect(run(read.service(now))).resolves.toEqual({ status: "failed" });
    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({
        event: "pgcf_compute_observation_overdue",
        operationId,
        databaseId: DATABASE_ID,
        providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
      }),
    );
    expect(read.observations).toEqual([
      expect.objectContaining({
        providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
        state: "failed",
      }),
    ]);
    expect(read.recorded).toEqual([expect.objectContaining({ success: false })]);
  });

  it("fails an uncertain dispatch whose PGCF database stays unreadable past the ceiling, and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unreadable = fixture(new PgcfProviderError("timeout"), null, {
      mutationPermitted: false,
      providerDispatchStarted: true,
    });
    const now = { current: new Date(ACCEPTED.getTime() + 21 * MINUTE) };

    await expect(run(unreadable.service(now))).resolves.toEqual({ status: "running" });
    expect(logged).not.toHaveBeenCalled();

    now.current = new Date(ACCEPTED.getTime() + 25 * 60 * MINUTE);
    await expect(run(unreadable.service(now))).resolves.toEqual({ status: "failed" });
    expect(logged).toHaveBeenCalledWith(
      JSON.stringify({
        event: "pgcf_compute_observation_overdue",
        operationId,
        databaseId: DATABASE_ID,
        providerOperationId: null,
      }),
    );
    expect(unreadable.observations).toEqual([
      expect.objectContaining({
        databaseId: DATABASE_ID,
        providerOperationId: null,
        state: "failed",
      }),
    ]);
    expect(unreadable.recorded).toEqual([expect.objectContaining({ success: false })]);
  });

  it("fails a job whose PGCF read is permanently refused, on either observation path", async () => {
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    // A vanished operation answers 404 for every read, so no later observation can settle the job.
    const vanished = fixture(
      new PgcfProviderError("rejected", 404, false),
      KNOWN_PROVIDER_OPERATION_ID,
    );
    await expect(run(vanished.service(now))).resolves.toEqual({ status: "failed" });
    expect(vanished.observations).toEqual([
      expect.objectContaining({
        providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
        state: "failed",
      }),
    ]);
    expect(vanished.recorded).toEqual([expect.objectContaining({ success: false })]);

    // An uncertain dispatch whose database answers 404 at the deadline has nothing left to settle it.
    now.current = new Date(ACCEPTED.getTime() + 21 * MINUTE);
    const gone = fixture(new PgcfProviderError("rejected", 404, false), null, {
      mutationPermitted: false,
      providerDispatchStarted: true,
    });
    await expect(run(gone.service(now))).resolves.toEqual({ status: "failed" });
    expect(gone.observations).toEqual([
      expect.objectContaining({ providerOperationId: null, state: "failed" }),
    ]);
    expect(gone.recorded).toEqual([expect.objectContaining({ success: false })]);
  });

  it("fails an accepted resize that reads fine but never settles past the observation ceiling, whatever its provider status, and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // PGCF answers every read, and the database is at the target size, yet the operation has not settled.
    const cases = [
      { status: "running" as const, database: pgcfDatabase() },
      // The provider reports success while the database's generation is still unobserved.
      { status: "succeeded" as const, database: pgcfDatabase({ observedGeneration: 1 }) },
    ];
    for (const { status, database } of cases) {
      logged.mockClear();
      const stuck = fixture(
        new PgcfProviderError("timeout"),
        KNOWN_PROVIDER_OPERATION_ID,
        {},
        database,
        pgcfOperation({ status }),
      );
      const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

      await expect(run(stuck.service(now))).resolves.toEqual({ status: "running" });
      expect(logged).not.toHaveBeenCalled();
      expect(stuck.observations).toEqual([
        expect.objectContaining({
          providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
          state: "pending",
        }),
      ]);
      expect(stuck.recorded).toEqual([]);

      now.current = new Date(ACCEPTED.getTime() + 25 * 60 * MINUTE);
      await expect(run(stuck.service(now))).resolves.toEqual({ status: "failed" });
      expect(logged).toHaveBeenCalledWith(
        JSON.stringify({
          event: "pgcf_compute_observation_overdue",
          operationId,
          databaseId: DATABASE_ID,
          providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
        }),
      );
      expect(stuck.observations).toEqual([
        expect.objectContaining({
          providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
          state: "pending",
        }),
        expect.objectContaining({
          providerOperationId: KNOWN_PROVIDER_OPERATION_ID,
          state: "failed",
        }),
      ]);
      expect(stuck.recorded).toEqual([expect.objectContaining({ success: false })]);
    }
  });

  it("keeps an accepted operation running through any failed status read", async () => {
    const now = { current: new Date(ACCEPTED.getTime() + MINUTE) };

    for (const status of [502, 503, 401, 403]) {
      const read = fixture(
        new PgcfProviderError("rejected", status, false),
        KNOWN_PROVIDER_OPERATION_ID,
      );

      await expect(run(read.service(now))).resolves.toEqual({ status: "running" });
      expect(read.observations).toEqual([]);
      expect(read.recorded).toEqual([]);
    }
  });
});
