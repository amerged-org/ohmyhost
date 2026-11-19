import { Pool, type ClientConfig, type PoolClient, type PoolConfig } from "pg";
import { createPgcfPostgresPoolConfig, type PgcfPostgresTarget } from "@ohmyhost/database";
import {
  ProjectDatabaseBusyError,
  type ProjectDatabaseClient,
  type ProjectDatabaseServiceDependencies,
} from "./service.js";
import { databaseTlsConfiguration } from "./registry.js";

/** A PGCF database that is going to sleep or waking refuses a connection before any SQL runs. */
export const WAKE_REFUSAL_BUDGET_MS = 90_000;
export const WAKE_REFUSAL_STATES = new Set(["08006", "53300", "57P03"]);
export const WAKE_RETRY_CAP_MS = 8_000;

/** Retry delays of 1, 2, 4 and then 8 seconds for every later refusal. */
export function wakeRetryDelayMs(retry: number): number {
  return Math.min(1_000 * 2 ** retry, WAKE_RETRY_CAP_MS);
}

function isWakeRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" && WAKE_REFUSAL_STATES.has(code)) ||
    (typeof message === "string" && message.includes("WebSocket send() after close"))
  );
}

/** One instance per physical environment and lane; pg's queue is explicitly bounded. */
export class DatabaseLanePool extends Pool {
  private readonly clients = new Set<PoolClient>();
  private unavailable = false;
  private readonly waiting = new Set<(error: Error) => void>();
  private readonly pgcf: boolean;

  public constructor(connectionString: string, maximum: number, target?: PgcfPostgresTarget) {
    const config: PoolConfig = {
      ...(target === undefined
        ? databaseTlsConfiguration(connectionString)
        : createPgcfPostgresPoolConfig(connectionString, target)),
      max: maximum,
      idleTimeoutMillis: 10_000,
      // Acquisition precedes all application SQL and held-session clocks. PGCF can wake from
      // suspension within its qualified 70 s bound; legacy Neon retains its measured 10 s bound.
      connectionTimeoutMillis: target === undefined ? 10_000 : 70_000,
      // The same server-side bound as the runtime's non-pooled clients; before this the pooled
      // sessions ran with statement_timeout 0 and relied on the 12 s client deadline alone.
      statement_timeout: 10_000,
      query_timeout: 12_000,
      allowExitOnIdle: true,
    };
    super(config);
    this.pgcf = target !== undefined;
    this.on("connect", (client: PoolClient) => this.clients.add(client));
    this.on("remove", (client: PoolClient) => this.clients.delete(client));
    this.on("error", ignorePoolShutdown);
  }

  public override connect(): Promise<PoolClient>;
  public override connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: boolean) => void,
    ) => void,
  ): void;
  public override connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: boolean) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    const acquisition = this.acquire();
    if (callback) {
      void acquisition.then(
        (client) => callback(undefined, client, (release) => client.release(release)),
        (error: unknown) =>
          callback(
            error instanceof Error ? error : new ProjectDatabaseBusyError(),
            undefined,
            () => undefined,
          ),
      );
      return;
    }
    return acquisition;
  }

  private acquire(): Promise<PoolClient> {
    if (this.unavailable || this.waitingCount >= 32)
      return Promise.reject(new ProjectDatabaseBusyError());
    return new Promise<PoolClient>((resolve, reject) => {
      this.waiting.add(reject);
      void this.connectAfterWake().then(
        (client) => {
          // Shutdown may release an active lease before its caller's finally block runs.
          const release = client.release.bind(client);
          let released = false;
          client.release = (destroy) => {
            if (released) return;
            released = true;
            release(destroy);
          };
          this.waiting.delete(reject);
          if (this.unavailable) {
            client.release(true);
            reject(new ProjectDatabaseBusyError());
          } else resolve(client);
        },
        (error: unknown) => {
          this.waiting.delete(reject);
          reject(error);
        },
      );
    });
  }

  /** Retries only the connection phase, so no SQL is ever repeated; a database wakes within seconds. */
  private async connectAfterWake(): Promise<PoolClient> {
    const deadline = Date.now() + WAKE_REFUSAL_BUDGET_MS;
    for (let retry = 0; ; retry += 1) {
      try {
        return await super.connect();
      } catch (error) {
        const delay = wakeRetryDelayMs(retry);
        if (
          !this.pgcf ||
          this.unavailable ||
          !isWakeRefusal(error) ||
          Date.now() + delay > deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  public async invalidate(): Promise<void> {
    if (this.unavailable) return;
    this.unavailable = true;
    for (const reject of this.waiting) reject(new ProjectDatabaseBusyError());
    this.waiting.clear();
    // Mark the pool ending before waiting, including sockets still completing TLS setup.
    const ending = this.end().catch(ignorePoolShutdown);
    await Promise.allSettled(
      [...this.clients].map(async (client) => {
        // pg removes its idle error listener while a client is leased. A backend FATAL can still
        // arrive during end(), so retain a sink for the lifetime of this discarded client.
        client.on("error", ignorePoolShutdown);
        try {
          await (client as PoolClient & { end(): Promise<void> }).end();
        } finally {
          client.release(true);
        }
      }),
    );
    await ending;
  }
}

export function pooledClientDependencies(pool: Pool): ProjectDatabaseServiceDependencies {
  return { createClient: (configuration) => pooledClient(pool, configuration) };
}

function pooledClient(pool: Pool, configuration: ClientConfig): ProjectDatabaseClient {
  let client: PoolClient | undefined;
  let closed = false;
  const listeners: ((error: Error) => void)[] = [];
  return {
    async connect() {
      if (closed || client) throw new Error("project_database_connection_closed");
      client = await pool.connect();
      for (const listener of listeners) client.on("error", listener);
    },
    on(_event, listener) {
      listeners.push(listener);
      client?.on("error", listener);
    },
    async query(query) {
      if (!client || closed) throw new Error("project_database_connection_closed");
      const prepared = {
        ...query,
        values: [...query.values],
        ...(configuration.types ? { types: configuration.types } : {}),
        queryMode: "extended" as const,
      };
      return client.query(prepared);
    },
    async terminate() {
      if (closed) return;
      closed = true;
      if (!client) return;
      // Terminate is asynchronous: removing the application listeners must not leave a leased
      // client unguarded before the pool installs its listener on forced release.
      client.on("error", ignorePoolShutdown);
      for (const listener of listeners) client.removeListener("error", listener);
      try {
        await (client as PoolClient & { end(): Promise<void> }).end();
      } finally {
        client.release(true);
      }
    },
    async end() {
      if (closed) return;
      closed = true;
      if (!client) return;
      // A tenant query can change the session's timeouts or settings; the next lease of this pooled session must start
      // from the platform defaults, so RESET ALL runs before the session returns. A session that cannot be reset is destroyed.
      client.on("error", ignorePoolShutdown);
      for (const listener of listeners) client.removeListener("error", listener);
      let reusable = true;
      try {
        await client.query("RESET ALL");
      } catch {
        reusable = false;
      } finally {
        // A destroyed session keeps the sink: what its backend reports after the destruction is absorbed, not thrown.
        if (reusable) client.removeListener("error", ignorePoolShutdown);
      }
      client.release(!reusable);
    },
  };
}

function ignorePoolShutdown(): undefined {
  return undefined;
}
