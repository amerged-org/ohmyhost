import { beforeEach, describe, expect, it, vi } from "vitest";

const authHarness = vi.hoisted(() => ({
  handler: vi.fn<(request: Request) => Promise<Response>>(),
  options: undefined as Record<string, unknown> | undefined,
}));

const databaseHarness = vi.hoisted(() => ({
  configuration: undefined as Record<string, unknown> | undefined,
  destroy: vi.fn(async () => undefined),
  schema: undefined as string | undefined,
}));

vi.mock("better-auth", () => ({
  betterAuth: (options: Record<string, unknown>) => {
    authHarness.options = options;
    return { handler: authHarness.handler };
  },
}));

vi.mock("kysely", () => ({
  Kysely: class {
    destroy = databaseHarness.destroy;

    withSchema(schema: string) {
      databaseHarness.schema = schema;
      return this;
    }
  },
  PostgresDialect: class {
    readonly configuration: Record<string, unknown>;

    constructor(input: { pool: { configuration: Record<string, unknown> } }) {
      this.configuration = input.pool.configuration;
      databaseHarness.configuration = input.pool.configuration;
    }
  },
}));

vi.mock("pg", () => ({
  Client: class {
    readonly kind = "test-client";
  },
  Pool: class {
    readonly configuration: Record<string, unknown>;

    constructor(configuration: Record<string, unknown>) {
      this.configuration = configuration;
    }
  },
}));

import { createProjectDatabaseHttpWorker, sendProjectMail } from "../src/http-worker.js";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ORIGIN = "https://app.example.com";
const SECRET = "s".repeat(32);
const MAIL_KEY = "mail-key-value-1";

function authRequest(headers: Record<string, string> = {}) {
  return new Request("https://database.internal/api/auth/sign-in/email?callback=dashboard", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ohmyhost-app-name": "Example App",
      "x-ohmyhost-auth-secret": SECRET,
      "x-ohmyhost-auth-url": ORIGIN,
      "x-ohmyhost-mail-key": MAIL_KEY,
      "x-ohmyhost-project-id": PROJECT_ID,
      ...headers,
    },
    body: JSON.stringify({ email: "person@example.test", password: "not-a-real-password" }),
  });
}

function bindings(
  fetch: (request: Request) => Promise<Response> = vi.fn(
    async () => new Response(null, { status: 202 }),
  ),
) {
  return {
    DATABASE_CONNECTION_STRING: "postgres://project-database",
    OHMYHOST_MAIL_GATEWAY: { fetch },
    PROJECT_ID,
  };
}

describe("project database HTTP auth boundary", () => {
  beforeEach(() => {
    authHarness.handler.mockReset();
    authHarness.options = undefined;
    databaseHarness.configuration = undefined;
    databaseHarness.destroy.mockClear();
    databaseHarness.schema = undefined;
  });

  it("forwards auth requests to the public project origin without internal credentials", async () => {
    authHarness.handler.mockImplementation(async (request) => {
      expect(request.url).toBe(`${ORIGIN}/api/auth/sign-in/email?callback=dashboard`);
      expect(request.headers.get("x-ohmyhost-project-id")).toBeNull();
      expect(request.headers.get("x-ohmyhost-auth-secret")).toBeNull();
      expect(request.headers.get("x-ohmyhost-mail-key")).toBeNull();
      expect(request.headers.get("x-ohmyhost-app-name")).toBeNull();
      expect(request.headers.get("content-type")).toBe("application/json");
      return Response.json({ ok: true });
    });
    const worker = createProjectDatabaseHttpWorker();

    await expect((await worker.fetch(authRequest(), bindings())).json()).resolves.toEqual({
      ok: true,
    });
    expect(databaseHarness.schema).toBe("auth");
    expect(databaseHarness.configuration).toEqual({
      connectionString: "postgres://project-database",
      connectionTimeoutMillis: 10_000,
      // Five origin connections per project environment, two of which the held connections take.
      max: 2,
      query_timeout: 12_000,
      statement_timeout: 10_000,
    });
    expect(databaseHarness.destroy).toHaveBeenCalledOnce();
  });

  it("rejects malformed auth configuration before creating a database pool", async () => {
    const worker = createProjectDatabaseHttpWorker();

    const response = await worker.fetch(
      authRequest({ "x-ohmyhost-auth-url": "http://app.example.com" }),
      bindings(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "service_unavailable" });
    expect(databaseHarness.configuration).toBeUndefined();
    expect(authHarness.handler).not.toHaveBeenCalled();
  });

  it("rejects the removed project-prefixed public auth origin", async () => {
    const worker = createProjectDatabaseHttpWorker();

    const response = await worker.fetch(
      authRequest({ "x-ohmyhost-auth-url": `${ORIGIN}/p/${PROJECT_ID}` }),
      bindings(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "service_unavailable" });
    expect(databaseHarness.configuration).toBeUndefined();
    expect(authHarness.handler).not.toHaveBeenCalled();
  });

  it("sends escaped password-reset mail through the project mail gateway", async () => {
    authHarness.handler.mockImplementation(async (request) => {
      expect(request.headers.get("x-ohmyhost-egress-project-id")).toBeNull();
      return new Response(null, { status: 204 });
    });
    const gatewayFetch = vi.fn(async function (this: unknown, request: Request) {
      expect(this).toBe(bound.OHMYHOST_MAIL_GATEWAY);
      expect(request.headers.get("x-ohmyhost-egress-project-id")).toBe(PROJECT_ID);
      expect(request.headers.get("authorization")).toBe(`Bearer ${MAIL_KEY}`);
      expect(request.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/u);
      await expect(request.json()).resolves.toEqual({
        project_id: PROJECT_ID,
        to: "person@example.test",
        subject: "Reset your Example App password",
        text: 'Reset your password: https://app.example.com/reset?a=1&b="quoted"',
        html: '<p>Reset your password: <a href="https://app.example.com/reset?a=1&amp;b=&quot;quoted&quot;">Reset password</a></p>',
      });
      return new Response(null, { status: 202 });
    });
    const worker = createProjectDatabaseHttpWorker();
    const bound = bindings(gatewayFetch);
    Object.defineProperty(gatewayFetch, "bind", {
      get() {
        throw new Error("An RPC method must not be bound");
      },
    });
    const foreignProject = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    for (const suppliedProject of [foreignProject, "not-a-project"]) {
      const rejected = await worker.fetch(
        authRequest({
          "x-ohmyhost-project-id": suppliedProject,
          "x-ohmyhost-egress-project-id": PROJECT_ID,
        }),
        bound,
      );
      expect(rejected.status).toBe(503);
      expect(databaseHarness.configuration).toBeUndefined();
      expect(authHarness.handler).not.toHaveBeenCalled();
      expect(gatewayFetch).not.toHaveBeenCalled();
    }
    await worker.fetch(authRequest({ "x-ohmyhost-egress-project-id": foreignProject }), bound);
    const options = authHarness.options as {
      emailAndPassword: {
        sendResetPassword(input: {
          user: { id: string; email: string };
          url: string;
          token: string;
        }): Promise<void>;
      };
    };

    await expect(
      options.emailAndPassword.sendResetPassword({
        user: { id: "user-1", email: "person@example.test" },
        url: 'https://app.example.com/reset?a=1&b="quoted"',
        token: "reset-token",
      }),
    ).resolves.toBeUndefined();
    expect(gatewayFetch).toHaveBeenCalledOnce();
  });

  it("sends escaped verification mail through the project mail gateway", async () => {
    authHarness.handler.mockImplementation(async (request) => {
      expect(request.headers.get("x-ohmyhost-egress-project-id")).toBeNull();
      return new Response(null, { status: 204 });
    });
    const gatewayFetch = vi.fn(async function (this: unknown, request: Request) {
      expect(this).toBe(bound.OHMYHOST_MAIL_GATEWAY);
      expect(request.headers.get("x-ohmyhost-egress-project-id")).toBe(PROJECT_ID);
      expect(request.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/u);
      await expect(request.json()).resolves.toEqual({
        project_id: PROJECT_ID,
        to: "person@example.test",
        subject: "Verify your Example App email",
        text: "Verify your email: https://app.example.com/verify?value=<token>'",
        html: '<p>Verify your email: <a href="https://app.example.com/verify?value=&lt;token&gt;&#39;">Verify email</a></p>',
      });
      return new Response(null, { status: 202 });
    });
    const worker = createProjectDatabaseHttpWorker();
    const bound = bindings(gatewayFetch);
    Object.defineProperty(gatewayFetch, "bind", {
      get() {
        throw new Error("An RPC method must not be bound");
      },
    });
    const foreignProject = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    for (const suppliedProject of [foreignProject, "not-a-project"]) {
      const rejected = await worker.fetch(
        authRequest({
          "x-ohmyhost-project-id": suppliedProject,
          "x-ohmyhost-egress-project-id": PROJECT_ID,
        }),
        bound,
      );
      expect(rejected.status).toBe(503);
      expect(databaseHarness.configuration).toBeUndefined();
      expect(authHarness.handler).not.toHaveBeenCalled();
      expect(gatewayFetch).not.toHaveBeenCalled();
    }
    await worker.fetch(authRequest({ "x-ohmyhost-egress-project-id": foreignProject }), bound);
    const options = authHarness.options as {
      emailVerification: {
        sendVerificationEmail(input: {
          user: { id: string; email: string };
          url: string;
          token: string;
        }): Promise<void>;
      };
    };

    await expect(
      options.emailVerification.sendVerificationEmail({
        user: { id: "user-1", email: "person@example.test" },
        url: "https://app.example.com/verify?value=<token>'",
        token: "verify-token",
      }),
    ).resolves.toBeUndefined();
    expect(gatewayFetch).toHaveBeenCalledOnce();
  });

  it("returns a stable unavailable response and bounded diagnostics when auth fails", async () => {
    authHarness.handler.mockRejectedValue(
      Object.assign(new Error("sensitive database message"), {
        code: "23505",
        constraint: "auth_user_email_key",
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createProjectDatabaseHttpWorker();

    const response = await worker.fetch(authRequest(), bindings());

    expect(response.status).toBe(503);
    expect(error).toHaveBeenCalledWith("project_auth_failed", {
      name: "Error",
      code: "23505",
      constraint: "auth_user_email_key",
    });
    expect(error.mock.calls.flat().join(" ")).not.toContain("sensitive database message");
    expect(databaseHarness.destroy).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("rejects mail gateway responses that were not accepted", async () => {
    await expect(
      sendProjectMail(
        { fetch: vi.fn(async () => new Response(null, { status: 429 })) },
        MAIL_KEY,
        PROJECT_ID,
        {
          to: "person@example.test",
          subject: "Verify",
          text: "Verify text",
          html: "<p>Verify</p>",
          idempotencyKey: "opaque-key",
        },
      ),
    ).rejects.toThrow("mail_delivery_failed");
  });
});
