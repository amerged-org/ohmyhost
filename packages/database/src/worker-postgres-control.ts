import type { PoolConfig } from "pg";
import { type NeonControlPostgresTarget } from "./worker-postgres-targets.js";

export interface DatabaseProviderPolicy {
  readonly caller: string;
  readonly audit: boolean;
  /** Broad transitional Neon traffic. Retained Control needs its separate exact SQL allowance. */
  readonly neonTrafficEnabled: boolean;
  readonly purpose?: "control";
  readonly neonControlTarget?: NeonControlPostgresTarget;
}

/** Optional observation never includes credential values or query text; denials remain visible. */
export function databaseProviderTargetEvent(
  policy: DatabaseProviderPolicy | undefined,
  target: {
    readonly provider: "pgcf" | "neon" | "unknown";
    readonly host: string | null;
    readonly databaseId: string | null;
  },
  outcome: "started" | "succeeded" | "blocked",
): void {
  if (outcome !== "blocked" && policy?.audit !== true) return;
  console.log(
    JSON.stringify({
      event: "database_provider_target",
      provider: target.provider,
      host: target.host,
      databaseId: target.databaseId,
      transport: "sql",
      purpose: policy?.purpose ?? "application",
      caller: policy?.caller ?? "database-transport",
      outcome,
    }),
  );
}

export type WorkerPostgresPoolOptions = Pick<
  PoolConfig,
  "max" | "connectionTimeoutMillis" | "idleTimeoutMillis" | "query_timeout" | "statement_timeout"
>;
