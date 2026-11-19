import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it, vi } from "vitest";

import {
  authMailIdempotencyKey,
  createProjectAuthOptions,
  createProjectDatabaseHttpWorker,
  sendProjectMail,
} from "../src/http-worker.js";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("project database HTTP service", () => {
  it("returns 404 for the retired HTTP query without opening a database", async () => {
    const createPool = vi.fn(() => {
      throw new Error("The retired query route must not open a database pool");
    });
    const mailFetch = vi.fn();
    const worker = createProjectDatabaseHttpWorker({ createPool });
    const request = new Request("https://database.internal/__ohmyhost/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ohmyhost-project-id": PROJECT_ID },
      body: JSON.stringify({ text: "SELECT $1::int AS value", values: [7] }),
    });
    const response = await worker.fetch(request, {
      PROJECT_ID,
      DATABASE_CONNECTION_STRING: "postgres://project-database",
      OHMYHOST_MAIL_GATEWAY: { fetch: mailFetch },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(request.bodyUsed).toBe(false);
    expect(createPool).not.toHaveBeenCalled();
    expect(mailFetch).not.toHaveBeenCalled();
  });

  it("keeps old project headers and malformed query bodies behind the same 404", async () => {
    const createPool = vi.fn(() => {
      throw new Error("Legacy query requests must not open a database pool");
    });
    const mailFetch = vi.fn();
    const worker = createProjectDatabaseHttpWorker({ createPool });
    const bindings = {
      PROJECT_ID,
      DATABASE_CONNECTION_STRING: "postgres://project-database",
      OHMYHOST_MAIL_GATEWAY: { fetch: mailFetch },
    };
    for (const body of ["not-json", "x".repeat(128 * 1024 + 1)]) {
      const request = new Request("https://database.internal/__ohmyhost/query", {
        method: "POST",
        headers: { "x-ohmyhost-project-id": "01ARZ3NDEKTSV4RRFFQ69G5FAX" },
        body,
      });
      const response = await worker.fetch(request, bindings);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
      expect(request.bodyUsed).toBe(false);
    }
    expect(createPool).not.toHaveBeenCalled();
    expect(mailFetch).not.toHaveBeenCalled();
  });

  it("configures Better Auth with secure verification and database policy", () => {
    const options = createProjectAuthOptions({
      database: {} as BetterAuthOptions["database"],
      origin: "https://app.example.com",
      secret: "s".repeat(32),
      appName: "Example App",
      sendMail: vi.fn(),
    });
    expect(options).toMatchObject({
      appName: "Example App",
      basePath: "/api/auth",
      baseURL: "https://app.example.com/api/auth",
      trustedOrigins: ["https://app.example.com"],
      emailAndPassword: { enabled: true, requireEmailVerification: true },
      emailVerification: { sendOnSignUp: true },
      advanced: {
        useSecureCookies: true,
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      },
      rateLimit: { enabled: true, storage: "database" },
    });
  });

  it("delivers project mail through the private service binding", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://mail-gateway.internal/v1/send");
      expect(request.headers.get("authorization")).toBe("Bearer project-mail-key");
      expect(request.headers.get("idempotency-key")).toBe("auth-verify:user:token");
      expect(await request.json()).toEqual({
        project_id: PROJECT_ID,
        to: "person@example.test",
        subject: "Verify",
        text: "Verify text",
        html: "<p>Verify</p>",
      });
      return new Response(null, { status: 202 });
    });

    await expect(
      sendProjectMail({ fetch }, "project-mail-key", PROJECT_ID, {
        to: "person@example.test",
        subject: "Verify",
        text: "Verify text",
        html: "<p>Verify</p>",
        idempotencyKey: "auth-verify:user:token",
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("derives bounded opaque idempotency keys for auth mail", async () => {
    const token = "secret-verification-token-".repeat(10);
    const first = await authMailIdempotencyKey("verify", "user-1", token);
    const replay = await authMailIdempotencyKey("verify", "user-1", token);
    const reset = await authMailIdempotencyKey("reset", "user-1", token);

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toBe(replay);
    expect(reset).not.toBe(first);
    expect(first).not.toContain(token);
  });
});
