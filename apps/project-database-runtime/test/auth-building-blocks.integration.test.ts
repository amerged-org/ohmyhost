import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { expect, it } from "vitest";

import {
  createCustomerAuth,
  createCustomerAuthOptions,
  createCustomerAuthPostgresPool,
} from "../../../packages/customer-auth-better-auth/src/runtime.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createProjectDatabaseHttpWorker } from "../src/http-worker.js";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ORIGIN = "https://auth.example.test";
const SECRET = randomBytes(32).toString("hex");
const PASSWORD = randomBytes(24).toString("hex");

function request(path: string, body?: Record<string, unknown>, cookie?: string) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: ORIGIN,
      "cf-connecting-ip": "192.0.2.42",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function bridgeRequest(path: string, body?: Record<string, unknown>, cookie?: string) {
  const result = request(path, body, cookie);
  result.headers.set("x-ohmyhost-project-id", PROJECT_ID);
  result.headers.set("x-ohmyhost-auth-url", ORIGIN);
  result.headers.set("x-ohmyhost-auth-secret", SECRET);
  result.headers.set("x-ohmyhost-app-name", "Building Blocks");
  return result;
}

function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function mailEndpoint() {
  const received: Record<string, unknown>[] = [];
  const server: Server = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += String(chunk);
    received.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(202);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test mail port");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    received,
    origin,
    // This test adapter exercises the real HTTP protocol; it is never a selectable provider.
    binding: { fetch: (input: Request) => fetch(new Request(`${origin}/v1/send`, input)) },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const AUTH_MIGRATION = new URL(
  "../../../packages/customer-auth-better-auth/migrations/20260822000000_better_auth.sql",
  import.meta.url,
);
const AUTH_UPGRADE = new URL(
  "../../../packages/customer-auth-better-auth/upgrades/20261028000000_better_auth_1_7_7_account_issuer.sql",
  import.meta.url,
);

async function installAuthSchema(pool: Pool) {
  await pool.query(await readFile(AUTH_MIGRATION, "utf8"));
}

it("keeps real project auth sessions usable without Mail and fails only operations that send email", async () => {
  const db = await startTestPostgres();
  const mail = await mailEndpoint();
  try {
    await installAuthSchema(db.pool);
    const worker = createProjectDatabaseHttpWorker({ sharedPool: db.pool });
    const base = {
      DATABASE_CONNECTION_STRING: db.pool.options.connectionString as string,
      PROJECT_ID,
    };
    const configured = { ...base, OHMYHOST_MAIL_GATEWAY: mail.binding };
    const signupRequest = bridgeRequest("/sign-up/email", {
      name: "Existing User",
      email: "existing@example.test",
      password: PASSWORD,
    });
    signupRequest.headers.set("x-ohmyhost-mail-key", "customer-project-mail-key");
    expect((await worker.fetch(signupRequest, configured)).status).toBe(200);
    expect(mail.received).toHaveLength(1);
    const unverifiedSignin = await worker.fetch(
      bridgeRequest("/sign-in/email", { email: "existing@example.test", password: PASSWORD }),
      base,
    );
    expect(unverifiedSignin.status).toBe(403);
    expect(await unverifiedSignin.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(mail.received).toHaveLength(1);
    const verifyUrl = String(mail.received[0]?.["text"]).replace("Verify your email: ", "");
    const verify = bridgeRequest(
      new URL(verifyUrl).pathname.replace("/api/auth", "") + new URL(verifyUrl).search,
    );
    expect((await worker.fetch(verify, base)).status).toBe(302);

    const signin = await worker.fetch(
      bridgeRequest("/sign-in/email", { email: "existing@example.test", password: PASSWORD }),
      base,
    );
    expect(signin.status).toBe(200);
    expect(signin.headers.get("set-cookie")).toContain("Secure");
    expect(signin.headers.get("set-cookie")).toContain("HttpOnly");
    const sessionCookie = cookie(signin);
    const session = await worker.fetch(
      bridgeRequest("/get-session", undefined, sessionCookie),
      base,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { email: "existing@example.test", emailVerified: true },
    });
    expect(mail.received).toHaveLength(1);

    const reset = await worker.fetch(
      bridgeRequest("/request-password-reset", { email: "existing@example.test" }),
      base,
    );
    expect(reset.status).toBe(503);
    expect(await reset.json()).toMatchObject({ code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED" });
    expect((await db.pool.query('SELECT count(*)::int n FROM auth."verification"')).rows).toEqual([
      { n: 0 },
    ]);
    const signup = await worker.fetch(
      bridgeRequest("/sign-up/email", {
        name: "Needs Verification",
        email: "unverified@example.test",
        password: PASSWORD,
      }),
      base,
    );
    expect(signup.status).toBe(503);
    expect(await signup.json()).toMatchObject({ code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED" });
    expect(
      (
        await db.pool.query('SELECT count(*)::int n FROM auth."user" WHERE email=$1', [
          "unverified@example.test",
        ])
      ).rows,
    ).toEqual([{ n: 0 }]);
    const malformedMail = bridgeRequest("/get-session", undefined, sessionCookie);
    malformedMail.headers.set("x-ohmyhost-mail-key", "short");
    expect((await worker.fetch(malformedMail, configured)).status).toBe(200);
    const foreign = bridgeRequest("/get-session", undefined, sessionCookie);
    foreign.headers.set("x-ohmyhost-project-id", "01ARZ3NDEKTSV4RRFFQ69G5FAX");
    expect((await worker.fetch(foreign, base)).status).toBe(503);
    const hostile = bridgeRequest("/sign-out", {}, sessionCookie);
    hostile.headers.set("origin", "https://other.example.test");
    expect((await worker.fetch(hostile, base)).status).toBe(403);
    expect((await worker.fetch(bridgeRequest("/sign-out", {}, sessionCookie), base)).status).toBe(
      200,
    );
    expect(
      await (
        await worker.fetch(bridgeRequest("/get-session", undefined, sessionCookie), base)
      ).json(),
    ).toBeNull();
  } finally {
    await mail.close();
    await db.stop();
  }
}, 30_000);

it("accepts a customer-owned sender independently and initializes without one for non-mail operations", async () => {
  const db = await startTestPostgres();
  const mail = await mailEndpoint();
  const authPool = createCustomerAuthPostgresPool(db.pool.options.connectionString as string);
  try {
    await installAuthSchema(db.pool);
    const common = {
      appName: "Customer Sender",
      publicOrigin: ORIGIN,
      database: authPool,
      secret: SECRET,
    };
    const withoutSender = createCustomerAuth(common);
    expect(await (await withoutSender.handler(request("/get-session"))).json()).toBeNull();
    const signupWithoutSender = await withoutSender.handler(
      request("/sign-up/email", {
        name: "Needs Sender",
        email: "needs-sender@example.test",
        password: PASSWORD,
      }),
    );
    expect(signupWithoutSender.status).toBe(503);
    expect(await signupWithoutSender.json()).toMatchObject({
      code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED",
    });
    expect(
      (
        await db.pool.query('SELECT count(*)::int n FROM auth."user" WHERE email=$1', [
          "needs-sender@example.test",
        ])
      ).rows,
    ).toEqual([{ n: 0 }]);

    const customerAuth = createCustomerAuth({
      ...common,
      email: {
        async send(message) {
          const response = await fetch(`${mail.origin}/customer-sender`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message),
          });
          if (response.status !== 202) throw new Error("Customer sender rejected email");
        },
      },
    });
    expect(
      (
        await customerAuth.handler(
          request("/sign-up/email", {
            name: "Custom Sender User",
            email: "custom-sender@example.test",
            password: PASSWORD,
          }),
        )
      ).status,
    ).toBe(200);
    expect(mail.received).toHaveLength(1);
    expect(mail.received[0]).toMatchObject({
      kind: "verification",
      to: "custom-sender@example.test",
    });
    const withoutSenderOptions = createCustomerAuthOptions(common);
    expect(withoutSenderOptions.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(withoutSenderOptions.emailVerification?.sendOnSignIn).toBe(false);
    const unverifiedSignin = await withoutSender.handler(
      request("/sign-in/email", { email: "custom-sender@example.test", password: PASSWORD }),
    );
    expect(unverifiedSignin.status).toBe(403);
    expect(await unverifiedSignin.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(unverifiedSignin.headers.get("set-cookie")).toBeNull();
    expect(mail.received).toHaveLength(1);
    expect((await db.pool.query('SELECT count(*)::int n FROM auth."session"')).rows).toEqual([
      { n: 0 },
    ]);
    expect((await db.pool.query('SELECT count(*)::int n FROM auth."verification"')).rows).toEqual([
      { n: 0 },
    ]);
    const verification = await withoutSender.handler(
      new Request(String(mail.received[0]?.["url"]), { headers: { origin: ORIGIN } }),
    );
    expect(verification.status).toBe(302);
    const signin = await withoutSender.handler(
      request("/sign-in/email", { email: "custom-sender@example.test", password: PASSWORD }),
    );
    expect(signin.status).toBe(200);
    expect(
      await (
        await withoutSender.handler(request("/get-session", undefined, cookie(signin)))
      ).json(),
    ).toMatchObject({ user: { email: "custom-sender@example.test", emailVerified: true } });
    expect(mail.received).toHaveLength(1);
    expect(
      (
        await customerAuth.handler(
          request("/request-password-reset", { email: "custom-sender@example.test" }),
        )
      ).status,
    ).toBe(200);
    expect(mail.received[1]).toMatchObject({
      kind: "password-reset",
      to: "custom-sender@example.test",
    });
    const resetToken = new URL(String(mail.received[1]?.["url"])).pathname.split("/").at(-1);
    const resetBody = { token: resetToken, newPassword: "new-correct-horse-staple-456" };
    const resetWithoutSender = await withoutSender.handler(request("/reset-password", resetBody));
    expect(resetWithoutSender.status).toBe(503);
    expect(await resetWithoutSender.json()).toMatchObject({
      code: "AUTH_EMAIL_SENDER_NOT_CONFIGURED",
    });
    expect((await customerAuth.handler(request("/reset-password", resetBody))).status).toBe(200);
    expect(mail.received[2]).toMatchObject({
      kind: "password-changed",
      to: "custom-sender@example.test",
      url: `${ORIGIN}/login`,
    });
    expect(
      await (
        await withoutSender.handler(request("/get-session", undefined, cookie(signin)))
      ).json(),
    ).toBeNull();
    expect(
      (
        await withoutSender.handler(
          request("/sign-in/email", {
            email: "custom-sender@example.test",
            password: resetBody.newPassword,
          }),
        )
      ).status,
    ).toBe(200);
  } finally {
    await authPool.end();
    await mail.close();
    await db.stop();
  }
}, 30_000);

it("refuses an auth schema created before Better Auth 1.7.7 until its account issuer is relaxed", async () => {
  const db = await startTestPostgres();
  const mail = await mailEndpoint();
  try {
    // The 1.7.1 contract's account table: a required issuer column and its unique index.
    const current = await readFile(AUTH_MIGRATION, "utf8");
    const before = current.replace(
      'auth."account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, ',
      'auth."account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "issuer" text not null, ',
    );
    expect(before).not.toBe(current);
    await db.pool.query(
      `${before}\ncreate unique index "account_issuer_accountId_uidx" on auth."account" ("issuer", "accountId");\n`,
    );
    const worker = createProjectDatabaseHttpWorker({ sharedPool: db.pool });
    const bindings = {
      DATABASE_CONNECTION_STRING: db.pool.options.connectionString as string,
      PROJECT_ID,
      OHMYHOST_MAIL_GATEWAY: mail.binding,
    };
    const signUp = (email: string) => {
      const signup = bridgeRequest("/sign-up/email", {
        name: "Upgraded",
        email,
        password: PASSWORD,
      });
      signup.headers.set("x-ohmyhost-mail-key", "customer-project-mail-key");
      return worker.fetch(signup, bindings);
    };
    expect((await signUp("before@example.test")).status).toBe(503);
    const upgrade = await readFile(AUTH_UPGRADE, "utf8");
    await db.pool.query(upgrade);
    await db.pool.query(upgrade);
    expect((await signUp("after@example.test")).status).toBe(200);
    expect(
      (
        await db.pool.query('SELECT count(*)::int n FROM auth."user" WHERE email = $1', [
          "before@example.test",
        ])
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect((await db.pool.query('SELECT "issuer" FROM auth."account"')).rows).toEqual([
      { issuer: null },
    ]);
    // A schema installed by the current contract needs no upgrade and the script leaves it unchanged.
    await db.pool.query("DROP SCHEMA auth CASCADE");
    await db.pool.query(current);
    await db.pool.query(upgrade);
    expect((await signUp("fresh@example.test")).status).toBe(200);
  } finally {
    await mail.close();
    await db.stop();
  }
}, 30_000);

it("revokes the existing sessions when a password is reset and the password-changed notice cannot be sent", async () => {
  // Better Auth changes the password, awaits the notice hook, and only then revokes the sessions. A rejected
  // notice must not leave the sessions of a reset account, possibly an attacker's, still valid.
  const db = await startTestPostgres();
  const authPool = createCustomerAuthPostgresPool(db.pool.options.connectionString as string);
  const NEW_PASSWORD = randomBytes(24).toString("hex");
  const sent: Array<{ kind: string; to: string; url: string }> = [];
  try {
    await installAuthSchema(db.pool);
    const auth = createCustomerAuth({
      appName: "Reset Notice",
      publicOrigin: ORIGIN,
      database: authPool,
      secret: SECRET,
      email: {
        async send(message) {
          if (message.kind === "password-changed") throw new Error("mail provider refused");
          sent.push(message);
        },
      },
    });
    const email = "reset-notice@example.test";
    expect(
      (await auth.handler(request("/sign-up/email", { name: "Reset", email, password: PASSWORD })))
        .status,
    ).toBe(200);
    const verification = sent.find((message) => message.kind === "verification");
    if (!verification) throw new Error("missing_verification_email");
    await auth.handler(new Request(verification.url));
    const signin = await auth.handler(request("/sign-in/email", { email, password: PASSWORD }));
    expect(signin.status).toBe(200);
    const cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(
      (await auth.handler(request("/request-password-reset", { email, redirectTo: "/login" })))
        .status,
    ).toBe(200);
    const reset = sent.findLast((message) => message.kind === "password-reset");
    if (!reset) throw new Error("missing_reset_email");
    const token = new URL(reset.url).pathname.split("/").at(-1) ?? "";
    expect(
      (await auth.handler(request("/reset-password", { newPassword: NEW_PASSWORD, token }))).status,
    ).toBe(200);
    expect(
      await (await auth.handler(request("/get-session", undefined, cookie))).json(),
    ).toBeNull();
    expect(
      (await auth.handler(request("/sign-in/email", { email, password: NEW_PASSWORD }))).status,
    ).toBe(200);
  } finally {
    await authPool.end();
    await db.stop();
  }
});
