import type { StorageGatewayScope } from "./bindings.js";
import type { createStorageGateway } from "./runtime.js";
export type StorageRequestScope =
  | StorageGatewayScope
  | {
      readonly kind: "egress";
      readonly projectId: string;
      readonly deploymentScope?: StorageGatewayScope;
    };
export type StorageGatewayPersistence = Pick<
  Parameters<typeof createStorageGateway>[0],
  | "authenticate"
  | "claim"
  | "readReservation"
  | "complete"
  | "readObject"
  | "claimDelete"
  | "completeDelete"
  | "readObjects"
  | "claimDeletes"
  | "completeDeletes"
>;
export interface StorageGatewayRuntimeBinding {
  authenticateStorageGateway(input: unknown): Promise<unknown>;
  claimStorageUpload(input: unknown): Promise<unknown>;
  readStorageUploadReservation(input: unknown): Promise<unknown>;
  completeStorageUpload(input: unknown): Promise<unknown>;
  readStorageObject(input: unknown): Promise<unknown>;
  claimStorageDelete(input: unknown): Promise<unknown>;
  completeStorageErasure(input: unknown): Promise<unknown>;
  readStorageObjects(input: unknown): Promise<unknown>;
  readUnconfirmedStorageClaims(input: unknown): Promise<unknown>;
  markUnconfirmedStorageClaimAttempts(input: unknown): Promise<unknown>;
  claimStorageDeletes(input: unknown): Promise<unknown>;
  completeStorageErasures(input: unknown): Promise<unknown>;
}
