import { parseUlid, type AuthorizationCheck, type Operation } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createControlApi,
  createUnavailableProviderReconciliationPort,
  createUnavailableProductSurfacePort,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
} from "../src/index.js";
import { problem } from "../src/app.js";
import { operationDeploymentResultFixture } from "./operation-result.fixture.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const OPERATION_ID = parseUlid("00000000000000000000000003");
const EVENT_ID = parseUlid("00000000000000000000000004");
const STARTED_EVENT_ID = parseUlid("00000000000000000000000005");
const FAILED_EVENT_ID = parseUlid("00000000000000000000000006");
const FOREIGN_PROJECT_ID = parseUlid("00000000000000000000000007");
const FOREIGN_OPERATION_ID = parseUlid("00000000000000000000000008");
const FOREIGN_ORGANIZATION_ID = parseUlid("00000000000000000000000009");
const NOW = "2026-08-18T12:00:00.000Z";
const STARTED_AT = "2026-08-18T12:00:01.000Z";
const FAILED_AT = "2026-08-18T12:00:02.000Z";
const DEPLOYMENT_ID = parseUlid("0000000000000000000000000A");
const PLAN_ID = parseUlid("0000000000000000000000000B");

describe("Control API failure and admission boundaries", () => {
  it("builds a problem only with the status its policy declares", () => {
    expect(problem("request", 404, "resource_not_found", "Resource not found.").status).toBe(404);
    // The compiler refuses a status the policy does not declare; the run-time guard covers dynamic codes.
    // @ts-expect-error resource_not_found is declared with 404 only
    expect(() => problem("request", 400, "resource_not_found", "Resource not found.")).toThrow(
      TypeError,
    );
  });

  it("returns only the canonical result of a succeeded operation", async () => {
    const result = operationDeploymentResultFixture({
      operationId: OPERATION_ID,
      deploymentId: DEPLOYMENT_ID,
      planId: PLAN_ID,
    });
    const operation = succeededOperation(result);
    const app = createControlApi(dependencies({ operation }));

    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      id: OPERATION_ID,
      state: "succeeded",
      created_at: NOW,
      updated_at: FAILED_AT,
      result,
    });
  });

  it("fails closed without leaking a credential-bearing operation result", async () => {
    const credentialCanary = "Bearer credential-canary-abcdefghijklmnopqrstuvwxyz";
    const invalidResult = {
      ...operationDeploymentResultFixture({
        operationId: OPERATION_ID,
        deploymentId: DEPLOYMENT_ID,
        planId: PLAN_ID,
      }),
      providerToken: credentialCanary,
    };
    const app = createControlApi(dependencies({ operation: succeededOperation(invalidResult) }));

    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });
    const responseText = await response.text();

    expect(response.status, responseText).toBe(503);
    expect(JSON.parse(responseText)).toMatchObject({ code: "service_unavailable" });
    expect(responseText).not.toContain(credentialCanary);
    expect(responseText).not.toContain("providerToken");
  });

  it.each([
    ["PROVIDER_FAILURE", "operation_failed", "The operation failed."],
    ["BUILD_NOT_STARTED", "build_not_started", "The deployment ended without starting a build."],
    ["BUILD_FAILED", "build_failed", "The build did not produce a verified deployable artifact."],
  ])(
    "returns a safe actionable %s failure in operation JSON and SSE",
    async (internalCode, code, message) => {
      const secretCanary = "provider-secret-canary";
      const operation: Operation = {
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        state: "failed",
        createdAt: NOW,
        updatedAt: FAILED_AT,
        failure: { code: internalCode, message: secretCanary },
        events: [
          {
            eventId: EVENT_ID,
            type: "OperationQueued",
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: NOW,
          },
          {
            eventId: STARTED_EVENT_ID,
            type: "OperationStarted",
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: STARTED_AT,
            idempotencyKey: "transition-1",
          },
          {
            eventId: FAILED_EVENT_ID,
            type: "OperationFailed",
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: FAILED_AT,
            idempotencyKey: "transition-2",
            failure: { code: internalCode, message: secretCanary },
          },
        ],
      };
      const app = createControlApi(dependencies({ operation }));

      const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
        headers: { Authorization: "Bearer valid" },
      });
      const stream = await app.request(`https://api.test/v1/operations/${OPERATION_ID}/events`, {
        headers: { Authorization: "Bearer valid" },
      });

      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).not.toContain(secretCanary);
      expect(JSON.parse(responseText)).toMatchObject({
        id: OPERATION_ID,
        state: "failed",
        created_at: NOW,
        updated_at: FAILED_AT,
        error: {
          code,
          message,
          retryable: false,
          suggested_action: expect.any(String),
        },
      });
      const reader = stream.body?.getReader();
      if (reader === undefined) throw new Error("Expected an operation event stream");
      let streamed = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += new TextDecoder().decode(chunk.value);
      }
      expect(streamed).toContain("event: OperationFailed");
      expect(streamed).not.toContain(secretCanary);
      expect(streamed).toContain(JSON.stringify(JSON.parse(responseText).error));
    },
  );

  it.each(["revoked", "expired", "unavailable"] as const)(
    "terminates a live event stream on the next %s session revalidation",
    async (outcome) => {
      const queued: Operation = {
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        state: "queued",
        createdAt: NOW,
        updatedAt: NOW,
        events: [
          {
            eventId: EVENT_ID,
            type: "OperationQueued",
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            occurredAt: NOW,
          },
        ],
      };
      let authenticationCount = 0;
      const app = createControlApi(
        dependencies({
          operation: queued,
          authentication: {
            authenticate: async () => {
              authenticationCount += 1;
              if (authenticationCount === 1) {
                return {
                  actorId: "user:user_1",
                  credentialId: "workos_session:session_1",
                  authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
                  organizationIds: [ORGANIZATION_ID],
                };
              }
              if (outcome === "unavailable") throw new Error("private status unavailable");
              return null;
            },
          },
        }),
      );
      vi.useFakeTimers();
      try {
        const response = await app.request(
          `https://api.test/v1/operations/${OPERATION_ID}/events`,
          { headers: { Authorization: "Bearer expiring" } },
        );
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error("Expected an operation event stream");

        expect((await reader.read()).done).toBe(false);
        // Session access is revalidated every fifteen seconds, so the stream ends at the next refresh.
        const next = reader.read();
        await vi.advanceTimersByTimeAsync(15_500);
        expect((await next).done).toBe(true);
        expect(authenticationCount).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    },
    5_000,
  );

  it("cancels a live SSE reader without polling further persistence", async () => {
    const queued = queuedOperation(OPERATION_ID, PROJECT_ID);
    const getOperation = vi.fn(async () => queued);
    const app = createControlApi(dependencies({ operation: queued, getOperation }));
    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}/events`, {
      headers: { Authorization: "Bearer valid" },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected an operation event stream");

    expect((await reader.read()).done).toBe(false);
    await reader.cancel("consumer closed");
    expect(getOperation).toHaveBeenCalledOnce();
  });

  it("returns 429 with Retry-After before authentication or persistence", async () => {
    const getProject = vi.fn();
    const app = createControlApi(
      dependencies({
        getProject,
        rateLimits: {
          consume: async ({ dimension }) =>
            dimension === "application"
              ? { allowed: false, retryAfterSeconds: 7 }
              : { allowed: true },
        },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}`);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toMatchObject({ code: "rate_limited", retry_after_seconds: 7 });
    expect(getProject).not.toHaveBeenCalled();
  });

  it("charges tenant buckets only for principals that pass membership or visibility", async () => {
    const consumed: string[] = [];
    const rateLimits = {
      consume: async ({ dimension, key }: { readonly dimension: string; readonly key: string }) => {
        consumed.push(`${dimension}:${key}`);
        return { allowed: true as const };
      },
    };
    const createProject = vi.fn();
    const createApp = createControlApi(
      dependencies({
        createProject,
        rateLimits,
        authorization: { check: async () => "allow" },
      }),
    );
    const created = await createApp.request("https://api.test/v1/projects", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "foreign-organization",
      },
      body: JSON.stringify({ organization_id: FOREIGN_ORGANIZATION_ID, name: "foreign" }),
    });
    expect(created.status).toBe(403);
    expect(createProject).not.toHaveBeenCalled();
    expect(consumed).not.toContain(`organization:${FOREIGN_ORGANIZATION_ID}`);

    consumed.length = 0;
    const getApp = createControlApi(
      dependencies({
        rateLimits,
        getProject: async () => null,
        authorization: { check: async () => "deny" },
      }),
    );
    const read = await getApp.request(`https://api.test/v1/projects/${FOREIGN_PROJECT_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });
    expect(read.status).toBe(404);
    expect(consumed).not.toContain(`project:${FOREIGN_PROJECT_ID}`);

    consumed.length = 0;
    const auditApp = createControlApi(
      dependencies({
        rateLimits,
        authorization: {
          check: async ({ resource }) => (resource.kind === "project" ? "deny" : "allow"),
        },
      }),
    );
    const audit = await auditApp.request(
      `https://api.test/v1/audit-events?organization_id=${ORGANIZATION_ID}&project_id=${FOREIGN_PROJECT_ID}`,
      { headers: { Authorization: "Bearer valid" } },
    );
    expect(audit.status).toBe(404);
    expect(consumed).not.toContain(`project:${FOREIGN_PROJECT_ID}`);
  });

  it("isolates unauthenticated admission by trusted client IP and groups malformed addresses", async () => {
    const admitted = new Set<string>();
    const app = createControlApi(
      dependencies({
        rateLimits: {
          async consume({ dimension, key }) {
            if (dimension !== "application") return { allowed: true };
            if (admitted.has(key)) return { allowed: false, retryAfterSeconds: 7 };
            admitted.add(key);
            return { allowed: true };
          },
        },
      }),
    );
    const status = async (ip: string) =>
      (
        await app.request(`https://api.test/v1/projects/${PROJECT_ID}`, {
          headers: { "CF-Connecting-IP": ip },
        })
      ).status;
    expect(await status("203.0.113.1")).toBe(401);
    expect(await status("203.0.113.1")).toBe(429);
    expect(await status("203.0.113.2")).toBe(401);
    expect(await status("not-an-address")).toBe(401);
    expect(await status("another-invalid-address")).toBe(429);
    expect([...admitted]).toEqual([
      "control-api-test:ip:203.0.113.1",
      "control-api-test:ip:203.0.113.2",
      "control-api-test:ip:unknown",
    ]);
  });

  it("uses stable actor and credential buckets before nonexistent operation lookup", async () => {
    const consumed: { readonly dimension: string; readonly key: string }[] = [];
    const getOperation = vi.fn();
    const app = createControlApi(
      dependencies({
        getOperation,
        rateLimits: {
          async consume(input) {
            consumed.push(input);
            return input.dimension === "credential"
              ? { allowed: false, retryAfterSeconds: 11 }
              : { allowed: true };
          },
        },
      }),
    );

    const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });

    expect(response.status).toBe(429);
    expect(consumed).toEqual([
      { dimension: "application", key: "control-api-test:ip:unknown" },
      { dimension: "actor", key: "user:user_1" },
      { dimension: "credential", key: "workos_session:session_1" },
    ]);
    expect(getOperation).not.toHaveBeenCalled();
  });

  it("returns redacted 503 for authentication infrastructure failure", async () => {
    const app = createControlApi(
      dependencies({
        authentication: {
          authenticate: async () => {
            throw new Error("jwks-secret-canary");
          },
        },
      }),
    );

    const response = await app.request(`https://api.test/v1/projects/${PROJECT_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).not.toContain("jwks-secret-canary");
  });

  it("fails closed on project-scoped authorization outages without an organization pre-check", async () => {
    const authorization = vi.fn(async (check: AuthorizationCheck) => {
      void check;
      throw new Error("authorization-secret-canary");
    });
    const app = createControlApi(
      dependencies({
        authorization: { check: authorization },
        getProject: vi.fn(async () => ({
          projectId: PROJECT_ID,
          organizationId: ORGANIZATION_ID,
          name: "private",
          handle: "quiet-moles-sing",
          dataMode: "shared" as const,
          region: "us" as const,
          createdAt: NOW,
        })),
        operation: queuedOperation(OPERATION_ID, PROJECT_ID),
      }),
    );

    const project = await app.request(`https://api.test/v1/projects/${PROJECT_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });
    const operation = await app.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
      headers: { Authorization: "Bearer valid" },
    });

    expect(project.status).toBe(503);
    expect(operation.status).toBe(503);
    expect(await project.text()).not.toContain("authorization-secret-canary");
    expect(await operation.text()).not.toContain("authorization-secret-canary");
    expect(authorization).toHaveBeenCalledTimes(2);
    expect(authorization.mock.calls.every(([check]) => check.resource.kind === "project")).toBe(
      true,
    );
  });

  it("enforces an API-key scope ceiling before project persistence", async () => {
    const createProject = vi.fn();
    const app = createControlApi(
      dependencies({
        createProject,
        authentication: {
          authenticate: async () => ({
            actorId: "api_key:00000000000000000000000009",
            credentialId: "api_key:00000000000000000000000009",
            authorizationPrincipal: {
              kind: "organization_api_key",
              subjectId: "api_key:00000000000000000000000009",
            },
            organizationIds: [ORGANIZATION_ID],
            authorizationScopeConstraint: ["projects:read"],
          }),
        },
      }),
    );

    const response = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers: {
        Authorization: "Bearer api-key",
        "Content-Type": "application/json",
        "Idempotency-Key": "scope-denied",
      },
      body: JSON.stringify({ organization_id: ORGANIZATION_ID, name: "denied" }),
    });

    expect(response.status).toBe(403);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("fails closed when persistence returns a project, operation, or audit outside request scope", async () => {
    const foreignOperation = queuedOperation(FOREIGN_OPERATION_ID, FOREIGN_PROJECT_ID);
    const projectApp = createControlApi(
      dependencies({
        getProject: vi.fn(async () => ({
          projectId: FOREIGN_PROJECT_ID,
          organizationId: FOREIGN_ORGANIZATION_ID,
          name: "foreign",
          handle: "gentle-birds-sing",
          dataMode: "shared" as const,
          region: "us" as const,
          createdAt: NOW,
        })),
      }),
    );
    const operationApp = createControlApi(
      dependencies({ getOperation: vi.fn(async () => foreignOperation) }),
    );
    const auditApp = createControlApi(
      dependencies({
        readAuditEvents: vi.fn(async () => ({
          events: [
            {
              eventId: EVENT_ID,
              organizationId: FOREIGN_ORGANIZATION_ID,
              projectId: FOREIGN_PROJECT_ID,
              operationId: FOREIGN_OPERATION_ID,
              eventType: "ProjectCreated",
              actorType: "user",
              actorId: "user:foreign",
              summary: "foreign event",
              occurredAt: NOW,
            },
          ],
          nextCursor: null,
        })),
      }),
    );

    const [project, operation, audit] = await Promise.all([
      projectApp.request(`https://api.test/v1/projects/${PROJECT_ID}`, {
        headers: { Authorization: "Bearer valid" },
      }),
      operationApp.request(`https://api.test/v1/operations/${OPERATION_ID}`, {
        headers: { Authorization: "Bearer valid" },
      }),
      auditApp.request("https://api.test/v1/audit-events", {
        headers: { Authorization: "Bearer valid" },
      }),
    ]);

    for (const response of [project, operation, audit]) {
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(text).not.toContain(FOREIGN_PROJECT_ID);
      expect(text).not.toContain(FOREIGN_OPERATION_ID);
      expect(text).not.toContain(FOREIGN_ORGANIZATION_ID);
    }
  });

  it("terminates and reports when an SSE refresh changes operation scope", async () => {
    const initial = queuedOperation(OPERATION_ID, PROJECT_ID);
    const foreign = queuedOperation(FOREIGN_OPERATION_ID, FOREIGN_PROJECT_ID);
    let reads = 0;
    const reports: string[] = [];
    const app = createControlApi(
      dependencies({
        getOperation: vi.fn(async () => {
          reads += 1;
          return reads === 1 ? initial : foreign;
        }),
        reporter: {
          report: ({ code }) => {
            reports.push(code);
          },
        },
      }),
    );
    vi.useFakeTimers();
    try {
      const response = await app.request(`https://api.test/v1/operations/${OPERATION_ID}/events`, {
        headers: { Authorization: "Bearer valid" },
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Expected an operation event stream");

      expect((await reader.read()).done).toBe(false);
      // The scope change is seen at the next fifteen-second refresh.
      const failed = expect(reader.read()).rejects.toThrow("Operation event stream failed");
      await vi.advanceTimersByTimeAsync(15_500);
      await failed;
      expect(reports).toContain("OPERATION_STREAM_FAILED");
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it("rejects encoded and oversized bodies before project persistence", async () => {
    const createProject = vi.fn();
    const app = createControlApi(dependencies({ createProject }));
    const headers = {
      Authorization: "Bearer valid",
      "Content-Type": "application/json",
      "Idempotency-Key": "bounded-body",
    };

    const encoded = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers: { ...headers, "Content-Encoding": "gzip" },
      body: "not-really-gzip",
    });
    const oversized = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ organization_id: ORGANIZATION_ID, name: "x".repeat(70_000) }),
    });
    const duplicate = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers,
      body: `{"organization_id":"${ORGANIZATION_ID}","name":"first","name":"second"}`,
    });
    const loneSurrogate = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers,
      body: `{"organization_id":"${ORGANIZATION_ID}","name":"\\ud800"}`,
    });
    const escapedDuplicate = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers,
      body: `{"organization_id":"${ORGANIZATION_ID}","name":"first","na\\u006de":"second"}`,
    });
    const arrayBody = await app.request("https://api.test/v1/projects", {
      method: "POST",
      headers,
      body: `["${ORGANIZATION_ID}","name"]`,
    });

    expect(encoded.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(duplicate.status).toBe(400);
    expect(loneSurrogate.status, await loneSurrogate.clone().text()).toBe(400);
    expect(escapedDuplicate.status).toBe(400);
    expect(arrayBody.status).toBe(400);
    expect(createProject).not.toHaveBeenCalled();
  });
});

function dependencies(
  overrides: Partial<ControlApiDependencies> & {
    readonly operation?: Operation;
    readonly getProject?: ControlApiDependencies["persistence"]["getProject"];
    readonly getOperation?: ControlApiDependencies["persistence"]["getOperation"];
    readonly readAuditEvents?: ControlApiDependencies["persistence"]["readAuditEvents"];
    readonly createProject?: ControlApiDependencies["persistence"]["createProject"];
  } = {},
): ControlApiDependencies {
  const operation = overrides.operation ?? null;
  return {
    authentication: overrides.authentication ?? {
      authenticate: async (token) =>
        token === "valid"
          ? {
              actorId: "user:user_1",
              credentialId: "workos_session:session_1",
              authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
              organizationIds: [ORGANIZATION_ID],
            }
          : null,
    },
    authorization: overrides.authorization ?? { check: async () => "allow" },
    persistence: overrides.persistence ?? {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      takenProjectHandles: async () => new Set<string>(),
      createProject:
        overrides.createProject ??
        (async () => {
          throw new Error("unexpected create");
        }),
      getProject: overrides.getProject ?? (async () => null),
      listProjects: async () => ({ projects: [], nextCursor: null }),
      getOperation: overrides.getOperation ?? (async () => operation),
      readAuditEvents:
        overrides.readAuditEvents ?? (async () => ({ events: [], nextCursor: null })),
    },
    productSurface: overrides.productSurface ?? createUnavailableProductSurfacePort(),
    providerReconciliation:
      overrides.providerReconciliation ?? createUnavailableProviderReconciliationPort(),
    environmentSecrets: overrides.environmentSecrets ?? createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: overrides.projectMailDomains ?? createUnavailableProjectMailDomainsPort(),
    devAccessTickets: overrides.devAccessTickets ?? {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(["https://app.ohmyho.st"]),
    applicationId: "control-api-test",
    rateLimits: overrides.rateLimits ?? { consume: async () => ({ allowed: true }) },
    reporter: overrides.reporter ?? { report: () => undefined },
  };
}

function queuedOperation(
  operationId: typeof OPERATION_ID,
  projectId: typeof PROJECT_ID,
): Operation {
  return {
    operationId,
    projectId,
    state: "queued",
    createdAt: NOW,
    updatedAt: NOW,
    events: [
      {
        eventId: EVENT_ID,
        type: "OperationQueued",
        operationId,
        projectId,
        occurredAt: NOW,
      },
    ],
  };
}

function succeededOperation(result: unknown): Operation {
  return {
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    state: "succeeded",
    createdAt: NOW,
    updatedAt: FAILED_AT,
    result,
    events: [
      {
        eventId: EVENT_ID,
        type: "OperationQueued",
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        occurredAt: NOW,
      },
      {
        eventId: STARTED_EVENT_ID,
        type: "OperationStarted",
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        occurredAt: STARTED_AT,
        idempotencyKey: "transition-1",
      },
      {
        eventId: FAILED_EVENT_ID,
        type: "OperationSucceeded",
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        occurredAt: FAILED_AT,
        idempotencyKey: "transition-2",
        result,
      },
    ],
  } as unknown as Operation;
}
