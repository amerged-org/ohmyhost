import { verifyProjectSqlRoleLogin } from "./sql-role-bootstrap.js";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import { parseProjectDatabaseWrite } from "@ohmyhost/contracts/database-access";
import {
  acceptProjectDatabaseWrite,
  finishProjectDatabaseWrite,
  ProjectDatabaseWriteError,
  OrganizationCreditError,
  type PgcfPostgresTarget,
  type ProjectDatabaseSqlTarget,
} from "@ohmyhost/database";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";

export interface DatabaseWriteConnection {
  client: {
    query(
      input: string | { text: string; values: readonly unknown[]; queryMode: "extended" },
    ): Promise<{
      command: string;
      rowCount: number | null;
      rows: readonly Record<string, unknown>[];
    }>;
  };
  close(): Promise<void>;
}
export interface ProjectDatabaseWritePersistence {
  accept(
    input: Parameters<typeof acceptProjectDatabaseWrite>[1],
  ): ReturnType<typeof acceptProjectDatabaseWrite>;
  finish(
    input: Parameters<typeof finishProjectDatabaseWrite>[1] & { projectId: string },
  ): ReturnType<typeof finishProjectDatabaseWrite>;
}
/** The private request owns one execution attempt; only its Control receipt survives. */
export function createProjectDatabaseWriter(input: {
  persistence: ProjectDatabaseWritePersistence;
  pgcfProvider: Pick<PgcfProjectProvider, "readConnection" | "projectId">;
  connect: (uri: string, pgcfTarget: PgcfPostgresTarget) => Promise<DatabaseWriteConnection>;
  clock: Clock;
  ids: UlidFactory;
}) {
  const { persistence } = input;
  return async (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new TypeError("Invalid database write request");
    const value = raw as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
      "canonicalRequestSha256,environment,idempotencyKey,organizationId,parameters,principalId,projectId,requestId,statement"
    )
      throw new TypeError("Invalid database write request");
    const organizationId = parseUlid(String(value["organizationId"])),
      projectId = parseUlid(String(value["projectId"]));
    const request = parseProjectDatabaseWrite({
      environment: value["environment"],
      statement: value["statement"],
      parameters: value["parameters"],
    });
    const principalId = String(value["principalId"]),
      requestId = String(value["requestId"]),
      idempotencyKey = String(value["idempotencyKey"]);
    const digestHex = value["canonicalRequestSha256"];
    if (typeof digestHex !== "string" || !/^[0-9a-f]{64}$/u.test(digestHex))
      throw new TypeError("Invalid database write digest");
    const digest = Buffer.from(digestHex, "hex");
    let accepted;
    try {
      accepted = await persistence.accept({
        organizationId,
        projectId,
        ...request,
        principalId,
        requestId,
        idempotencyKey,
        canonicalRequestDigest: digest,
        now: input.clock.now().toISOString(),
        ids: input.ids,
      });
    } catch (error) {
      if (error instanceof ProjectDatabaseWriteError)
        return { status: "rejected", code: error.code };
      if (error instanceof OrganizationCreditError) return { status: "rejected", code: error.code };
      throw error;
    }
    if (accepted.mode === "observe") return accepted.receipt;
    const result = await executeWrite({
      pgcfProvider: input.pgcfProvider,
      connect: input.connect,
      target: accepted.target,
      request,
      clock: input.clock,
    });
    return persistence.finish({
      organizationId,
      projectId,
      operationId: parseUlid(accepted.receipt.operation_id),
      now: input.clock.now().toISOString(),
      ids: input.ids,
      ...result,
    });
  };
}
async function executeWrite(input: {
  pgcfProvider: Pick<PgcfProjectProvider, "readConnection" | "projectId">;
  connect: (uri: string, pgcfTarget: PgcfPostgresTarget) => Promise<DatabaseWriteConnection>;
  target: ProjectDatabaseSqlTarget & { readonly deadlineAt: string };
  request: ReturnType<typeof parseProjectDatabaseWrite>;
  clock: Clock;
}) {
  let submitted = false,
    commitAttempted = false;
  try {
    const placement = input.target;
    if (
      placement.provider !== "pgcf" ||
      input.pgcfProvider.projectId !== placement.providerProjectId
    )
      throw new Error("PGCF write target is unavailable");
    const execute = async (directUri: string, pgcfTarget: PgcfPostgresTarget) => {
      const uri = new URL(directUri);
      if (
        decodeURIComponent(uri.username) !== placement.roleName ||
        !["postgres:", "postgresql:"].includes(uri.protocol) ||
        decodeURIComponent(uri.pathname.slice(1)) !== placement.databaseId
      )
        throw new Error("Invalid runtime role");
      const connection = await input.connect(directUri, pgcfTarget);
      try {
        await verifyProjectSqlRoleLogin(
          {
            query: (text, values) =>
              connection.client.query({ text, values: values ?? [], queryMode: "extended" }),
          },
          input.target.roleName,
        );
        await connection.client.query("BEGIN");
        await connection.client.query("SET LOCAL statement_timeout='5s'");
        await connection.client.query("SET LOCAL lock_timeout='5s'");
        await connection.client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
        // A slow URI/connection preflight cannot start SQL after maintenance closed the claim.
        if (input.clock.now().getTime() + 20_000 >= Date.parse(input.target.deadlineAt))
          throw new Error("Database write execution deadline elapsed");
        submitted = true;
        const result = await connection.client.query({
          text: input.request.statement,
          values: input.request.parameters,
          queryMode: "extended",
        });
        if (
          !["INSERT", "UPDATE", "DELETE"].includes(result.command) ||
          !Number.isSafeInteger(result.rowCount) ||
          result.rowCount === null ||
          result.rowCount < 0 ||
          result.rowCount > 1000 ||
          result.rows.length > 1000 ||
          new TextEncoder().encode(JSON.stringify(result.rows)).byteLength > 1_048_576
        )
          throw new Error("Database write result exceeded limits");
        commitAttempted = true;
        await connection.client.query("COMMIT");
        return {
          command: result.command as "INSERT" | "UPDATE" | "DELETE",
          affectedRows: result.rowCount,
        };
      } catch {
        if (commitAttempted) return { failureCode: "DATABASE_WRITE_OUTCOME_UNKNOWN" };
        try {
          await connection.client.query("ROLLBACK");
          return {
            failureCode: submitted ? "DATABASE_WRITE_REJECTED" : "DATABASE_WRITE_UNAVAILABLE",
          };
        } catch {
          return {
            failureCode: submitted
              ? "DATABASE_WRITE_OUTCOME_UNKNOWN"
              : "DATABASE_WRITE_UNAVAILABLE",
          };
        }
      } finally {
        // A confirmed COMMIT remains confirmed even when connection disposal fails.
        await connection.close().catch(() => undefined);
      }
    };
    const handle = await input.pgcfProvider.readConnection(
      placement.databaseId,
      placement.roleName,
    );
    if (handle.host !== placement.originHost) throw new Error("PGCF write target changed");
    const target: PgcfPostgresTarget = {
      provider: "pgcf",
      host: handle.host,
      databaseId: placement.databaseId,
      role: placement.roleName,
    };
    return await handle.consume((uri) => execute(uri, target));
  } catch {
    return {
      failureCode:
        commitAttempted || submitted
          ? "DATABASE_WRITE_OUTCOME_UNKNOWN"
          : "DATABASE_WRITE_UNAVAILABLE",
    };
  }
}
