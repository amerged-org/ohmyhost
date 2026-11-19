import { FeedbackPersistenceError } from "@ohmyhost/database";
import { describe, expect, it, vi } from "vitest";

import { createControlApi, type ControlApiDependencies } from "../src/index.js";
import {
  API,
  BEARER,
  ENVIRONMENT_ID,
  EVENT_ID,
  FOREIGN_ORGANIZATION_ID,
  JSON_BEARER,
  OPERATION_ID,
  ORGANIZATION_ID,
  PRINCIPAL,
  PROJECT_ID,
  NOW,
  recordingReporter,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const FEEDBACK_ID = "00000000000000000000000006";
const REPORT = {
  organization_id: ORGANIZATION_ID,
  kind: "issue",
  title: "Deployment does not finish",
  description:
    "Expected a terminal result. Actual: still queued after the documented wait. Reproduce by resuming the original operation.",
  client_version: "cli/0.0.0",
};
const RECEIPT = { id: FEEDBACK_ID, organization_id: ORGANIZATION_ID, submitted_at: NOW };
const STATUS = {
  id: FEEDBACK_ID,
  organization_id: ORGANIZATION_ID,
  submitted_at: NOW,
  status: "received",
  updated_at: NOW,
  history: [],
  next_cursor: null,
};

function submit(
  app: ReturnType<typeof createControlApi>,
  body: unknown,
  headers: Record<string, string> = {},
  path = "/v1/feedback",
) {
  return app.request(`${API}${path}`, {
    method: "POST",
    headers: { ...JSON_BEARER, "Idempotency-Key": "feedback-1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/feedback", () => {
  it("acknowledges a report with a 201 receipt and hands persistence the canonical request", async () => {
    const submitFeedback = vi.fn(async () => RECEIPT);
    const check = vi.fn(async () => "allow" as const);
    const base = routeDependencies();
    const app = createControlApi(
      routeDependencies({
        authorization: { check },
        persistence: { ...base.persistence, submitFeedback },
      }),
    );

    const response = await submit(app, REPORT);

    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).toBe("req_fixture");
    expect(await response.json()).toEqual(RECEIPT);
    expect(submitFeedback).toHaveBeenCalledWith({
      report: REPORT,
      actorId: "user:user_1",
      idempotencyKey: "feedback-1",
      requestSha256: expect.any(Buffer),
    });
    const [{ requestSha256 }] = submitFeedback.mock.calls[0] as unknown as [
      { requestSha256: Buffer },
    ];
    expect(requestSha256).toHaveLength(32);
    expect(check).toHaveBeenCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "feedback:create",
    });

    await submit(app, { ...REPORT, project_id: PROJECT_ID, environment_id: ENVIRONMENT_ID });
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: {
        kind: "project",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
      },
      action: "feedback:create",
    });
    await submit(app, { ...REPORT, project_id: PROJECT_ID });
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "project", organizationId: ORGANIZATION_ID, projectId: PROJECT_ID },
      action: "feedback:create",
    });
  });

  it("derives the replay digest from the report, so a changed report cannot share a key silently", async () => {
    const digests: string[] = [];
    const base = routeDependencies();
    const app = createControlApi(
      routeDependencies({
        persistence: {
          ...base.persistence,
          submitFeedback: async (input) => {
            digests.push(Buffer.from(input.requestSha256).toString("hex"));
            return RECEIPT;
          },
        },
      }),
    );

    await submit(app, REPORT);
    await submit(app, REPORT);
    await submit(app, { ...REPORT, title: "Changed report" });

    expect(digests[0]).toBe(digests[1]);
    expect(digests[2]).not.toBe(digests[0]);
  });

  it("refuses malformed requests before persistence and never echoes the rejected values", async () => {
    const submitFeedback = vi.fn(async () => RECEIPT);
    const base = routeDependencies();
    const app = createControlApi(
      routeDependencies({ persistence: { ...base.persistence, submitFeedback } }),
    );
    const noKey = await app.request(`${API}/v1/feedback`, {
      method: "POST",
      headers: JSON_BEARER,
      body: JSON.stringify(REPORT),
    });
    expect(noKey.status).toBe(400);
    expect((await submit(app, REPORT, { "Idempotency-Key": "not valid!" })).status).toBe(400);
    expect((await submit(app, REPORT, {}, "/v1/feedback?debug=1")).status).toBe(400);
    expect((await submit(app, REPORT, { "X-Request-Id": "r".repeat(129) })).status).toBe(400);
    const notJson = await submit(app, "{", {});
    expect(notJson.status).toBe(400);
    const tooLarge = await submit(app, { ...REPORT, description: "x".repeat(70_000) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "payload_too_large" });

    const refused = await submit(app, {
      ...REPORT,
      kind: "support",
      title: " padded",
      secret_field: "credential-canary",
    });
    expect(refused.status).toBe(400);
    const body = await refused.json();
    expect(body).toMatchObject({ code: "invalid_request", retryable: false });
    expect(body.detail).toMatch(/^Feedback was not accepted: .*Nothing was stored/u);
    expect(body.detail).toContain("kind must be bug, issue or feature_request");
    expect(body.detail).toContain("title must not start or end with whitespace");
    expect(JSON.stringify(body)).not.toMatch(/credential-canary|support/u);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("answers authentication failures with the right status and no persistence call", async () => {
    const submitFeedback = vi.fn(async () => RECEIPT);
    const base = routeDependencies();
    const persistence = { ...base.persistence, submitFeedback };
    const app = createControlApi(routeDependencies({ persistence }));

    const anonymous = await app.request(`${API}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "k" },
      body: JSON.stringify(REPORT),
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" });

    const outage = createControlApi(
      routeDependencies({
        persistence,
        authentication: {
          authenticate: async () => {
            throw new Error("identity provider offline");
          },
        },
      }),
    );
    const unavailable = await submit(outage, REPORT);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "service_unavailable",
      retryable: true,
    });

    let calls = 0;
    const expiring = createControlApi(
      routeDependencies({
        persistence,
        authentication: { authenticate: async () => (++calls === 1 ? PRINCIPAL : null) },
      }),
    );
    expect((await submit(expiring, REPORT)).status).toBe(401);

    let flaky = 0;
    const failing = createControlApi(
      routeDependencies({
        persistence,
        authentication: {
          authenticate: async () => {
            if (++flaky > 1) throw new Error("identity provider offline");
            return PRINCIPAL;
          },
        },
      }),
    );
    expect((await submit(failing, REPORT)).status).toBe(503);

    const internalRevalidate = vi.fn(async () => null);
    const internal = createControlApi(
      routeDependencies({
        persistence,
        internalAuthentication: { resolve: async () => PRINCIPAL, revalidate: internalRevalidate },
      }),
    );
    const revoked = await internal.request(`${API}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "k" },
      body: JSON.stringify(REPORT),
    });
    expect(revoked.status).toBe(401);
    expect(internalRevalidate).toHaveBeenCalledWith(PRINCIPAL);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("keeps foreign workspaces and denied scopes indistinguishable and honours rate limits", async () => {
    const submitFeedback = vi.fn(async () => RECEIPT);
    const base = routeDependencies();
    const persistence = { ...base.persistence, submitFeedback };
    const app = createControlApi(routeDependencies({ persistence }));
    const foreign = await submit(app, { ...REPORT, organization_id: FOREIGN_ORGANIZATION_ID });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: "resource_not_found" });

    const denied = createControlApi(
      routeDependencies({ persistence, authorization: { check: async () => "deny" } }),
    );
    expect((await submit(denied, REPORT)).status).toBe(404);

    const outage = createControlApi(
      routeDependencies({
        persistence,
        authorization: {
          check: async () => {
            throw new Error("authorization offline");
          },
        },
      }),
    );
    const unavailable = await submit(outage, REPORT);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ retryable: true });

    const limited = createControlApi(
      routeDependencies({
        persistence,
        rateLimits: {
          consume: async ({ dimension }) =>
            dimension === "organization"
              ? { allowed: false, retryAfterSeconds: 17 }
              : { allowed: true },
        },
      }),
    );
    const response = await submit(limited, REPORT);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(await response.json()).toMatchObject({ code: "rate_limited", retry_after_seconds: 17 });

    const throttled = createControlApi(
      routeDependencies({
        persistence,
        rateLimits: { consume: async () => ({ allowed: false, retryAfterSeconds: 3 }) },
      }),
    );
    expect((await submit(throttled, REPORT)).status).toBe(429);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("maps durable-store outcomes without leaking their cause", async () => {
    const { reports, reporter } = recordingReporter();
    const failures: unknown[] = [
      new FeedbackPersistenceError("resource_not_found"),
      new FeedbackPersistenceError("idempotency_key_reused"),
      new Error("postgres-private-canary"),
    ];
    const base = routeDependencies();
    const app = createControlApi(
      routeDependencies({
        reporter,
        persistence: {
          ...base.persistence,
          submitFeedback: async () => {
            throw failures.shift();
          },
        },
      }),
    );

    const missing = await submit(app, REPORT);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "resource_not_found" });
    const reused = await submit(app, REPORT);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });
    const unavailable = await submit(app, REPORT);
    const text = await unavailable.text();
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: "service_unavailable", retryable: true });
    expect(text).not.toContain("postgres-private-canary");
    expect(reports).toEqual([
      { requestId: "req_fixture", code: "FEEDBACK_PERSISTENCE_UNAVAILABLE", route: "/v1/feedback" },
    ]);
  });

  it("answers the same way when the failure reporter itself fails", async () => {
    const base = routeDependencies();
    const app = createControlApi(
      routeDependencies({
        reporter: { report: () => Promise.reject(new Error("error sink offline")) },
        persistence: {
          ...base.persistence,
          submitFeedback: async () => {
            throw new Error("store offline");
          },
        },
      }),
    );

    const response = await submit(app, REPORT);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable" });
  });
});

describe("GET /v1/feedback/:feedback_id", () => {
  const read = (
    app: ReturnType<typeof createControlApi>,
    path = `/v1/feedback/${FEEDBACK_ID}`,
    headers: Record<string, string> = {},
  ) => app.request(`${API}${path}`, { headers: { ...BEARER, ...headers } });
  const record = (status: unknown = STATUS, scope: Record<string, unknown> = {}) => ({
    organizationId: ORGANIZATION_ID,
    projectId: null,
    environmentId: null,
    status,
    ...scope,
  });
  const appFor = (
    readFeedbackStatus: ControlApiDependencies["persistence"]["readFeedbackStatus"],
    overrides: Partial<ControlApiDependencies> = {},
  ) => {
    const base = routeDependencies();
    return createControlApi(
      routeDependencies({ persistence: { ...base.persistence, readFeedbackStatus }, ...overrides }),
    );
  };

  it("returns the customer view scoped to the caller's organizations and forwards the cursor", async () => {
    const readFeedbackStatus = vi.fn(async () => record() as never);
    const check = vi.fn(async () => "allow" as const);
    const app = appFor(readFeedbackStatus, { authorization: { check } });

    const first = await read(app);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(await first.json()).toEqual(STATUS);
    expect(readFeedbackStatus).toHaveBeenCalledWith({
      feedbackId: FEEDBACK_ID,
      organizationIds: [ORGANIZATION_ID],
    });
    expect(check).toHaveBeenCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "organization", organizationId: ORGANIZATION_ID },
      action: "feedback:create",
    });

    const cursor = "0000000000000000000000000A";
    expect((await read(app, `/v1/feedback/${FEEDBACK_ID}?cursor=${cursor}`)).status).toBe(200);
    expect(readFeedbackStatus).toHaveBeenLastCalledWith({
      feedbackId: FEEDBACK_ID,
      organizationIds: [ORGANIZATION_ID],
      cursor,
    });
  });

  it("authorizes against the stored project and environment scope of the report", async () => {
    const check = vi.fn(async () => "allow" as const);
    const scoped = appFor(
      async () => record(STATUS, { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID }) as never,
      { authorization: { check } },
    );
    expect((await read(scoped)).status).toBe(200);
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: {
        kind: "project",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
      },
      action: "feedback:create",
    });
    const projectOnly = appFor(async () => record(STATUS, { projectId: PROJECT_ID }) as never, {
      authorization: { check },
    });
    expect((await read(projectOnly)).status).toBe(200);
    expect(check).toHaveBeenLastCalledWith({
      principal: PRINCIPAL.authorizationPrincipal,
      resource: { kind: "project", organizationId: ORGANIZATION_ID, projectId: PROJECT_ID },
      action: "feedback:create",
    });
  });

  it("rejects malformed identifiers and unsupported query parameters", async () => {
    const readFeedbackStatus = vi.fn(async () => record() as never);
    const app = appFor(readFeedbackStatus);
    for (const path of [
      "/v1/feedback/not-a-ulid",
      `/v1/feedback/${FEEDBACK_ID}?cursor=bad`,
      `/v1/feedback/${FEEDBACK_ID}?page=2`,
      `/v1/feedback/${FEEDBACK_ID}?cursor=0000000000000000000000000A&cursor=0000000000000000000000000B`,
    ]) {
      const response = await read(app, path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect((await read(app, undefined, { "X-Request-Id": "x".repeat(129) })).status).toBe(400);
    expect(readFeedbackStatus).not.toHaveBeenCalled();
  });

  it("answers missing reports, unreadable stores and authentication outages safely", async () => {
    const { reports, reporter } = recordingReporter();
    expect((await read(appFor(async () => null))).status).toBe(404);

    const broken = appFor(
      async () => {
        throw new Error("postgres-private-canary");
      },
      { reporter },
    );
    const unavailable = await read(broken);
    const text = await unavailable.text();
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: "service_unavailable", retryable: true });
    expect(text).not.toContain("postgres-private-canary");
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "FEEDBACK_READ_UNAVAILABLE",
        route: "/v1/feedback/{feedback_id}",
      },
    ]);

    const anonymous = await appFor(async () => record() as never).request(
      `${API}/v1/feedback/${FEEDBACK_ID}`,
    );
    expect(anonymous.status).toBe(401);
    const down = appFor(async () => record() as never, {
      authentication: {
        authenticate: async () => {
          throw new Error("identity provider offline");
        },
      },
    });
    expect((await read(down)).status).toBe(503);
  });

  it("hides reports from callers whose permission is denied and reports an unreachable decision", async () => {
    const denied = appFor(async () => record() as never, {
      authorization: { check: async () => "deny" },
    });
    const hidden = await read(denied);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ detail: "Resource not found." });

    const outage = appFor(async () => record() as never, {
      authorization: {
        check: async () => {
          throw new Error("authorization offline");
        },
      },
    });
    const unavailable = await read(outage);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ detail: "Resource unavailable." });

    const limited = appFor(async () => record() as never, {
      rateLimits: {
        consume: async ({ dimension }) =>
          dimension === "organization"
            ? { allowed: false, retryAfterSeconds: 9 }
            : { allowed: true },
      },
    });
    const response = await read(limited);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
  });

  it("refuses a cursor that is not an update of the receipt only after authorization", async () => {
    const cursor = "0000000000000000000000000A";
    const app = appFor(async () => record(null) as never);
    const response = await read(app, `/v1/feedback/${FEEDBACK_ID}?cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      detail: "The cursor is not a next_cursor of this feedback receipt.",
    });

    const denied = appFor(async () => record(null) as never, {
      authorization: { check: async () => "deny" },
    });
    expect((await read(denied, `/v1/feedback/${FEEDBACK_ID}?cursor=${cursor}`)).status).toBe(404);
  });

  it("fails closed when persistence answers outside the requested scope", async () => {
    const { reports, reporter } = recordingReporter();
    const foreign = appFor(
      async () => record(STATUS, { organizationId: FOREIGN_ORGANIZATION_ID }) as never,
      { reporter },
    );
    const response = await read(foreign);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable" });
    const other = appFor(
      async () => record({ ...STATUS, id: "0000000000000000000000000B" }) as never,
      {
        reporter,
      },
    );
    expect((await read(other)).status).toBe(503);
    expect(reports.map((report) => report.code)).toEqual([
      "UNEXPECTED_APPLICATION_FAILURE",
      "UNEXPECTED_APPLICATION_FAILURE",
    ]);
  });
});

describe("POST /v1/session:revoke", () => {
  const revoke = (
    app: ReturnType<typeof createControlApi>,
    headers: Record<string, string> = {},
    init: RequestInit = {},
    path = "/v1/session:revoke",
  ) =>
    app.request(`${API}${path}`, {
      method: "POST",
      headers: { ...BEARER, "Idempotency-Key": "revoke-1", ...headers },
      ...init,
    });

  it("revokes the current user session once per request with an empty body", async () => {
    const port = { revoke: vi.fn(async () => undefined) };
    const app = createControlApi(routeDependencies({ sessionRevocation: port }));

    const response = await revoke(app);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ revoked: true });
    expect(port.revoke).toHaveBeenCalledWith(PRINCIPAL);
  });

  it("is not mounted without a revocation port", async () => {
    const response = await revoke(createControlApi(routeDependencies()));
    expect(response.status).toBe(404);
  });

  it("refuses requests that are not exactly the current session with an idempotency key", async () => {
    const port = { revoke: vi.fn(async () => undefined) };
    const app = createControlApi(routeDependencies({ sessionRevocation: port }));
    for (const [headers, init, path] of [
      [{ "Idempotency-Key": "" }, {}, undefined],
      [{ "Idempotency-Key": "not valid!" }, {}, undefined],
      [{}, { body: "{}" }, undefined],
      [{}, {}, "/v1/session:revoke?session=other"],
      [{ "X-Request-Id": "r".repeat(129) }, {}, undefined],
    ] as const) {
      const response = await revoke(app, { ...headers }, { ...init }, path);
      expect(response.status, JSON.stringify(headers) + String(path)).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(port.revoke).not.toHaveBeenCalled();
  });

  it("rejects credentials that are not an interactive session", async () => {
    const port = { revoke: vi.fn(async () => undefined) };
    const apiKey = createControlApi(
      routeDependencies({
        sessionRevocation: port,
        authentication: {
          authenticate: async () => ({ ...PRINCIPAL, credentialId: "user_api_key:key_1" }),
        },
      }),
    );
    const forbidden = await revoke(apiKey);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: "forbidden" });
    const service = createControlApi(
      routeDependencies({
        sessionRevocation: port,
        authentication: {
          authenticate: async () => ({
            ...PRINCIPAL,
            authorizationPrincipal: { kind: "service", subjectId: "service:ci" } as never,
          }),
        },
      }),
    );
    expect((await revoke(service)).status).toBe(403);
    expect(port.revoke).not.toHaveBeenCalled();
  });

  it("answers authentication failures and rate limits before touching the session", async () => {
    const port = { revoke: vi.fn(async () => undefined) };
    const anonymous = createControlApi(routeDependencies({ sessionRevocation: port }));
    const unauthenticated = await anonymous.request(`${API}/v1/session:revoke`, {
      method: "POST",
      headers: { "Idempotency-Key": "k" },
    });
    expect(unauthenticated.status).toBe(401);
    const down = createControlApi(
      routeDependencies({
        sessionRevocation: port,
        authentication: {
          authenticate: async () => {
            throw new Error("identity provider offline");
          },
        },
      }),
    );
    const unavailable = await revoke(down);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ retryable: true });
    const limited = createControlApi(
      routeDependencies({
        sessionRevocation: port,
        rateLimits: {
          consume: async ({ dimension }) =>
            dimension === "actor" ? { allowed: false, retryAfterSeconds: 5 } : { allowed: true },
        },
      }),
    );
    const response = await revoke(limited);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    const throttled = createControlApi(
      routeDependencies({
        sessionRevocation: port,
        rateLimits: { consume: async () => ({ allowed: false, retryAfterSeconds: 2 }) },
      }),
    );
    expect((await revoke(throttled)).status).toBe(429);
    expect(port.revoke).not.toHaveBeenCalled();
  });

  it("does not claim a revocation it could not confirm", async () => {
    const { reports, reporter } = recordingReporter();
    const app = createControlApi(
      routeDependencies({
        reporter,
        sessionRevocation: {
          revoke: async () => {
            throw new Error("workos-private-canary");
          },
        },
      }),
    );

    const response = await revoke(app);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: "service_unavailable", retryable: true });
    expect(text).not.toContain("workos-private-canary");
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "SESSION_REVOCATION_UNAVAILABLE",
        route: "/v1/session:revoke",
      },
    ]);
  });
});

describe("GET /v1/audit-events", () => {
  const event = {
    eventId: EVENT_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    operationId: null,
    eventType: "project.created",
    actorType: "user",
    actorId: "user:user_1",
    summary: "Project created.",
    occurredAt: NOW,
  };
  const audit = (
    readAuditEvents: ControlApiDependencies["persistence"]["readAuditEvents"],
    overrides: Partial<ControlApiDependencies> = {},
  ) => {
    const base = routeDependencies();
    return createControlApi(
      routeDependencies({ persistence: { ...base.persistence, readAuditEvents }, ...overrides }),
    );
  };
  const list = (app: ReturnType<typeof createControlApi>, query = "", headers = {}) =>
    app.request(`${API}/v1/audit-events${query}`, { headers: { ...BEARER, ...headers } });

  it("renders every event with its exact public shape and the continuation cursor", async () => {
    const withOperation = { ...event, eventId: OPERATION_ID, operationId: OPERATION_ID };
    const readAuditEvents = vi.fn(async () => ({
      events: [event, withOperation],
      nextCursor: "page_2-token",
    }));
    const app = audit(readAuditEvents);

    const response = await list(app, "?limit=2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          audit_event_id: EVENT_ID,
          project_id: PROJECT_ID,
          event_type: "project.created",
          actor_type: "user",
          actor_id: "user:user_1",
          payload: { summary: "Project created." },
          occurred_at: NOW,
        },
        {
          audit_event_id: OPERATION_ID,
          project_id: PROJECT_ID,
          operation_id: OPERATION_ID,
          event_type: "project.created",
          actor_type: "user",
          actor_id: "user:user_1",
          payload: { summary: "Project created." },
          occurred_at: NOW,
        },
      ],
      next_cursor: "page_2-token",
    });
    expect(readAuditEvents).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID, limit: 2 });
    const multi = audit(readAuditEvents, {
      authentication: {
        authenticate: async () => ({
          ...PRINCIPAL,
          organizationIds: [ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID],
          selectedOrganizationId: ORGANIZATION_ID,
        }),
      },
    });
    expect((await list(multi)).status).toBe(200);
    readAuditEvents.mockResolvedValueOnce({ events: [], nextCursor: "page_2-token" });
    expect((await list(multi, `?organization_id=${FOREIGN_ORGANIZATION_ID}`)).status).toBe(200);
    expect(readAuditEvents).toHaveBeenLastCalledWith({
      organizationId: FOREIGN_ORGANIZATION_ID,
      limit: 50,
    });
    expect((await list(multi, "?organization_id=invalid")).status).toBe(400);
    const ambiguous = audit(readAuditEvents, {
      authentication: {
        authenticate: async () => ({
          ...PRINCIPAL,
          organizationIds: [ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID],
        }),
      },
    });
    expect((await list(ambiguous)).status).toBe(403);
    const single = audit(readAuditEvents);
    expect((await list(single, `?organization_id=${FOREIGN_ORGANIZATION_ID}`)).status).toBe(403);
    const restricted = audit(readAuditEvents, {
      authentication: {
        authenticate: async () => ({
          ...PRINCIPAL,
          authorizationRestriction: { actions: ["audit:read"], projectIds: [PROJECT_ID] },
        }),
      },
    });
    expect((await list(restricted)).status).toBe(200);
    expect(readAuditEvents).toHaveBeenLastCalledWith({
      organizationId: ORGANIZATION_ID,
      projectIds: [PROJECT_ID],
      limit: 50,
    });
    expect((await list(restricted, `?project_id=${FOREIGN_ORGANIZATION_ID}`)).status).toBe(404);
  });

  it("fails closed instead of publishing an event that violates the output contract", async () => {
    const { reports, reporter } = recordingReporter();
    for (const broken of [
      { ...event, summary: "   " },
      { ...event, summary: "s".repeat(513) },
      { ...event, actorId: "" },
      { ...event, eventType: " " },
      { ...event, actorType: "" },
      { ...event, occurredAt: "2026-09-10 10:00:00" },
    ]) {
      const response = await list(
        audit(async () => ({ events: [broken], nextCursor: null }), { reporter }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "service_unavailable" });
    }
    expect(reports.map((report) => report.code)).toEqual(Array(6).fill("AUDIT_READ_FAILED"));
    const escaped = await list(
      audit(
        async () => ({
          events: [{ ...event, organizationId: FOREIGN_ORGANIZATION_ID }],
          nextCursor: null,
        }),
        {
          reporter,
        },
      ),
    );
    expect(escaped.status).toBe(503);
  });

  it("maps an invalid cursor from the store to a client error", async () => {
    const app = audit(async () => {
      throw new TypeError("Invalid audit cursor");
    });
    const response = await list(app, "?cursor=stale");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "Audit cursor is invalid." });
  });

  it("echoes a caller-chosen X-Request-Id and rejects one that is empty or too long", async () => {
    const app = audit(async () => ({ events: [], nextCursor: null }));

    const accepted = await list(app, "", { "X-Request-Id": "caller-request-1" });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("X-Request-Id")).toBe("caller-request-1");

    for (const invalid of ["r".repeat(129), ""]) {
      const response = await list(app, "", { "X-Request-Id": invalid });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ detail: "X-Request-Id is invalid." });
    }
  });
});

describe("public entry mounts", () => {
  it("forwards /v1/site and /v1/contact-requests to the public entry port without authentication", async () => {
    const contact = vi.fn(async () => true);
    const app = createControlApi(
      routeDependencies({
        publicEntry: {
          contact,
          vote: async () => true,
          votes: async () => ({ votes: [] }),
          stats: async () => ({ deploys_7d: 4, observed_at: NOW }),
        },
      }),
    );

    const stats = await app.request(`${API}/v1/site/stats`);
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual({ deploys_7d: 4, observed_at: NOW });
    expect(stats.headers.get("Cache-Control")).toBe("no-store");

    const accepted = await app.request(`${API}/v1/contact-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://ohmyho.st" },
      body: JSON.stringify({
        name: " Reader ",
        email: "Reader@Example.com",
        company: "Example",
        message: "Please provide the DPA.",
        idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(contact).toHaveBeenCalledWith({
      name: "Reader",
      email: "reader@example.com",
      company: "Example",
      message: "Please provide the DPA.",
      idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      bucket: null,
    });
  });

  it("answers 503 when no public entry port is composed", async () => {
    const app = createControlApi(routeDependencies());
    const site = await app.request(`${API}/v1/site/stats`);
    expect(site.status).toBe(503);
    const contact = await app.request(`${API}/v1/contact-requests`, { method: "POST" });
    expect(contact.status).toBe(503);
    expect(await contact.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  });
});
