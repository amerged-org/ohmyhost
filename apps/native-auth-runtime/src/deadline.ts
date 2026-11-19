import type { Pool, PoolClient } from "pg";
import { NATIVE_AUTH_REQUEST_DEADLINE_MS } from "@ohmyhost/contracts/native-auth";

export class NativeAuthDeadlineExceeded extends Error {
  constructor() {
    super("auth_unavailable");
    this.name = "NativeAuthDeadlineExceeded";
  }
}

/** Absolute deadlines are supplied by trusted entrypoints, never HTTP input. */
export function nativeRequestDeadline(suppliedAt?: number) {
  const receiverNow = Date.now();
  const inputAt =
    suppliedAt === undefined ? receiverNow + NATIVE_AUTH_REQUEST_DEADLINE_MS : suppliedAt;
  if (!Number.isSafeInteger(inputAt) || inputAt < 0) throw new Error("auth_unavailable");
  // Caller and receiver clocks need not agree. Never extend the trusted budget or the local cap.
  const at = Math.min(inputAt, receiverNow + NATIVE_AUTH_REQUEST_DEADLINE_MS);
  return {
    at,
    async run<T>(operation: () => Promise<T>, onTimeout?: () => void): Promise<T> {
      const remaining = at - Date.now();
      if (remaining <= 0) {
        onTimeout?.();
        throw new NativeAuthDeadlineExceeded();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              onTimeout?.();
              reject(new NativeAuthDeadlineExceeded());
            }, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
export type NativeRequestDeadline = ReturnType<typeof nativeRequestDeadline>;

/**
 * Request-local view of the shared realm pool. A timed-out SQL lease is destroyed,
 * so PostgreSQL rolls back even when a private authority RPC never settles.
 * These private callers use only pg's promise query/acquisition interfaces.
 */
export function nativeDeadlinePool(pool: Pool, deadline: NativeRequestDeadline): Pool {
  const connect = async (): Promise<PoolClient> => {
    let timedOut = false;
    const acquired = deadline.run(
      () =>
        pool.connect().then((client) => {
          if (timedOut) client.release(true);
          return client;
        }),
      () => {
        timedOut = true;
      },
    );
    const client = await acquired;
    let released = false;
    const release = (error?: Error | boolean) => {
      if (released) return;
      released = true;
      client.release(error);
    };
    const query = (...args: unknown[]) =>
      deadline.run(
        () => Reflect.apply(client.query, client, args) as Promise<unknown>,
        () => release(true),
      );
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property === "query") return query;
        if (property === "release") return release;
        return Reflect.get(target, property, receiver);
      },
    });
  };
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "connect") return connect;
      if (property === "query")
        return async (...args: unknown[]) => {
          const client = await connect();
          try {
            return await Reflect.apply(client.query, client, args);
          } finally {
            client.release();
          }
        };
      return Reflect.get(target, property, receiver);
    },
  });
}
