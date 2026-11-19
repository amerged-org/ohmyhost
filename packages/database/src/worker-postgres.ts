import {
  databaseProviderTargetEvent,
  type DatabaseProviderPolicy,
  type WorkerPostgresPoolOptions,
} from "./worker-postgres-control.js";
export {
  databaseProviderTargetEvent,
  type DatabaseProviderPolicy,
  type WorkerPostgresPoolOptions,
} from "./worker-postgres-control.js";
import {
  readPgcfPostgresTarget,
  type PgcfPostgresTarget,
  type PgcfPostgresTargetInput,
} from "./worker-postgres-targets.js";
export { readPgcfPostgresTarget } from "./worker-postgres-targets.js";
export type {
  NeonControlPostgresTarget,
  PgcfPostgresTarget,
  PgcfPostgresTargetInput,
} from "./worker-postgres-targets.js";

import { DatabaseError, type PoolConfig } from "pg";
import {
  Client as WebSocketPostgresClient,
  DatabaseError as WebSocketDatabaseError,
} from "@neondatabase/serverless";

/** Both transports preserve genuine PostgreSQL errors at the redacted SQLSTATE boundary. */
export function isWorkerPostgresDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError || error instanceof WebSocketDatabaseError;
}

/** Validates the API-issued URI against trusted metadata; TLS belongs to WSS, not PostgreSQL. */
export function readPgcfPostgresConnectionString(
  connectionString: string,
  targetInput: Exclude<PgcfPostgresTargetInput, undefined>,
): string {
  const target = readPgcfPostgresTarget(targetInput);
  let uri: URL;
  try {
    uri = new URL(connectionString);
    if (
      connectionString.length > 5_120 ||
      !["postgres:", "postgresql:"].includes(uri.protocol) ||
      uri.hostname !== target.host ||
      (uri.port !== "" && uri.port !== "5432") ||
      uri.searchParams.getAll("sslmode").length > 1 ||
      (uri.searchParams.has("sslmode") &&
        !["require", "verify-full"].includes(uri.searchParams.get("sslmode") ?? "")) ||
      [...uri.searchParams.keys()].some((key) => key !== "sslmode") ||
      uri.hash !== "" ||
      decodeURIComponent(uri.pathname.slice(1)) !== target.databaseId ||
      decodeURIComponent(uri.username) !== target.role ||
      uri.password === ""
    )
      throw new Error();
  } catch {
    throw new TypeError("PGCF database URL does not match its target");
  }
  uri.search = "";
  uri.port = "";
  return uri.toString();
}

/** Uses one WSS PostgreSQL session per pg-pool client; no global driver settings or SQL retry. */
export function createPgcfPostgresPoolConfig(
  connectionString: string,
  targetInput: Exclude<PgcfPostgresTargetInput, undefined>,
  options: WorkerPostgresPoolOptions = {},
  policy?: DatabaseProviderPolicy,
): PoolConfig {
  let target: PgcfPostgresTarget;
  let uri: string;
  try {
    target = readPgcfPostgresTarget(targetInput);
    uri = readPgcfPostgresConnectionString(connectionString, target);
  } catch (error) {
    databaseProviderTargetEvent(
      policy,
      { provider: "unknown", host: null, databaseId: null },
      "blocked",
    );
    throw error;
  }
  class PgcfClient extends WebSocketPostgresClient {
    public constructor(configuration?: ConstructorParameters<typeof WebSocketPostgresClient>[0]) {
      super(configuration);
      this.neonConfig.useSecureWebSocket = true;
      this.neonConfig.forceDisablePgSSL = true;
      // Wait for PostgreSQL's real ReadyForQuery before handing out a session. Eager password
      // pipelining fabricates readiness and would start business-query deadlines during a wake.
      this.neonConfig.pipelineConnect = false;
      this.neonConfig.coalesceWrites = true;
      this.once("connect", () => databaseProviderTargetEvent(policy, target, "succeeded"));
      this.neonConfig.wsProxy = (host) => {
        if (host !== target.host) {
          databaseProviderTargetEvent(policy, target, "blocked");
          throw new TypeError("PGCF database target is invalid");
        }
        databaseProviderTargetEvent(policy, target, "started");
        return `${target.host}/v2?${new URLSearchParams({ database: target.databaseId, user: target.role })}`;
      };
    }
  }
  return {
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    ...options,
    connectionString: uri,
    // pg-pool's documented Client option keeps its lease, queue and disposal semantics.
    Client: PgcfClient as unknown as NonNullable<PoolConfig["Client"]>,
    ssl: false,
  };
}
