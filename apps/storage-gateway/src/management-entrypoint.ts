import { createCoreRetiredStoragePersistence, requireStorageDataCore } from "./core-persistence.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCloudflareR2ObjectTransferProvider } from "@ohmyhost/provider-cloudflare";
import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";
import { requireStorageGatewayBindings, type StorageGatewayBindings } from "./bindings.js";
import { createRetiredStoragePurger } from "./management.js";

type StorageDataManagementConstructor = new (
  context: ConstructorParameters<typeof WorkerEntrypoint>[0],
  env: StorageGatewayBindings,
) => WorkerEntrypoint<StorageGatewayBindings> &
  Pick<ReturnType<typeof createRetiredStoragePurger>, "purgeRetiredData">;

export function createStorageDataManagementEntrypoint(dependencies: {
  createProvider: (
    configuration: Parameters<typeof createCloudflareR2ObjectTransferProvider>[0],
  ) => Parameters<typeof createRetiredStoragePurger>[0]["provider"];
  clock: { now(): Date };
  ids: { next(): string };
}): StorageDataManagementConstructor {
  /** The application binding targets the default HTTP entrypoint and cannot call this RPC. */
  return class StorageDataManagement extends WorkerEntrypoint<StorageGatewayBindings> {
    async purgeRetiredData(input: unknown) {
      const bindings = requireStorageGatewayBindings(this.env);
      return createRetiredStoragePurger({
        provider: dependencies.createProvider({
          accountId: bindings.CLOUDFLARE_ACCOUNT_ID,
          apiToken: bindings.CLOUDFLARE_R2_API_TOKEN,
          parentAccessKeyId: bindings.CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID,
          fetch: globalThis.fetch,
        }),
        nextId: dependencies.ids.next.bind(dependencies.ids),
        now: dependencies.clock.now.bind(dependencies.clock),
        persistence: createCoreRetiredStoragePersistence(
          requireStorageDataCore(bindings.STORAGE_DATA_RUNTIME),
        ),
      }).purgeRetiredData(input);
    }
  };
}
const clock = new SystemClock();
export const StorageDataManagementEntrypoint = createStorageDataManagementEntrypoint({
  createProvider: createCloudflareR2ObjectTransferProvider,
  clock,
  ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
});
