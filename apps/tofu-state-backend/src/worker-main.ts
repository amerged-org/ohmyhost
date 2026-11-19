import { DurableObject } from "cloudflare:workers";

import {
  createTofuStateService,
  parseStateName,
  type StateMetadataStore,
  type StateRecord,
  type StateSnapshotStore,
} from "./state.js";
import { createTofuHttpWorker, type TofuHttpBindings } from "./http.js";

interface R2StateObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2StateBucket {
  put(
    key: string,
    body: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch: string } },
  ): Promise<unknown | null>;
  get(key: string): Promise<R2StateObject | null>;
}
export interface TofuStateBindings extends TofuHttpBindings {
  readonly SNAPSHOTS: R2StateBucket;
}

export default {
  fetch(request: Request, env: TofuStateBindings) {
    return createTofuHttpWorker(env).fetch(request);
  },
};

const empty = (): StateRecord => ({
  revision: 0,
  snapshotKey: null,
  sha256: null,
  bytes: 0,
  deleted: true,
  lock: null,
});

/** One SQLite-backed object per state key; all state bytes live as immutable R2 snapshots. */
export class TofuStateObject extends DurableObject<TofuStateBindings> {
  public async fetch(request: Request): Promise<Response> {
    const value = request.headers.get("x-ohmyhost-state-name");
    if (value === null) return new Response(null, { status: 404 });
    let name: string;
    try {
      name = parseStateName(value);
      if (decodeURIComponent(new URL(request.url).pathname.slice(7)) !== name) throw new Error();
    } catch {
      return new Response(null, { status: 404 });
    }
    const metadata: StateMetadataStore = {
      read: async () => (await this.ctx.storage.get<StateRecord>("record")) ?? null,
      update: <T>(change: (record: StateRecord) => { record: StateRecord; result: T }) =>
        this.ctx.storage.transaction(async (transaction) => {
          const current = (await transaction.get<StateRecord>("record")) ?? empty();
          const next = change(current);
          await transaction.put("record", next.record);
          return next.result;
        }),
    };
    const snapshots: StateSnapshotStore = {
      putIfAbsent: async (key, bytes) =>
        (await this.env.SNAPSHOTS.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } })) !== null,
      read: async (key) => {
        const object = await this.env.SNAPSHOTS.get(key);
        return object === null ? null : new Uint8Array(await object.arrayBuffer());
      },
    };
    return createTofuStateService({ name, metadata, snapshots, crypto }).fetch(request);
  }
}
