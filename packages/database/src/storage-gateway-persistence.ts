import type { TransactionClient } from "./transaction.js";
import { type StorageErasureProof } from "./storage-erasure.js";
export {
  storageErasureMarkerDigest,
  StorageErasureConflictError,
  type StorageErasureProof,
} from "./storage-erasure.js";
export declare const completeStorageErasures: typeof import("./storage-erasure.js").completeStorageErasures;
export const STORAGE_UPLOAD_DRAIN_MILLISECONDS = 30_000;

export class StorageGatewayConflictError extends Error {
  public constructor(
    public readonly code:
      | "storage_gateway_conflict"
      | "storage_object_conflict" = "storage_gateway_conflict",
  ) {
    super(
      code === "storage_object_conflict"
        ? "Storage logical key has multiple historical physical files"
        : "Storage gateway request conflicts with durable state",
    );
    this.name = "StorageGatewayConflictError";
  }
}

export class StorageGatewayQuotaError extends Error {
  public readonly code = "storage_gateway_quota_exceeded";
  public constructor() {
    super("Storage gateway quota is exceeded");
    this.name = "StorageGatewayQuotaError";
  }
}
export class StorageGatewayBindingChangedError extends Error {
  readonly code = "storage_binding_data_changed";
  constructor() {
    super("Storage deployment must be redeployed for its current data assignment");
    this.name = "StorageGatewayBindingChangedError";
  }
}
export class StorageGatewayDataChangeInProgressError extends Error {
  readonly code = "data_change_in_progress";
  constructor() {
    super("This environment's data change must finish before retrying storage");
    this.name = "StorageGatewayDataChangeInProgressError";
  }
}

export interface StorageUploadClaimInput {
  readonly transferId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: Uint8Array;
  readonly objectKey: string;
  readonly contentType: string;
  readonly expectedBytes: number;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface StorageObjectReceipt {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly transferId: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly uploadedAt: Date;
}

export interface StorageObjectAccess extends StorageObjectReceipt {
  readonly jurisdiction: "eu" | "us";
  readonly dataEnvironmentId: string;
  readonly physicalObjectKey: string;
}

export interface StorageDeleteClaimInput {
  readonly deletionId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: Uint8Array;
  readonly objectKey: string;
  readonly requestedAt: string;
}

export declare function claimStorageUpload(
  client: TransactionClient,
  input: StorageUploadClaimInput,
): Promise<
  | Readonly<{
      outcome: "existing" | "completed";
      transferId: import("@ohmyhost/platform").Ulid;
      expiresAt: Date;
      physicalObjectKey: string;
      dataEnvironmentId: string;
    }>
  | Readonly<{
      outcome: "claimed";
      transferId: string;
      expiresAt: Date;
      physicalObjectKey: string;
      dataEnvironmentId: string;
    }>
>;

export declare function completeStorageUpload(
  client: TransactionClient,
  receipt: StorageObjectReceipt,
): Promise<"created" | "existing">;

export declare function claimStorageDeletes(
  client: TransactionClient,
  inputs: readonly StorageDeleteClaimInput[],
): Promise<
  readonly (
    | {
        state: "not_found";
        objectKey: string;
        deletionId?: never;
        environmentId?: never;
        dataEnvironmentId?: never;
        physicalObjectKey?: never;
        jurisdiction?: never;
        expiresAt?: never;
        completedAt?: never;
        transferId?: never;
        payloadErased?: never;
      }
    | {
        state: "claimed" | "completed";
        objectKey: string;
        deletionId: string;
        environmentId: string;
        dataEnvironmentId: string;
        physicalObjectKey: string;
        jurisdiction: "us" | "eu";
        expiresAt: Date;
        completedAt: Date | null;
        transferId: string;
        payloadErased: boolean;
      }
  )[]
>;

export interface RetiredStorageScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  dataEnvironmentId: string;
  operationId: string;
  claimId: string;
}
export declare function readRetiredStorageInventory(
  client: TransactionClient,
  input: RetiredStorageScope & {
    limit?: number;
  },
): Promise<{
  items: {
    erasureProof?: {
      markerSha256: string;
      erasedAt: string;
    };
    transferId: string;
    environmentId: string;
    dataEnvironmentId: string;
    objectKey: string;
    physicalObjectKey: string;
    contentType: string;
    expectedBytes: number;
    requestedAt: Date;
    expiresAt: Date;
    completed: boolean;
    jurisdiction: "us" | "eu";
  }[];
  maxExpiresAt: Date | null;
  deletedFiles: number;
}>;

export declare function claimRetiredStorageDeletes(
  client: TransactionClient,
  input: RetiredStorageScope & {
    items: readonly {
      transferId: string;
      deletionId: string;
      objectObserved: boolean;
    }[];
    requestedAt: string;
  },
): Promise<
  {
    deletionId: string;
    environmentId: string;
    dataEnvironmentId: string;
    transferId: string;
    objectKey: string;
    physicalObjectKey: string;
  }[]
>;

export declare function completeRetiredStorageDeletes(
  client: TransactionClient,
  input: RetiredStorageScope & {
    items: readonly StorageErasureProof[];
  },
): Promise<void>;
