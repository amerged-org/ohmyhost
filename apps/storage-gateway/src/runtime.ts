import { parseUlid, type Ulid } from "@ohmyhost/platform";
import {
  projectR2BucketTarget,
  type R2ObjectObservation,
  CloudflareR2TransferContractError,
  CloudflareR2TransferInputError,
  CloudflareR2TransferUncertainError,
  type R2PayloadErasureResult,
} from "@ohmyhost/provider-cloudflare";
import type {
  StorageDeleteClaimInput,
  StorageObjectReceipt,
  StorageObjectAccess,
  StorageUploadClaimInput,
  claimStorageDeletes,
  completeStorageErasures,
  StorageErasureProof,
} from "@ohmyhost/database";
import { STORAGE_UPLOAD_DRAIN_MILLISECONDS } from "@ohmyhost/database";
import { streamStorageBatch } from "./batch.js";
import { withStorageErasureBudget, STORAGE_ERASURE_ACK_BATCH_SIZE } from "./erasure-budget.js";

interface AuthorizedProject {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly bucketName: string;
  readonly jurisdiction: "eu" | "us";
  readonly quotaBytes: number;
  readonly dataEnvironmentId: string;
}

interface TransferProvider {
  createTransfer(input: unknown): Promise<{
    operation: "DELETE" | "GET" | "PUT";
    objectKey: string;
    url: string;
    expiresAt: Date;
    expectedContentLength: number | null;
    requiredHeaders: Readonly<Record<string, string>>;
  }>;
  observeObject(input: unknown): Promise<R2ObjectObservation>;
  readObject: Parameters<typeof streamStorageBatch>[0]["readObject"];
  erasePayloads(
    input: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly R2PayloadErasureResult[]>;
}

interface Dependencies {
  authenticate(
    projectId: Ulid,
    environmentId: Ulid,
    digest: Uint8Array,
  ): Promise<AuthorizedProject | null>;
  claim(input: StorageUploadClaimInput): Promise<{
    outcome: "claimed" | "existing" | "completed";
    transferId: string;
    expiresAt: Date;
    physicalObjectKey: string;
    dataEnvironmentId: string;
  }>;
  readReservation(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    transferId: string;
  }): Promise<{
    transferId: string;
    objectKey: string;
    contentType: string;
    expectedBytes: number;
    requestedAt: Date;
    expiresAt: Date;
    completed: boolean;
    environmentId: string;
    physicalObjectKey: string;
    jurisdiction: "eu" | "us";
  } | null>;
  complete(input: StorageObjectReceipt): Promise<"created" | "existing">;
  readObject(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    objectKey: string;
  }): Promise<StorageObjectAccess | null>;
  claimDelete(input: StorageDeleteClaimInput): Promise<{
    outcome: "claimed" | "existing" | "completed";
    deletionId: string;
    environmentId: string;
    jurisdiction: "eu" | "us";
    physicalObjectKey: string;
    dataEnvironmentId: string;
    expiresAt: Date;
    completedAt: Date | null;
    transferId: string;
    payloadErased: boolean;
  }>;
  completeDelete(input: StorageErasureProof): Promise<"created" | "existing">;
  readObjects(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    objectKeys: readonly string[];
  }): Promise<readonly (StorageObjectAccess | null)[]>;
  claimDeletes: (
    inputs: readonly StorageDeleteClaimInput[],
  ) => ReturnType<typeof claimStorageDeletes>;
  completeDeletes: (
    inputs: Parameters<typeof completeStorageErasures>[1],
  ) => ReturnType<typeof completeStorageErasures>;
  provider: TransferProvider;
  sha256(value: string): Promise<Uint8Array>;
  ids: { next(): string };
  now(): Date;
}

export class StorageGatewayInputError extends Error {
  public readonly code = "storage_gateway_input_invalid";
  public constructor() {
    super("Storage gateway input is invalid");
    this.name = "StorageGatewayInputError";
  }
}
export const STORAGE_PUT_DRAIN_MILLISECONDS = STORAGE_UPLOAD_DRAIN_MILLISECONDS;
export class StorageGatewayDeletePendingError extends Error {
  readonly code = "storage_delete_pending";
  constructor(readonly retryAt: string) {
    super(
      "Wait until the existing signed upload has expired and drained, then retry the same deletion",
    );
    this.name = "StorageGatewayDeletePendingError";
  }
}

export function createStorageGateway(
  dependencies: Dependencies,
  options: { readonly signal?: AbortSignal } = {},
) {
  validateDependencies(dependencies);
  return Object.freeze({
    upload: (value: unknown) => upload(value, dependencies),
    complete: (value: unknown) => complete(value, dependencies),
    download: (value: unknown) => download(value, dependencies),
    delete: (value: unknown) =>
      withStorageErasureBudget(options.signal, (signal) => remove(value, dependencies, signal)),
    readMany: (value: unknown) => readMany(value, dependencies),
    deleteMany: (value: unknown) =>
      withStorageErasureBudget(options.signal, (signal) => deleteMany(value, dependencies, signal)),
  });
}

async function upload(value: unknown, dependencies: Dependencies) {
  const input = parseUpload(value);
  const project = await authenticate(input, dependencies);
  if (project === null) return Object.freeze({ status: "unauthorized" as const });
  const requestedAt = canonicalNow(dependencies.now);
  const expiresAt = new Date(requestedAt.getTime() + 300_000);
  const requestSha256 = await dependencies.sha256(
    JSON.stringify({
      projectId: input.projectId,
      environmentId: input.environmentId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      contentLength: input.contentLength,
    }),
  );
  const claim = await dependencies.claim({
    transferId: parseUlid(dependencies.ids.next()),
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.environmentId,
    idempotencyKey: input.idempotencyKey,
    requestSha256,
    objectKey: input.objectKey,
    contentType: input.contentType,
    expectedBytes: input.contentLength,
    requestedAt: requestedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  if (claim.outcome === "completed") {
    return Object.freeze({ status: "completed" as const, transferId: claim.transferId });
  }
  const target = projectR2BucketTarget(
    project.projectId,
    project.environmentId,
    project.jurisdiction,
  );
  if (target.bucketName !== project.bucketName) throw new StorageGatewayInputError();
  // A key is reserved exactly once, so bytes found under a replayed reservation are its own upload
  // whose completion failed; R2 would refuse a second create-only PUT for them with 412.
  if (
    claim.outcome === "existing" &&
    (await recordStoredObject(
      project,
      target,
      claim.transferId,
      input.objectKey,
      claim.physicalObjectKey,
      project.environmentId,
      dependencies,
    ))
  )
    return Object.freeze({ status: "completed" as const, transferId: claim.transferId });
  const remainingSeconds = Math.floor(
    (claim.expiresAt.getTime() - canonicalNow(dependencies.now).getTime()) / 1_000,
  );
  if (remainingSeconds < 60)
    return Object.freeze({ status: "expired" as const, transferId: claim.transferId });
  const capability = await dependencies.provider.createTransfer({
    target,
    objectKey: claim.physicalObjectKey,
    operation: "PUT",
    expiresInSeconds: Math.min(300, remainingSeconds),
    contentLength: input.contentLength,
    contentType: input.contentType,
  });
  return Object.freeze({
    status: "ready" as const,
    transferId: claim.transferId,
    capability: Object.freeze({ ...capability, objectKey: input.objectKey }),
  });
}

async function complete(value: unknown, dependencies: Dependencies) {
  const input = parseCompletion(value);
  const project = await authenticate(input, dependencies);
  if (project === null) return Object.freeze({ status: "unauthorized" as const });
  const reservation = await dependencies.readReservation({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.environmentId,
    transferId: input.transferId,
  });
  if (reservation === null) return Object.freeze({ status: "not_found" as const });
  if (reservation.completed)
    return Object.freeze({ status: "completed" as const, transferId: input.transferId });
  // A confirmation after the signed upload's expiry records nothing: its bytes are swept with the unconfirmed claim.
  if (canonicalNow(dependencies.now).getTime() > reservation.expiresAt.getTime())
    return Object.freeze({ status: "expired" as const, transferId: input.transferId });
  const target = projectR2BucketTarget(
    project.projectId,
    reservation.environmentId,
    reservation.jurisdiction,
  );
  if (
    !(await recordStoredObject(
      project,
      target,
      input.transferId,
      reservation.objectKey,
      reservation.physicalObjectKey,
      reservation.environmentId,
      dependencies,
    ))
  )
    return Object.freeze({ status: "pending" as const, transferId: input.transferId });
  return Object.freeze({ status: "completed" as const, transferId: input.transferId });
}

/** Records the reservation's object when R2 holds it; false while the bytes are still absent. */
async function recordStoredObject(
  project: AuthorizedProject,
  target: ReturnType<typeof projectR2BucketTarget>,
  transferId: string,
  objectKey: string,
  physicalObjectKey: string,
  environmentId: string,
  dependencies: Dependencies,
): Promise<boolean> {
  const observation = await dependencies.provider.observeObject({
    target,
    objectKey: physicalObjectKey,
  });
  if (observation.state === "absent") return false;
  if (observation.objectKey !== physicalObjectKey) throw new StorageGatewayInputError();
  await dependencies.complete({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId,
    transferId,
    objectKey,
    contentType: observation.contentType,
    size: observation.contentLength,
    etag: observation.etag,
    uploadedAt: observation.uploadedAt,
  });
  return true;
}

async function download(value: unknown, dependencies: Dependencies) {
  const input = parseDownload(value);
  const project = await authenticate(input, dependencies);
  if (project === null) return Object.freeze({ status: "unauthorized" as const });
  const object = await dependencies.readObject({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.environmentId,
    objectKey: input.objectKey,
  });
  if (object === null) return Object.freeze({ status: "not_found" as const });
  const target = projectR2BucketTarget(
    project.projectId,
    object.environmentId,
    object.jurisdiction,
  );
  const capability = await dependencies.provider.createTransfer({
    target,
    objectKey: object.physicalObjectKey,
    operation: "GET",
    expiresInSeconds: 300,
  });
  return Object.freeze({
    status: "ready" as const,
    capability: Object.freeze({ ...capability, objectKey: input.objectKey }),
  });
}

async function remove(value: unknown, dependencies: Dependencies, signal: AbortSignal) {
  const input = parseDelete(value);
  const project = await authenticate(input, dependencies);
  if (project === null) return Object.freeze({ status: "unauthorized" as const });
  const requestedAt = canonicalNow(dependencies.now);
  const claim = await dependencies.claimDelete({
    deletionId: parseUlid(dependencies.ids.next()),
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.environmentId,
    idempotencyKey: input.idempotencyKey,
    requestSha256: await dependencies.sha256(
      JSON.stringify({
        projectId: input.projectId,
        environmentId: input.environmentId,
        objectKey: input.objectKey,
      }),
    ),
    objectKey: input.objectKey,
    requestedAt: requestedAt.toISOString(),
  });
  if (claim.outcome === "completed" && claim.payloadErased)
    return Object.freeze({ status: "completed" as const, deletionId: claim.deletionId });
  const safeAt = new Date(claim.expiresAt.getTime() + STORAGE_PUT_DRAIN_MILLISECONDS);
  if (!claim.payloadErased && safeAt > canonicalNow(dependencies.now))
    throw new StorageGatewayDeletePendingError(safeAt.toISOString());
  const result = (
    await dependencies.provider.erasePayloads(
      {
        target: projectR2BucketTarget(project.projectId, claim.environmentId, claim.jurisdiction),
        objects: [
          {
            organizationId: project.organizationId,
            projectId: project.projectId,
            environmentId: claim.environmentId,
            dataEnvironmentId: claim.dataEnvironmentId,
            transferId: claim.transferId,
            objectKey: claim.physicalObjectKey,
          },
        ],
      },
      { signal },
    )
  )[0];
  if (
    result === undefined ||
    result.objectKey !== claim.physicalObjectKey ||
    result.transferId !== claim.transferId
  )
    throw new StorageGatewayInputError();
  if (result.status === "pending")
    throw new StorageGatewayDeletePendingError(
      new Date(canonicalNow(dependencies.now).getTime() + 1000).toISOString(),
    );
  if (result.status === "failed") {
    if (!result.retryable) throw new CloudflareR2TransferContractError();
    throw new CloudflareR2TransferUncertainError();
  }
  await dependencies.completeDelete({
    deletionId: claim.deletionId,
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: claim.environmentId,
    dataEnvironmentId: claim.dataEnvironmentId,
    transferId: claim.transferId,
    objectKey: input.objectKey,
    physicalObjectKey: claim.physicalObjectKey,
    markerSha256: result.markerSha256,
    erasedAt: result.erasedAt.toISOString(),
  });
  return Object.freeze({ status: "completed" as const, deletionId: claim.deletionId });
}

async function authenticate(
  input: { projectId: Ulid; environmentId: Ulid; key: string },
  dependencies: Dependencies,
) {
  return dependencies.authenticate(
    input.projectId,
    input.environmentId,
    await dependencies.sha256(input.key),
  );
}

async function readMany(value: unknown, dependencies: Dependencies) {
  const record = exact(value, ["environmentId", "key", "objectKeys", "projectId"]);
  const input = batchAuthentication(record);
  const objectKeys = batchKeys(record["objectKeys"]);
  const project = await authenticate(input, dependencies);
  if (project === null) return { status: "unauthorized" as const };
  const objects = await dependencies.readObjects({ ...project, objectKeys });
  if (objects.length !== objectKeys.length) throw new StorageGatewayInputError();
  return {
    status: "stream" as const,
    body: streamStorageBatch({
      projectId: project.projectId,
      objectKeys,
      objects,
      readObject: dependencies.provider.readObject,
    }),
  };
}

async function deleteMany(value: unknown, dependencies: Dependencies, signal: AbortSignal) {
  const record = exact(value, ["environmentId", "key", "objects", "projectId"]);
  const input = batchAuthentication(record);
  if (!Array.isArray(record["objects"])) throw new StorageGatewayInputError();
  const items = record["objects"].map((value) => {
    const item = exact(value, ["objectKey", "idempotencyKey"]);
    if (
      typeof item["idempotencyKey"] !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(item["idempotencyKey"])
    )
      throw new StorageGatewayInputError();
    return { objectKey: item["objectKey"] as string, idempotencyKey: item["idempotencyKey"] };
  });
  batchKeys(items.map((item) => item.objectKey));
  if (new Set(items.map((item) => item.idempotencyKey)).size !== items.length)
    throw new StorageGatewayInputError();
  const project = await authenticate(input, dependencies);
  if (project === null) return { status: "unauthorized" as const };
  const requestedAt = canonicalNow(dependencies.now).toISOString();
  const claims = await dependencies.claimDeletes(
    await Promise.all(
      items.map(async (item) => ({
        ...project,
        ...item,
        deletionId: dependencies.ids.next(),
        requestedAt,
        requestSha256: await dependencies.sha256(
          JSON.stringify({
            projectId: input.projectId,
            environmentId: input.environmentId,
            objectKey: item.objectKey,
          }),
        ),
      })),
    ),
  );
  const results: (
    | { object_key: string; state: "completed"; deletion_id: string }
    | { object_key: string; state: "pending"; retry_at: string }
    | { object_key: string; state: "failed"; code: string; retryable: boolean }
  )[] = items.map((item) => ({
    object_key: item.objectKey,
    state: "pending",
    retry_at: new Date(canonicalNow(dependencies.now).getTime() + 1000).toISOString(),
  }));
  const eligible: Extract<(typeof claims)[number], { state: "completed" | "claimed" }>[] = [];
  for (const [index, claim] of claims.entries()) {
    if (claim.state === "not_found")
      results[index] = {
        object_key: claim.objectKey,
        state: "failed",
        code: "object_not_found",
        retryable: false,
      };
    else if (
      !claim.payloadErased &&
      new Date(claim.expiresAt.getTime() + STORAGE_PUT_DRAIN_MILLISECONDS) >
        canonicalNow(dependencies.now)
    )
      results[index] = {
        object_key: claim.objectKey,
        state: "pending",
        retry_at: new Date(
          claim.expiresAt.getTime() + STORAGE_PUT_DRAIN_MILLISECONDS,
        ).toISOString(),
      };
    else if (claim.state === "completed" && claim.payloadErased)
      results[index] = {
        object_key: claim.objectKey,
        state: "completed",
        deletion_id: claim.deletionId,
      };
    else eligible.push(claim);
  }
  const grouped = new Map<string, typeof eligible>();
  for (const claim of eligible) {
    const key = `${claim.environmentId}/${claim.jurisdiction}`;
    const group = grouped.get(key) ?? [];
    group.push(claim);
    grouped.set(key, group);
  }
  for (const group of grouped.values())
    for (let offset = 0; offset < group.length; offset += STORAGE_ERASURE_ACK_BATCH_SIZE) {
      if (signal.aborted) break;
      const batch = group.slice(offset, offset + STORAGE_ERASURE_ACK_BATCH_SIZE);
      const first = batch[0];
      if (first === undefined) throw new StorageGatewayInputError();
      const stillAuthorized = await authenticate(input, dependencies);
      if (
        stillAuthorized === null ||
        stillAuthorized.dataEnvironmentId !== project.dataEnvironmentId
      )
        throw new StorageGatewayInputError();
      let erased: readonly R2PayloadErasureResult[];
      try {
        erased = await dependencies.provider.erasePayloads(
          {
            target: projectR2BucketTarget(
              project.projectId,
              first.environmentId,
              first.jurisdiction,
            ),
            objects: batch.map((item) => ({
              organizationId: project.organizationId,
              projectId: project.projectId,
              environmentId: item.environmentId,
              dataEnvironmentId: item.dataEnvironmentId,
              transferId: item.transferId,
              objectKey: item.physicalObjectKey,
            })),
          },
          { signal },
        );
      } catch (error) {
        const retryable = !(
          error instanceof CloudflareR2TransferContractError ||
          error instanceof CloudflareR2TransferInputError
        );
        for (const claim of batch) {
          const index = items.findIndex((item) => item.objectKey === claim.objectKey);
          results[index] = {
            object_key: claim.objectKey,
            state: "failed",
            code: "storage_gateway_unavailable",
            retryable,
          };
        }
        continue;
      }
      const byPhysical = new Map(erased.map((item) => [item.objectKey, item]));
      if (
        byPhysical.size !== batch.length ||
        erased.length !== batch.length ||
        erased.some(
          (item) =>
            !batch.some(
              (claim) =>
                claim.physicalObjectKey === item.objectKey && claim.transferId === item.transferId,
            ),
        )
      )
        throw new StorageGatewayInputError();
      const proofs: StorageErasureProof[] = [];
      for (const claim of batch) {
        const result = byPhysical.get(claim.physicalObjectKey);
        if (result?.status === "erased")
          proofs.push({
            organizationId: project.organizationId,
            projectId: project.projectId,
            environmentId: claim.environmentId,
            dataEnvironmentId: claim.dataEnvironmentId,
            transferId: claim.transferId,
            objectKey: claim.objectKey,
            physicalObjectKey: claim.physicalObjectKey,
            deletionId: claim.deletionId,
            markerSha256: result.markerSha256,
            erasedAt: result.erasedAt.toISOString(),
          });
      }
      if (proofs.length) await dependencies.completeDeletes(proofs);
      for (const claim of batch) {
        const index = items.findIndex((item) => item.objectKey === claim.objectKey);
        const result = byPhysical.get(claim.physicalObjectKey);
        if (result === undefined) throw new StorageGatewayInputError();
        results[index] =
          result.status === "erased"
            ? { object_key: claim.objectKey, state: "completed", deletion_id: claim.deletionId }
            : result.status === "pending"
              ? {
                  object_key: claim.objectKey,
                  state: "pending",
                  retry_at: new Date(canonicalNow(dependencies.now).getTime() + 1000).toISOString(),
                }
              : {
                  object_key: claim.objectKey,
                  state: "failed",
                  code: "storage_gateway_unavailable",
                  retryable: result.retryable,
                };
      }
    }
  return {
    status: "batch" as const,
    state: results.every((result) => result.state === "completed")
      ? ("completed" as const)
      : ("partial" as const),
    results,
  };
}

function batchAuthentication(record: Record<string, unknown>) {
  if (typeof record["key"] !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(record["key"]))
    throw new StorageGatewayInputError();
  return {
    projectId: parseUlid(String(record["projectId"])),
    environmentId: parseUlid(String(record["environmentId"])),
    key: record["key"],
  };
}
function batchKeys(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4000 ||
    new Set(value).size !== value.length ||
    value.some((key) => typeof key !== "string" || !validObjectKey(key))
  )
    throw new StorageGatewayInputError();
  return value as string[];
}

function parseUpload(value: unknown) {
  const record = exact(value, [
    "contentLength",
    "contentType",
    "environmentId",
    "idempotencyKey",
    "key",
    "objectKey",
    "projectId",
  ]);
  if (
    typeof record["key"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record["key"]) ||
    typeof record["objectKey"] !== "string" ||
    typeof record["contentType"] !== "string" ||
    typeof record["idempotencyKey"] !== "string" ||
    !Number.isSafeInteger(record["contentLength"]) ||
    Number(record["contentLength"]) < 0 ||
    Number(record["contentLength"]) > 1_073_741_824 ||
    !validObjectKey(record["objectKey"]) ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(
      record["contentType"],
    ) ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(record["idempotencyKey"])
  )
    throw new StorageGatewayInputError();
  return Object.freeze({
    projectId: parseUlid(String(record["projectId"])),
    environmentId: parseUlid(String(record["environmentId"])),
    key: record["key"],
    objectKey: record["objectKey"],
    contentType: record["contentType"],
    contentLength: Number(record["contentLength"]),
    idempotencyKey: record["idempotencyKey"],
  });
}

function parseCompletion(value: unknown) {
  const record = exact(value, ["environmentId", "key", "projectId", "transferId"]);
  if (typeof record["key"] !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(record["key"]))
    throw new StorageGatewayInputError();
  return Object.freeze({
    projectId: parseUlid(String(record["projectId"])),
    environmentId: parseUlid(String(record["environmentId"])),
    transferId: parseUlid(String(record["transferId"])),
    key: record["key"],
  });
}

function parseDownload(value: unknown) {
  const record = exact(value, ["environmentId", "key", "objectKey", "projectId"]);
  if (
    typeof record["key"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record["key"]) ||
    typeof record["objectKey"] !== "string" ||
    !validObjectKey(record["objectKey"])
  ) {
    throw new StorageGatewayInputError();
  }
  return Object.freeze({
    projectId: parseUlid(String(record["projectId"])),
    environmentId: parseUlid(String(record["environmentId"])),
    objectKey: record["objectKey"],
    key: record["key"],
  });
}

function parseDelete(value: unknown) {
  const record = exact(value, ["environmentId", "idempotencyKey", "key", "objectKey", "projectId"]);
  if (
    typeof record["key"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record["key"]) ||
    typeof record["objectKey"] !== "string" ||
    !validObjectKey(record["objectKey"]) ||
    typeof record["idempotencyKey"] !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(record["idempotencyKey"])
  ) {
    throw new StorageGatewayInputError();
  }
  return Object.freeze({
    projectId: parseUlid(String(record["projectId"])),
    environmentId: parseUlid(String(record["environmentId"])),
    objectKey: record["objectKey"],
    idempotencyKey: record["idempotencyKey"],
    key: record["key"],
  });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new StorageGatewayInputError();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new StorageGatewayInputError();
  }
  return record;
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new StorageGatewayInputError();
  return new Date(value.getTime());
}

function validObjectKey(value: string): boolean {
  const bytes = new TextEncoder().encode(value).byteLength;
  return (
    bytes >= 1 &&
    bytes <= 512 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    value
      .split("/")
      .every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(segment))
  );
}

function validateDependencies(value: Dependencies): void {
  if (
    typeof value?.authenticate !== "function" ||
    typeof value.claim !== "function" ||
    typeof value.readReservation !== "function" ||
    typeof value.complete !== "function" ||
    typeof value.readObject !== "function" ||
    typeof value.claimDelete !== "function" ||
    typeof value.completeDelete !== "function" ||
    typeof value.readObjects !== "function" ||
    typeof value.claimDeletes !== "function" ||
    typeof value.completeDeletes !== "function" ||
    typeof value.provider?.createTransfer !== "function" ||
    typeof value.provider.observeObject !== "function" ||
    typeof value.provider.readObject !== "function" ||
    typeof value.provider.erasePayloads !== "function" ||
    typeof value.sha256 !== "function" ||
    typeof value.ids?.next !== "function" ||
    typeof value.now !== "function"
  )
    throw new TypeError("Storage gateway dependencies are invalid");
}
