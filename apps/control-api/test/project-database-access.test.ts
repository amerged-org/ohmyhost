import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createControlApi,
  createD1ProjectDatabaseAccessPort,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  createUnavailableProviderReconciliationPort,
  type ControlApiDependencies,
  type ProjectDatabaseAccessBinding,
} from "../src/index.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const EVENT_ID = parseUlid("00000000000000000000000003");
const ACCESS_ID = parseUlid("01M2K0000000000000000000A1");
const DATA_ENVIRONMENT_ID = parseUlid("01M2K0000000000000000000D1");
const NOW = "2026-09-15T10:00:00.000Z";
const EXPIRES_AT = "2026-09-15T11:00:00.000Z";
const ROLE_NAME = `ohmyho_da_${DATA_ENVIRONMENT_ID.toLowerCase()}_a1b2c3d4`;
const DATABASE = "abcdefghijklmnopqrst";
const HOST = `${DATABASE}.db.example.com`;
const PASSWORD = "9".repeat(64);
const CONNECTION_URI = `postgresql://${ROLE_NAME}:${PASSWORD}@${HOST}/${DATABASE}?sslmode=require`;

const ACCESS = Object.freeze({
  access_id: ACCESS_ID,
  environment: "dev" as const,
  mode: "read" as const,
  role_name: ROLE_NAME,
  provider: "pgcf" as const,
  transport: "wss" as const,
  websocket_url: `wss://${HOST}/`,
  host: HOST,
  database: DATABASE,
  label: "laptop",
  state: "active" as const,
  issued_at: NOW,
  expires_at: EXPIRES_AT,
  revoked_at: null,
  revocation_reason: null,
});
const CREDENTIAL = Object.freeze({
  ...ACCESS,
  connection_uri: CONNECTION_URI,
  psql_command: `ohmyhost database psql --project ${PROJECT_ID} --environment dev --mode read`,
});
describe("Control API project database access", () => {
  it("uses the closed D1 history port with the original product checks and no SQL configuration", async () => {
    const readProjectDatabaseAccessHistory = vi.fn(async () => ({ items: [ACCESS] }));
    const selected = createD1ProjectDatabaseAccessPort(
      { issueDatabaseAccess: async () => CREDENTIAL, revokeDatabaseAccess: async () => ACCESS },
      { readProjectDatabaseAccessHistory },
      { now: () => new Date(NOW) },
    );
    expect(
      await selected.list({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environment: "dev",
        principalId: "user:fixture",
        requestId: "request",
      }),
    ).toEqual({ items: [ACCESS] });
    expect(readProjectDatabaseAccessHistory).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      now: NOW,
    });
    expect(
      await selected.list({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        principalId: "user:fixture",
        requestId: "request",
      }),
    ).toEqual({ items: [ACCESS] });
    expect(readProjectDatabaseAccessHistory).toHaveBeenLastCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      now: NOW,
    });
  });
  it("issues one credential without caching it and forwards the exact request", async () => {
    const issueDatabaseAccess = vi.fn(async () => ({ ...CREDENTIAL }));
    const authorization = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        projectDatabaseAccess: port({ issueDatabaseAccess }),
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "access-key-0001",
        },
        body: JSON.stringify({ environment: "dev", label: "laptop" }),
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({ ...CREDENTIAL });
    expect(issueDatabaseAccess).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      requestId: "req_database_access",
      environment: "dev",
      mode: "read",
      ttlSeconds: 3600,
      label: "laptop",
    });
    expect(authorization).toHaveBeenCalledWith(
      expect.objectContaining({ action: "projects:write" }),
    );
  });

  it("accepts the exact PGCF credential/history/revocation contract on public routes and still rejects malformed transport metadata", async () => {
    const access = ACCESS,
      credential = CREDENTIAL;
    const revoked = {
      ...access,
      state: "revoked" as const,
      revoked_at: EXPIRES_AT,
      revocation_reason: "principal" as const,
    };
    const app = createControlApi(
      dependencies({
        projectDatabaseAccess: port(
          {
            issueDatabaseAccess: async () => credential,
            revokeDatabaseAccess: async () => revoked,
          },
          fakeHistory([access]).runtime,
        ),
      }),
    );
    const path = `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
      headers = {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "access-key-0001",
      };
    const issue = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ environment: "dev" }),
    });
    expect(issue.status).toBe(201);
    expect(issue.headers.get("Cache-Control")).toBe("no-store");
    expect(await issue.json()).toEqual(credential);
    const history = await app.request(path, { headers });
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({ items: [access] });
    const revoke = await app.request(path + "/" + ACCESS_ID, { method: "DELETE", headers });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual(revoked);
    for (const malformed of [
      { ...credential, transport: "tcp" },
      { ...credential, websocket_url: "wss://foreign.example.com/" },
      { ...credential, password: PASSWORD },
    ]) {
      const unsafe = createControlApi(
        dependencies({
          projectDatabaseAccess: port({ issueDatabaseAccess: async () => malformed }),
        }),
      );
      const result = await unsafe.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ environment: "dev" }),
      });
      expect(result.status).toBe(503);
      expect(await result.text()).not.toContain(PASSWORD);
    }
  });

  it("rejects an invalid lifetime before the management boundary is reached", async () => {
    const issueDatabaseAccess = vi.fn(async () => ({ ...CREDENTIAL }));
    const app = createControlApi(
      dependencies({ projectDatabaseAccess: port({ issueDatabaseAccess }) }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "access-key-0001",
        },
        body: JSON.stringify({ environment: "dev", ttl_seconds: 120 }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(issueDatabaseAccess).not.toHaveBeenCalled();
  });

  it("hides a denied project and a foreign scope behind the same not-found answer", async () => {
    const denied = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" as const },
        projectDatabaseAccess: port({
          issueDatabaseAccess: async () => {
            throw new Error("Unexpected issuance for a denied project");
          },
        }),
      }),
    );
    const deniedResponse = await denied.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "access-key-0001",
        },
        body: JSON.stringify({ environment: "prod" }),
      },
    );
    expect(deniedResponse.status).toBe(404);
    expect(await deniedResponse.json()).toMatchObject({ code: "resource_not_found" });

    const scoped = createControlApi(
      dependencies({
        projectDatabaseAccess: port({
          issueDatabaseAccess: async () => ({ status: "rejected", code: "scope" }),
        }),
      }),
    );
    const scopedResponse = await scoped.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
          "Idempotency-Key": "access-key-0001",
        },
        body: JSON.stringify({ environment: "prod" }),
      },
    );
    expect(scopedResponse.status).toBe(404);
    expect(await scopedResponse.json()).toMatchObject({ code: "resource_not_found" });
  });

  it("maps the active credential limit and the credit decisions to their public problems", async () => {
    for (const [code, status, problem] of [
      ["limit", 409, "database_access_limit"],
      ["insufficient_organization_credits", 402, "insufficient_organization_credits"],
      ["project_budget_exceeded", 402, "project_budget_exceeded"],
      // A suspended database answers its Paid requirement, which a retry cannot clear, rather than a retryable outage.
      ["paid_plan_required", 402, "paid_plan_required"],
    ] as const) {
      const app = createControlApi(
        dependencies({
          projectDatabaseAccess: port({
            issueDatabaseAccess: async () => ({ status: "rejected", code }),
          }),
        }),
      );
      const response = await app.request(
        `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            "Idempotency-Key": "access-key-0001",
          },
          body: JSON.stringify({ environment: "dev", mode: "write", ttl_seconds: 900 }),
        },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code: problem, retryable: false });
    }
  });

  it("reports an unavailable or unsafe issuance as 503 without leaking the binding value", async () => {
    for (const value of [
      { status: "rejected", code: "unavailable" },
      { ...CREDENTIAL, password: PASSWORD },
    ]) {
      const app = createControlApi(
        dependencies({
          projectDatabaseAccess: port({ issueDatabaseAccess: async () => value }),
        }),
      );
      const response = await app.request(
        `https://api.test/v1/projects/${PROJECT_ID}/database/access`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer valid",
            "Content-Type": "application/json",
            "Idempotency-Key": "access-key-0001",
          },
          body: JSON.stringify({ environment: "dev" }),
        },
      );
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ code: "service_unavailable", retryable: true });
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain(ROLE_NAME);
    }
  });

  it("lists the stored credentials from the Core without any connection URI", async () => {
    const control = fakeHistory([ACCESS]);
    const app = createControlApi(
      dependencies({
        projectDatabaseAccess: port({}, control.runtime),
        authorization: { check: async () => "allow" as const },
      }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access?environment=dev`,
      { headers: { Authorization: "Bearer valid" } },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ items: [{ ...ACCESS }] });
    expect(body).not.toContain("connection_uri");
    expect(body).not.toContain("user:user_1");
    expect(control.inputs.at(-1)).toMatchObject({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
    });

    const unknownQuery = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access?state=active`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(unknownQuery.status).toBe(400);
    expect(await unknownQuery.json()).toMatchObject({ code: "invalid_request" });
  });

  it("revokes one credential by identity and answers an unknown one with not found", async () => {
    const revoked = {
      ...ACCESS,
      state: "revoked" as const,
      revoked_at: EXPIRES_AT,
      revocation_reason: "principal" as const,
    };
    const revokeDatabaseAccess = vi.fn(async () => revoked);
    const app = createControlApi(
      dependencies({ projectDatabaseAccess: port({ revokeDatabaseAccess }) }),
    );

    const response = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access/${ACCESS_ID}`,
      { method: "DELETE", headers: { Authorization: "Bearer valid" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(revoked);
    expect(revokeDatabaseAccess).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      accessId: ACCESS_ID,
    });

    const missing = createControlApi(
      dependencies({
        projectDatabaseAccess: port({
          revokeDatabaseAccess: async () => ({ status: "rejected", code: "not_found" }),
        }),
      }),
    );
    const missingResponse = await missing.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access/${ACCESS_ID}`,
      { method: "DELETE", headers: { Authorization: "Bearer valid" } },
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ code: "resource_not_found" });

    const invalid = await app.request(
      `https://api.test/v1/projects/${PROJECT_ID}/database/access/not-a-ulid`,
      { method: "DELETE", headers: { Authorization: "Bearer valid" } },
    );
    expect(invalid.status).toBe(400);
  });
});

function port(
  overrides: Partial<ProjectDatabaseAccessBinding>,
  runtime: Parameters<typeof createD1ProjectDatabaseAccessPort>[1] = fakeHistory([]).runtime,
): ReturnType<typeof createD1ProjectDatabaseAccessPort> {
  const binding: ProjectDatabaseAccessBinding = {
    issueDatabaseAccess: async () => {
      throw new Error("Unexpected issuance");
    },
    revokeDatabaseAccess: async () => {
      throw new Error("Unexpected revocation");
    },
    ...overrides,
  };
  return createD1ProjectDatabaseAccessPort(binding, runtime, { now: () => new Date(NOW) });
}

function fakeHistory(items: readonly Record<string, unknown>[]): {
  runtime: Parameters<typeof createD1ProjectDatabaseAccessPort>[1];
  inputs: unknown[];
} {
  const inputs: unknown[] = [];
  return {
    runtime: {
      readProjectDatabaseAccessHistory: async (input) => {
        inputs.push(input);
        return { items } as never;
      },
    },
    inputs,
  };
}

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
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_database_access",
    ...overrides,
  };
}

describe("the idempotency of a database credential issuance", () => {
  it("issues a credential without an Idempotency-Key, and a repeated request is not replayed", async () => {
    const issueDatabaseAccess = vi.fn(async () => ({ ...CREDENTIAL }));
    const app = createControlApi(
      dependencies({ projectDatabaseAccess: port({ issueDatabaseAccess }) }),
    );
    const path = `https://api.test/v1/projects/${PROJECT_ID}/database/access`;
    const body = JSON.stringify({ environment: "dev", label: "laptop" });
    const withoutKey = await app.request(path, {
      method: "POST",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body,
    });
    expect(withoutKey.status).toBe(201);
    const repeated = await app.request(path, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "access-key-0001",
      },
      body,
    });
    expect(repeated.status).toBe(201);
    expect(issueDatabaseAccess).toHaveBeenCalledTimes(2);
  });
});
