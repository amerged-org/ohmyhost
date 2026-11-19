import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import {
  parseProjectDatabaseWrite,
  assertProjectDatabaseWriteReceipt,
  assertProjectDatabaseAccess,
  assertProjectDatabaseAccessCredential,
  assertProjectDatabaseAccessPage,
  parseProjectDatabaseAccessRequest,
  DATABASE_ACCESS_DEFAULT_TTL_SECONDS,
  DATABASE_ACCESS_MAX_TTL_SECONDS,
  DATABASE_ACCESS_MIN_TTL_SECONDS,
} from "../src/database-access.js";
import { publicOperationFailure } from "../src/operation-failure.js";

it("requires explicit database scope and validates bounded write input and truthful receipts", () => {
  const base = {
    environment: "prod",
    statement:
      "INSERT INTO visits(id,value) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value",
    parameters: [1, { note: "a; COMMIT; --", ok: true }],
  };
  expect(parseProjectDatabaseWrite(base)).toEqual(base);
  for (const candidate of [
    { ...base, environment: "preview" },
    { ...base, statement: "WITH changed AS (DELETE FROM visits) SELECT 1" },
    { ...base, parameters: Array(101).fill(1) },
    { ...base, parameters: [NaN] },
    { ...base, statement: "INSERT " + "x".repeat(65536) },
    { ...base, extra: true },
  ])
    expect(() => parseProjectDatabaseWrite(candidate)).toThrow();
  const receipt = {
    operation_id: "00000000000000000000000001",
    environment: "prod",
    state: "failed",
    command: null,
    affected_rows: null,
    error: publicOperationFailure("DATABASE_WRITE_OUTCOME_UNKNOWN"),
  };
  expect(() => assertProjectDatabaseWriteReceipt(receipt)).not.toThrow();
  expect(receipt.error.retryable).toBe(false);
  expect(() => assertProjectDatabaseWriteReceipt({ ...receipt, state: "succeeded" })).toThrow();
});

const HOST = "pgcf.example.test";
const ROLE = "ohmyho_da_01h00000000000000000000002_a1b2c3d4";
const DATABASE = "a".repeat(20);
const URI = `postgres://${ROLE}:0123456789abcdef@${HOST}/${DATABASE}?sslmode=require`;
const credential = {
  provider: "pgcf",
  transport: "wss",
  websocket_url: `wss://${HOST}/`,
  access_id: "01H00000000000000000000001",
  environment: "dev",
  mode: "read",
  role_name: ROLE,
  host: HOST,
  database: DATABASE,
  label: "psql",
  state: "active",
  issued_at: "2026-09-15T12:00:00.000Z",
  expires_at: "2026-09-15T13:00:00.000Z",
  revoked_at: null,
  revocation_reason: null,
  connection_uri: URI,
  psql_command:
    "ohmyhost database psql --project 01H00000000000000000000001 --environment dev --mode read",
} as const;
const access = Object.fromEntries(
  Object.entries(credential).filter(([key]) => !["connection_uri", "psql_command"].includes(key)),
);

it("defaults the database access request and bounds its time to live and label", () => {
  expect(DATABASE_ACCESS_MIN_TTL_SECONDS).toBe(300);
  expect(DATABASE_ACCESS_DEFAULT_TTL_SECONDS).toBe(3600);
  expect(DATABASE_ACCESS_MAX_TTL_SECONDS).toBe(86_400);
  expect(parseProjectDatabaseAccessRequest({ environment: "dev" })).toEqual({
    environment: "dev",
    mode: "read",
    ttl_seconds: 3600,
    label: null,
  });
  expect(
    parseProjectDatabaseAccessRequest({
      environment: "prod",
      mode: "write",
      ttl_seconds: 300,
      label: "  nightly audit  ",
    }),
  ).toEqual({ environment: "prod", mode: "write", ttl_seconds: 300, label: "nightly audit" });
  expect(parseProjectDatabaseAccessRequest({ environment: "dev", label: null }).label).toBeNull();
  for (const candidate of [
    {},
    null,
    [],
    { environment: "preview" },
    { environment: "dev", mode: "owner" },
    { environment: "dev", ttl_seconds: 299 },
    { environment: "dev", ttl_seconds: 86_401 },
    { environment: "dev", ttl_seconds: 600.5 },
    { environment: "dev", ttl_seconds: "600" },
    { environment: "dev", label: "" },
    { environment: "dev", label: "   " },
    { environment: "dev", label: "x".repeat(65) },
    { environment: "dev", label: `bad${String.fromCodePoint(7)}label` },
    { environment: "dev", label: 7 },
    { environment: "dev", extra: true },
  ])
    expect(() => parseProjectDatabaseAccessRequest(candidate)).toThrow();
});

it("accepts only truthful access records, credentials bound to their role and host, and bounded pages", () => {
  expect(() => assertProjectDatabaseAccess(access)).not.toThrow();
  expect(() => assertProjectDatabaseAccessCredential(credential)).not.toThrow();
  const withoutProvider = Object.fromEntries(
    Object.entries(access).filter(([key]) => key !== "provider"),
  );
  for (const changed of [
    { ...credential, transport: "tcp" },
    { ...credential, websocket_url: "ws://pgcf.example.test/" },
    { ...credential, websocket_url: "wss://foreign.example.test/" },
    { ...credential, provider: "neon" },
    { ...credential, database: "neondb" },
    { ...credential, connection_uri: URI.replace(DATABASE, "b".repeat(20)) },
    { ...credential, psql_command: `psql '${URI}'` },
    { ...credential, connection_uri: `${URI}&host=foreign.example.test` },
  ])
    expect(() => assertProjectDatabaseAccessCredential(changed)).toThrow();
  for (const legacy of [
    withoutProvider,
    { ...withoutProvider, database: "neondb" },
    { ...access, database: "neondb" },
  ])
    expect(() => assertProjectDatabaseAccess(legacy)).toThrow();

  expect(() => assertProjectDatabaseAccess(credential)).toThrow();
  expect(() => assertProjectDatabaseAccessCredential(access)).toThrow();
  for (const candidate of [
    { ...access, access_id: "not-a-ulid" },
    { ...access, environment: "preview" },
    { ...access, mode: "owner" },
    { ...access, role_name: "ohmyho_rw_01h00000000000000000000002" },
    { ...access, host: "HOST.example.com" },
    { ...access, database: "postgres" },
    { ...access, state: "pending" },
    { ...access, issued_at: "2026-09-15 12:00:00" },
    { ...access, expires_at: null },
    { ...access, label: "" },
    { ...access, state: "revoked" },
    { ...access, revoked_at: "2026-09-15T12:30:00.000Z" },
    { ...access, revocation_reason: "principal" },
    {
      ...access,
      state: "revoked",
      revoked_at: "2026-09-15T12:30:00.000Z",
      revocation_reason: "nope",
    },
    { ...access, extra: true },
    null,
  ])
    expect(() => assertProjectDatabaseAccess(candidate)).toThrow();
  expect(() => assertProjectDatabaseAccess({ ...access, state: "expired" })).not.toThrow();
  expect(() =>
    assertProjectDatabaseAccess({
      ...access,
      state: "expired",
      revoked_at: "2026-09-15T12:30:00.000Z",
      revocation_reason: "budget",
    }),
  ).toThrow();
  for (const reason of ["principal", "expired", "budget", "creation_failed"] as const)
    expect(() =>
      assertProjectDatabaseAccess({
        ...access,
        state: "revoked",
        revoked_at: "2026-09-15T12:30:00.000Z",
        revocation_reason: reason,
      }),
    ).not.toThrow();
  for (const candidate of [
    { ...credential, connection_uri: URI.replace("postgres:", "https:") },
    { ...credential, connection_uri: URI.replace(`/${DATABASE}`, "/postgres") },
    { ...credential, host: "other.example.test", websocket_url: "wss://other.example.test/" },
    { ...credential, connection_uri: URI.replace(":0123456789abcdef@", "@") },
    { ...credential, connection_uri: URI.replace(ROLE, "ohmyho_rw_x") },
  ])
    expect(() => assertProjectDatabaseAccessCredential(candidate)).toThrow();
  expect(() => assertProjectDatabaseAccessPage({ items: [access, access] })).not.toThrow();
  expect(() => assertProjectDatabaseAccessPage({ items: [] })).not.toThrow();
  expect(() =>
    assertProjectDatabaseAccessPage({ items: Array.from({ length: 51 }, () => access) }),
  ).toThrow();
  for (const candidate of [{ items: access }, { items: [access], extra: 1 }, {}, null])
    expect(() => assertProjectDatabaseAccessPage(candidate)).toThrow();
});

const CONTRACT_ID = "https://openapi.test/contract.json";
const openApiDocument = parse(
  readFileSync(fileURLToPath(new URL("../openapi.yaml", import.meta.url)), "utf8"),
) as Record<string, unknown>;

function openApiSchemaValidator(name: string) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema({ $id: CONTRACT_ID, ...openApiDocument });
  const validate = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`OpenAPI schema ${name} is missing`);
  return validate;
}

it("keeps the OpenAPI PGCF credential schema aligned with the runtime assertions (W07)", () => {
  const withoutWebsocket = Object.fromEntries(
    Object.entries(credential).filter(([key]) => key !== "websocket_url"),
  );
  const credentialSchema = openApiSchemaValidator("ProjectDatabaseAccessCredential");
  const accessSchema = openApiSchemaValidator("ProjectDatabaseAccess");

  expect(credentialSchema(credential)).toBe(true);
  expect(() => assertProjectDatabaseAccessCredential(credential)).not.toThrow();
  expect(accessSchema(access)).toBe(true);
  expect(() => assertProjectDatabaseAccess(access)).not.toThrow();
  for (const value of [
    { ...credential, extra: 1 },
    { ...credential, database: "neondb" },
    withoutWebsocket,
  ]) {
    expect(credentialSchema(value)).toBe(false);
    expect(() => assertProjectDatabaseAccessCredential(value)).toThrow();
  }
});

type OpenApiParameterRef = { $ref?: string };
type OpenApiOperation = { operationId?: string; parameters?: OpenApiParameterRef[] };

it("documents dev as the default application environment for database reads (blueprint 2.1)", () => {
  const components = openApiDocument["components"] as { parameters: Record<string, unknown> };
  expect(components.parameters["DatabaseEnvironmentRead"]).toEqual({
    name: "environment",
    in: "query",
    description: "Application environment to read; dev when omitted.",
    required: false,
    schema: { type: "string", enum: ["dev", "prod"], default: "dev" },
  });

  const operations = Object.values(
    openApiDocument["paths"] as Record<string, Record<string, unknown>>,
  )
    .flatMap((pathItem) => Object.values(pathItem) as OpenApiOperation[])
    .filter((operation) => typeof operation.operationId === "string");
  const readOperations = [
    "listProjectDatabaseWebhooks",
    "getProjectDatabaseWebhook",
    "listProjectDatabaseWebhookDeliveries",
    "listProjectDatabaseSchedules",
    "getProjectDatabaseSchedule",
    "listProjectDatabaseScheduleRuns",
    "getProjectDatabaseExecutionUsage",
  ];
  for (const operationId of readOperations) {
    const operation = operations.find((candidate) => candidate.operationId === operationId);
    expect(operation?.parameters?.map((parameter) => parameter.$ref)).toContain(
      "#/components/parameters/DatabaseEnvironmentRead",
    );
    expect(operation?.parameters?.map((parameter) => parameter.$ref)).not.toContain(
      "#/components/parameters/DatabaseEnvironmentFilter",
    );
  }
  const accessList = operations.find(
    (candidate) => candidate.operationId === "listProjectDatabaseAccess",
  );
  expect(accessList?.parameters?.map((parameter) => parameter.$ref)).toContain(
    "#/components/parameters/DatabaseEnvironmentFilter",
  );
});

it("states that a database login can assert ohmyhost.request_claims and so reads every application row, not that RLS isolates it", () => {
  const operations = Object.values(
    openApiDocument["paths"] as Record<string, Record<string, unknown>>,
  )
    .flatMap((pathItem) => Object.values(pathItem) as OpenApiOperation[])
    .filter((operation) => typeof operation.operationId === "string");
  const access = operations.find(
    (candidate) => candidate.operationId === "createProjectDatabaseAccess",
  ) as { description?: string } | undefined;
  expect(access?.description).toMatch(/ohmyhost\.request_claims/u);
  expect(access?.description).toMatch(/all application rows/u);
  expect(access?.description).not.toMatch(/row-level security policies remain effective/u);
});
