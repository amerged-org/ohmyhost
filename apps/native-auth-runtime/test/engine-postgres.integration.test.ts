import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativeAuthPostgresEngine } from "../src/postgres-engine.js";
import { validateNativeSessionPolicy } from "../src/session-policy.js";
import { createNativeSocialEngineOptions } from "../src/engine.js";

it("uses the pinned engine with PostgreSQL and emits an application-owned reset link", async () => {
  const db = await startTestPostgres();
  const schema = `native_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const realm = new Pool({ connectionString, options: `-c search_path=${schema}` });
  let engine: ReturnType<typeof createNativeAuthPostgresEngine> | undefined;
  try {
    await realm.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const origin = "https://native-auth.example.test";
    const messages: Array<{ kind: string; url: string; token: string }> = [];
    engine = createNativeAuthPostgresEngine(
      {
        connectionString,
        schema,
        canonicalOrigin: origin,
        applicationName: "Test App",
        secret: "test-secret-at-least-32-characters-long",
        sendMail: async (message) => {
          messages.push(message);
        },
      },
      { handle: (_request, execute) => execute(), validate: async (session) => session },
      (configuration) => new Pool(configuration),
    );
    const current = engine;
    const request = (path: string, body: object) =>
      current.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: { origin, "content-type": "application/json", "cf-connecting-ip": "192.0.2.10" },
          body: JSON.stringify(body),
        }),
      );
    const email = `proof-${randomUUID()}@example.test`;
    const password = "correct-horse-battery-123"; // gitleaks:allow -- disposable local test password
    expect((await request("/sign-up/email", { name: "Proof", email, password })).status).toBe(200);
    expect((await request("/sign-in/email", { email, password })).status).not.toBe(200);
    const verification = messages.find((message) => message.kind === "verification");
    if (!verification) throw new Error("verification mail missing");
    const verify = await current.handle(new Request(verification.url, { headers: { origin } }));
    expect(verify.status).toBeLessThan(400);
    expect(verify.headers.getSetCookie()).toHaveLength(0);
    const login = await request("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const socialOnly = betterAuth(
      createNativeSocialEngineOptions({
        canonicalOrigin: origin,
        applicationName: "Test App",
        secret: "test-secret-at-least-32-characters-long",
        database: realm,
      }),
    );
    const socialPasswordAttempt = await socialOnly.handler(
      new Request(`${origin}/api/auth/v1/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(socialPasswordAttempt.status).not.toBe(200);
    expect(await login.clone().json()).not.toHaveProperty("token");
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain("omh_native");
    expect(cookie).toBeTruthy();
    const session = await current.validateSession(cookie);
    if (!session) throw new Error("session missing");
    expect(session.user.email).toBe(email);
    expect(await validateNativeSessionPolicy(realm, session, 1)).toBeNull();
    await realm.query("insert into native_user_policy (user_id, status) values ($1, 'active')", [
      session.user.id,
    ]);
    await realm.query(
      "insert into native_session_policy (session_id, realm_epoch, user_epoch, authenticated_at) values ($1, 1, 0, now())",
      [session.session.id],
    );
    expect(await validateNativeSessionPolicy(realm, session, 1)).toEqual(session);
    expect(await validateNativeSessionPolicy(realm, session, 2)).toBeNull();
    await realm.query("update native_user_policy set status = 'suspended' where user_id = $1", [
      session.user.id,
    ]);
    expect(await validateNativeSessionPolicy(realm, session, 1)).toBeNull();
    await realm.query(
      "update native_user_policy set status = 'active', revocation_epoch = 1 where user_id = $1",
      [session.user.id],
    );
    expect(await validateNativeSessionPolicy(realm, session, 1)).toBeNull();
    expect(
      (
        await request("/request-password-reset", {
          email,
          redirectTo: "https://evil.example/reset-password",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/request-password-reset", { email, redirectTo: "/reset-password" })).status,
    ).toBe(200);
    const reset = messages.find((message) => message.kind === "password-reset");
    if (!reset) throw new Error("reset mail missing");
    expect(new URL(reset.url).pathname).toBe("/reset-password");
    expect(
      (
        await request("/reset-password", {
          token: reset.token,
          newPassword: "different-correct-horse-123",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/reset-password", {
          token: reset.token,
          newPassword: "different-correct-horse-123",
        })
      ).status,
    ).not.toBe(200);
    expect(await current.validateSession(cookie)).toBeNull();
    const freshLogin = await request("/sign-in/email", {
      email,
      password: "different-correct-horse-123",
    });
    expect(freshLogin.status).toBe(200);
    const freshCookie = freshLogin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(
      (await current.validateSession(`${freshCookie}; better-auth.session_token=external-fixture`))
        ?.user.email,
    ).toBe(email);
    const signout = await current.handle(
      new Request(`${origin}/api/auth/v1/sign-out`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: `${freshCookie}; better-auth.session_token=external-fixture`,
        },
        body: "{}",
      }),
    );
    expect(signout.status).toBe(200);
    expect(signout.headers.getSetCookie().join("; ")).toContain("omh_native");
    expect(signout.headers.getSetCookie().join("; ")).not.toContain("better-auth.session_token");
    const accounts = await realm.query(
      'select "password", "accessToken", "refreshToken", "idToken" from "account"',
    );
    expect(accounts.rows[0]).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    expect(accounts.rows[0].password).not.toBe(password);
  } finally {
    await engine?.close();
    await realm.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
