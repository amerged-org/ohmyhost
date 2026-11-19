import { PROBLEM_POLICY } from "@ohmyhost/contracts/problem-policy";
import { parseDatabaseTableCreateRequest } from "@ohmyhost/contracts/database-tables";
import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import {
  createControlApi,
  createProjectDatabaseEventsPort,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  createUnavailableProviderReconciliationPort,
  ProjectDatabaseEventsError,
  type ControlApiDependencies,
  type ProjectDatabaseEventsBinding,
} from "../src/index.js";
import type { ProjectDatabaseAdmissionRuntime } from "../src/project-database-events.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const EVENT_ID = parseUlid("00000000000000000000000003");
const NOW = "2026-10-31T10:00:00.000Z";
const PATH = `https://api.test/v1/projects/${PROJECT_ID}/database/tables`;
const JSON_HEADERS = { Authorization: "Bearer valid", "Content-Type": "application/json" };
const WRITE_HEADERS = { ...JSON_HEADERS, "Idempotency-Key": "tables-key-0001" };
const CLOCK = { now: () => new Date(NOW) };

const COLUMNS = [
  { name: "id", type: "bigint", nullable: false, identity: true, default: null },
  { name: "total", type: "numeric", nullable: true, identity: false, default: null },
];
const TABLE = { schema: "public", table: "orders", columns: COLUMNS, primaryKey: ["id"] };
const CREATED_BODY = {
  table: {
    environment: "dev",
    schema: "public",
    table: "orders",
    columns: COLUMNS,
    primary_key: ["id"],
    created: true,
  },
};
const REPEATED_BODY = {
  table: {
    environment: "dev",
    schema: "public",
    table: "orders",
    columns: COLUMNS,
    primary_key: ["id"],
    created: false,
  },
};
const createBody = {
  environment: "dev",
  table: "orders",
  columns: [
    { name: "id", type: "bigint", nullable: false, identity: true },
    { name: "total", type: "numeric" },
  ],
  primary_key: ["id"],
};

type Answer = (input: Readonly<Record<string, unknown>>) => unknown;

function ok(value: unknown): { status: "ok"; value: unknown } {
  return { status: "ok", value };
}

/** The RPC answer for a create: the table as the service holds it and whether this request created it. */
function created(createdNow: boolean): Answer {
  return () => ok({ table: TABLE, created: createdNow });
}

/** The neon-management binding; every create is recorded, and an unexpected event operation fails the test. */
function tablesBinding(answer: Answer = created(true)): {
  binding: ProjectDatabaseEventsBinding;
  inputs: Record<string, unknown>[];
} {
  const inputs: Record<string, unknown>[] = [];
  return {
    inputs,
    binding: {
      databaseEvents: async () => {
        throw new Error("Unexpected database events operation");
      },
      createDatabaseTable: async (input: unknown) => {
        const record = input as Record<string, unknown>;
        inputs.push(record);
        return answer(record);
      },
    },
  };
}

/** The Core's admission answer, admitted unless a test names another; every question the port asks is recorded. */
function admissionOf(answer: unknown = { status: "admitted" }) {
  const questions: Record<string, unknown>[] = [];
  const admission: ProjectDatabaseAdmissionRuntime = {
    readProjectDatabaseAdmission: async (input) => {
      questions.push(input as Record<string, unknown>);
      return answer;
    },
    recordProjectDatabaseEventAudit: async () => ({ recorded: true }),
  };
  return { admission, questions };
}

function appWith(
  answer: Answer = created(true),
  admission: ProjectDatabaseAdmissionRuntime = admissionOf().admission,
  overrides: Partial<ControlApiDependencies> = {},
): {
  app: ReturnType<typeof createControlApi>;
  inputs: Record<string, unknown>[];
  reported: { code: string; route: string }[];
} {
  const { binding, inputs } = tablesBinding(answer);
  const reported: { code: string; route: string }[] = [];
  const app = createControlApi(
    dependencies({
      projectDatabaseEvents: createProjectDatabaseEventsPort(binding, admission, CLOCK),
      reporter: {
        report: (report) => {
          reported.push({ code: report.code, route: report.route });
        },
      },
      ...overrides,
    }),
  );
  return { app, inputs, reported };
}

const SCOPE = {
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  principalId: "user:1",
  requestId: "request",
  environment: "dev" as const,
};

describe("Control API database tables", () => {
  it("creates a table through the boundary with exactly the RPC fields", async () => {
    const { binding, inputs } = tablesBinding();
    const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);
    const request = parseDatabaseTableCreateRequest({
      table: "orders",
      columns: [
        { name: "id", type: "bigint", nullable: false, identity: true },
        { name: "total", type: "numeric" },
      ],
      primaryKey: ["id"],
    });

    expect(await port.createTable({ ...SCOPE, request })).toEqual({
      environment: "dev",
      table: TABLE,
      created: true,
    });
    expect(inputs.at(-1)).toEqual({
      operation: "table.create",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      table: "orders",
      columns: [
        { name: "id", type: "bigint", nullable: false, identity: true },
        { name: "total", type: "numeric", nullable: true, identity: false },
      ],
      primaryKey: ["id"],
    });
  });

  it("sends the defaults as the service reads them and omits a primary key that is not named", async () => {
    const { binding, inputs } = tablesBinding(() =>
      ok({
        table: {
          schema: "public",
          table: "events",
          columns: [
            { name: "at", type: "timestamptz", nullable: true, identity: false, default: "now" },
            { name: "token", type: "uuid", nullable: false, identity: false, default: "uuid" },
          ],
          primaryKey: [],
        },
        created: true,
      }),
    );
    const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);
    const request = parseDatabaseTableCreateRequest({
      table: "events",
      columns: [
        { name: "at", type: "timestamptz", default: "now" },
        { name: "token", type: "uuid", default: "uuid", nullable: false },
      ],
    });

    await port.createTable({ ...SCOPE, request });
    expect(inputs.at(-1)).toEqual({
      operation: "table.create",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      table: "events",
      columns: [
        { name: "at", type: "timestamptz", nullable: true, identity: false, default: "now" },
        { name: "token", type: "uuid", nullable: false, identity: false, default: "uuid" },
      ],
    });
    expect(inputs.at(-1)).not.toHaveProperty("primaryKey");
  });

  it("answers null for an absent database and throws the table refusals it is given with their code", async () => {
    const absent = tablesBinding(() => ({ status: "absent" }));
    const absentPort = createProjectDatabaseEventsPort(
      absent.binding,
      admissionOf().admission,
      CLOCK,
    );
    const request = parseDatabaseTableCreateRequest({
      table: "orders",
      columns: [{ name: "id", type: "bigint" }],
    });
    expect(await absentPort.createTable({ ...SCOPE, request })).toBeNull();

    for (const code of ["table_conflict", "table_limit", "pending"]) {
      const { binding } = tablesBinding(() => ({ status: "rejected", code }));
      const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);
      await expect(port.createTable({ ...SCOPE, request })).rejects.toBeInstanceOf(
        ProjectDatabaseEventsError,
      );
      await expect(port.createTable({ ...SCOPE, request })).rejects.toMatchObject({ code });
    }

    const watchCode = tablesBinding(() => ({ status: "rejected", code: "watch_limit" }));
    const strict = createProjectDatabaseEventsPort(
      watchCode.binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(strict.createTable({ ...SCOPE, request })).rejects.toThrow(TypeError);
  });

  it("refuses a create that the budget admission does not admit, before the binding is touched, with the Core's reason", async () => {
    for (const code of ["project_budget_exceeded", "insufficient_organization_credits"]) {
      const { binding, inputs } = tablesBinding();
      const port = createProjectDatabaseEventsPort(
        binding,
        admissionOf({ status: "rejected", code }).admission,
        CLOCK,
      );
      const request = parseDatabaseTableCreateRequest({
        table: "orders",
        columns: [{ name: "id", type: "bigint" }],
      });
      await expect(port.createTable({ ...SCOPE, request })).rejects.toMatchObject({ code });
      expect(inputs).toEqual([]);
    }
  });

  it("answers null for a scope the Core does not know and asks exactly the admission question", async () => {
    const unknown = admissionOf({ status: "rejected", code: "organization_credit_scope_missing" });
    const { binding, inputs } = tablesBinding();
    const port = createProjectDatabaseEventsPort(binding, unknown.admission, CLOCK);
    const request = parseDatabaseTableCreateRequest({
      table: "orders",
      columns: [{ name: "id", type: "bigint" }],
    });
    await expect(port.createTable({ ...SCOPE, request })).resolves.toBeNull();
    expect(inputs).toEqual([]);
    expect(unknown.questions).toEqual([
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
    ]);
  });

  it("refuses an answer about another table or environment, or with an extra key", async () => {
    const request = parseDatabaseTableCreateRequest({
      table: "orders",
      columns: [{ name: "id", type: "bigint" }],
    });
    const other = createProjectDatabaseEventsPort(
      tablesBinding(() => ok({ table: { ...TABLE, table: "invoices" }, created: true })).binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(other.createTable({ ...SCOPE, request })).rejects.toThrow(TypeError);

    const extra = createProjectDatabaseEventsPort(
      tablesBinding(() => ok({ table: TABLE, created: true, secret: "x" })).binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(extra.createTable({ ...SCOPE, request })).rejects.toThrow(TypeError);
  });

  it("answers 201 with the table and no-store for a new table, and the RPC carries the exact fields", async () => {
    const { app, inputs } = appWith();
    const response = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(CREATED_BODY);
    expect(inputs.at(-1)).toEqual({
      operation: "table.create",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      table: "orders",
      columns: [
        { name: "id", type: "bigint", nullable: false, identity: true },
        { name: "total", type: "numeric", nullable: true, identity: false },
      ],
      primaryKey: ["id"],
    });
  });

  it("answers 200 for an identical table that already exists", async () => {
    const { app } = appWith(created(false));
    const response = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REPEATED_BODY);
  });

  it("repeats an identical request with the same key by asking the boundary again and answering its answer", async () => {
    const { app, inputs } = appWith(created(false));
    const first = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    const replay = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(replay.status).toBe(first.status);
    expect(await replay.json()).toEqual(await first.clone().json());
    expect(inputs.map((input) => input["operation"])).toEqual(["table.create", "table.create"]);
  });

  it("answers 409 with the policy text for a table that exists with another definition, and for the table limit", async () => {
    const cases: Array<[string, string]> = [
      ["table_conflict", "The table already exists with another definition in this database."],
      [
        "table_limit",
        "This database already holds the maximum number of tables in its public schema.",
      ],
    ];
    for (const [rejection, detail] of cases) {
      const { app } = appWith(() => ({ status: "rejected", code: rejection }));
      const response = await app.request(PATH, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify(createBody),
      });
      const code = `database_${rejection}`;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code,
        retryable: false,
        detail,
        title: PROBLEM_POLICY[code as keyof typeof PROBLEM_POLICY].title,
        suggested_action: PROBLEM_POLICY[code as keyof typeof PROBLEM_POLICY].action,
      });
    }
  });

  it("answers 503 with a neutral retryable unavailable for a pending create", async () => {
    const { app } = appWith(() => ({ status: "rejected", code: "pending" }));
    const response = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
      retryable: true,
      detail: "The database event request is still being processed. Retry shortly.",
    });
  });

  it("answers 402 with the Core's reason while the stop budget is reached, and the binding is never touched", async () => {
    const reached = admissionOf({ status: "rejected", code: "project_budget_exceeded" });
    const { app, inputs } = appWith(created(true), reached.admission);
    const response = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "project_budget_exceeded" });
    expect(inputs).toEqual([]);
  });

  it("refuses a create without an Idempotency-Key or with an invalid one before the boundary", async () => {
    const { app, inputs } = appWith();
    const body = JSON.stringify(createBody);
    const missing = await app.request(PATH, { method: "POST", headers: JSON_HEADERS, body });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "invalid_request" });

    const tooLong = await app.request(PATH, {
      method: "POST",
      headers: { ...JSON_HEADERS, "Idempotency-Key": "k".repeat(129) },
      body,
    });
    expect(tooLong.status).toBe(400);
    expect(inputs).toEqual([]);
  });

  it("refuses every malformed create before the boundary", async () => {
    const { app, inputs } = appWith();
    const valid = { ...createBody };
    const cases: Array<{ path: string; body: string }> = [
      { path: "?environment=dev", body: JSON.stringify(valid) },
      {
        path: "",
        body: JSON.stringify({ table: "orders", columns: [{ name: "id", type: "bigint" }] }),
      },
      { path: "", body: JSON.stringify({ ...valid, environment: "staging" }) },
      { path: "", body: JSON.stringify({ ...valid, role: "app" }) },
      { path: "", body: JSON.stringify({ ...valid, project_id: "p" }) },
      { path: "", body: JSON.stringify({ ...valid, primaryKey: ["id"] }) },
      { path: "", body: JSON.stringify({ ...valid, schema: "pgcf" }) },
      { path: "", body: JSON.stringify({ ...valid, table: "Orders" }) },
      { path: "", body: JSON.stringify({ ...valid, table: "select" }) },
      { path: "", body: JSON.stringify({ ...valid, table: "pg_orders" }) },
      { path: "", body: JSON.stringify({ ...valid, columns: [] }) },
      {
        path: "",
        body: JSON.stringify({
          ...valid,
          columns: Array.from({ length: 65 }, (_, index) => ({ name: `c${index}`, type: "text" })),
        }),
      },
      {
        path: "",
        body: JSON.stringify({
          ...valid,
          columns: [{ name: "id", type: "bigint", extra: true }],
        }),
      },
      {
        path: "",
        body: JSON.stringify({ ...valid, columns: [{ name: "id", type: "serial" }] }),
      },
      {
        path: "",
        body: JSON.stringify({
          ...valid,
          columns: [{ name: "id", type: "bigint", identity: true, default: "now" }],
        }),
      },
      {
        path: "",
        body: JSON.stringify({ ...valid, columns: [{ name: "at", type: "text", default: "now" }] }),
      },
      { path: "", body: JSON.stringify({ ...valid, primary_key: [] }) },
      { path: "", body: JSON.stringify({ ...valid, primary_key: ["missing"] }) },
      { path: "", body: "[]" },
    ];
    for (const item of cases) {
      const response = await app.request(`${PATH}${item.path}`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: item.body,
      });
      expect(response.status, item.body).toBe(400);
    }
    expect(inputs).toEqual([]);
  });

  it("hides a denied project behind not found without touching the binding", async () => {
    const { app, inputs } = appWith(created(true), admissionOf().admission, {
      authorization: { check: async () => "deny" as const },
    });
    const response = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(404);
    expect(inputs).toEqual([]);
  });

  it("reports a boundary answer about another table under the template route label", async () => {
    const { app, reported } = appWith(() =>
      ok({ table: { ...TABLE, table: "invoices" }, created: true }),
    );
    const response = await app.request(PATH, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(503);
    expect(reported.at(-1)).toEqual({
      code: "PRODUCT_SURFACE_UNAVAILABLE",
      route: "/v1/projects/{project_id}/database/tables",
    });
  });
});

function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  return {
    authentication: {
      authenticate: async () => ({
        actorId: "user:user_1",
        credentialId: "workos_session:session_1",
        authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
        organizationIds: [ORGANIZATION_ID],
      }),
    },
    authorization: { check: async () => "allow" },
    persistence: {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      listProjects: async () => ({ projects: [], nextCursor: null }),
      takenProjectHandles: async () => new Set<string>(),
      createProject: async () => {
        throw new Error("unused");
      },
      getProject: async (organizationId, projectId) => ({
        dataMode: "isolated" as const,
        region: "us" as const,
        organizationId,
        projectId,
        name: "fixture",
        handle: "calm-otter-waves",
        createdAt: NOW,
      }),
      getOperation: async () => null,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    devAccessTickets: {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: CLOCK,
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_database_tables",
    ...overrides,
  };
}
