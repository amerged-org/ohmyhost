import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid, type CatalogContext } from "../../src/catalog/common.js";
import { authenticateStorageGateway } from "../../src/catalog/storage-gateway/auth.js";
import {
  StorageErasureConflictError,
  StorageGatewayBindingChangedError,
  StorageGatewayConflictError,
  StorageGatewayDataChangeInProgressError,
  StorageGatewayQuotaError,
} from "../../src/catalog/storage-gateway/common.js";
import {
  claimStorageDelete,
  claimStorageDeletes,
  completeStorageErasure,
  completeStorageErasures,
} from "../../src/catalog/storage-gateway/deletes.js";
import {
  claimRetiredStorageDeletes,
  completeRetiredStorageDeletes,
  readRetiredStorageInventory,
} from "../../src/catalog/storage-gateway/retired.js";
import {
  claimStorageUpload,
  completeStorageUpload,
  markUnconfirmedStorageClaimAttempts,
  readStorageObject,
  readStorageObjects,
  readStorageUploadReservation,
  readUnconfirmedStorageClaims,
} from "../../src/catalog/storage-gateway/uploads.js";
import type { D1Database } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createControlStore } from "../../src/store.js";
import { seedAcceptedOperation, seedCleanupRun } from "../support/accepted-operation.js";
import { createTestControl, losingNthResponse, type TestControl } from "../support/control-d1.js";
import { projectInput, seedOrganization } from "../support/seed.js";

const TIME = "2026-10-28T12:00:00.000000Z";
const EXPIRES = "2026-10-28T12:05:00.000Z";
const UPLOADED = new Date("2026-10-28T12:00:30Z");

let control: TestControl;
let db: D1Database;
let context: CatalogContext;
let store: ReturnType<typeof createControlStore>;
let organizationId: string;

beforeAll(async () => {
  control = await createTestControl(1);
  db = control.core;
  context = { directory: db, router: new SharedCoreRouter(db) };
  store = createControlStore(control.bindings);
  organizationId = await seedOrganization(store, 1, 0);
}, 60_000);
afterAll(async () => control.dispose());

const sha256Hex = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

interface Gateway {
  readonly scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    dataEnvironmentId: string;
  };
  readonly keySha256: Uint8Array;
  readonly billingEpochId: string;
  readonly prodEnvironmentId: string;
}

/** An isolated project whose development environment owns a bucket receipt and a Storage Gateway key. */
async function seedGateway(): Promise<Gateway> {
  const project = projectInput(organizationId, `storage-${newUlid().toLowerCase()}`, false);
  await store.projects.createInitialProject(project);
  const scope = {
    organizationId,
    projectId: project.projectId,
    environmentId: project.developmentEnvironmentId,
    dataEnvironmentId: project.developmentDataEnvironmentId,
  };
  const keySha256 = new Uint8Array(32).fill(Math.floor(Math.random() * 200) + 1);
  await db.batch([
    db
      .prepare(
        "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
      )
      .bind(
        organizationId,
        scope.projectId,
        scope.environmentId,
        newUlid(),
        newUlid(),
        `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
        crypto.randomUUID().replaceAll("-", ""),
        TIME,
      ),
    db
      .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,1,?4,?5)")
      .bind(organizationId, scope.projectId, scope.environmentId, keySha256, TIME),
  ]);
  return {
    scope,
    keySha256,
    billingEpochId: project.billingEpochId,
    prodEnvironmentId: project.productionEnvironmentId,
  };
}

const logicalOf = (g: Gateway) => ({
  organizationId: g.scope.organizationId,
  projectId: g.scope.projectId,
  environmentId: g.scope.environmentId,
});
const physical = (g: Gateway, objectKey: string) => `d/${g.scope.dataEnvironmentId}/${objectKey}`;
const count = async (table: string, g: Gateway) =>
  (
    await db
      .prepare(`SELECT count(*) n FROM ${table} WHERE project_id = ?1`)
      .bind(g.scope.projectId)
      .first<{ n: number }>()
  )?.n;

const uploadOf = (g: Gateway, objectKey: string, overrides: Record<string, unknown> = {}) => ({
  ...logicalOf(g),
  transferId: newUlid(),
  idempotencyKey: `idem-${objectKey}`,
  requestSha256: new Uint8Array(32).fill(7),
  objectKey,
  contentType: "application/octet-stream",
  expectedBytes: 3,
  requestedAt: TIME,
  expiresAt: EXPIRES,
  ...overrides,
});
const receiptOf = (g: Gateway, claim: { transferId: string }, objectKey: string) => ({
  ...logicalOf(g),
  transferId: claim.transferId,
  objectKey,
  contentType: "application/octet-stream",
  size: 3,
  etag: "a".repeat(32),
  uploadedAt: UPLOADED,
});
/** Reserves and completes one object; returns its claim. */
async function stored(g: Gateway, objectKey: string) {
  const claim = await claimStorageUpload(context, {
    scope: g.scope,
    input: uploadOf(g, objectKey),
  });
  await completeStorageUpload(context, {
    scope: g.scope,
    input: receiptOf(g, claim, objectKey),
  });
  return claim;
}
const deleteOf = (g: Gateway, objectKey: string, overrides: Record<string, unknown> = {}) => ({
  ...logicalOf(g),
  deletionId: newUlid(),
  idempotencyKey: `delete-${objectKey}`,
  requestSha256: new Uint8Array(32).fill(9),
  objectKey,
  requestedAt: TIME,
  ...overrides,
});
/** The proof the Gateway presents after it erased the payload of one claimed deletion. */
async function proofOf(
  g: Gateway,
  claimed: { deletionId: string; transferId: string; physicalObjectKey: string },
  objectKey: string,
) {
  const marker = await sha256Hex(
    [
      "ohmyhost.r2-erasure/v1",
      g.scope.organizationId,
      g.scope.projectId,
      g.scope.environmentId,
      g.scope.dataEnvironmentId,
      claimed.transferId,
      claimed.physicalObjectKey,
    ].join("\n"),
  );
  return {
    deletionId: claimed.deletionId,
    ...g.scope,
    transferId: claimed.transferId,
    objectKey,
    physicalObjectKey: claimed.physicalObjectKey,
    markerSha256: Uint8Array.from(marker.match(/../gu) ?? [], (pair) => parseInt(pair, 16)),
    erasedAt: "2026-10-28T12:10:00.000Z",
  };
}

describe("storage gateway authority", () => {
  it("authenticates a key in its frozen data scope and refuses a changed binding or a running data change", async () => {
    const g = await seedGateway();
    const identity = {
      organizationId,
      projectId: g.scope.projectId,
      environmentId: g.scope.environmentId,
      bucketName: `ohmyho-${g.scope.projectId.toLowerCase()}-${g.scope.environmentId.toLowerCase()}`,
      jurisdiction: "eu",
      quotaBytes: 1073741824,
      dataEnvironmentId: g.scope.dataEnvironmentId,
    };
    const input = {
      projectId: g.scope.projectId,
      environmentId: g.scope.environmentId,
      keySha256: g.keySha256,
    };
    // Unscoped lookup, scoped lookup under the frozen four-ID authority, and an unknown key.
    expect(await authenticateStorageGateway(context, { scope: null, input })).toEqual(identity);
    expect(await authenticateStorageGateway(context, { scope: g.scope, input })).toEqual(identity);
    expect(
      await authenticateStorageGateway(context, {
        scope: null,
        input: { ...input, keySha256: new Uint8Array(32).fill(255) },
      }),
    ).toBeNull();
    // A deployment frozen for another data assignment is told to redeploy, before any other answer.
    await expect(
      authenticateStorageGateway(context, {
        scope: null,
        input: { ...input, dataEnvironmentId: newUlid() },
      }),
    ).rejects.toBeInstanceOf(StorageGatewayBindingChangedError);
    await expect(
      authenticateStorageGateway(context, {
        scope: { ...g.scope, dataEnvironmentId: newUlid() },
        input,
      }),
    ).rejects.toBeInstanceOf(StorageGatewayBindingChangedError);

    // An accepted data change that redeploys this environment stops the key until the change finishes.
    await seedAcceptedOperation(
      {
        organizationId,
        projectId: g.scope.projectId,
        billingEpochId: g.billingEpochId,
        shard: db,
      },
      g.scope.environmentId,
      { eventType: "ProjectDataChangeRequestedV1" },
    );
    await expect(
      authenticateStorageGateway(context, { scope: null, input }),
    ).rejects.toBeInstanceOf(StorageGatewayDataChangeInProgressError);
    await expect(
      claimStorageUpload(context, { scope: g.scope, input: uploadOf(g, "blocked.bin") }),
    ).rejects.toBeInstanceOf(StorageGatewayDataChangeInProgressError);
    expect(await count("project_r2_upload_reservations", g)).toBe(0);
  });

  it("answers the gateway key lookup through an index, not a scan of the key table", async () => {
    // Capture the statement that every unscoped authentication runs, then ask the migrated Core how it executes that SQL.
    const statements: string[] = [];
    const captured = {
      prepare: (sql: string) => {
        statements.push(sql);
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const capturing = {
      directory: db,
      router: { routeShard: async () => ({ db: captured }) } as unknown as CatalogContext["router"],
    };
    await authenticateStorageGateway(capturing, {
      scope: null,
      input: { projectId: newUlid(), environmentId: newUlid(), keySha256: new Uint8Array(32) },
    });
    expect(statements).toHaveLength(1);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
      .bind(null, null, null)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    expect(
      details.filter((detail) =>
        /^SCAN (?:key|other)\b|^SEARCH (?:key|other) USING AUTOMATIC/u.test(detail),
      ),
    ).toEqual([]);
    // The lookup is a covering search by all three values, and the cross-environment reuse check searches by project
    // and digest rather than by every key of the project.
    expect(details).toContain(
      "SEARCH key USING COVERING INDEX storage_gateway_keys_project_digest (project_id=? AND key_sha256=? AND environment_id=?)",
    );
    expect(details).toContain(
      "SEARCH other USING COVERING INDEX storage_gateway_keys_project_digest (project_id=? AND key_sha256=?)",
    );
  });
});

describe("storage gateway uploads", () => {
  it("refuses a receipt uploaded even one millisecond after the claim expired, with no grace", async () => {
    const g = await seedGateway();
    const claimed = await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "late-receipt.bin"),
    });
    await expect(
      completeStorageUpload(context, {
        scope: g.scope,
        input: {
          ...receiptOf(g, claimed, "late-receipt.bin"),
          uploadedAt: new Date("2026-10-28T12:05:00.001Z"),
        },
      }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);
  });

  it("refuses a claim of an object key already reserved under another idempotency key, with a conflict", async () => {
    const g = await seedGateway();
    const first = uploadOf(g, "a.bin");
    await claimStorageUpload(context, { scope: g.scope, input: first });
    await expect(
      claimStorageUpload(context, {
        scope: g.scope,
        input: {
          ...first,
          idempotencyKey: `${first.idempotencyKey}-second`,
          transferId: newUlid(),
        },
      }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);
  });

  it("refuses an upload claim of an object key whose deletion is already claimed, with a conflict", async () => {
    const g = await seedGateway();
    await stored(g, "x.bin");
    await claimStorageDelete(context, { scope: g.scope, input: deleteOf(g, "x.bin") });
    await expect(
      claimStorageUpload(context, { scope: g.scope, input: uploadOf(g, "x.bin") }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);
  });

  it("keeps an expired unconfirmed claim against the quota until it is completed or erased", async () => {
    const g = await seedGateway();
    await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "abandoned.bin", { expectedBytes: 1073741824 }),
    });
    // an hour later the abandoned claim has expired, but its bytes may still be in the bucket
    const later = "2026-10-28T13:00:00.000000Z";
    await expect(
      claimStorageUpload(context, {
        scope: g.scope,
        input: uploadOf(g, "next.bin", {
          expectedBytes: 3,
          requestedAt: later,
          expiresAt: "2026-10-28T13:05:00.000Z",
        }),
      }),
    ).rejects.toBeInstanceOf(StorageGatewayQuotaError);
  });

  it("claims, replays, completes and reads an upload; refuses conflicts and quota; survives a lost response", async () => {
    const g = await seedGateway();
    const first = uploadOf(g, "a.bin");
    const claimed = await claimStorageUpload(context, { scope: g.scope, input: first });
    expect(claimed).toEqual({
      outcome: "claimed",
      transferId: first.transferId,
      expiresAt: new Date(EXPIRES),
      physicalObjectKey: physical(g, "a.bin"),
      dataEnvironmentId: g.scope.dataEnvironmentId,
    });
    // The same request is the same reservation, never a second one.
    expect(
      await claimStorageUpload(context, {
        scope: g.scope,
        input: { ...first, transferId: newUlid() },
      }),
    ).toMatchObject({ outcome: "existing", transferId: first.transferId });
    expect(await count("project_r2_upload_reservations", g)).toBe(1);
    expect(
      await readStorageUploadReservation(context, {
        scope: g.scope,
        input: { ...logicalOf(g), transferId: first.transferId },
      }),
    ).toEqual({
      transferId: first.transferId,
      objectKey: "a.bin",
      contentType: "application/octet-stream",
      expectedBytes: 3,
      requestedAt: new Date(TIME),
      expiresAt: new Date(EXPIRES),
      completed: false,
      environmentId: g.scope.environmentId,
      dataEnvironmentId: g.scope.dataEnvironmentId,
      physicalObjectKey: physical(g, "a.bin"),
      jurisdiction: "eu",
    });
    expect(
      await readStorageUploadReservation(context, {
        scope: g.scope,
        input: { ...logicalOf(g), transferId: newUlid() },
      }),
    ).toBeNull();

    // Completion is idempotent; the claim then reports the finished upload.
    const receipt = receiptOf(g, claimed, "a.bin");
    expect(await completeStorageUpload(context, { scope: g.scope, input: receipt })).toBe(
      "created",
    );
    expect(await completeStorageUpload(context, { scope: g.scope, input: receipt })).toBe(
      "existing",
    );
    expect(await count("project_r2_objects", g)).toBe(1);
    expect(await claimStorageUpload(context, { scope: g.scope, input: first })).toMatchObject({
      outcome: "completed",
      transferId: first.transferId,
    });
    expect(
      await readStorageUploadReservation(context, {
        scope: g.scope,
        input: { ...logicalOf(g), transferId: first.transferId },
      }),
    ).toMatchObject({ completed: true });

    // Objects are read by logical key; a missing key is null, in input order.
    const object = {
      ...logicalOf(g),
      transferId: first.transferId,
      objectKey: "a.bin",
      contentType: "application/octet-stream",
      size: 3,
      etag: "a".repeat(32),
      uploadedAt: UPLOADED,
      jurisdiction: "eu",
      dataEnvironmentId: g.scope.dataEnvironmentId,
      physicalObjectKey: physical(g, "a.bin"),
    };
    expect(
      await readStorageObjects(context, {
        scope: g.scope,
        input: { ...logicalOf(g), objectKeys: ["missing.bin", "a.bin"] },
      }),
    ).toEqual([null, object]);
    expect(
      await readStorageObject(context, {
        scope: g.scope,
        input: { ...logicalOf(g), objectKey: "a.bin" },
      }),
    ).toEqual(object);
    expect(
      await readStorageObject(context, {
        scope: g.scope,
        input: { ...logicalOf(g), objectKey: "missing.bin" },
      }),
    ).toBeNull();

    // Refusals: a reused idempotency key for another object, a body outside the frozen environment, the quota.
    await expect(
      claimStorageUpload(context, {
        scope: g.scope,
        input: { ...first, transferId: newUlid(), objectKey: "other.bin" },
      }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);
    await expect(
      readStorageObjects(context, {
        scope: g.scope,
        input: { ...logicalOf(g), environmentId: g.prodEnvironmentId, objectKeys: ["a.bin"] },
      }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);
    await expect(
      claimStorageUpload(context, {
        scope: g.scope,
        input: uploadOf(g, "huge.bin", { expectedBytes: 1073741824 }),
      }),
    ).rejects.toBeInstanceOf(StorageGatewayQuotaError);
    expect(await count("project_r2_upload_reservations", g)).toBe(1);

    // The write commits but its response is lost: the retry finds its own reservation instead of making a second.
    // Batches of one claim: scope check, reservation read, total read, key conflict read, then the write (5th).
    const lossy: CatalogContext = {
      directory: db,
      router: new SharedCoreRouter(losingNthResponse(db, 5)),
    };
    const lost = uploadOf(g, "lost.bin");
    expect(await claimStorageUpload(lossy, { scope: g.scope, input: lost })).toMatchObject({
      outcome: "existing",
      transferId: lost.transferId,
    });
    expect(await count("project_r2_upload_reservations", g)).toBe(2);
  }, 30_000);
});

describe("storage gateway deletes", () => {
  it("claims deletions, replays them, records erasure barriers and reports completed payload erasure", async () => {
    const g = await seedGateway();
    const x = await stored(g, "x.bin");
    await stored(g, "y.bin");
    await stored(g, "z.bin");

    const deleteX = deleteOf(g, "x.bin");
    const claimed = await claimStorageDelete(context, { scope: g.scope, input: deleteX });
    expect(claimed).toEqual({
      outcome: "claimed",
      deletionId: deleteX.deletionId,
      environmentId: g.scope.environmentId,
      jurisdiction: "eu",
      physicalObjectKey: physical(g, "x.bin"),
      dataEnvironmentId: g.scope.dataEnvironmentId,
      expiresAt: new Date(EXPIRES),
      completedAt: null,
      transferId: x.transferId,
      payloadErased: false,
    });
    expect(
      await claimStorageDelete(context, {
        scope: g.scope,
        input: { ...deleteX, deletionId: newUlid() },
      }),
    ).toMatchObject({ outcome: "existing", deletionId: deleteX.deletionId });
    expect(await count("project_r2_delete_requests", g)).toBe(1);
    // The same idempotency key with another request body, or an unknown object, is a conflict.
    await expect(
      claimStorageDelete(context, {
        scope: g.scope,
        input: { ...deleteX, requestSha256: new Uint8Array(32).fill(1) },
      }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);
    await expect(
      claimStorageDelete(context, { scope: g.scope, input: deleteOf(g, "missing.bin") }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);

    // A batch claims what exists and names what does not.
    const deleteY = deleteOf(g, "y.bin");
    const batch = await claimStorageDeletes(context, {
      scope: g.scope,
      inputs: [deleteY, deleteOf(g, "missing.bin")],
    });
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({
      state: "claimed",
      objectKey: "y.bin",
      deletionId: deleteY.deletionId,
      payloadErased: false,
    });
    expect(batch[1]).toEqual({ state: "not_found", objectKey: "missing.bin" });

    // The Gateway proves it erased the payload: the barrier and the delete receipt commit together, once.
    const proofX = await proofOf(g, claimed, "x.bin");
    expect(await completeStorageErasure(context, { scope: g.scope, input: proofX })).toBe(
      "created",
    );
    expect(await completeStorageErasure(context, { scope: g.scope, input: proofX })).toBe(
      "existing",
    );
    expect(await count("project_r2_erasure_barriers", g)).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT lower(hex(marker_sha256)) marker FROM project_r2_erasure_barriers WHERE transfer_id = ?1",
        )
        .bind(x.transferId)
        .first(),
    ).toEqual({
      marker: Array.from(proofX.markerSha256, (b) => b.toString(16).padStart(2, "0")).join(""),
    });
    expect(await count("project_r2_delete_receipts", g)).toBe(1);
    const claimedY = batch[0] as {
      deletionId: string;
      transferId: string;
      physicalObjectKey: string;
    };
    expect(
      await completeStorageErasures(context, {
        scope: g.scope,
        inputs: [proofX, await proofOf(g, claimedY, "y.bin")],
      }),
    ).toEqual(["existing", "created"]);
    expect(await count("project_r2_erasure_barriers", g)).toBe(2);
    expect(await count("project_r2_delete_receipts", g)).toBe(2);

    // An erased object is gone for readers and the claim reports the finished erasure.
    expect(
      await readStorageObject(context, {
        scope: g.scope,
        input: { ...logicalOf(g), objectKey: "x.bin" },
      }),
    ).toBeNull();
    expect(await claimStorageDelete(context, { scope: g.scope, input: deleteX })).toMatchObject({
      outcome: "completed",
      payloadErased: true,
    });

    // A proof for another marker, another data scope or a repeated deletion is refused before any write.
    await expect(
      completeStorageErasure(context, {
        scope: g.scope,
        input: { ...proofX, markerSha256: new Uint8Array(32) },
      }),
    ).rejects.toBeInstanceOf(StorageErasureConflictError);
    await expect(
      completeStorageErasure(context, {
        scope: { ...g.scope, dataEnvironmentId: newUlid() },
        input: proofX,
      }),
    ).rejects.toBeInstanceOf(StorageErasureConflictError);
    await expect(
      completeStorageErasures(context, { scope: g.scope, inputs: [proofX, proofX] }),
    ).rejects.toBeInstanceOf(StorageErasureConflictError);
    expect(await count("project_r2_erasure_barriers", g)).toBe(2);
  }, 30_000);
});

describe("retired storage cleanup", () => {
  it("inventories, claims and completes the deletion of a retired data area under an accepted data change", async () => {
    const g = await seedGateway();
    const kept = await stored(g, "kept.bin");
    const reserved = await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "reserved.bin"),
    });

    // The accepted reset retires the data area: the environment now points at a new one.
    const project = {
      organizationId,
      projectId: g.scope.projectId,
      billingEpochId: g.billingEpochId,
      shard: db,
    };
    const { operationId, claimId } = await seedAcceptedOperation(project, g.scope.environmentId, {
      eventType: "ProjectDataChangeRequestedV1",
      intent: async (operation) => ({
        expected_etag: "fixture-etag",
        cleanup_run_id: await seedCleanupRun(project, operation),
        data_change: "reset_dev",
        data_change_snapshot: JSON.stringify({
          transition: { redeployEnvironments: ["dev"] },
          environmentHeads: [{}, {}],
          registrationGenerations: [],
        }),
      }),
    });
    const newData = newUlid();
    await db.batch([
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at)VALUES(?1,?2,?3,?4)",
        )
        .bind(organizationId, g.scope.projectId, newData, TIME),
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,operation_id,assigned_at)VALUES(?1,?2,?3,?4,2,?5,?6)",
        )
        .bind(organizationId, g.scope.projectId, g.scope.environmentId, newData, operationId, TIME),
    ]);
    const ids = { ...g.scope, operationId, claimId };

    const inventory = await readRetiredStorageInventory(context, ids);
    expect(inventory.deletedFiles).toBe(0);
    expect(inventory.maxExpiresAt).toEqual(new Date(EXPIRES));
    expect(inventory.items.map((item) => [item.objectKey, item.completed]).sort()).toEqual([
      ["kept.bin", true],
      ["reserved.bin", false],
    ]);
    expect((await readRetiredStorageInventory(context, { ...ids, limit: 1 })).items).toHaveLength(
      1,
    );
    // Another claim is not this operation's authority.
    await expect(
      readRetiredStorageInventory(context, { ...ids, claimId: newUlid() }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);

    const items = [
      { transferId: kept.transferId, deletionId: newUlid(), objectObserved: true },
      { transferId: reserved.transferId, deletionId: newUlid(), objectObserved: false },
    ];
    const requested = { ...ids, items, requestedAt: TIME };
    const claimed = await claimRetiredStorageDeletes(context, requested);
    expect(claimed).toEqual(
      items.map((item, n) => ({
        deletionId: item.deletionId,
        environmentId: g.scope.environmentId,
        dataEnvironmentId: g.scope.dataEnvironmentId,
        transferId: item.transferId,
        objectKey: n === 0 ? "kept.bin" : "reserved.bin",
        physicalObjectKey: physical(g, n === 0 ? "kept.bin" : "reserved.bin"),
      })),
    );
    // A replay with fresh deletion ids returns the stored claim, never a second one.
    expect(
      await claimRetiredStorageDeletes(context, {
        ...requested,
        items: items.map((item) => ({ ...item, deletionId: newUlid() })),
      }),
    ).toEqual(claimed);
    expect(await count("project_r2_delete_requests", g)).toBe(2);
    expect(
      (
        await db
          .prepare(
            "SELECT object_key, object_was_observed FROM project_r2_delete_requests WHERE project_id = ?1 ORDER BY object_key",
          )
          .bind(g.scope.projectId)
          .all()
      ).results,
    ).toEqual([
      { object_key: "kept.bin", object_was_observed: 1 },
      { object_key: "reserved.bin", object_was_observed: 0 },
    ]);
    await expect(
      claimRetiredStorageDeletes(context, { ...requested, items: [items[0], items[0]] }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);

    const proofs = await Promise.all(claimed.map((c) => proofOf(g, c, c.objectKey)));
    await completeRetiredStorageDeletes(context, { ...ids, items: proofs });
    expect(await count("project_r2_erasure_barriers", g)).toBe(2);
    expect(await count("project_r2_delete_receipts", g)).toBe(2);
    // Completing again changes nothing; a proof of another data area is refused.
    await completeRetiredStorageDeletes(context, { ...ids, items: proofs });
    expect(await count("project_r2_erasure_barriers", g)).toBe(2);
    await expect(
      completeRetiredStorageDeletes(context, {
        ...ids,
        dataEnvironmentId: newUlid(),
        items: proofs,
      }),
    ).rejects.toBeInstanceOf(StorageGatewayConflictError);

    // Everything is erased: nothing is left to do, and the observed file is counted.
    expect(await readRetiredStorageInventory(context, ids)).toEqual({
      items: [],
      maxExpiresAt: null,
      deletedFiles: 1,
    });
  }, 30_000);
});

describe("storage gateway upload sweep", () => {
  const LATE = "2026-10-29T12:30:00.000Z";
  const OLD = "2026-10-01T00:00:00.000000Z";
  const OLD_EXPIRES = "2026-10-01T00:05:00.000Z";
  const RECENT = "2026-10-28T23:00:00.000000Z";
  const RECENT_EXPIRES = "2026-10-28T23:05:00.000Z";

  it("lists only unconfirmed claims older than a day, and an erased claim stops counting against the quota", async () => {
    const g = await seedGateway();
    const ofProject = async (now: string, limit = 50) =>
      (await readUnconfirmedStorageClaims(context, { now, limit })).filter(
        (claim) => claim.projectId === g.scope.projectId,
      );
    await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "recent.bin", { requestedAt: RECENT, expiresAt: RECENT_EXPIRES }),
    });
    const stale = await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "stale.bin", {
        expectedBytes: 1073741821,
        requestedAt: OLD,
        expiresAt: OLD_EXPIRES,
      }),
    });
    // The recent and the stale claim together fill the quota exactly, so one more byte is refused.
    await expect(
      claimStorageUpload(context, { scope: g.scope, input: uploadOf(g, "over.bin") }),
    ).rejects.toBeInstanceOf(StorageGatewayQuotaError);

    // Only the stale claim is listed: the recent one is not yet a day old and the completed ones are objects.
    expect(await ofProject(LATE)).toEqual([
      {
        organizationId,
        projectId: g.scope.projectId,
        environmentId: g.scope.environmentId,
        dataEnvironmentId: g.scope.dataEnvironmentId,
        transferId: stale.transferId,
        objectKey: "stale.bin",
        physicalObjectKey: physical(g, "stale.bin"),
        jurisdiction: "eu",
        requestedAt: new Date(OLD),
      },
    ]);
    expect(await readUnconfirmedStorageClaims(context, { now: LATE, limit: 1 })).toHaveLength(1);
    await expect(readUnconfirmedStorageClaims(context, { now: LATE, limit: 51 })).rejects.toThrow();

    // The Gateway erases the stale payload and claims its deletion: the erasure proof commits the barrier.
    const claimed = await claimStorageDelete(context, {
      scope: g.scope,
      input: deleteOf(g, "stale.bin", {
        deletionId: newUlid(),
        idempotencyKey: `sweep:${stale.transferId}`,
        requestedAt: LATE,
      }),
    });
    expect(claimed).toMatchObject({ outcome: "claimed", transferId: stale.transferId });
    expect(
      await completeStorageErasure(context, {
        scope: g.scope,
        input: {
          ...(await proofOf(g, claimed, "stale.bin")),
          erasedAt: "2026-10-29T12:30:01.000Z",
        },
      }),
    ).toBe("created");

    // The erased claim is no longer listed and no longer counts: the refused bytes now fit.
    expect(await ofProject(LATE)).toEqual([]);
    await expect(
      claimStorageUpload(context, {
        scope: g.scope,
        input: uploadOf(g, "refill.bin", {
          expectedBytes: 1073741821,
          requestedAt: LATE,
          expiresAt: "2026-10-29T12:35:00.000Z",
        }),
      }),
    ).resolves.toMatchObject({ outcome: "claimed" });
  }, 30_000);

  it("a claim the sweep tried and could not erase goes behind the claims not yet tried", async () => {
    const g = await seedGateway();
    const micro = (ms: number) => new Date(ms).toISOString().replace(".000Z", ".000000Z");
    const claimAt = (name: string, ms: number) =>
      claimStorageUpload(context, {
        scope: g.scope,
        input: uploadOf(g, name, {
          requestedAt: micro(ms),
          expiresAt: new Date(ms + 300000).toISOString(),
        }),
      });
    // Older than every other claim of this file, so the sweep's first pages hold exactly these claims.
    const base = Date.parse("2026-09-15T00:00:00.000Z");
    // Fifty claims that the sweep can never erase, all older than one healthy claim requested after them.
    const failing: string[] = [];
    for (let i = 0; i < 50; i++)
      failing.push((await claimAt(`failing-${i}.bin`, base + i * 1000)).transferId);
    const healthy = (await claimAt("healthy.bin", base + 60000)).transferId;
    const listed = async () =>
      (await readUnconfirmedStorageClaims(context, { now: LATE, limit: 50 })).map(
        (claim) => claim.transferId,
      );

    // The first pass lists the fifty oldest claims, every one of which fails.
    expect(await listed()).toEqual(failing);
    await markUnconfirmedStorageClaimAttempts(context, { now: LATE, transferIds: failing });

    // The next pass lists the healthy claim first, so the fifty failing claims cannot hold the head of the list.
    expect((await listed())[0]).toBe(healthy);
  }, 60_000);

  it("an erasure drops the attempt stamp of its claim, so no stamp outlives the claim", async () => {
    const g = await seedGateway();
    const stale = await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "stale.bin", { requestedAt: OLD, expiresAt: OLD_EXPIRES }),
    });
    await markUnconfirmedStorageClaimAttempts(context, {
      now: LATE,
      transferIds: [stale.transferId],
    });
    const claimed = await claimStorageDelete(context, {
      scope: g.scope,
      input: deleteOf(g, "stale.bin", {
        deletionId: newUlid(),
        idempotencyKey: `sweep:${stale.transferId}`,
        requestedAt: LATE,
      }),
    });
    expect(
      await completeStorageErasure(context, {
        scope: g.scope,
        input: {
          ...(await proofOf(g, claimed, "stale.bin")),
          erasedAt: "2026-10-29T12:30:01.000Z",
        },
      }),
    ).toBe("created");
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM project_r2_upload_sweep_attempts WHERE transfer_id=?1")
        .bind(stale.transferId)
        .first(),
    ).toEqual({ n: 0 });
  }, 30_000);

  it("an erased claim no longer holds back the purge of its data area", async () => {
    const g = await seedGateway();
    const stale = await claimStorageUpload(context, {
      scope: g.scope,
      input: uploadOf(g, "stale.bin", { requestedAt: OLD, expiresAt: OLD_EXPIRES }),
    });
    const claimed = await claimStorageDelete(context, {
      scope: g.scope,
      input: deleteOf(g, "stale.bin", {
        deletionId: newUlid(),
        idempotencyKey: `sweep:${stale.transferId}`,
        requestedAt: LATE,
      }),
    });
    await completeStorageErasure(context, {
      scope: g.scope,
      input: {
        ...(await proofOf(g, claimed, "stale.bin")),
        erasedAt: "2026-10-29T12:30:01.000Z",
      },
    });

    // The accepted reset retires the data area, as the purge reads it.
    const project = {
      organizationId,
      projectId: g.scope.projectId,
      billingEpochId: g.billingEpochId,
      shard: db,
    };
    const { operationId, claimId } = await seedAcceptedOperation(project, g.scope.environmentId, {
      eventType: "ProjectDataChangeRequestedV1",
      intent: async (operation) => ({
        expected_etag: "fixture-etag",
        cleanup_run_id: await seedCleanupRun(project, operation),
        data_change: "reset_dev",
        data_change_snapshot: JSON.stringify({
          transition: { redeployEnvironments: ["dev"] },
          environmentHeads: [{}, {}],
          registrationGenerations: [],
        }),
      }),
    });
    const newData = newUlid();
    await db.batch([
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at)VALUES(?1,?2,?3,?4)",
        )
        .bind(organizationId, g.scope.projectId, newData, TIME),
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,operation_id,assigned_at)VALUES(?1,?2,?3,?4,2,?5,?6)",
        )
        .bind(organizationId, g.scope.projectId, g.scope.environmentId, newData, operationId, TIME),
    ]);

    // The erased claim is still inventoried for the purge, with its proof, but it no longer sets a wait.
    const inventory = await readRetiredStorageInventory(context, {
      ...g.scope,
      operationId,
      claimId,
    });
    expect(inventory.maxExpiresAt).toBeNull();
    expect(
      inventory.items.map((item) => [item.transferId, item.erasureProof !== undefined]),
    ).toEqual([[stale.transferId, true]]);
  }, 30_000);
});
