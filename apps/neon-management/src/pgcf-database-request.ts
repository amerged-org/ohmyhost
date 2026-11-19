import { parseUlid } from "@ohmyhost/platform";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import type { DatabaseEnvironment } from "@ohmyhost/contracts/database-access";
import { parseDatabaseEnvironment } from "@ohmyhost/contracts/database-events";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";

/** The project environment a database request names; the database id is never part of the request. */
export interface DatabaseRequestEnvelope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environment: DatabaseEnvironment;
}

/** The product compute scope of one project environment; the only source of the database id. */
export type ReadDatabaseScope = (input: DatabaseRequestEnvelope) => Promise<{
  readonly physicalEnvironmentId: string;
  readonly target: DatabaseProviderTarget | null;
}>;

export interface DatabaseScope {
  readonly databaseId: string;
  readonly physicalEnvironmentId: string;
  readonly environment: DatabaseEnvironment;
}

/** Per operation, the required and the optional member keys of the RPC request. */
export type DatabaseRequestShapes<Operation extends string> = Readonly<
  Record<Operation, readonly [required: readonly string[], optional: readonly string[]]>
>;

/**
 * Parses the RPC envelope shared by the database operations. Closed key sets: a key outside the operation's shape
 * is refused, an undefined key counts as absent. The raw input is returned for the operation-specific members.
 */
export function parseDatabaseRequest<Operation extends string>(
  value: unknown,
  shapes: DatabaseRequestShapes<Operation>,
): {
  readonly operation: Operation;
  readonly envelope: DatabaseRequestEnvelope;
  readonly input: Record<string, unknown>;
} {
  const input = record(value);
  const operation = input["operation"];
  if (typeof operation !== "string" || !Object.hasOwn(shapes, operation))
    throw new TypeError("Invalid database event request");
  const [required, optional] = shapes[operation as Operation];
  members(
    input,
    ["operation", "organizationId", "projectId", "environment", ...required],
    optional,
  );
  return {
    operation: operation as Operation,
    envelope: {
      organizationId: ulid(input["organizationId"]),
      projectId: ulid(input["projectId"]),
      environment: parseDatabaseEnvironment(input["environment"]),
    },
    input,
  };
}

/**
 * The database of a request, read from the product scope. Null when the environment has no database yet; a target of
 * another PGCF project or provider is a misconfiguration and throws.
 */
export async function resolveDatabaseScope(
  dependencies: {
    readonly readScope: ReadDatabaseScope;
    readonly provider: Pick<PgcfProjectProvider, "projectId">;
  },
  envelope: DatabaseRequestEnvelope,
): Promise<DatabaseScope | null> {
  const scope = await dependencies.readScope({
    organizationId: envelope.organizationId,
    projectId: envelope.projectId,
    environment: envelope.environment,
  });
  const target = scope.target;
  if (target === null) return null;
  if (target.provider !== "pgcf" || target.providerProjectId !== dependencies.provider.projectId)
    throw new Error("Database compute scope unavailable");
  return {
    databaseId: target.databaseId,
    physicalEnvironmentId: scope.physicalEnvironmentId,
    environment: envelope.environment,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid database event request");
  return value as Record<string, unknown>;
}

function members(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = [...required, ...optional];
  for (const key of Object.keys(input))
    if (input[key] !== undefined && !allowed.includes(key))
      throw new TypeError("Invalid database event request");
  for (const key of required)
    if (input[key] === undefined) throw new TypeError("Invalid database event request");
}

function ulid(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid database event request");
  return parseUlid(value);
}
