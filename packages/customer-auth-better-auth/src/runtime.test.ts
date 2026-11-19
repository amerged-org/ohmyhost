import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import {
  createCustomerAuthOptions,
  createCustomerAuthPostgresPool,
  type CustomerAuthRuntimeInput,
} from "./runtime.js";

function input(): CustomerAuthRuntimeInput {
  return {
    appName: "Portable App",
    publicOrigin: "https://g-project.account.workers.dev",
    database: { query: vi.fn() } as unknown as Pool,
    secret: "s".repeat(43),
    email: { send: vi.fn(async () => undefined) },
  };
}

describe("Better Auth customer runtime template", () => {
  it("creates the closed project-local PostgreSQL, session, cookie, mail, and rate-limit policy", async () => {
    const runtime = input();
    const options = createCustomerAuthOptions(runtime);

    expect(options).toMatchObject({
      appName: "Portable App",
      baseURL: "https://g-project.account.workers.dev",
      basePath: "/api/auth",
      trustedOrigins: ["https://g-project.account.workers.dev"],
      secret: "s".repeat(43),
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        autoSignIn: false,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        revokeSessionsOnPasswordReset: true,
      },
      emailVerification: { sendOnSignUp: true, sendOnSignIn: true },
      session: { expiresIn: 604_800, updateAge: 86_400 },
      rateLimit: { enabled: true, storage: "database" },
      advanced: {
        useSecureCookies: true,
        database: { generateId: "uuid", joins: true },
      },
    });
    expect(options.advanced?.disableCSRFCheck).toBe(false);
    expect(options.advanced?.disableOriginCheck).toBe(false);

    await options.emailVerification?.sendVerificationEmail?.({
      user: { email: "user@example.test" },
      url: "https://g-project.account.workers.dev/api/auth/verify-email?token=opaque",
    } as never);
    await options.emailAndPassword?.sendResetPassword?.({
      user: { email: "user@example.test" },
      url: "https://g-project.account.workers.dev/api/auth/reset-password/opaque",
    } as never);
    await options.emailAndPassword?.onPasswordReset?.({
      user: { email: "user@example.test" },
    } as never);
    expect(runtime.email?.send).toHaveBeenNthCalledWith(1, {
      kind: "verification",
      to: "user@example.test",
      url: "https://g-project.account.workers.dev/api/auth/verify-email?token=opaque",
    });
    expect(runtime.email?.send).toHaveBeenNthCalledWith(2, {
      kind: "password-reset",
      to: "user@example.test",
      url: "https://g-project.account.workers.dev/api/auth/reset-password/opaque",
    });
    expect(runtime.email?.send).toHaveBeenNthCalledWith(3, {
      kind: "password-changed",
      to: "user@example.test",
      url: "https://g-project.account.workers.dev/login",
    });
  });

  it.each([
    { publicOrigin: "http://example.test" },
    { publicOrigin: "https://example.test/path" },
    {
      publicOrigin: "https://g-project.account.workers.dev/p/01J00000000000000000000021",
    },
    { secret: "short" },
    { appName: "" },
    { database: {} },
    { email: {} },
  ])("rejects unsafe runtime input %#", (override) => {
    expect(() => createCustomerAuthOptions({ ...input(), ...override } as never)).toThrow();
  });

  it("rejects cross-origin and non-auth e-mail links", async () => {
    const options = createCustomerAuthOptions(input());
    for (const url of [
      "https://evil.example/api/auth/verify-email?token=opaque",
      "https://g-project.account.workers.dev/dashboard",
      "https://g-project.account.workers.dev/p/01J00000000000000000000021/api/auth/verify-email?token=opaque",
    ]) {
      await expect(
        options.emailVerification?.sendVerificationEmail?.({
          user: { email: "user@example.test" },
          url,
        } as never),
      ).rejects.toThrow("Customer auth e-mail URL is invalid");
    }
  });

  it("creates a bounded PostgreSQL pool fixed to the auth schema", async () => {
    const pool = createCustomerAuthPostgresPool("postgresql://runtime:secret@db.example/app");
    expect(pool.options).toMatchObject({
      max: 1,
      options: "-c search_path=auth",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    await pool.end();
    expect(() => createCustomerAuthPostgresPool("mysql://db.example/app")).toThrow(
      "Customer auth database URL is invalid",
    );
  });
});
