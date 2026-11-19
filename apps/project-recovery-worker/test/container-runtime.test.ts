import { Buffer } from "node:buffer";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";

import {
  createContainerRecoveryDatabaseReader,
  createContainerRecoveryRuntime,
  parseContainerRecoveryConfiguration,
} from "../src/container-runtime.js";
import type { RecoveryControl } from "../src/control-wire.js";

vi.mock("../src/recovery-runtime.js", () => ({ createRecoveryRuntime: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createRecoveryRuntime).mockReset();
});

const configuration = {
  pgcf: {
    baseUrl: "https://api.pgcf.example.test/",
    projectId: `prj_${"b".repeat(20)}`,
    apiKey: "k".repeat(32),
  },
  r2AccountId: "00000000000000000000000000000001",
  r2AccessKeyId: "a".repeat(32),
  r2ApiToken: "r".repeat(32),
  inputKeyBase64: Buffer.alloc(32, 7).toString("base64"),
  pgcfKeyExpiresAt: "2099-01-01T00:00:00.000Z",
};
const TOKEN = "t".repeat(43);

it("accepts only the exact environment-scoped Container configuration with no Control database authority", () => {
  const text = JSON.stringify(configuration);
  expect(parseContainerRecoveryConfiguration(text, "production")).toEqual(configuration);
  const withoutPgcf: Record<string, unknown> = { ...configuration };
  delete withoutPgcf["pgcf"];
  for (const altered of [
    { controlDatabaseUrl: "postgresql://control_runtime:secret@host/control" },
    { controlDatabaseTarget: { provider: "pgcf" } },
    { NEON_CONTROL_TARGET: "x" },
    { neonApiKey: "must-not-enter-container" },
    { awsSecretArn: "must-not-enter-container" },
    { DATABASE_PROVIDER_AUDIT: "true" },
    { inputKeyBase64: "invalid" },
    { r2AccountId: "foreign" },
    { r2AccessKeyId: "short" },
    { r2ApiToken: "has space has space has space" },
    { r2ApiToken: "" },
    { pgcf: null },
    { pgcf: { ...configuration.pgcf, extra: 1 } },
    { pgcf: { ...configuration.pgcf, baseUrl: "not a url" } },
  ]) {
    expect(() =>
      parseContainerRecoveryConfiguration(
        JSON.stringify({ ...configuration, ...altered }),
        "production",
      ),
    ).toThrow("RECOVERY_CONFIGURATION_INVALID");
  }
  expect(() =>
    parseContainerRecoveryConfiguration(JSON.stringify(withoutPgcf), "production"),
  ).toThrow("RECOVERY_CONFIGURATION_INVALID");
  expect(() => parseContainerRecoveryConfiguration(text, "sandbox" as never)).toThrow(
    "RECOVERY_CONFIGURATION_INVALID",
  );
  // The expiry is optional: deployed configurations predate it and run without an expiry check.
  const withoutExpiry: Record<string, unknown> = { ...configuration };
  delete withoutExpiry["pgcfKeyExpiresAt"];
  expect(parseContainerRecoveryConfiguration(JSON.stringify(withoutExpiry), "production")).toEqual(
    withoutExpiry,
  );
  for (const invalid of [
    JSON.stringify({ ...configuration, pgcfKeyExpiresAt: "2099-01-01" }),
    JSON.stringify({ ...configuration, pgcfKeyExpiresAt: "soon" }),
  ]) {
    expect(() => parseContainerRecoveryConfiguration(invalid, "production")).toThrow(
      "RECOVERY_CONFIGURATION_INVALID",
    );
  }
  expect(() => parseContainerRecoveryConfiguration("private-password", "production")).toThrow(
    "RECOVERY_CONFIGURATION_INVALID",
  );
  expect(() => parseContainerRecoveryConfiguration("[1,2]", "production")).toThrow(
    "RECOVERY_CONFIGURATION_INVALID",
  );
  expect(() => parseContainerRecoveryConfiguration(7, "production")).toThrow(
    "RECOVERY_CONFIGURATION_INVALID",
  );
});

it("reads only the claimed PGCF backup role and its WSS transport for one physical environment", async () => {
  const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const databaseId = "a".repeat(20);
  const providerProjectId = configuration.pgcf.projectId;
  const roleName = `ohmyho_backup_${environmentId.toLowerCase()}`;
  const uri = `postgres://${roleName}:secret@pgcf.example.test/${databaseId}?sslmode=require`;
  const reference = {
    provider: "pgcf" as const,
    databaseEnvironmentId: parseUlid(environmentId),
    providerProjectId,
    databaseId,
    databaseName: databaseId,
    roleName,
    regionId: "eu1",
    targetVersion: 1,
    postgresVersion: "18" as const,
  };
  let connectionLimit = 2;
  let desiredState = "running";
  let memberOf = [`ohmyho_ro_${environmentId.toLowerCase()}`];
  const reader = createContainerRecoveryDatabaseReader({
    projectId: providerProjectId,
    readDatabase: async () => ({
      id: databaseId,
      projectId: providerProjectId,
      regionId: "eu1",
      desiredState,
      observedState: "ready",
    }),
    readRoles: async () => [
      {
        name: roleName,
        owner: false,
        bypassRls: true,
        connectionLimit,
        membershipOptions: { inherit: true, set: false },
        memberOf,
      },
    ],
    readConnection: async () => ({
      host: "pgcf.example.test",
      consume: async (work: (value: string) => Promise<unknown>) => work(uri),
    }),
  } as never);
  const signal = () => new AbortController().signal;
  await expect(reader.read(reference, signal())).resolves.toEqual({
    connectionUrl: uri,
    transport: {
      provider: "pgcf",
      websocketUrl: "wss://pgcf.example.test/",
      databaseId,
      role: roleName,
    },
  });
  const invalid = "RECOVERY_DATABASE_SCOPE_INVALID";
  connectionLimit = 1;
  await expect(reader.read(reference, signal())).rejects.toThrow(invalid);
  connectionLimit = 2;
  memberOf = ["ohmyho_ro_other"];
  await expect(reader.read(reference, signal())).rejects.toThrow(invalid);
  memberOf = [`ohmyho_ro_${environmentId.toLowerCase()}`];
  desiredState = "deleted";
  await expect(reader.read(reference, signal())).rejects.toThrow(invalid);
  desiredState = "running";
  await expect(reader.read({ ...reference, roleName: "other" }, signal())).rejects.toThrow(invalid);
  await expect(
    reader.read({ ...reference, providerProjectId: "prj_other" }, signal()),
  ).rejects.toThrow(invalid);
  await expect(reader.read({ ...reference, databaseName: "other" }, signal())).rejects.toThrow(
    invalid,
  );
  await expect(reader.read({ ...reference, regionId: "eu2" }, signal())).rejects.toThrow(invalid);
  await expect(reader.read({ ...reference, provider: "neon" } as never, signal())).rejects.toThrow(
    invalid,
  );
  const aborted = new AbortController();
  aborted.abort();
  await expect(reader.read(reference, aborted.signal)).rejects.toThrow();
  const absent = createContainerRecoveryDatabaseReader(undefined);
  await expect(absent.read(reference, signal())).rejects.toThrow(invalid);
  const noRole = createContainerRecoveryDatabaseReader({
    projectId: providerProjectId,
    readDatabase: async () => ({
      id: databaseId,
      projectId: providerProjectId,
      regionId: "eu1",
      desiredState,
      observedState: "ready",
    }),
    readRoles: async () => [],
  } as never);
  await expect(noRole.read(reference, signal())).rejects.toThrow(invalid);
});

it("grants the entitlement wake budget only while PGCF shows the platform's suspension or its resume in flight", async () => {
  const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const databaseId = "a".repeat(20);
  const providerProjectId = configuration.pgcf.projectId;
  const roleName = `ohmyho_backup_${environmentId.toLowerCase()}`;
  const uri = `postgres://${roleName}:secret@pgcf.example.test/${databaseId}?sslmode=require`;
  const reference = {
    provider: "pgcf" as const,
    databaseEnvironmentId: parseUlid(environmentId),
    providerProjectId,
    databaseId,
    databaseName: databaseId,
    roleName,
    regionId: "eu1",
    targetVersion: 1,
    postgresVersion: "18" as const,
  };
  let database: Record<string, unknown> = {
    id: databaseId,
    projectId: providerProjectId,
    regionId: "eu1",
    desiredState: "running",
    observedState: "ready",
    suspensionReason: null,
  };
  const reader = createContainerRecoveryDatabaseReader({
    projectId: providerProjectId,
    readDatabase: async () => database,
    readRoles: async () => [
      {
        name: roleName,
        owner: false,
        bypassRls: true,
        connectionLimit: 2,
        membershipOptions: { inherit: true, set: false },
        memberOf: [`ohmyho_ro_${environmentId.toLowerCase()}`],
      },
    ],
    readConnection: async () => ({
      host: "pgcf.example.test",
      consume: async (work: (value: string) => Promise<unknown>) => work(uri),
    }),
  } as never);
  const budgetOf = async () =>
    (
      (await reader.read(reference, new AbortController().signal)) as {
        wakeBudgetMilliseconds?: number;
      }
    ).wakeBudgetMilliseconds;
  // An awake database keeps the default 90 second budget.
  expect(await budgetOf()).toBeUndefined();
  // The platform's entitlement suspension is the only manual suspension: its export waits up to 10 minutes.
  database = {
    ...database,
    desiredState: "suspended",
    suspensionReason: "manual",
    observedState: "hibernated",
  };
  expect(await budgetOf()).toBe(600_000);
  // The reconciler's resume is in flight: the database is running but not yet ready.
  database = { ...database, desiredState: "running", suspensionReason: null };
  expect(await budgetOf()).toBe(600_000);
  // An idle suspension is woken by PGCF on connect and keeps the default budget.
  database = {
    ...database,
    desiredState: "suspended",
    suspensionReason: "idle",
    observedState: "hibernated",
  };
  expect(await budgetOf()).toBeUndefined();
});

it("reads a project-scoped Native backup role without a synthetic environment", async () => {
  const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    databaseId = "a".repeat(20),
    roleName = `omh_ab_${projectId.toLowerCase()}`,
    providerProjectId = configuration.pgcf.projectId;
  const reference = {
    kind: "native_auth_database" as const,
    provider: "pgcf" as const,
    projectId,
    providerProjectId,
    databaseId,
    regionId: "eu-dev" as const,
    roleName,
    targetVersion: 1,
    realms: [
      {
        environmentId: projectId,
        schemaName: `omh_auth_${projectId.toLowerCase()}`,
        revocationEpoch: 1,
        configurationRevision: 1,
      },
    ],
  };
  let bypassRls = false,
    memberOf: string[] = [];
  const reader = createContainerRecoveryDatabaseReader({
    projectId: providerProjectId,
    readDatabase: async () => ({
      id: databaseId,
      projectId: providerProjectId,
      regionId: "eu-dev",
      desiredState: "running",
    }),
    readRoles: async () => [
      {
        databaseId,
        name: roleName,
        owner: false,
        bypassRls,
        connectionLimit: 2,
        memberOf,
        validUntil: null,
      },
    ],
    readConnection: async () => ({
      host: "pgcf.example.test",
      consume: async (work: (value: string) => Promise<unknown>) =>
        work(`postgres://${roleName}:secret@pgcf.example.test/${databaseId}?sslmode=require`),
    }),
  } as never);
  await expect(reader.read(reference, new AbortController().signal)).resolves.toMatchObject({
    transport: { databaseId, role: roleName },
  });
  bypassRls = true;
  await expect(reader.read(reference, new AbortController().signal)).rejects.toThrow(
    "RECOVERY_DATABASE_SCOPE_INVALID",
  );
  bypassRls = false;
  memberOf = ["foreign"];
  await expect(reader.read(reference, new AbortController().signal)).rejects.toThrow(
    "RECOVERY_DATABASE_SCOPE_INVALID",
  );
});

const command = {
  action: "download",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
};

it("refuses an override-shaped command and a missing job token before any provider or Control traffic", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 403 }));
  const run = createContainerRecoveryRuntime(configuration, "poc-private-fullstack", TOKEN);
  await expect(run({ action: "run", password: "must-not-cross" })).rejects.toThrow(
    "RECOVERY_EVENT_INVALID",
  );
  for (const token of [undefined, "short", `${"t".repeat(42)}!`])
    await expect(
      createContainerRecoveryRuntime(configuration, "production", token)(command),
    ).rejects.toThrow("RECOVERY_CONFIGURATION_INVALID");
  expect(createRecoveryRuntime).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

const RUN = {
  action: "run" as const,
  claimId: "123e4567-e89b-42d3-a456-426614174000",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
};

it("refuses a PGCF-using run once the integrator key has expired, before any provider or Control traffic", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 403 }));
  const expired = { ...configuration, pgcfKeyExpiresAt: "2020-01-01T00:00:00.000Z" };
  await expect(createContainerRecoveryRuntime(expired, "production", TOKEN)(RUN)).rejects.toThrow(
    "RECOVERY_PROVIDER_KEY_EXPIRED",
  );
  expect(createRecoveryRuntime).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it("keeps the R2-only actions working after the integrator key has expired", async () => {
  const expired = { ...configuration, pgcfKeyExpiresAt: "2020-01-01T00:00:00.000Z" };
  vi.mocked(createRecoveryRuntime).mockImplementation(() => async () => ({
    status: "unavailable" as const,
  }));
  await expect(
    createContainerRecoveryRuntime(expired, "production", TOKEN)(command),
  ).resolves.toEqual({ status: "unavailable" });
  expect(createRecoveryRuntime).toHaveBeenCalledTimes(1);
});

it("accepts a configuration without the key's expiry and warns once per run", async () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { pgcfKeyExpiresAt: _unset, ...unset } = configuration;
  void _unset;
  vi.mocked(createRecoveryRuntime).mockImplementation(() => async () => ({
    status: "unavailable" as const,
  }));
  await createContainerRecoveryRuntime(unset, "production", TOKEN)(RUN);
  const lines = logs.mock.calls.map((call) => String(call[0]));
  expect(lines.filter((line) => line.includes('"event":"pgcf_key_expiry_unset"'))).toHaveLength(1);
  expect(createRecoveryRuntime).toHaveBeenCalledTimes(1);
});

it("records one audit line per run with the key's expiry, before the provider is used", async () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.mocked(createRecoveryRuntime).mockImplementation(() => async () => ({
    status: "unavailable" as const,
  }));
  await createContainerRecoveryRuntime(configuration, "production", TOKEN)(RUN);
  const audit = logs.mock.calls
    .map((call) => String(call[0]))
    .find((line) => line.includes("database_provider_key_use"));
  expect(JSON.parse(audit ?? "null")).toEqual({
    event: "database_provider_key_use",
    action: RUN.action,
    keyExpiresAt: configuration.pgcfKeyExpiresAt,
  });
});

it("composes the runtime on the mediated port only and closes its resources", async () => {
  const destroyed = vi.spyOn(S3Client.prototype, "destroy");
  const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const seen: Record<string, unknown>[] = [];
  vi.mocked(createRecoveryRuntime).mockImplementation((dependencies) => {
    seen.push(dependencies as never);
    return async () => ({ status: "unavailable" as const });
  });
  await expect(
    createContainerRecoveryRuntime(configuration, "production", TOKEN)(command),
  ).resolves.toEqual({ status: "unavailable" });
  expect(destroyed).toHaveBeenCalledTimes(2);
  const dependencies = seen[0] as Record<string, unknown>;
  expect(Object.keys(dependencies).sort()).toEqual([
    "archiveDownloads",
    "archives",
    "cipher",
    "clock",
    "control",
    "database",
  ]);
  expect(Object.keys(dependencies["control"] as object).sort()).toEqual([
    "acknowledgeRestore",
    "acquireFence",
    "applyRestoreOffline",
    "assertRestoreImportAllowed",
    "authorizeNativeCapture",
    "beginRestore",
    "claim",
    "completePinReconciliation",
    "completeRestore",
    "discardArchive",
    "dispatchArchive",
    "finish",
    "isRestoreAcknowledged",
    "isRestoreRealmImported",
    "markRestoreImported",
    "markRestoreRealmImported",
    "prepareArchive",
    "readArchive",
    "readClaimState",
    "readCleanupTarget",
    "readInventory",
    "readPinReconciliation",
    "readRestoreClaim",
    "readRestoreInput",
    "readRestorePinDeletionTarget",
    "recordNativeExportRetired",
    "recordRestorePin",
    "recordRestorePinAbsent",
    "recordRestorePinDeletionAbsent",
    "releaseFence",
    "renewFence",
    "reserveRestorePin",
    "revalidateRestore",
    "sanitizeRestore",
  ]);
  // An injected port replaces the HTTP client (the same closed interface).
  const injected = { marker: true } as unknown as RecoveryControl;
  await createContainerRecoveryRuntime(
    configuration,
    "poc-private-fullstack",
    undefined,
    injected,
  )(command);
  expect((seen[1] as Record<string, unknown>)["control"]).toBe(injected);
  // A download uses no PGCF key, so nothing is logged before the provider requests of the capture.
  expect(logs).not.toHaveBeenCalled();
  // Every provider request of the capture is logged (without its credential) by the Container.
  const physical = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
  const audited = (
    await (async () => {
      let captured: Record<string, unknown> | undefined;
      vi.mocked(createRecoveryRuntime).mockImplementationOnce((dependencies) => {
        captured = dependencies as never;
        return async () => ({ status: "unavailable" as const });
      });
      await createContainerRecoveryRuntime(configuration, "production", TOKEN)(command);
      return captured;
    })()
  )?.["database"] as ReturnType<typeof createContainerRecoveryDatabaseReader>;
  await expect(
    audited.read(
      {
        provider: "pgcf",
        providerProjectId: configuration.pgcf.projectId,
        databaseId: "a".repeat(20),
        regionId: "eu-dev",
        postgresVersion: "18",
        databaseName: "a".repeat(20),
        roleName: `ohmyho_backup_${physical.toLowerCase()}`,
        databaseEnvironmentId: physical,
        targetVersion: 1,
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(logs).toHaveBeenCalledWith(expect.stringContaining('"event":"database_provider_request"'));
  vi.unstubAllGlobals();
  // A restore cannot reach its encrypted archive or provider with an incomplete private port.
  vi.mocked(createRecoveryRuntime).mockImplementationOnce((dependencies) => async () => {
    if (!dependencies.restore) throw new Error("missing restore");
    return dependencies.restore();
  });
  await expect(
    createContainerRecoveryRuntime(
      configuration,
      "production",
      undefined,
      injected,
    )({
      action: "restore",
      organizationId: command.organizationId,
      projectId: command.projectId,
      restoreId: command.operationId,
      claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
  ).rejects.toThrow("recovery_restore_scope_unavailable");
  const destroyedBeforeFailure = destroyed.mock.calls.length;
  vi.mocked(createRecoveryRuntime).mockImplementation(() => async () => {
    throw new Error("boom");
  });
  await expect(
    createContainerRecoveryRuntime(configuration, "production", TOKEN)(command),
  ).rejects.toThrow("boom");
  expect(destroyed).toHaveBeenCalledTimes(destroyedBeforeFailure + 2);
});
