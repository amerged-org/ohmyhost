import {
  isRecordedBetterAuthVersion,
  parseUlid,
  type VerifiedDatabaseMigration,
} from "@ohmyhost/platform";

type PlacementScope = Readonly<{
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
  claimId: string;
}>;

const MAX_DIAGNOSTIC_STATEMENT_BYTES = 4_096;
const MAX_DIAGNOSTIC_PARAMETERS = 32;

export function parseDiagnosticQuery(value: unknown): Readonly<{
  organizationId: string;
  projectId: string;
  environment: "dev" | "prod";
  statement: string;
  parameters: readonly (string | number | boolean | null)[];
}> {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "environment,organizationId,parameters,projectId,statement"
  ) {
    throw new TypeError("Project database diagnostic query is invalid");
  }
  const organizationId = String(value["organizationId"]);
  const projectId = String(value["projectId"]);
  const statement = value["statement"];
  const parameters = value["parameters"];
  parseUlid(organizationId);
  parseUlid(projectId);
  if (
    (value["environment"] !== "dev" && value["environment"] !== "prod") ||
    typeof statement !== "string" ||
    !/^(?:select|with)\b/iu.test(statement.trimStart()) ||
    new TextEncoder().encode(statement).byteLength > MAX_DIAGNOSTIC_STATEMENT_BYTES ||
    !Array.isArray(parameters) ||
    parameters.length > MAX_DIAGNOSTIC_PARAMETERS ||
    !parameters.every(
      (parameter) =>
        parameter === null ||
        typeof parameter === "string" ||
        typeof parameter === "boolean" ||
        (typeof parameter === "number" && Number.isFinite(parameter)),
    )
  ) {
    throw new TypeError("Project database diagnostic query is invalid");
  }
  return Object.freeze({
    organizationId,
    projectId,
    environment: value["environment"] as "dev" | "prod",
    statement,
    parameters: Object.freeze([...parameters]) as readonly (string | number | boolean | null)[],
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMigrationRequest(value: unknown): Readonly<{
  scope: PlacementScope;
  migrations: readonly VerifiedDatabaseMigration[];
  auth: Readonly<{ provider: "none" | "better-auth" | "omh-native" }>;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Migration request is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "auth,claimId,environmentId,migrations,operationId,organizationId,projectId" ||
    !Array.isArray(record["migrations"])
  ) {
    throw new TypeError("Migration request is invalid");
  }
  const scope = parseScope(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "auth" && key !== "migrations"),
    ),
  );
  return Object.freeze({
    scope,
    migrations: Object.freeze(record["migrations"] as VerifiedDatabaseMigration[]),
    auth: parseCustomerAuthRequirement(record["auth"]),
  });
}

function parseCustomerAuthRequirement(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Customer auth requirement is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(",") === "provider" && record["provider"] === "none") {
    return Object.freeze({ provider: "none" as const });
  }
  if (
    Object.keys(record).sort().join(",") === "bindingName,provider,routePath" &&
    record["provider"] === "omh-native" &&
    record["routePath"] === "/api/auth/v1" &&
    record["bindingName"] === "OHMYHOST_AUTH"
  ) {
    return Object.freeze({ provider: "omh-native" as const });
  }
  if (
    Object.keys(record).sort().join(",") !==
      "authSecretName,databaseBindingName,databaseSchema,deployment,provider,routePath,version" ||
    record["provider"] !== "better-auth" ||
    !isRecordedBetterAuthVersion(record["version"]) ||
    (record["deployment"] !== "embedded" && record["deployment"] !== "companion") ||
    record["routePath"] !== "/api/auth" ||
    record["databaseSchema"] !== "auth" ||
    record["databaseBindingName"] !== "OHMYHOST_DATABASE" ||
    record["authSecretName"] !== "BETTER_AUTH_SECRET"
  ) {
    throw new TypeError("Customer auth requirement is invalid");
  }
  return Object.freeze({ provider: "better-auth" as const });
}

export async function migrationBundleDigest(
  migrations: readonly VerifiedDatabaseMigration[],
  auth: Readonly<{ provider: "none" | "better-auth" | "omh-native" }>,
) {
  for (const migration of migrations) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", migration.body as Uint8Array<ArrayBuffer>),
    );
    const expected = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (migration.size !== migration.body.byteLength || migration.digest !== expected) {
      throw new TypeError("Migration digest is invalid");
    }
  }
  const evidence = {
    migrations: migrations.map(({ path, digest, size }) => ({ path, digest, size })),
    auth,
  };
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(evidence))),
  );
}

function parseScope(value: unknown): PlacementScope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Placement scope is invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "claimId,environmentId,operationId,organizationId,projectId"
  ) {
    throw new TypeError("Placement scope is invalid");
  }
  return {
    organizationId: parseUlidField(record["organizationId"]),
    projectId: parseUlidField(record["projectId"]),
    environmentId: parseUlidField(record["environmentId"]),
    operationId: parseUlidField(record["operationId"]),
    claimId: parseUlidField(record["claimId"]),
  };
}

function parseUlidField(value: unknown) {
  if (typeof value !== "string") throw new TypeError("Placement scope is invalid");
  return parseUlid(value);
}
