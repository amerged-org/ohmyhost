import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
const r2 = vi.hoisted(() => ({
  createTransfer: vi.fn(),
  observeObject: vi.fn(),
  erasePayloads: vi.fn(),
  readObject: vi.fn(),
}));
vi.mock("@ohmyhost/provider-cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ohmyhost/provider-cloudflare")>()),
  createCloudflareR2ObjectTransferProvider: () => r2,
}));
import { parseUlid } from "@ohmyhost/platform";
import {
  StorageErasureConflictError,
  StorageGatewayBindingChangedError,
  StorageGatewayConflictError,
  StorageGatewayDataChangeInProgressError,
  StorageGatewayQuotaError,
  storageErasureMarkerDigest,
} from "@ohmyhost/database";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import {
  seedAcceptedOperation,
  seedCleanupRun,
} from "../../control-store/test/support/accepted-operation.js";
import {
  createCoreRetiredStoragePersistence,
  createCoreStoragePersistence,
  requireStorageCore,
  requireStorageDataCore,
} from "../src/core-persistence.js";
import { createStorageDataManagementEntrypoint } from "../src/management-entrypoint.js";
import { createRetiredStoragePurger } from "../src/management.js";
import worker from "../src/worker-main.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120000);
afterAll(async () => control?.dispose());

const time = "2026-10-28T12:00:00.000Z";
const later = "2026-10-28T12:10:00.000Z";
/** The stored microsecond form of `time`, as the shared schema checks it. */
const stored = "2026-10-28T12:00:00.000000Z";
const sha = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

/** An isolated project whose Development environment owns a bucket, a Storage key and its own data environment. */
async function seedStorage(label: string) {
  const organizationId = await seedOrganization(store, 2, 0),
    project = projectInput(organizationId, `${label}-${newUlid().toLowerCase()}`, false);
  project.developmentDataEnvironmentId = project.developmentEnvironmentId;
  project.productionDataEnvironmentId = project.productionEnvironmentId;
  await store.projects.createInitialProject(project);
  const scope = {
      organizationId,
      projectId: project.projectId,
      environmentId: project.developmentEnvironmentId,
      dataEnvironmentId: project.developmentDataEnvironmentId,
    },
    bucket = `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
    secret = `key-${label}`.padEnd(43, "x"),
    key = await sha(secret);
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
      )
      .bind(
        organizationId,
        scope.projectId,
        scope.environmentId,
        newUlid(),
        newUlid(),
        bucket,
        crypto.randomUUID().replaceAll("-", ""),
        stored,
      ),
    control.core
      .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,1,?4,?5)")
      .bind(organizationId, scope.projectId, scope.environmentId, key, stored),
  ]);
  return { project, scope, bucket, key, secret };
}

const upload = (
  scope: { organizationId: string; projectId: string; environmentId: string },
  objectKey: string,
  extra: Record<string, unknown> = {},
) => ({
  transferId: newUlid(),
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  environmentId: scope.environmentId,
  idempotencyKey: objectKey,
  requestSha256: new Uint8Array(32).fill(7),
  objectKey,
  contentType: "application/octet-stream",
  expectedBytes: 3,
  requestedAt: time,
  expiresAt: "2026-10-28T12:05:00.000Z",
  ...extra,
});

/** A peer whose named commands answer as given: how the RPC boundary can fail or lie, which the real store never does. */
const peer = (answers: Record<string, () => unknown>) =>
  requireStorageCore({
    ...store.storageGateway,
    ...Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => [name, async () => answer()]),
    ),
  });

it("authenticates, claims, completes, reads and erases through the real Core in the frozen scope", async () => {
  const { scope, bucket, key } = await seedStorage("gateway"),
    other = await seedStorage("foreign"),
    binding = requireStorageCore(store.storageGateway),
    persistence = createCoreStoragePersistence(binding, {
      kind: "egress",
      projectId: scope.projectId,
    }),
    logical = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
    ids = [scope.projectId, scope.environmentId].map(parseUlid) as [
      ReturnType<typeof parseUlid>,
      ReturnType<typeof parseUlid>,
    ];

  await expect(persistence.readObjects({ ...logical, objectKeys: ["a.bin"] })).rejects.toThrow(
    "Storage work before authentication",
  );
  // Neither a wrong key nor another project's valid key authenticates this deployment.
  expect(await persistence.authenticate(...ids, await sha("wrong"))).toBeNull();
  expect(
    await persistence.authenticate(
      parseUlid(other.scope.projectId),
      parseUlid(other.scope.environmentId),
      other.key,
    ),
  ).toBeNull();
  const identity = await persistence.authenticate(...ids, key);
  expect(identity).toEqual({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    bucketName: bucket,
    jurisdiction: "eu",
    quotaBytes: 1073741824,
    dataEnvironmentId: scope.dataEnvironmentId,
  });
  // Once frozen, authentication carries the data environment and still answers the same identity; a foreign
  // deployment's key names another data environment, which the frozen scope refuses by class.
  expect(await persistence.authenticate(...ids, key)).toEqual(identity);
  await expect(
    persistence.authenticate(
      parseUlid(other.scope.projectId),
      parseUlid(other.scope.environmentId),
      other.key,
    ),
  ).rejects.toBeInstanceOf(StorageGatewayBindingChangedError);

  const first = upload(scope, "first.bin"),
    claimed = await persistence.claim(first);
  expect(claimed).toEqual({
    outcome: "claimed",
    transferId: first.transferId,
    expiresAt: new Date(first.expiresAt),
    physicalObjectKey: `d/${scope.dataEnvironmentId}/first.bin`,
    dataEnvironmentId: scope.dataEnvironmentId,
  });
  expect(await persistence.claim({ ...first, transferId: newUlid() })).toMatchObject({
    outcome: "existing",
    transferId: first.transferId,
  });
  // The same idempotency key with another request is a conflict, whatever the peer's class identity across RPC.
  await expect(
    persistence.claim({ ...first, transferId: newUlid(), contentType: "text/plain" }),
  ).rejects.toMatchObject({
    name: "StorageGatewayConflictError",
    code: "storage_gateway_conflict",
  });
  await expect(
    persistence.claim(upload(scope, "huge.bin", { expectedBytes: 1073741824 })),
  ).rejects.toBeInstanceOf(StorageGatewayQuotaError);

  const reservation = await persistence.readReservation({
    ...logical,
    transferId: first.transferId,
  });
  expect(reservation).toEqual({
    transferId: first.transferId,
    objectKey: "first.bin",
    contentType: "application/octet-stream",
    expectedBytes: 3,
    requestedAt: new Date(time),
    expiresAt: new Date(first.expiresAt),
    completed: false,
    environmentId: scope.environmentId,
    physicalObjectKey: `d/${scope.dataEnvironmentId}/first.bin`,
    dataEnvironmentId: scope.dataEnvironmentId,
    jurisdiction: "eu",
  });
  expect(await persistence.readReservation({ ...logical, transferId: newUlid() })).toBeNull();
  expect(await persistence.readObject({ ...logical, objectKey: "first.bin" })).toBeNull();

  const receipt = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    transferId: first.transferId,
    objectKey: "first.bin",
    contentType: "application/octet-stream",
    size: 3,
    etag: "a".repeat(32),
    uploadedAt: new Date("2026-10-28T12:00:30.000Z"),
  };
  expect(await persistence.complete(receipt)).toBe("created");
  expect(await persistence.complete(receipt)).toBe("existing");
  expect(await persistence.claim({ ...first, transferId: newUlid() })).toMatchObject({
    outcome: "completed",
  });
  const object = await persistence.readObject({ ...logical, objectKey: "first.bin" });
  expect(object).toMatchObject({
    ...receipt,
    jurisdiction: "eu",
    dataEnvironmentId: scope.dataEnvironmentId,
    physicalObjectKey: `d/${scope.dataEnvironmentId}/first.bin`,
  });
  expect(object?.uploadedAt).toBeInstanceOf(Date);
  expect(
    await persistence.readObjects({ ...logical, objectKeys: ["missing.bin", "first.bin"] }),
  ).toEqual([null, object]);

  const second = upload(scope, "second.bin");
  await persistence.claim(second);
  const deletion = {
      deletionId: newUlid(),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      idempotencyKey: "delete-second",
      requestSha256: new Uint8Array(32).fill(9),
      objectKey: "second.bin",
      requestedAt: later,
    },
    deleteClaim = await persistence.claimDelete(deletion);
  expect(deleteClaim).toEqual({
    outcome: "claimed",
    deletionId: deletion.deletionId,
    environmentId: scope.environmentId,
    jurisdiction: "eu",
    physicalObjectKey: `d/${scope.dataEnvironmentId}/second.bin`,
    dataEnvironmentId: scope.dataEnvironmentId,
    expiresAt: new Date(second.expiresAt),
    completedAt: null,
    transferId: second.transferId,
    payloadErased: false,
  });
  expect(await persistence.claimDelete({ ...deletion, deletionId: newUlid() })).toMatchObject({
    outcome: "existing",
    deletionId: deletion.deletionId,
  });
  const proof = (
    claim: { deletionId: string; transferId: string; physicalObjectKey: string },
    objectKey: string,
  ) => ({
    deletionId: claim.deletionId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    dataEnvironmentId: scope.dataEnvironmentId,
    transferId: claim.transferId,
    objectKey,
    physicalObjectKey: claim.physicalObjectKey,
    markerSha256: storageErasureMarkerDigest({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      dataEnvironmentId: scope.dataEnvironmentId,
      transferId: claim.transferId,
      physicalObjectKey: claim.physicalObjectKey,
    }),
    erasedAt: "2026-10-28T12:10:05.000Z",
  });
  const erasure = proof(deleteClaim, "second.bin");
  await expect(
    persistence.completeDelete({ ...erasure, markerSha256: new Uint8Array(32) }),
  ).rejects.toBeInstanceOf(StorageErasureConflictError);
  expect(await persistence.completeDelete(erasure)).toBe("created");
  expect(await persistence.completeDelete(erasure)).toBe("existing");
  expect(await persistence.claimDelete({ ...deletion, deletionId: newUlid() })).toMatchObject({
    outcome: "completed",
    payloadErased: true,
    completedAt: new Date("2026-10-28T12:10:05.000Z"),
  });

  // A bulk claim answers per key: the unknown key is not_found, the live one claimed, and a settled one completed.
  const third = upload(scope, "third.bin");
  await persistence.claim(third);
  const bulk = [
      { ...deletion, deletionId: newUlid(), idempotencyKey: "bulk-third", objectKey: "third.bin" },
      { ...deletion, deletionId: newUlid(), idempotencyKey: "bulk-none", objectKey: "none.bin" },
    ],
    claims = await persistence.claimDeletes(bulk);
  expect(claims.map((c) => c.state)).toEqual(["claimed", "not_found"]);
  expect(claims[1]).toEqual({ state: "not_found", objectKey: "none.bin" });
  const thirdClaim = claims[0];
  if (thirdClaim?.state !== "claimed") throw new Error("expected a claimed deletion");
  expect(thirdClaim).toMatchObject({
    objectKey: "third.bin",
    deletionId: bulk[0]?.deletionId,
    completedAt: null,
    payloadErased: false,
  });
  expect(await persistence.completeDeletes([proof(thirdClaim, "third.bin")])).toEqual(["created"]);
  expect((await persistence.claimDeletes([bulk[0] as (typeof bulk)[0]]))[0]).toMatchObject({
    state: "completed",
    payloadErased: true,
  });
});

it("maps the error classes that survive the RPC boundary only by name and refuses malformed answers", async () => {
  const { scope } = await seedStorage("peer"),
    persistence = (answers: Record<string, () => unknown>) =>
      createCoreStoragePersistence(peer(answers), scope),
    named = (name: string, message = name) => Object.assign(new Error(message), { name }) as Error,
    refuse = (error: unknown) => () => {
      throw error;
    },
    claim = upload(scope, "peer.bin");

  const mapped: [string, new (...arguments_: never[]) => Error][] = [
    ["StorageGatewayConflictError", StorageGatewayConflictError],
    ["StorageGatewayQuotaError", StorageGatewayQuotaError],
    ["StorageGatewayBindingChangedError", StorageGatewayBindingChangedError],
    ["StorageGatewayDataChangeInProgressError", StorageGatewayDataChangeInProgressError],
    ["StorageErasureConflictError", StorageErasureConflictError],
  ];
  for (const [name, error] of mapped)
    await expect(
      persistence({ claimStorageUpload: refuse(named(name)) }).claim(claim),
    ).rejects.toBeInstanceOf(error);
  await expect(
    persistence({
      claimStorageUpload: refuse(named("StorageGatewayConflictError", "multiple historical files")),
    }).claim(claim),
  ).rejects.toMatchObject({ code: "storage_object_conflict" });
  const unknown = new Error("network down");
  await expect(persistence({ claimStorageUpload: refuse(unknown) }).claim(claim)).rejects.toBe(
    unknown,
  );

  await expect(persistence({ claimStorageUpload: () => "no" }).claim(claim)).rejects.toThrow(
    "Invalid Storage Core response",
  );
  await expect(
    persistence({ claimStorageUpload: () => ({ expiresAt: "soon" }) }).claim(claim),
  ).rejects.toThrow("Invalid Storage Core date");
  await expect(
    persistence({ completeStorageUpload: () => "maybe" }).complete({
      ...scope,
      transferId: claim.transferId,
      objectKey: "peer.bin",
      contentType: claim.contentType,
      size: 3,
      etag: "a".repeat(32),
      uploadedAt: new Date(time),
    }),
  ).rejects.toThrow("Invalid Storage completion response");
  await expect(
    persistence({ readStorageObjects: () => ({}) }).readObjects({ ...scope, objectKeys: ["a"] }),
  ).rejects.toThrow("Invalid Storage objects response");
  await expect(persistence({ claimStorageDeletes: () => ({}) }).claimDeletes([])).rejects.toThrow(
    "Invalid Storage delete response",
  );
  await expect(
    persistence({ claimStorageDeletes: () => [{ state: "weird" }] }).claimDeletes([]),
  ).rejects.toThrow("Invalid Storage delete state");
  await expect(
    persistence({ completeStorageErasures: () => ["created", "created"] }).completeDeletes([
      {
        deletionId: newUlid(),
        ...scope,
        transferId: newUlid(),
        objectKey: "a",
        physicalObjectKey: "d/a",
        markerSha256: new Uint8Array(32),
        erasedAt: later,
      },
    ]),
  ).rejects.toThrow("Invalid Storage erasure vector");

  // A peer that answers an identity of another scope than the frozen one authenticates nothing.
  const identity = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    bucketName: "bucket",
    jurisdiction: "eu",
    quotaBytes: 1,
    dataEnvironmentId: scope.dataEnvironmentId,
  };
  const ids = [parseUlid(scope.projectId), parseUlid(scope.environmentId)] as const;
  expect(
    await persistence({ authenticateStorageGateway: () => identity }).authenticate(
      ...ids,
      new Uint8Array(32),
    ),
  ).toEqual(identity);
  expect(
    await persistence({
      authenticateStorageGateway: () => ({ ...identity, dataEnvironmentId: newUlid() }),
    }).authenticate(...ids, new Uint8Array(32)),
  ).toBeNull();
  expect(
    await persistence({ authenticateStorageGateway: () => null }).authenticate(
      ...ids,
      new Uint8Array(32),
    ),
  ).toBeNull();

  expect(() => requireStorageCore({ ...store.storageGateway, claimStorageUpload: 1 })).toThrow(
    "Storage private Core runtime required",
  );
  expect(() => requireStorageCore(null)).toThrow("Storage private Core runtime required");
  expect(() => requireStorageDataCore({})).toThrow("Retired Storage Core runtime required");
  expect(() => requireStorageDataCore("data")).toThrow("Retired Storage Core runtime required");
});

/** The retired data environment of a project whose Development environment moved on, holding one claimed upload. */
async function seedRetired(label: string) {
  const { project, scope } = await seedStorage(label),
    persistence = createCoreStoragePersistence(requireStorageCore(store.storageGateway), scope),
    physical = `d/${scope.dataEnvironmentId}/retired.bin`,
    current = newUlid(),
    ids = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      billingEpochId: project.billingEpochId,
      shard: control.core,
    };
  await persistence.claim(upload(scope, "retired.bin"));
  const { operationId, claimId } = await seedAcceptedOperation(ids, scope.environmentId, {
    eventType: "ProjectDataChangeRequestedV1",
    at: stored,
    intent: async (operation) => ({
      expected_etag: "fixture-etag",
      cleanup_run_id: await seedCleanupRun(ids, operation),
      data_change: "reset_dev",
      data_change_snapshot: JSON.stringify({
        transition: { redeployEnvironments: ["dev"] },
        environmentHeads: [{}, {}],
        registrationGenerations: [],
      }),
    }),
  });
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at)VALUES(?1,?2,?3,?4)",
      )
      .bind(scope.organizationId, scope.projectId, current, stored),
    control.core
      .prepare(
        "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,operation_id,assigned_at)VALUES(?1,?2,?3,?4,2,?5,?6)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        current,
        operationId,
        stored,
      ),
  ]);
  return { scope, physical, current, retired: { ...scope, operationId, claimId } };
}

/** The provider side of a purge: one object that exists until it is erased, and the proof that erases it. */
function eraseOnly(files: Set<string>, erasedAt = new Date("2026-10-29T00:00:00.000Z")) {
  return {
    observeObject: async (value: unknown) => {
      const objectKey = (value as { objectKey: string }).objectKey;
      return files.has(objectKey)
        ? {
            state: "found" as const,
            objectKey,
            contentType: "application/octet-stream",
            contentLength: 3,
            etag: "a".repeat(32),
            uploadedAt: new Date("2026-10-28T12:00:30.000Z"),
          }
        : { state: "absent" as const, objectKey };
    },
    erasePayloads: async (value: unknown) => {
      const objects = (
        value as {
          objects: {
            organizationId: string;
            projectId: string;
            environmentId: string;
            dataEnvironmentId: string;
            transferId: string;
            objectKey: string;
          }[];
        }
      ).objects;
      for (const object of objects) files.delete(object.objectKey);
      return objects.map((object) => ({
        objectKey: object.objectKey,
        transferId: object.transferId,
        status: "erased" as const,
        markerSha256: storageErasureMarkerDigest({
          ...object,
          physicalObjectKey: object.objectKey,
        }),
        erasedAt,
      }));
    },
  };
}

it("purges a retired data environment through the D1 entrypoint and the real retired commands", async () => {
  const { scope, physical, retired } = await seedRetired("retired"),
    files = new Set([physical]),
    Entrypoint = createStorageDataManagementEntrypoint({
      createProvider: () => eraseOnly(files),
      clock: { now: () => new Date("2026-10-29T00:00:00.000Z") },
      ids: { next: newUlid },
    }),
    entrypoint = new Entrypoint({} as never, {
      RUNTIME_CONFIGURATION_STATE: "configured",
      STORAGE_DATA_RUNTIME: store.storageData,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_R2_API_TOKEN: "s".repeat(40),
      CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "a".repeat(32),
    });

  expect(await entrypoint.purgeRetiredData(retired)).toEqual({ status: "ready", deletedFiles: 1 });
  expect([...files]).toEqual([]);
  expect(await entrypoint.purgeRetiredData(retired)).toEqual({ status: "ready", deletedFiles: 1 });
  expect(
    (
      await control.core
        .prepare(
          "SELECT count(*) AS n FROM project_r2_erasure_barriers WHERE data_environment_id=?",
        )
        .bind(scope.dataEnvironmentId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);

  // The retired port refuses an inventory that is not the closed shape the store answers.
  const lying = createCoreRetiredStoragePersistence(
    requireStorageDataCore({
      ...store.storageData,
      readRetiredStorageInventory: async () => ({ items: "none" }),
    }),
  );
  await expect(lying.read(retired)).rejects.toThrow("Invalid retired inventory");
});

it("waits for the old upload leases, answers uncertain on a lost deletion reply and refuses a foreign scope before the provider", async () => {
  const { physical, current, retired } = await seedRetired("purger"),
    files = new Set([physical]);
  let clock = new Date("2026-10-28T12:04:59.000Z"),
    lost = true,
    erasures = 0;
  const provider = eraseOnly(files),
    purger = createRetiredStoragePurger({
      persistence: createCoreRetiredStoragePersistence(requireStorageDataCore(store.storageData)),
      nextId: newUlid,
      now: () => clock,
      provider: {
        observeObject: provider.observeObject,
        erasePayloads: async (value) => {
          erasures++;
          const erased = await provider.erasePayloads(value);
          if (lost) {
            lost = false;
            throw new Error("lost delete reply");
          }
          return erased;
        },
      },
    });

  // The signed upload may still be in flight: nothing is erased before its lease has drained.
  expect(await purger.purgeRetiredData(retired)).toEqual({
    status: "pending",
    retryAfterSeconds: 32,
  });
  expect(erasures).toBe(0);
  clock = new Date("2026-10-28T12:06:00.000Z");
  expect(await purger.purgeRetiredData(retired)).toEqual({ status: "uncertain" });
  expect([...files]).toEqual([]);
  expect(await purger.purgeRetiredData(retired)).toEqual({ status: "ready", deletedFiles: 1 });
  expect(erasures).toBe(2);

  for (const scope of [
    {},
    { ...retired, extra: true },
    { ...retired, organizationId: newUlid() },
    { ...retired, claimId: newUlid() },
    { ...retired, dataEnvironmentId: current },
  ])
    await expect(purger.purgeRetiredData(scope)).rejects.toThrow();
  expect(erasures).toBe(2);
});

it("serves upload, completion, download, deletion and both bulk routes of the Worker on the real Core", async () => {
  const { scope, secret } = await seedStorage("worker"),
    persistence = createCoreStoragePersistence(requireStorageCore(store.storageGateway), scope),
    env = {
      RUNTIME_CONFIGURATION_STATE: "configured",
      STORAGE_GATEWAY_RUNTIME: store.storageGateway,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_R2_API_TOKEN: "s".repeat(40),
      CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "a".repeat(32),
      GATEWAY_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    call = async (path: string, body: object, idempotencyKey?: string, bearer = secret) => {
      const response = await worker.fetch(
        new Request(`https://gateway.example.test${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
          },
          body: JSON.stringify({
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            ...body,
          }),
        }),
        env as never,
        { props: scope },
      );
      return {
        response,
        json:
          response.headers.get("content-type")?.includes("json") === true
            ? await response.json()
            : null,
      };
    };
  // Three objects stored long ago, so that their upload leases have drained and they can be erased.
  for (const objectKey of ["read.bin", "delete.bin", "bulk.bin"]) {
    const claimed = upload(scope, objectKey);
    await persistence.claim(claimed);
    await persistence.complete({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      transferId: claimed.transferId,
      objectKey,
      contentType: "application/octet-stream",
      size: 3,
      etag: "a".repeat(32),
      uploadedAt: new Date("2026-10-28T12:00:30.000Z"),
    });
  }
  r2.createTransfer.mockImplementation(async (input: { operation: string; objectKey: string }) => ({
    operation: input.operation,
    objectKey: input.objectKey,
    url: "https://signed.example.test",
    expiresAt: new Date(Date.now() + 300_000),
    expectedContentLength: 3,
    requiredHeaders: {},
  }));
  r2.observeObject.mockImplementation(async (input: { objectKey: string }) => ({
    state: "found",
    objectKey: input.objectKey,
    contentType: "application/octet-stream",
    contentLength: 3,
    etag: "b".repeat(32),
    uploadedAt: new Date(),
  }));
  r2.erasePayloads.mockImplementation(async (value: unknown) =>
    eraseOnly(new Set(), new Date()).erasePayloads(value),
  );
  r2.readObject.mockImplementation(async (input: { objectKey: string }) => ({
    state: "found",
    objectKey: input.objectKey,
    contentType: "application/octet-stream",
    contentLength: 3,
    etag: "a".repeat(32),
    body: new Response(new Uint8Array([1, 2, 3])).body,
  }));

  const uploaded = await call(
    "/v1/uploads",
    { objectKey: "new.bin", contentType: "application/octet-stream", contentLength: 3 },
    "new-upload",
  );
  expect(uploaded.response.status).toBe(200);
  expect(uploaded.json).toMatchObject({ state: "ready", capability: { objectKey: "new.bin" } });
  const completed = await call("/v1/uploads/complete", { transferId: uploaded.json.transfer_id });
  expect(completed.json).toMatchObject({
    state: "completed",
    transfer_id: uploaded.json.transfer_id,
  });
  expect((await call("/v1/downloads", { objectKey: "new.bin" })).json).toMatchObject({
    state: "ready",
    capability: { objectKey: "new.bin" },
  });
  expect((await call("/v1/downloads", { objectKey: "none.bin" })).response.status).toBe(404);

  // The fresh upload may still be written to, so its deletion waits; an old one is erased.
  const pending = await call("/v1/deletions", { objectKey: "new.bin" }, "delete-new");
  expect(pending.response.status).toBe(409);
  expect(pending.json).toMatchObject({ code: "storage_delete_pending" });
  const deleted = await call("/v1/deletions", { objectKey: "delete.bin" }, "delete-old");
  expect(deleted.json).toMatchObject({ state: "completed" });
  expect(r2.erasePayloads).toHaveBeenCalledTimes(1);

  const read = await call("/v1/downloads/batch", { objectKeys: ["read.bin", "none.bin"] });
  expect(read.response.headers.get("content-type")).toBe(
    "application/vnd.ohmyhost.storage-batch.v1",
  );
  expect(await read.response.text()).toContain('"state":"not_found"');
  const bulk = await call("/v1/deletions/batch", {
    objects: [
      { objectKey: "bulk.bin", idempotencyKey: "bulk" },
      { objectKey: "none.bin", idempotencyKey: "none" },
    ],
  });
  expect(bulk.json).toMatchObject({
    state: "partial",
    results: [
      { object_key: "bulk.bin", state: "completed" },
      { object_key: "none.bin", state: "failed", code: "object_not_found" },
    ],
  });

  // Another key never authenticates, and the answer does not name the lookup for a deployment's own binding.
  const refused = await call("/v1/downloads", { objectKey: "read.bin" }, undefined, "z".repeat(43));
  expect(refused.response.status).toBe(401);
  expect(refused.response.headers.get("x-ohmyhost-gateway-stage")).toBeNull();
  expect(refused.json).toEqual({ code: "unauthorized" });
});

it("erases abandoned signed uploads a day after their claim through the scheduled Worker, one claim at a time", async () => {
  const { scope } = await seedStorage("sweep"),
    persistence = createCoreStoragePersistence(requireStorageCore(store.storageGateway), scope),
    now = Date.now(),
    at = (milliseconds: number) => new Date(now + milliseconds).toISOString(),
    hour = 3_600_000,
    minute = 60_000,
    physical = (objectKey: string) => `d/${scope.dataEnvironmentId}/${objectKey}`,
    stale = upload(scope, "stale.bin", {
      requestedAt: at(-25 * hour),
      expiresAt: at(-25 * hour + 5 * minute),
    }),
    broken = upload(scope, "broken.bin", {
      requestedAt: at(-26 * hour),
      expiresAt: at(-26 * hour + 5 * minute),
    }),
    fresh = upload(scope, "fresh.bin", {
      requestedAt: at(-hour),
      expiresAt: at(-hour + 5 * minute),
    });
  for (const claim of [stale, broken, fresh]) await persistence.claim(claim);

  // A fake bucket: each payload exists until it is erased; the erasure of one payload fails at the provider.
  const files = new Set([physical("stale.bin"), physical("broken.bin"), physical("fresh.bin")]);
  r2.observeObject.mockImplementation(async (value: unknown) =>
    eraseOnly(files).observeObject(value),
  );
  r2.erasePayloads.mockImplementation(async (value: unknown) => {
    const objects = (value as { objects: { objectKey: string; transferId: string }[] }).objects;
    if (objects.some((object) => object.objectKey === physical("broken.bin")))
      return objects.map((object) => ({
        objectKey: object.objectKey,
        transferId: object.transferId,
        status: "failed" as const,
        retryable: true,
      }));
    return eraseOnly(files, new Date()).erasePayloads(value);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await worker.scheduled(undefined, {
      RUNTIME_CONFIGURATION_STATE: "configured",
      STORAGE_GATEWAY_RUNTIME: store.storageGateway,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_R2_API_TOKEN: "s".repeat(40),
      CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "a".repeat(32),
    });

    // The stale payload is gone and its claim carries the barrier; the failed one is kept for the next pass.
    expect([...files].sort()).toEqual([physical("broken.bin"), physical("fresh.bin")].sort());
    const barriers = await control.core
      .prepare("SELECT object_key FROM project_r2_erasure_barriers WHERE project_id = ?1")
      .bind(scope.projectId)
      .all<{ object_key: string }>();
    expect(barriers.results.map((row) => row.object_key)).toEqual(["stale.bin"]);
    const listed = await store.storageGateway.readUnconfirmedStorageClaims({
      now: new Date(now).toISOString(),
      limit: 50,
    });
    expect(
      listed.filter((claim) => claim.projectId === scope.projectId).map((c) => c.objectKey),
    ).toEqual(["broken.bin"]);
    // The failure is reported per claim, with its code and transfer, never its object key.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"storage_upload_sweep_failed"'),
    );
    expect(warn.mock.calls.flat().join("\n")).not.toContain("broken.bin");
  } finally {
    warn.mockRestore();
  }
}, 60_000);
