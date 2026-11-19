import type {
  readRetiredStorageInventory,
  claimRetiredStorageDeletes,
  completeRetiredStorageDeletes,
} from "@ohmyhost/database";
export interface RetiredStoragePersistence {
  read(
    input: Parameters<typeof readRetiredStorageInventory>[1],
  ): ReturnType<typeof readRetiredStorageInventory>;
  claim(
    scope: Omit<Parameters<typeof claimRetiredStorageDeletes>[1], "items" | "requestedAt">,
    items: () => Parameters<typeof claimRetiredStorageDeletes>[1]["items"],
    requestedAt: () => string,
  ): ReturnType<typeof claimRetiredStorageDeletes>;
  complete(
    input: Parameters<typeof completeRetiredStorageDeletes>[1],
  ): ReturnType<typeof completeRetiredStorageDeletes>;
}
export interface StorageDataRuntimeBinding {
  readRetiredStorageInventory(input: unknown): Promise<unknown>;
  claimRetiredStorageDeletes(input: unknown): Promise<unknown>;
  completeRetiredStorageDeletes(input: unknown): Promise<unknown>;
}
