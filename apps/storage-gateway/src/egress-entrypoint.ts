import { WorkerEntrypoint, type WorkerContext } from "cloudflare:workers";
import type { StorageGatewayBindings } from "./bindings.js";

/**
 * The static `props` marker of the egress policy Worker's service binding to this entrypoint.
 * It is a misconfiguration guard, not a secret: whoever builds a binding chooses its props. The
 * real barrier is that only platform-built bindings can name this entrypoint at all.
 */
export const STORAGE_EGRESS_CALLER = "wfp-egress-policy";

/** What the entrypoint needs from the gateway: serve one forwarded request for a marked caller. */
export interface StorageEgressGateway {
  fetchForwarded(request: Request, rawBindings: unknown, caller: unknown): Promise<Response>;
}

export type StorageEgressConstructor = new (
  context: WorkerContext,
  env: StorageGatewayBindings,
) => WorkerEntrypoint<StorageGatewayBindings> & {
  fetch(request: Request): Promise<Response>;
  permit(projectId: string): Promise<boolean>;
};

/**
 * Builds the entrypoint class for the egress policy Worker. Its binding is the only caller: it
 * carries the marker as static `props` and stamps the project header over anything the customer
 * sent. The class owns no state beyond that marker; the gateway authorizes every request.
 */
export function createStorageEgressEntrypoint(
  gateway: StorageEgressGateway,
): StorageEgressConstructor {
  return createStorageEntrypoint(gateway, false);
}

/** The named target itself grants the fixed Egress role; provider readback attests its name. */
export function createStorageGatewayRelayEntrypoint(
  gateway: StorageEgressGateway,
): StorageEgressConstructor {
  return createStorageEntrypoint(gateway, true);
}

function createStorageEntrypoint(
  gateway: StorageEgressGateway,
  intrinsicEgressRole: boolean,
): StorageEgressConstructor {
  return class StorageEgress extends WorkerEntrypoint<StorageGatewayBindings> {
    readonly #caller: unknown;

    public constructor(context: WorkerContext, env: StorageGatewayBindings) {
      super(context, env);
      this.#caller = intrinsicEgressRole
        ? Object.freeze({ caller: STORAGE_EGRESS_CALLER })
        : context.props;
    }

    /** Shared mail/storage admission runs without gateway, database or HTTP initialization. */
    public async permit(projectId: string): Promise<boolean> {
      const caller = this.#caller;
      if (
        typeof caller !== "object" ||
        caller === null ||
        Array.isArray(caller) ||
        Object.keys(caller).join(",") !== "caller" ||
        (caller as Record<string, unknown>)["caller"] !== STORAGE_EGRESS_CALLER ||
        typeof projectId !== "string" ||
        !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(projectId)
      )
        throw new TypeError("Gateway admission unavailable");
      try {
        const limiter = this.env.GATEWAY_RATE_LIMITER;
        if (typeof limiter?.limit !== "function") throw new TypeError();
        const result = await limiter.limit({ key: projectId });
        if (typeof result?.success !== "boolean") throw new TypeError();
        return result.success;
      } catch {
        // RPC callers receive a fixed failure, never native-provider details.
        throw new Error("Gateway admission unavailable");
      }
    }

    /** Both public methods are callable only through the platform-built service binding. */
    public fetch(request: Request): Promise<Response> {
      return gateway.fetchForwarded(request, this.env, this.#caller);
    }
  };
}
