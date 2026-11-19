import { projectSqlRoleName, type DatabaseMigrationClient } from "@ohmyhost/platform";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import type { DatabaseScope } from "./pgcf-database-request.js";
import type { PgcfManagementDependencies } from "./pgcf-runtime.js";
import { verifyProjectSqlRoleLogin } from "./sql-role-bootstrap.js";

/** The migration role is the table owner; the schema changes of the product services run only as this role. */
export async function migrationSession<T>(
  dependencies: {
    readonly provider: Pick<PgcfProjectProvider, "readConnection">;
    readonly connect: PgcfManagementDependencies["connect"];
  },
  scope: DatabaseScope,
  work: (client: DatabaseMigrationClient) => Promise<T>,
): Promise<T> {
  const { provider, connect } = dependencies;
  const role = projectSqlRoleName(scope.physicalEnvironmentId, "migration");
  const handle = await provider.readConnection(scope.databaseId, role);
  return handle.consume(async (uri) => {
    const connected = await connect(uri, {
      provider: "pgcf",
      host: handle.host,
      databaseId: scope.databaseId,
      role,
    });
    try {
      await verifyProjectSqlRoleLogin(connected.client, role);
      return await work(connected.client);
    } finally {
      await connected.close();
    }
  });
}

/**
 * Runs the work in one transaction that waits for the migrations lock, so a product change never lands inside a
 * migration's catalog snapshot. A busy lock answers `busy`; a refusal commits nothing; any other failure rolls back.
 */
export async function migrationTransaction<T>(
  client: { query(sql: string): Promise<unknown> },
  work: () => Promise<T>,
  busy: T,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ohmyhost:migrations', 0))");
    const outcome = await work();
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (sqlstate(error) === "55P03") return busy;
    throw error;
  }
}

function sqlstate(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
