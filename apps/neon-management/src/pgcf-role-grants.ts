import { DatabaseProviderConflictError, type PgcfPostgresTarget } from "@ohmyhost/database";
import {
  PERSISTING_FUNCTION_SIGNATURES,
  projectSqlPersistenceGrants,
  projectSqlRoleName,
} from "@ohmyhost/platform";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { migrationTransaction } from "./pgcf-migration-session.js";
import { isDatabaseOwnerLogin } from "./sql-role-bootstrap.js";

interface OwnerConnection {
  readonly client: {
    query(
      text: string,
      values?: readonly unknown[],
    ): Promise<{
      readonly rows: readonly Record<string, unknown>[];
      readonly rowCount: number | null;
    }>;
  };
  close(): Promise<void>;
}
/**
 * `current`: nothing was missing, so nothing was written and no lock was taken. `ensured`: the statements ran.
 * `busy`: a migration held the migrations lock for the lock timeout, so nothing was changed.
 */
export type EnsuredRoleGrants = "current" | "ensured" | "busy";

/**
 * True when the grants are not as the owner statements leave them: PUBLIC still holds TEMPORARY on the database, or the
 * migration or runtime role lacks TEMPORARY or one of the persisting functions. Held privileges include those a role
 * receives from PUBLIC, so before the PGCF baseline the functions count as present. $1 the two writing roles, $2 the
 * function signatures.
 */
const MISSING_SQL = `SELECT (
  EXISTS(SELECT 1 FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
    WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='TEMPORARY')
  OR EXISTS(SELECT 1 FROM unnest($1::text[]) w WHERE NOT has_database_privilege(w::name,current_database(),'TEMPORARY'))
  OR EXISTS(SELECT 1 FROM unnest($1::text[]) w, unnest($2::text[]) f WHERE NOT has_function_privilege(w::name,f::regprocedure,'EXECUTE'))
) AS missing`;

/**
 * Brings the TEMPORARY and persisting-function grants of one environment to what its migrations leave, through the
 * database owner `app`, the login a migration already uses for its owner grants (no superuser, no CREATEROLE). A read
 * credential does not wait for the environment's next migration this way.
 *
 * The state is read first, without a lock; only when something is missing are the statements run, in one transaction
 * under the migrations lock that `migrateProject`'s own owner grants take too, so the two writers of the same catalog
 * rows never overlap (PostgreSQL answers a concurrent GRANT on one row with "tuple concurrently updated"). The statements
 * are idempotent and the function grant cannot abort them (see `projectSqlRoleGrants`), so a database in any PGCF state
 * is accepted. The caller has already authorized the environment. The outcome is a fixed word, never a message.
 */
export async function ensureProjectRoleGrants(input: {
  readonly provider: Pick<PgcfProjectProvider, "readConnection">;
  readonly connect: (uri: string, target: PgcfPostgresTarget) => Promise<OwnerConnection>;
  readonly databaseId: string;
  readonly environmentId: string;
  readonly originHost: string;
}): Promise<EnsuredRoleGrants> {
  const { provider, databaseId } = input;
  const statements = projectSqlPersistenceGrants(input.environmentId, databaseId);
  const writers = (["migration", "runtime"] as const).map((purpose) =>
    projectSqlRoleName(input.environmentId, purpose),
  );
  const handle = await provider.readConnection(databaseId, "app");
  if (handle.host !== input.originHost) throw new DatabaseProviderConflictError();
  return handle.consume(async (uri) => {
    const connected = await input.connect(uri, {
      provider: "pgcf",
      host: handle.host,
      databaseId,
      role: "app",
    });
    try {
      if (!(await isDatabaseOwnerLogin(connected.client, "app")))
        throw new DatabaseProviderConflictError();
      const state = await connected.client.query(MISSING_SQL, [
        writers,
        PERSISTING_FUNCTION_SIGNATURES,
      ]);
      if (state.rows[0]?.["missing"] === false) return "current";
      return await migrationTransaction<EnsuredRoleGrants>(
        connected.client,
        async () => {
          for (const sql of statements) await connected.client.query(sql);
          return "ensured";
        },
        "busy",
      );
    } finally {
      await connected.close();
    }
  });
}
