import { Pool } from "pg";
import {
  createPgcfPostgresPoolConfig,
  type PgcfPostgresTarget,
} from "@ohmyhost/database/worker-postgres";
import type { NativeAuthDeploymentScope } from "./boundary.js";

export interface NativeRealmRegistration {
  readonly connectionString: string;
  readonly schema: string;
  readonly secret: string;
  readonly target: PgcfPostgresTarget;
}

/** Uses only the registry's independently verified PGCF target; no TCP fallback. */
export function createNativeRealmPool(
  config: NativeRealmRegistration,
  scope: NativeAuthDeploymentScope,
): Pool {
  if (
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(scope.projectId) ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(scope.environmentId)
  )
    throw new Error("auth_unavailable");
  const expectedRole = `omh_ar_${scope.environmentId.toLowerCase()}`;
  const expectedSchema = `omh_auth_${scope.environmentId.toLowerCase()}`;
  if (config.schema !== expectedSchema || config.target?.role !== expectedRole)
    throw new Error("auth_unavailable");
  const pool = new Pool({
    ...createPgcfPostgresPoolConfig(config.connectionString, config.target, { max: 2 }),
    options: `-c search_path=${expectedSchema}`,
  });
  // pg removes the failed idle client; never emit its potentially sensitive details.
  pool.on("error", () => undefined);
  return pool;
}
