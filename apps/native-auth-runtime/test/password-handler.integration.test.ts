import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Kysely, sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createNativeAuthBrowser } from "../../../packages/customer-runtime/src/auth-browser.js";
import { createNativePasswordRateLimiter, nativeRateBucketDigest } from "../src/rate-limit.js";
import { createNativeLatencyProfile } from "../src/latency-profile.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import {
  createNativePasswordHandler,
  createNativePasswordMailDispatcher,
  boundDialect,
} from "../src/password-handler.js";

const SHARED_TEST_PASSWORD = "correct-horse-battery-staple-1"; // gitleaks:allow -- disposable local test password

// Test double for Better Auth only: the real handler runs, then answers 500 once for an armed change-password, after it
// has written the new password. Production never wraps the engine.
const failNextChange = vi.hoisted(() => ({ armed: false }));
vi.mock("better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth")>();
  return {
    ...actual,
    betterAuth: (options: Parameters<typeof actual.betterAuth>[0]) => {
      const auth = actual.betterAuth(options);
      const handler = auth.handler;
      return {
        ...auth,
        handler: async (request: Request) => {
          const response = await handler(request);
          if (failNextChange.armed && new URL(request.url).pathname.endsWith("/change-password")) {
            failNextChange.armed = false;
            return new Response(null, { status: 500 });
          }
          return response;
        },
      };
    },
  };
});

it("runs signup, mailbox verification, login, recovery and revocation through one real PostgreSQL realm", async () => {
  const db = await startTestPostgres();
  const schema = `native_password_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true, 1, 1)",
    );
    const borrowed = await pool.connect();
    try {
      await borrowed.query("begin");
      const query = new Kysely<Record<string, never>>({ dialect: boundDialect(borrowed) });
      await sql`update native_realm_policy set enabled=false where singleton=true`.execute(query);
      await expect(sql`commit`.execute(query)).rejects.toThrow("native_auth_nested_transaction");
      await query.destroy();
      expect(
        (await borrowed.query("select enabled from native_realm_policy")).rows[0].enabled,
      ).toBe(false);
      expect((await pool.query("select enabled from native_realm_policy")).rows[0].enabled).toBe(
        true,
      );
      let getterInvoked = false;
      const hostile = Object.defineProperty(new Error("synthetic-secret"), "code", {
        get() {
          getterInvoked = true;
          throw new Error("synthetic-secret");
        },
      });
      const hostileClient = new Proxy(borrowed, {
        get(target, property) {
          if (property === "query")
            return async () => {
              throw hostile;
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const hostileQuery = new Kysely<Record<string, never>>({
        dialect: boundDialect(hostileClient),
      });
      const closed = await sql`select 1`.execute(hostileQuery).catch((error: unknown) => error);
      expect(closed).toBeInstanceOf(Error);
      expect(String(closed)).toContain("native_auth_database_unavailable");
      expect(String(closed)).not.toContain("synthetic-secret");
      expect(getterInvoked).toBe(false);
      await hostileQuery.destroy();
      await borrowed.query("rollback");
      expect(
        (await borrowed.query("select enabled from native_realm_policy")).rows[0].enabled,
      ).toBe(true);
    } finally {
      borrowed.release();
    }
    const origin = "https://native-auth.example.test";
    const messages: Array<{ kind: string; url: string; token: string; messageId: string }> = [];
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async (message) => {
          messages.push(message);
          return new Uint8Array([1, 2, 3]);
        },
      },
    });
    const failingHandler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async () => {
          throw new Error("sender_unavailable");
        },
      },
    });
    const failedEmail = `failed-${randomUUID()}@example.test`;
    expect(
      (
        await failingHandler.handle(
          new Request(`${origin}/api/auth/v1/sign-up/email`, {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            },
            body: JSON.stringify({
              name: "Test",
              email: failedEmail,
              password: "correct-horse-battery-123", // gitleaks:allow -- disposable local test password
            }),
          }),
        )
      ).status,
    ).toBe(503);
    expect(
      (await pool.query('select id from "user" where email = $1', [failedEmail])).rowCount,
    ).toBe(0);
    const observed: string[] = [];
    let firstDelivery = true;
    const replayHandler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        isProviderUsable: async () => true,
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async () => new Uint8Array([1, 2]),
        deliverMail: async (ids) => {
          observed.push(...ids);
          if (firstDelivery) {
            firstDelivery = false;
            throw new Error("delivery_pending");
          }
          for (const id of ids)
            await pool.query(
              "update native_auth_mail_outbox set delivered_at = now() where message_id=$1",
              [id],
            );
        },
      },
    });
    const replayEmail = `replay-${randomUUID()}@example.test`;
    const retryId = randomUUID();
    const replayRequest = () =>
      new Request(`${origin}/api/auth/v1/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "idempotency-key": retryId },
        body: JSON.stringify({
          name: "Replay",
          email: replayEmail,
          password: "correct-horse-battery-123", // gitleaks:allow -- disposable local test password
        }),
      });
    await expect(replayHandler.handle(replayRequest())).rejects.toThrow("delivery_pending");
    expect((await replayHandler.handle(replayRequest())).status).toBe(200);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toBe(observed[1]);
    expect((await pool.query('select id from "user" where email=$1', [replayEmail])).rowCount).toBe(
      1,
    );
    let raceEpoch = 1;
    const authorityRace = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        isProviderUsable: async () => true,
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: raceEpoch,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async () => {
          raceEpoch = 2;
          return new Uint8Array([1]);
        },
        deliverMail: async () => {
          throw new Error("unexpected_delivery");
        },
      },
    });
    const raceEmail = `race-${randomUUID()}@example.test`;
    const raceRequestId = randomUUID();
    const raceResponse = await authorityRace.handle(
      new Request(`${origin}/api/auth/v1/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "idempotency-key": raceRequestId },
        body: JSON.stringify({
          name: "Race",
          email: raceEmail,
          password: "a-long-correct-password",
        }),
      }),
    );
    expect(raceResponse.status).toBe(503);
    expect(await raceResponse.json()).toEqual({ error: "auth_unavailable" });
    expect(raceResponse.headers.get("content-type")).toContain("application/json");
    expect(raceEpoch).toBe(2);
    expect((await pool.query('select id from "user" where email=$1', [raceEmail])).rowCount).toBe(
      0,
    );
    expect(
      (
        await pool.query("select 1 from native_auth_mail_outbox where request_id=$1", [
          raceRequestId,
        ])
      ).rowCount,
    ).toBe(0);
    const delivered: string[] = [];
    const dispatcher = createNativePasswordMailDispatcher({
      pool,
      currentAuthority: async () => ({
        enabled: true,
        revocationEpoch: 1,
        configurationRevision: 1,
        signupMode: "open",
      }),
      send: async ({ messageId }) => {
        delivered.push(messageId);
      },
    });
    const request = (path: string, body: object, cookie?: string) =>
      handler.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    const email = `test-${randomUUID()}@example.test`;
    const password = "correct-horse-battery-123"; // gitleaks:allow -- disposable local test password
    expect((await request("/sign-up/email", { name: "Test", email, password })).status).toBe(200);
    expect((await request("/sign-in/email", { email, password })).status).not.toBe(200);
    expect((await request("/request-password-reset", { email })).status).toBe(200);
    expect(messages.filter((message) => message.kind === "password-reset")).toHaveLength(0);
    const predecessor = messages.find((m) => m.kind === "verification");
    if (!predecessor) throw new Error("missing_verification");
    expect((await request("/send-verification-email", { email })).status).toBe(200);
    const verification = messages.filter((m) => m.kind === "verification").at(-1);
    if (!verification) throw new Error("missing_replacement_verification");
    expect(verification.token).not.toBe(predecessor.token);
    expect(await dispatcher.dispatchOne(predecessor.messageId)).toBe(false);
    expect(
      (await handler.handle(new Request(predecessor.url, { headers: { origin } }))).status,
    ).toBe(400);
    expect(await dispatcher.dispatchOne(randomUUID())).toBe(false);
    expect(await dispatcher.dispatchOne(verification.messageId)).toBe(true);
    expect(await dispatcher.dispatchOne(verification.messageId)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(
      (await handler.handle(new Request(verification.url, { headers: { origin } }))).status,
    ).toBeLessThan(400);
    expect(
      (await handler.handle(new Request(verification.url, { headers: { origin } }))).status,
    ).toBe(400);
    const login = await request("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    expect(await login.clone().json()).not.toHaveProperty("token");
    const cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    expect(cookie).toBeTruthy();
    const get = () =>
      handler.handle(
        new Request(`${origin}/api/auth/v1/get-session`, { headers: { origin, cookie } }),
      );
    expect((await (await get()).json()).user.email).toBe(email);
    const statements: string[] = [];
    const tracedPool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return async (text: string, parameters?: unknown[]) => {
                if (typeof text === "string") statements.push(text);
                return target.query(text, parameters);
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const tracePorts = {
      admitAttempt: async () => true,
      currentAuthority: async () => ({
        enabled: true,
        revocationEpoch: 1,
        configurationRevision: 1,
        signupMode: "open" as const,
      }),
      sealMail: async () => new Uint8Array([1]),
      deliverMail: async () => {},
    };
    const traced = createNativePasswordHandler({
      pool: tracedPool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: tracePorts,
    });
    const publicResponse = await traced.handle(
      new Request(`${origin}/api/auth/v1/get-session?disableRefresh=true`, {
        headers: { origin, cookie },
      }),
    );
    expect(publicResponse.headers.get("cache-control")).toBe("no-store");
    const publicSession = await publicResponse.json();
    expect(publicSession.user.email).toBe(email);
    expect(publicSession.user.recoveryAvailable).toBe(true);
    expect(publicSession.session).not.toHaveProperty("token");
    const publicLookups = statements.filter((query) => /from\s+"session"/iu.test(query)).length;
    statements.length = 0;
    const privateSession = await traced.validateSession(cookie);
    expect(privateSession).toEqual({
      user: { id: publicSession.user.id, email },
      session: { id: publicSession.session.id, expiresAt: publicSession.session.expiresAt },
    });
    const privateLookups = statements.filter((query) => /from\s+"session"/iu.test(query)).length;
    // Internal validation must still exercise Better Auth's HTTP database limiter.
    expect(statements.some((query) => /"rateLimit"/u.test(query))).toBe(true);
    expect(privateLookups).toBe(1);
    expect(publicLookups).toBeGreaterThan(privateLookups);
    const brokenDiagnostics = createNativeLatencyProfile({
      clock: () => {
        throw new Error("synthetic-diagnostic-failure");
      },
      emit: () => {
        throw new Error("synthetic-diagnostic-failure");
      },
    });
    const diagnosed = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      latency: brokenDiagnostics,
      ports: tracePorts,
    });
    expect(await diagnosed.validateSession(cookie)).toEqual(privateSession);
    expect(await diagnosed.validateSession("")).toBeNull();
    expect(() => brokenDiagnostics.finish("active")).not.toThrow();
    await pool.query('update "rateLimit" set "count"=100');
    await expect(traced.validateSession(cookie)).rejects.toThrow("native_auth_unavailable");
    await pool.query('delete from "rateLimit"');
    expect(await traced.validateSession("")).toBeNull();
    expect(await traced.validateSession("__Host-omh_native.session_token=invalid")).toBeNull();
    const expiredLogin = await request("/sign-in/email", { email, password });
    expect(expiredLogin.status).toBe(200);
    const expiredCookie = expiredLogin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const expiringSession = await traced.validateSession(expiredCookie);
    if (!expiringSession) throw new Error("missing_expiring_session");
    await pool.query(
      `update "session" set "expiresAt"=current_timestamp - interval '1 second' where id=$1`,
      [expiringSession.session.id],
    );
    expect(await traced.validateSession(expiredCookie)).toBeNull();
    const expiredPublic = await handler.handle(
      new Request(`${origin}/api/auth/v1/get-session?disableRefresh=true`, {
        headers: { origin, cookie: expiredCookie },
      }),
    );
    expect(await expiredPublic.json()).toBeNull();
    expect(expiredPublic.headers.getSetCookie().length).toBeGreaterThan(0);
    const lockLogin = await request("/sign-in/email", { email, password });
    expect(lockLogin.status).toBe(200);
    const lockCookie = lockLogin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const lockSession = await traced.validateSession(lockCookie);
    if (!lockSession) throw new Error("missing_lock_session");
    const expiresDuringWait = Date.now() + 2_000;
    await pool.query('update "session" set "expiresAt"=$2 where id=$1', [
      lockSession.session.id,
      new Date(expiresDuringWait),
    ]);
    const beforeBlockedLimit = await pool.query<{ total: string }>(
      'select coalesce(sum("count"),0)::text as total from "rateLimit"',
    );
    const blocker = await pool.connect();
    let blockedResult: ReturnType<typeof traced.validateSession> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from native_user_policy where user_id=$1 for update", [
        lockSession.user.id,
      ]);
      blockedResult = traced.validateSession(lockCookie);
      let observedBlocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await pool.query<{ blocked: boolean }>(
          `select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%from native_session_policy s join native_user_policy p%') as blocked`,
        );
        if (status.rows[0]?.blocked) {
          observedBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlocked).toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresDuringWait - Date.now() + 50)),
      );
      await blocker.query("commit");
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
    expect(await blockedResult).toBeNull();
    await pool.query('delete from "session" where id=$1', [lockSession.session.id]);
    const afterBlockedLimit = await pool.query<{ total: string }>(
      'select coalesce(sum("count"),0)::text as total from "rateLimit"',
    );
    expect(Number(afterBlockedLimit.rows[0]?.total)).toBeGreaterThan(
      Number(beforeBlockedLimit.rows[0]?.total),
    );
    let authorityReads = 0;
    const raced = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        ...tracePorts,
        currentAuthority: async () => ({
          ...(await tracePorts.currentAuthority()),
          enabled: ++authorityReads === 1,
        }),
      },
    });
    await expect(raced.validateSession(cookie)).rejects.toThrow("native_auth_unavailable");
    expect(authorityReads).toBe(2);
    let injected = false;
    const failurePool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query")
              return async (text: string, parameters?: unknown[]) => {
                if (typeof text === "string" && /from\s+"user"/iu.test(text)) {
                  injected = true;
                  return target.query("select $1::integer", ["synthetic-private-sql-marker"]);
                }
                return target.query(text, parameters);
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const failureHandler = createNativePasswordHandler({
      pool: failurePool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
      },
    });
    const diagnostics = vi.spyOn(console, "error");
    const failedSession = await failureHandler.handle(
      new Request(`${origin}/api/auth/v1/get-session`, { headers: { origin, cookie } }),
    );
    const reportedError = diagnostics.mock.calls
      .flat()
      .find((value: unknown) => value instanceof Error);
    const logged = diagnostics.mock.calls
      .flat()
      .map((value: unknown) => String(value))
      .join(" ");
    diagnostics.mockRestore();
    expect(injected).toBe(true);
    expect(failedSession.status).toBe(503);
    expect(await failedSession.text()).not.toContain("synthetic-private-sql-marker");
    expect(logged).not.toContain("synthetic-private-sql-marker");
    expect(reportedError).toMatchObject({
      message: "native_auth_database_unavailable",
      code: "22P02",
    });
    expect(reportedError).not.toHaveProperty("cause");
    expect(reportedError).not.toHaveProperty("detail");
    expect((await handler.validateSession(cookie))?.user.email).toBe(email);
    await pool.query(
      "update native_session_policy set authenticated_at=now()-interval '10 minutes'",
    );
    for (const originHeader of ["https://attacker.example", undefined, "null"]) {
      for (const [path, body] of [
        ["/reauthenticate", { password }],
        ["/enroll-recovery", {}],
        ["/unlink-account", { accountId: randomUUID() }],
      ] as const) {
        expect(
          (
            await handler.handle(
              new Request(`${origin}/api/auth/v1${path}`, {
                method: "POST",
                headers: {
                  ...(originHeader === undefined ? {} : { origin: originHeader }),
                  "content-type": "application/json",
                  "idempotency-key": randomUUID(),
                  cookie,
                },
                body: JSON.stringify(body),
              }),
            )
          ).status,
        ).toBe(403);
      }
    }
    expect(
      (
        await pool.query(
          "select authenticated_at > now()-interval '5 minutes' as fresh from native_session_policy",
        )
      ).rows[0].fresh,
    ).toBe(false);
    expect((await request("/reauthenticate", { password: "wrong-password" }, cookie)).status).toBe(
      403,
    );
    const reauthenticated = await request("/reauthenticate", { password }, cookie);
    expect(reauthenticated.status).toBe(200);
    expect(typeof (await reauthenticated.json()).authenticatedAt).toBe("string");
    expect(
      (
        await pool.query(
          "select authenticated_at > now()-interval '1 minute' as fresh from native_session_policy",
        )
      ).rows[0].fresh,
    ).toBe(true);
    expect((await request("/enroll-recovery", {}, cookie)).status).toBe(200);
    const recoveryVerification = messages.at(-1);
    if (!recoveryVerification) throw new Error("missing_recovery_verification");
    expect((await handler.handle(new Request(recoveryVerification.url))).status).toBeLessThan(400);
    const linkedMethod = await pool.query<{ id: string }>(
      `insert into "account" ("providerId", "accountId", "userId", "updatedAt")
       select 'google', 'origin-check-subject', id, current_timestamp from "user" where email=$1
       returning id::text`,
      [email],
    );
    const linkedMethodId = linkedMethod.rows[0]?.id;
    if (!linkedMethodId) throw new Error("missing_linked_method");
    expect((await request("/unlink-account", { accountId: linkedMethodId }, cookie)).status).toBe(
      200,
    );
    expect(
      (await pool.query('select 1 from "account" where id=$1', [linkedMethodId])).rowCount,
    ).toBe(0);
    expect((await request("/request-password-reset", { email })).status).toBe(200);
    expect(await dispatcher.dispatchOne()).toBe(true);
    expect(delivered).toHaveLength(2);
    const reset = messages.find((m) => m.kind === "password-reset");
    if (!reset) throw new Error("missing_reset");
    const resetResponse = await request("/reset-password", {
      token: reset.token,
      newPassword: "different-correct-password",
    });
    expect(resetResponse.status).toBe(200);
    expect(await (await get()).json()).toBeNull();
    expect(await handler.validateSession(cookie)).toBeNull();
    expect(
      (
        await request("/reset-password", {
          token: reset.token,
          newPassword: "different-correct-password",
        })
      ).status,
    ).toBe(400);
    const secondLogin = await request("/sign-in/email", {
      email,
      password: "different-correct-password",
    });
    expect(secondLogin.status).toBe(200);
    const secondCookie = secondLogin.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    expect((await request("/sign-out", {}, secondCookie)).status).toBe(200);
    expect(
      await (
        await handler.handle(
          new Request(`${origin}/api/auth/v1/get-session`, {
            headers: { origin, cookie: secondCookie },
          }),
        )
      ).json(),
    ).toBeNull();
    const user = await pool.query<{ id: string }>('select id from "user" where email=$1', [email]);
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("missing_test_user");
    const fence = await pool.connect();
    try {
      await fence.query("begin");
      await fence.query("select 1 from native_realm_policy for update");
      await fence.query(
        "update native_user_policy set status='suspended', revocation_epoch=revocation_epoch+1 where user_id=$1",
        [userId],
      );
      const inFlight = request("/sign-in/email", { email, password: "different-correct-password" });
      await fence.query("commit");
      expect((await inFlight).status).not.toBe(200);
      expect((await request("/request-password-reset", { email })).status).toBe(200);
      expect(messages.filter((m) => m.kind === "password-reset")).toHaveLength(1);
    } finally {
      fence.release();
    }
    vi.stubGlobal("window", {
      location: { origin },
      addEventListener() {},
      removeEventListener() {},
    });
    let browserCookie = "";
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", origin);
      if (browserCookie) headers.set("cookie", browserCookie);
      const response = await handler.handle(new Request(url, { ...init, headers }));
      const setCookie = response.headers.getSetCookie();
      if (setCookie.length) browserCookie = setCookie.map((v) => v.split(";", 1)[0]).join("; ");
      return response;
    });
    const browser = createNativeAuthBrowser();
    const browserEmail = `browser-${randomUUID()}@example.test`;
    expect(
      (
        await browser.signUp.email({
          email: browserEmail,
          password: "browser-password-long-123",
          name: "Browser",
        })
      ).error,
    ).toBeNull();
    const browserVerification = messages
      .filter((message) => message.kind === "verification")
      .at(-1);
    if (!browserVerification) throw new Error("missing_browser_verification");
    expect(
      (await handler.handle(new Request(browserVerification.url, { headers: { origin } }))).status,
    ).toBeLessThan(400);
    expect(
      (await browser.signIn.email({ email: browserEmail, password: "browser-password-long-123" }))
        .error,
    ).toBeNull();
    const browserSelf = (await browser.getSession()).data;
    expect(browserSelf?.user.email).toBe(browserEmail);
    expect(browserSelf?.user.recoveryAvailable).toBe(true);
    expect((await browser.signOut()).error).toBeNull();
    expect((await browser.getSession()).data).toBeNull();
    vi.unstubAllGlobals();
    await pool.query('delete from "rateLimit"');
    const customHandler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Custom Forms",
      secret: "test-secret-at-least-32-characters-long",
      allowedRedirectPaths: ["/signin", "/recover", "/join"],
      resetPasswordPath: "/recover",
      ports: {
        admitAttempt: async () => true,
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async (message) => {
          messages.push(message);
          return new Uint8Array([1]);
        },
        deliverMail: async () => {},
      },
    });
    const customRequest = (path: string, body: object, cookie = "") =>
      customHandler.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const customEmail = `custom-${randomUUID()}@example.test`;
    expect(
      (await customRequest("/sign-up/email", { email: customEmail, password, name: "Custom" }))
        .status,
    ).toBe(200);
    const customVerification = messages.at(-1);
    if (!customVerification) throw new Error("missing_custom_verification");
    expect(new URL(customVerification.url).searchParams.get("callbackURL")).toBe("/signin");
    const customVerified = await customHandler.handle(new Request(customVerification.url));
    expect(customVerified.status).toBe(302);
    expect(customVerified.headers.get("location")).toBe("/signin");
    const customLogin = await customRequest("/sign-in/email", { email: customEmail, password });
    expect(customLogin.status).toBe(200);
    const customCookie = customLogin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    for (const callbackURL of [undefined, "/join"] as const) {
      expect(
        (
          await customRequest(
            "/enroll-recovery",
            callbackURL === undefined ? {} : { callbackURL },
            customCookie,
          )
        ).status,
      ).toBe(200);
      const recovery = messages.at(-1);
      if (!recovery) throw new Error("missing_custom_recovery");
      expect(new URL(recovery.url).searchParams.get("callbackURL")).toBe(callbackURL ?? "/signin");
      const verifiedRecovery = await customHandler.handle(new Request(recovery.url));
      expect(verifiedRecovery.status).toBe(302);
      expect(verifiedRecovery.headers.get("location")).toBe(callbackURL ?? "/signin");
    }
    expect(
      (
        await customRequest("/sign-up/email", {
          email: `bad-${customEmail}`,
          password,
          name: "Invalid",
          callbackURL: "/login",
        })
      ).status,
    ).toBe(400);
    const brokenLimiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      trustedClientIdentity: async () => "diagnostic-test",
      latency: brokenDiagnostics,
    });
    expect(await brokenLimiter.admitAttempt(new Request(`${origin}/api/auth/v1/get-session`))).toBe(
      true,
    );
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      trustedClientIdentity: async () => "trusted-attacker",
    });
    const limitedHandler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: (req) => limiter.admitAttempt(req),
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async () => new Uint8Array([1]),
      },
    });
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        limitedHandler.handle(
          new Request(`${origin}/api/auth/v1/sign-in/email`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ email, password: "incorrect-password" }),
          }),
        ),
      ),
    );
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(1);
    expect(attempts.every((response) => response.status !== 200)).toBe(true);
    expect(
      JSON.stringify((await pool.query("select key_digest from native_password_rate_limit")).rows),
    ).not.toContain(email);
  } finally {
    vi.unstubAllGlobals();
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("refuses a sign-up whose callbackURL is the root path unless the owner allows that path, before anything is stored", async () => {
  // The root path passed the handler without the owner's allowance, then the mail gateway refused it after the
  // user and its verification mail were stored, so each retry replayed an undeliverable message.
  const db = await startTestPostgres();
  const schema = `native_root_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const origin = "https://app.example.test";
  const password = SHARED_TEST_PASSWORD;
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true, 1, 1)",
    );
    const handlerFor = (allowedRedirectPaths: string[]) =>
      createNativePasswordHandler({
        pool,
        canonicalOrigin: origin,
        applicationName: "Root Callback",
        secret: "test-secret-at-least-32-characters-long",
        allowedRedirectPaths,
        ports: {
          admitAttempt: async () => true,
          currentAuthority: async () => ({
            enabled: true,
            revocationEpoch: 1,
            configurationRevision: 1,
            signupMode: "open",
          }),
          sealMail: async () => new Uint8Array([1]),
          deliverMail: async () => {},
        },
      });
    const signUp = (handler: ReturnType<typeof handlerFor>, email: string) =>
      handler.handle(
        new Request(`${origin}/api/auth/v1/sign-up/email`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ email, password, name: "Root", callbackURL: "/" }),
        }),
      );
    const refusedEmail = `root-refused-${randomUUID()}@example.test`;
    const defaultPaths = ["/login", "/reset-password", "/accept-invitation"];
    expect((await signUp(handlerFor(defaultPaths), refusedEmail)).status).toBe(400);
    expect(
      (await pool.query('select count(*)::int as n from "user" where email = $1', [refusedEmail]))
        .rows[0],
    ).toEqual({ n: 0 });
    expect((await pool.query("select count(*)::int as n from native_mail_outbox")).rows[0]).toEqual(
      { n: 0 },
    );
    const allowedEmail = `root-allowed-${randomUUID()}@example.test`;
    expect((await signUp(handlerFor(["/", ...defaultPaths]), allowedEmail)).status).toBe(200);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("charges every password check of one account to that account, whichever client address sends it", async () => {
  // A stolen session cookie must not get a fresh budget per client address: reauthentication and password change
  // share one per-account budget of five attempts a minute, as sign-in allows.
  const db = await startTestPostgres();
  const schema = `native_account_budget_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const origin = "https://app.example.test";
  const password = SHARED_TEST_PASSWORD;
  let clientAddress = "198.51.100.10";
  const messages: Array<{ kind: string; url: string }> = [];
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true, 1, 1)",
    );
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      trustedClientIdentity: async () => clientAddress,
    });
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Account Budget",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: (request) => limiter.admitAttempt(request),
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async (message) => {
          messages.push(message);
          return new Uint8Array([1]);
        },
      },
    });
    const post = (path: string, body: object, cookie = "") =>
      handler.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const email = `budget-${randomUUID()}@example.test`;
    expect((await post("/sign-up/email", { email, password, name: "Budget" })).status).toBe(200);
    const verification = messages.at(-1);
    if (!verification) throw new Error("missing_budget_verification");
    expect((await handler.handle(new Request(verification.url))).status).toBeLessThan(400);
    const login = await post("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    // The budget is one minute of database time, so start the burst early in a minute to keep it inside one window.
    const clock = await pool.query<{ seconds: number }>(
      "select (extract(epoch from current_timestamp) % 60)::float8 as seconds",
    );
    const seconds = clock.rows[0]?.seconds ?? 0;
    if (seconds > 55) await new Promise((resolve) => setTimeout(resolve, (61 - seconds) * 1000));
    const reauthenticate = (address: string, guess: string) => {
      clientAddress = address;
      return post("/reauthenticate", { password: guess }, cookie);
    };
    for (let attempt = 1; attempt <= 5; attempt++)
      expect((await reauthenticate("198.51.100.10", `wrong-${attempt}`)).status).toBe(403);
    expect((await reauthenticate("198.51.100.10", "wrong-6")).status).toBe(429);
    // The same session from a second client address spends the same account budget.
    expect((await reauthenticate("203.0.113.20", "wrong-7")).status).toBe(429);
    clientAddress = "203.0.113.20";
    expect(
      (
        await post(
          "/change-password",
          { currentPassword: password, newPassword: "different-correct-password-2" },
          cookie,
        )
      ).status,
    ).toBe(429);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);

it("applies the existing sign-in e-mail budget across client addresses and restores access in the next window", async () => {
  const db = await startTestPostgres();
  const schema = `native_email_budget_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const origin = "https://app.example.test";
  const password = SHARED_TEST_PASSWORD;
  let clientAddress = "198.51.100.10";
  const messages: Array<{ kind: string; url: string }> = [];
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true, 1, 1)",
    );
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      trustedClientIdentity: async () => clientAddress,
    });
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "E-mail Budget",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: (request) => limiter.admitAttempt(request),
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async (message) => {
          messages.push(message);
          return new Uint8Array([1]);
        },
      },
    });
    const post = (path: string, body: object) =>
      handler.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const email = `budget-${randomUUID()}@example.test`;
    expect((await post("/sign-up/email", { email, password, name: "Budget" })).status).toBe(200);
    const verification = messages.at(-1);
    if (!verification) throw new Error("missing_verification");
    expect((await handler.handle(new Request(verification.url))).status).toBeLessThan(400);
    const clock = await pool.query<{ seconds: number }>(
      "select (extract(epoch from current_timestamp) % 60)::float8 as seconds",
    );
    const seconds = clock.rows[0]?.seconds ?? 0;
    if (seconds > 55) await new Promise((resolve) => setTimeout(resolve, (61 - seconds) * 1000));
    expect((await post("/sign-in/email", { email, password })).status).toBe(200);
    const bucket = nativeRateBucketDigest(
      "private-rate-limit-secret-32-characters",
      "email:/sign-in/email",
      email,
    );
    const filled = await pool.query(
      "update native_password_rate_limit set count = 5 where key_digest = $1 and count = 1",
      [bucket],
    );
    expect(filled.rowCount).toBe(1);
    clientAddress = "203.0.113.66";
    expect((await post("/sign-in/email", { email: email.toUpperCase(), password })).status).toBe(
      429,
    );
    await pool.query(
      "update native_password_rate_limit set window_start = window_start - 1 where key_digest = $1",
      [bucket],
    );
    expect((await post("/sign-in/email", { email, password })).status).toBe(200);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);

it("counts one IPv6 /64 as one client in the SQL limiter, while another prefix keeps its own budget", async () => {
  const db = await startTestPostgres();
  const schema = `native_ipv6_budget_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  let clientAddress = "2001:db8:1:2::1";
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      trustedClientIdentity: async () => clientAddress,
    });
    const signIn = (address: string) => {
      clientAddress = address;
      return limiter.admitAttempt(
        new Request("https://app.example.test/api/auth/v1/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
    };
    // The burst must stay inside one minute window, so start it early in a minute.
    const clock = await pool.query<{ seconds: number }>(
      "select (extract(epoch from current_timestamp) % 60)::float8 as seconds",
    );
    const seconds = clock.rows[0]?.seconds ?? 0;
    if (seconds > 55) await new Promise((resolve) => setTimeout(resolve, (61 - seconds) * 1000));
    // Five sign-ins fit the sign-in budget of one client; the sixth comes from another address of the same /64.
    for (let attempt = 1; attempt <= 5; attempt++)
      expect(await signIn(`2001:db8:1:2::${attempt}`)).toBe(true);
    expect(await signIn("2001:db8:1:2:ffff::6")).toBe(false);
    expect(await signIn("2001:db8:1:3::1")).toBe(true);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);

it("keeps the password and sessions unchanged when a password change fails after its writes", async () => {
  // Better Auth writes the new password and replaces the sessions inside the handler transaction. A failure after
  // those writes must roll them back, so the refused answer and the stored state agree.
  const db = await startTestPostgres();
  const schema = `native_change_error_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const origin = "https://app.example.test";
  const password = SHARED_TEST_PASSWORD;
  const messages: Array<{ kind: string; url: string }> = [];
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true, 1, 1)",
    );
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Change Failure",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async (message) => {
          messages.push(message);
          return new Uint8Array([1]);
        },
      },
    });
    const post = (path: string, body: object, cookie = "") =>
      handler.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const email = `change-error-${randomUUID()}@example.test`;
    expect((await post("/sign-up/email", { email, password, name: "Change" })).status).toBe(200);
    const verification = messages.at(-1);
    if (!verification) throw new Error("missing_change_error_verification");
    expect((await handler.handle(new Request(verification.url))).status).toBeLessThan(400);
    const login = await post("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const userId = (
      await pool.query<{ id: string }>('select id from "user" where email = $1', [email])
    ).rows[0]?.id;
    if (!userId) throw new Error("missing_change_error_user");
    const state = async () =>
      (
        await pool.query<{ password: string | null; sessions: string }>(
          `select (select password from "account" where "userId" = $1 and "providerId" = 'credential') as password,
                  (select count(*)::text from "session" where "userId" = $1) as sessions`,
          [userId],
        )
      ).rows[0];
    const before = await state();
    // No session row is created after the password is written and the others are removed. The failure is thrown,
    // not answered, so the handler rolls the transaction back and answers 503.
    await pool.query(
      "create function refuse_new_session() returns trigger language plpgsql as $$ begin return null; end $$",
    );
    await pool.query(
      'create trigger refuse_new_session before insert on "session" for each row execute function refuse_new_session()',
    );
    let changed;
    try {
      changed = await post(
        "/change-password",
        {
          currentPassword: password,
          newPassword: "different-correct-password-2",
          revokeOtherSessions: true,
        },
        cookie,
      );
    } finally {
      await pool.query('drop trigger refuse_new_session on "session"');
    }
    expect(changed.status).toBe(503);
    expect(await state()).toEqual(before);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);

it("keeps the password and sessions unchanged when Better Auth answers 500 after writing the password, and still counts the attempt", async () => {
  // Better Auth writes the new password before its 500. The handler rolls that write back to its savepoint, so the
  // refused answer and the stored account agree, while the attempt admitted before the savepoint is committed.
  const db = await startTestPostgres();
  const schema = `native_change_500_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const origin = "https://app.example.test";
  const secret = "test-secret-at-least-32-characters-long";
  const password = SHARED_TEST_PASSWORD;
  const messages: Array<{ kind: string; url: string }> = [];
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true, 1, 1)",
    );
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Change Server Error",
      secret,
      ports: {
        admitAttempt: async () => true,
        isProviderUsable: async () => true,
        deliverMail: async () => {},
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async (message) => {
          messages.push(message);
          return new Uint8Array([1]);
        },
      },
    });
    const post = (path: string, body: object, cookie = "") =>
      handler.handle(
        new Request(`${origin}/api/auth/v1${path}`, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const email = `change-500-${randomUUID()}@example.test`;
    expect((await post("/sign-up/email", { email, password, name: "Change" })).status).toBe(200);
    const verification = messages.at(-1);
    if (!verification) throw new Error("missing_change_500_verification");
    expect((await handler.handle(new Request(verification.url))).status).toBeLessThan(400);
    const login = await post("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const userId = (
      await pool.query<{ id: string }>('select id from "user" where email = $1', [email])
    ).rows[0]?.id;
    if (!userId) throw new Error("missing_change_500_user");
    const state = async () =>
      (
        await pool.query<{ password: string | null; sessions: string }>(
          `select (select password from "account" where "userId" = $1 and "providerId" = 'credential') as password,
                  (select count(*)::text from "session" where "userId" = $1) as sessions`,
          [userId],
        )
      ).rows[0];
    const attempts = async () =>
      (
        await pool.query<{ count: number }>(
          "select count::int as count from native_password_rate_limit where key_digest = $1",
          [nativeRateBucketDigest(secret, "account-password", userId)],
        )
      ).rows[0]?.count ?? 0;
    const before = await state();
    const counted = await attempts();
    failNextChange.armed = true;
    const changed = await post(
      "/change-password",
      {
        currentPassword: password,
        newPassword: "different-correct-password-2",
        revokeOtherSessions: true,
      },
      cookie,
    );
    expect(changed.status).toBe(500);
    expect(await state()).toEqual(before);
    expect(await attempts()).toBe(counted + 1);
    expect((await post("/sign-in/email", { email, password })).status).toBe(200);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);
