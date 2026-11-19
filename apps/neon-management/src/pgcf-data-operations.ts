import { Pool } from "pg";
import {
  createPgcfPostgresPoolConfig,
  type PgcfPostgresTarget,
  type ProjectDatabaseSqlTarget,
} from "@ohmyhost/database";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { parseDiagnosticQuery } from "./request-parsing.js";
import { verifyProjectSqlRoleLogin } from "./sql-role-bootstrap.js";

/** Trusted session transport shared by diagnostics, temporary-role verification and product SQL. */
export async function productionPgcfDataConnection(
  uri: string,
  target: PgcfPostgresTarget,
  limits: { readonly query_timeout: number; readonly statement_timeout: number } = {
    query_timeout: 10_000,
    statement_timeout: 10_000,
  },
) {
  const pool = new Pool(
    createPgcfPostgresPoolConfig(uri, target, {
      max: 1,
      connectionTimeoutMillis: 70_000,
      idleTimeoutMillis: 10_000,
      ...limits,
    }),
  );
  try {
    const client = await pool.connect();
    return {
      client,
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

interface PgcfDiagnosticConnection {
  client: {
    query(
      input: string,
      values?: unknown[],
    ): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number | null }>;
    query(input: {
      text: string;
      values: unknown[];
      queryMode: "extended";
    }): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number | null }>;
  };
  close(): Promise<void>;
}
export async function queryPgcfProject(
  input: {
    readonly readTarget: (input: {
      organizationId: string;
      projectId: string;
      environment: "dev" | "prod";
    }) => Promise<ProjectDatabaseSqlTarget | null>;
    readonly provider: Pick<PgcfProjectProvider, "projectId" | "readConnection">;
    readonly connect: (
      uri: string,
      target: PgcfPostgresTarget,
    ) => Promise<PgcfDiagnosticConnection>;
  },
  raw: unknown,
) {
  const request = parseDiagnosticQuery(raw);
  const target = await input.readTarget({
    organizationId: request.organizationId,
    projectId: request.projectId,
    environment: request.environment,
  });
  if (target === null) return Object.freeze({ status: "absent" as const });
  if (target.provider !== "pgcf" || target.providerProjectId !== input.provider.projectId)
    throw new Error("Project database diagnostics are unavailable");
  const handle = await input.provider.readConnection(target.databaseId, target.roleName);
  if (handle.host !== target.originHost)
    throw new Error("Project database diagnostic target changed");
  return handle.consume(async (uri) => {
    const connection = await input.connect(uri, {
      provider: "pgcf",
      host: target.originHost,
      databaseId: target.databaseId,
      role: target.roleName,
    });
    try {
      await verifyProjectSqlRoleLogin(
        { query: (text, values) => connection.client.query(text, values ? [...values] : []) },
        target.roleName,
      );
      await connection.client.query("BEGIN READ ONLY");
      await connection.client.query("SET LOCAL statement_timeout='5s'");
      const statement = {
        text: `SELECT * FROM (${request.statement}) AS ohmyhost_diagnostic LIMIT 101`,
        values: [...request.parameters],
        queryMode: "extended" as const,
      };
      const result = await connection.client.query(statement);
      await connection.client.query("ROLLBACK");
      const rows = result.rows.slice(0, 100);
      const body = {
        environment: request.environment,
        rows,
        rowCount: rows.length,
        truncated: result.rows.length > 100,
      };
      const encoded = JSON.stringify(body);
      if (new TextEncoder().encode(encoded).byteLength > 256 * 1024)
        throw new TypeError("Project database diagnostic result is too large");
      return Object.freeze(JSON.parse(encoded) as typeof body);
    } catch (error) {
      await connection.client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof TypeError && error.message.includes("diagnostic result")) throw error;
      return Object.freeze({ status: "rejected" as const });
    } finally {
      await connection.close();
    }
  });
}
