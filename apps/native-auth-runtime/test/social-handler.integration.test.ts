import { randomUUID, randomBytes, createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativeSocialHandler } from "../src/social-handler.js";
import { createNativePasswordHandler } from "../src/password-handler.js";

it("runs the maintained GitHub OAuth handler with a provider HTTP fixture and PostgreSQL", async () => {
  const db = await startTestPostgres();
  const schema = `native_social_${randomUUID().replaceAll("-", "")}`;
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
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const attackerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let forgedSignature = false;
    const jwk = {
      ...keys.publicKey.export({ format: "jwk" }),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };
    let googleNonce = "";
    let providerEnabled = true;
    let flipOnToken = false;
    let failProjection = true;
    let googleSubject = "google-subject";
    let googleEmail = "user@gmail.com";
    const mail: Array<{ url: string }> = [];
    let githubId = 12345;
    let githubEmail = "primary@example.test";
    let signupMode: "open" | "invite-only" = "open";
    vi.stubGlobal("fetch", async (target: string | URL | Request, init?: RequestInit) => {
      const url = String(target instanceof Request ? target.url : target);
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });
      if (url === "https://oauth2.googleapis.com/token") {
        const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
        const unsigned = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({ iss: "https://accounts.google.com", aud: "client", sub: googleSubject, email: googleEmail, email_verified: true, name: "Google", nonce: googleNonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
        return Response.json({
          access_token: "provider-token",
          token_type: "bearer",
          id_token: `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), forgedSignature ? attackerKeys.privateKey : keys.privateKey).toString("base64url")}`,
        });
      }
      if (
        url === "https://github.com/login/oauth/access_token" &&
        new URLSearchParams(String(init?.body)).get("code") === "bad-code"
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (url === "https://github.com/login/oauth/access_token") {
        if (flipOnToken) providerEnabled = false;
        return Response.json({
          access_token: "provider-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (url === "https://api.github.com/user")
        return Response.json({ id: githubId, login: "tester", email: "other@example.test" });
      if (url === "https://api.github.com/user/emails")
        return Response.json([
          { email: githubEmail, primary: true, verified: true },
          { email: "other@example.test", primary: false, verified: true },
        ]);
      throw new Error("unexpected_test_fetch");
    });
    const origin = "https://native-auth.example.test";
    const successes: Array<{
      provider: string;
      configurationRevision: number;
      revocationEpoch: number;
    }> = [];
    const handler = createNativeSocialHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        recordProviderSuccess: async (value) => {
          successes.push(value);
          if (failProjection) {
            failProjection = false;
            throw new Error("projection_unavailable");
          }
        },
        admitAttempt: async () => true,
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode,
        }),
        sealMail: async (message) => {
          mail.push(message);
          return new Uint8Array([1, 2]);
        },
        deliverMail: async () => {},
        provider: async () => ({
          enabled: providerEnabled,
          clientId: "client",
          clientSecret: "private-secret",
          configurationRevision: 1,
        }),
      },
    });
    const start = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    expect(start.status).toBe(200);
    const destination = new URL((await start.json()).url);
    expect(destination.searchParams.get("scope")).toBe("read:user user:email");
    const state = destination.searchParams.get("state");
    if (!state) throw new Error("missing_oauth_state");
    const cookie = start.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const callback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(successes).toEqual([
      { provider: "github", configurationRevision: 1, revocationEpoch: 1 },
    ]);
    expect(callback.headers.get("location")).toBe("/login");
    const githubSessionCookie = callback.headers
      .getSetCookie()
      .filter((v) => v.includes("session_token="))
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    expect(githubSessionCookie).toBeTruthy();
    const recoveryMessages: Array<{ url: string }> = [];
    const recoveryHandler = createNativePasswordHandler({
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
          signupMode,
        }),
        sealMail: async (message) => {
          recoveryMessages.push(message);
          return new Uint8Array([1]);
        },
        deliverMail: async () => {},
      },
    });
    const self = () =>
      recoveryHandler.handle(
        new Request(`${origin}/api/auth/v1/get-session`, {
          headers: { cookie: githubSessionCookie },
        }),
      );
    const beforeRecovery = await (await self()).json();
    expect(beforeRecovery.user).toMatchObject({ emailVerified: true, recoveryAvailable: false });
    expect(
      await (await recoveryHandler.handle(new Request(`${origin}/api/auth/v1/get-session`))).json(),
    ).toBeNull();
    const foreignSchema = `native_foreign_${randomUUID().replaceAll("-", "")}`;
    await db.pool.query(`create schema ${foreignSchema}`);
    const foreignPool = new Pool({ connectionString, options: `-c search_path=${foreignSchema}` });
    try {
      await foreignPool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
      await foreignPool.query(
        "insert into native_realm_policy (enabled, revocation_epoch, configuration_revision) values (true,1,1)",
      );
      const foreignOrigin = "https://other-native-auth.example.test";
      const foreignHandler = createNativePasswordHandler({
        pool: foreignPool,
        canonicalOrigin: foreignOrigin,
        applicationName: "Other Realm",
        secret: "other-realm-secret-at-least-32-characters-long",
        ports: {
          admitAttempt: async () => true,
          currentAuthority: async () => ({
            enabled: true,
            revocationEpoch: 1,
            configurationRevision: 1,
            signupMode: "open",
          }),
          sealMail: async () => {
            throw new Error("unexpected_foreign_mail");
          },
          deliverMail: async () => {},
        },
      });
      expect(
        await (
          await foreignHandler.handle(
            new Request(`${foreignOrigin}/api/auth/v1/get-session`, {
              headers: { cookie: githubSessionCookie },
            }),
          )
        ).json(),
      ).toBeNull();
    } finally {
      await foreignPool.end();
      await db.pool.query(`drop schema ${foreignSchema} cascade`);
    }
    await pool.query("update native_user_policy set status='suspended' where user_id=$1", [
      beforeRecovery.user.id,
    ]);
    expect(await (await self()).json()).toBeNull();
    await pool.query("update native_user_policy set status='active' where user_id=$1", [
      beforeRecovery.user.id,
    ]);
    const enroll = await recoveryHandler.handle(
      new Request(`${origin}/api/auth/v1/enroll-recovery`, {
        method: "POST",
        headers: {
          origin,
          cookie: githubSessionCookie,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: "{}",
      }),
    );
    expect(enroll.status).toBe(200);
    expect((await (await self()).json()).user.recoveryAvailable).toBe(false);
    const recoveryMessage = recoveryMessages[0];
    if (!recoveryMessage) throw new Error("missing_recovery_message");
    expect((await recoveryHandler.handle(new Request(recoveryMessage.url))).status).toBeLessThan(
      400,
    );
    expect(
      (
        await pool.query(
          'select p.recovery_verified_at from native_user_policy p join "user" u on u.id=p.user_id where u.email=$1',
          ["primary@example.test"],
        )
      ).rows[0].recovery_verified_at,
    ).not.toBeNull();
    expect((await (await self()).json()).user.recoveryAvailable).toBe(true);
    expect((await recoveryHandler.validateSession(githubSessionCookie))?.user).toEqual({
      id: beforeRecovery.user.id,
      email: "primary@example.test",
    });
    expect((await recoveryHandler.handle(new Request(recoveryMessage.url))).status).toBe(400);
    await pool.query(
      "update native_session_policy set authenticated_at = now() - interval '10 minutes'",
    );
    const staleLink = await handler.handle(
      new Request(`${origin}/api/auth/v1/link-social`, {
        method: "POST",
        headers: { origin, cookie: githubSessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    expect(staleLink.status).toBe(403);
    expect((await staleLink.json()).error).toBe("reauthentication_required");
    await pool.query('delete from "rateLimit"');
    const reauth = await handler.handle(
      new Request(`${origin}/api/auth/v1/reauthenticate`, {
        method: "POST",
        headers: { origin, cookie: githubSessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    expect(reauth.status).toBe(200);
    const reauthUrl = new URL((await reauth.json()).url);
    const reauthState = reauthUrl.searchParams.get("state");
    if (!reauthState) throw new Error("missing_reauth_state");
    const reauthCookie = [
      githubSessionCookie,
      ...reauth.headers.getSetCookie().map((v) => v.split(";", 1)[0]),
    ].join("; ");
    const reauthCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(reauthState)}`,
        { headers: { cookie: reauthCookie } },
      ),
    );
    expect(reauthCallback.headers.get("location")).toBe("/login");
    const refreshedSession = reauthCallback.headers
      .getSetCookie()
      .filter((v) => v.includes("session_token="))
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    expect(refreshedSession).toBeTruthy();
    githubId = 99999;
    await pool.query('delete from "rateLimit"');
    const wrongReauth = await handler.handle(
      new Request(`${origin}/api/auth/v1/reauthenticate`, {
        method: "POST",
        headers: { origin, cookie: refreshedSession, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    expect(wrongReauth.status).toBe(200);
    const wrongState = new URL((await wrongReauth.json()).url).searchParams.get("state");
    if (!wrongState) throw new Error("missing_wrong_reauth_state");
    const wrongCookie = [
      refreshedSession,
      ...wrongReauth.headers.getSetCookie().map((v) => v.split(";", 1)[0]),
    ].join("; ");
    const successesBeforeWrong = successes.length;
    const wrongCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(wrongState)}`,
        { headers: { cookie: wrongCookie } },
      ),
    );
    expect(wrongCallback.headers.get("location")).not.toBe("/login");
    expect(successes).toHaveLength(successesBeforeWrong);
    expect(
      (
        await pool.query('select id from "account" where "providerId"=$1 and "accountId"=$2', [
          "github",
          "99999",
        ])
      ).rowCount,
    ).toBe(0);
    githubId = 12345;
    googleSubject = "linked-google-subject";
    googleEmail = "primary@example.test";
    await pool.query('delete from "rateLimit"');
    const expiringStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/link-social`, {
        method: "POST",
        headers: { origin, cookie: refreshedSession, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    const expiringState = new URL((await expiringStart.json()).url).searchParams.get("state");
    if (!expiringState) throw new Error("missing_expiring_link_state");
    const expiringCookie = [
      refreshedSession,
      ...expiringStart.headers.getSetCookie().map((v) => v.split(";", 1)[0]),
    ].join("; ");
    await pool.query(
      "update native_session_policy set authenticated_at=now()-interval '10 minutes'",
    );
    const expired = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(expiringState)}`,
        { headers: { cookie: expiringCookie } },
      ),
    );
    expect(expired.status).toBe(403);
    expect((await expired.json()).error).toBe("reauthentication_required");
    await pool.query("update native_session_policy set authenticated_at=now()");
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(expiringState)}`,
            { headers: { cookie: expiringCookie } },
          ),
        )
      ).status,
    ).toBe(403);
    await pool.query('delete from "rateLimit"');
    const linkStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/link-social`, {
        method: "POST",
        headers: { origin, cookie: refreshedSession, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    expect(linkStart.status).toBe(200);
    const linkUrl = new URL((await linkStart.json()).url);
    googleNonce = linkUrl.searchParams.get("nonce") ?? "";
    const linkState = linkUrl.searchParams.get("state");
    if (!linkState) throw new Error("missing_link_state");
    const linkCookie = [
      refreshedSession,
      ...linkStart.headers.getSetCookie().map((v) => v.split(";", 1)[0]),
    ].join("; ");
    const linkCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(linkState)}`,
        { headers: { cookie: linkCookie } },
      ),
    );
    expect(linkCallback.headers.get("location")).toBe("/login");
    const linked = await pool.query(
      'select u.email from "account" a join "user" u on u.id=a."userId" where a."providerId"=$1 and a."accountId"=$2',
      ["google", googleSubject],
    );
    expect(linked.rows[0]?.email).toBe("primary@example.test");
    googleSubject = "google-subject";
    googleEmail = "user@gmail.com";
    await pool.query('delete from "rateLimit"');
    const googleStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    expect(googleStart.status).toBe(200);
    const googleUrl = new URL((await googleStart.json()).url);
    googleNonce = googleUrl.searchParams.get("nonce") ?? "";
    expect(googleNonce.length).toBeGreaterThan(20);
    const googleState = googleUrl.searchParams.get("state");
    if (!googleState) throw new Error("missing_google_state");
    const googleCookie = googleStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const googleCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test-code&state=${encodeURIComponent(googleState)}`,
        { headers: { cookie: googleCookie } },
      ),
    );
    expect(googleCallback.status).toBe(302);
    expect(googleCallback.headers.get("location")).toBe("/login");
    const account = await pool.query(
      'select "accessToken", "refreshToken", "idToken" from "account"',
    );
    expect(account.rows).toEqual([
      { accessToken: null, refreshToken: null, idToken: null },
      { accessToken: null, refreshToken: null, idToken: null },
      { accessToken: null, refreshToken: null, idToken: null },
    ]);
    const methodsResponse = await recoveryHandler.handle(
      new Request(`${origin}/api/auth/v1/list-accounts`, { headers: { cookie: refreshedSession } }),
    );
    expect(methodsResponse.status).toBe(200);
    const methods = (await methodsResponse.json()) as Array<{ id: string; providerId: string }>;
    expect(methods.map((method) => method.providerId).sort()).toEqual(["github", "google"]);
    const unlink = (accountId: string) =>
      recoveryHandler.handle(
        new Request(`${origin}/api/auth/v1/unlink-account`, {
          method: "POST",
          headers: { origin, cookie: refreshedSession, "content-type": "application/json" },
          body: JSON.stringify({ accountId }),
        }),
      );
    const googleMethod = methods.find((method) => method.providerId === "google");
    const githubMethod = methods.find((method) => method.providerId === "github");
    if (!googleMethod || !githubMethod) throw new Error("missing_linked_method");
    expect((await unlink(googleMethod.id)).status).toBe(200);
    expect((await unlink(githubMethod.id)).status).toBe(409);
    githubId = 88888;
    await pool.query('delete from "rateLimit"');
    const sameEmailStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    const sameEmailState = new URL((await sameEmailStart.json()).url).searchParams.get("state");
    if (!sameEmailState) throw new Error("missing_same_email_state");
    const sameEmailCookie = sameEmailStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const sameEmailCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(sameEmailState)}`,
        { headers: { cookie: sameEmailCookie } },
      ),
    );
    expect(sameEmailCallback.headers.get("location")).not.toBe("/login");
    expect(
      (
        await pool.query('select id from "account" where "providerId"=$1 and "accountId"=$2', [
          "github",
          "88888",
        ])
      ).rowCount,
    ).toBe(0);
    githubId = 12345;
    expect(
      (await pool.query('select email from "user" where email=$1', ["primary@example.test"]))
        .rows[0].email,
    ).toBe("primary@example.test");
    expect(
      (await pool.query("select status, recovery_verified_at from native_user_policy limit 1"))
        .rows[0],
    ).toMatchObject({ status: "active" });
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
            { headers: { cookie } },
          ),
        )
      ).status,
    ).toBe(403);
    await pool.query('delete from "rateLimit"');
    googleSubject = "forged-nonce-subject";
    googleEmail = "forged@gmail.com";
    const invalidStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    const invalidUrl = new URL((await invalidStart.json()).url);
    const invalidState = invalidUrl.searchParams.get("state");
    if (!invalidState) throw new Error("missing_invalid_state");
    googleNonce = "wrong-nonce";
    const invalidCookie = invalidStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const successesBeforeInvalid = successes.length;
    const invalidCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(invalidState)}`,
        { headers: { cookie: invalidCookie } },
      ),
    );
    expect(invalidCallback.headers.get("location")).not.toBe("/login");
    expect(successes).toHaveLength(successesBeforeInvalid);
    googleNonce = invalidUrl.searchParams.get("nonce") ?? "";
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(invalidState)}`,
            { headers: { cookie: invalidCookie } },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await pool.query('select id from "account" where "providerId"=$1 and "accountId"=$2', [
          "google",
          googleSubject,
        ])
      ).rowCount,
    ).toBe(0);
    await pool.query('delete from "rateLimit"');
    googleSubject = "forged-signature-subject";
    const forgedStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    const forgedUrl = new URL((await forgedStart.json()).url);
    const forgedState = forgedUrl.searchParams.get("state");
    googleNonce = forgedUrl.searchParams.get("nonce") ?? "";
    if (!forgedState) throw new Error("missing_forged_state");
    const forgedCookie = forgedStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    forgedSignature = true;
    const forgedCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(forgedState)}`,
        { headers: { cookie: forgedCookie } },
      ),
    );
    forgedSignature = false;
    expect(forgedCallback.headers.get("location")).not.toBe("/login");
    expect(
      (
        await pool.query('select id from "account" where "providerId"=$1 and "accountId"=$2', [
          "google",
          googleSubject,
        ])
      ).rowCount,
    ).toBe(0);
    await pool.query('delete from "rateLimit"');
    const failStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    const failState = new URL((await failStart.json()).url).searchParams.get("state");
    if (!failState) throw new Error("missing_failure_state");
    const failCookie = failStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const failed = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=bad-code&state=${encodeURIComponent(failState)}`,
        { headers: { cookie: failCookie } },
      ),
    );
    expect(failed.headers.get("location")).not.toBe("/login");
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/github?code=good-code&state=${encodeURIComponent(failState)}`,
            { headers: { cookie: failCookie } },
          ),
        )
      ).status,
    ).toBe(403);
    await pool.query('delete from "rateLimit"');
    const deniedStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    const deniedState = new URL((await deniedStart.json()).url).searchParams.get("state");
    if (!deniedState) throw new Error("missing_denied_state");
    const deniedCookie = deniedStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const denied = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?error=access_denied&state=${encodeURIComponent(deniedState)}`,
        { headers: { cookie: deniedCookie } },
      ),
    );
    expect(denied.headers.get("location")).not.toBe("/login");
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/github?code=good-code&state=${encodeURIComponent(deniedState)}`,
            { headers: { cookie: deniedCookie } },
          ),
        )
      ).status,
    ).toBe(403);
    await pool.query('delete from "rateLimit"');
    const disabledStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    const disabledState = new URL((await disabledStart.json()).url).searchParams.get("state");
    if (!disabledState) throw new Error("missing_disabled_state");
    const disabledCookie = disabledStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    providerEnabled = false;
    const disabledCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(disabledState)}`,
        { headers: { cookie: disabledCookie } },
      ),
    );
    expect(disabledCallback.status).toBe(403);
    expect(await disabledCallback.json()).toEqual({ error: "provider_disabled" });
    providerEnabled = true;
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(disabledState)}`,
            { headers: { cookie: disabledCookie } },
          ),
        )
      ).status,
    ).toBe(403);
    await pool.query('delete from "rateLimit"');
    googleSubject = "external-subject";
    googleEmail = "thirdparty@example.test";
    const externalStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    const externalUrl = new URL((await externalStart.json()).url);
    googleNonce = externalUrl.searchParams.get("nonce") ?? "";
    const externalState = externalUrl.searchParams.get("state");
    if (!externalState) throw new Error("missing_external_state");
    const externalCookie = externalStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const successesBeforePending = successes.length;
    const externalCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(externalState)}`,
        { headers: { cookie: externalCookie } },
      ),
    );
    expect(externalCallback.status).toBe(302);
    expect(externalCallback.headers.get("location")).toBe("/login?error=verification_required");
    expect(successes).toHaveLength(successesBeforePending);
    expect(mail).toHaveLength(1);
    const externalUser = await pool.query<{ id: string }>('select id from "user" where email=$1', [
      googleEmail,
    ]);
    const externalId = externalUser.rows[0]?.id;
    if (!externalId) throw new Error("missing_external_user");
    expect(
      (await pool.query("select status from native_user_policy where user_id=$1", [externalId]))
        .rows[0].status,
    ).toBe("pending");
    const password = createNativePasswordHandler({
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
          signupMode,
        }),
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
      },
    });
    const verification = mail[0];
    if (!verification) throw new Error("missing_social_verification");
    expect((await password.handle(new Request(verification.url))).status).toBeLessThan(400);
    const verifiedPending = await pool.query(
      "select status,recovery_verified_at from native_user_policy where user_id=$1",
      [externalId],
    );
    expect(verifiedPending.rows[0].status).toBe("pending");
    expect(verifiedPending.rows[0].recovery_verified_at).not.toBeNull();
    await pool.query('delete from "rateLimit"');
    const freshStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/login" }),
      }),
    );
    expect(freshStart.status).toBe(200);
    const freshUrl = new URL((await freshStart.json()).url);
    googleNonce = freshUrl.searchParams.get("nonce") ?? "";
    const freshState = freshUrl.searchParams.get("state");
    if (!freshState) throw new Error("missing_fresh_state");
    const freshCookie = freshStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const freshCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(freshState)}`,
        { headers: { cookie: freshCookie } },
      ),
    );
    expect(freshCallback.headers.get("location")).toBe("/login");
    expect(
      (await pool.query("select status from native_user_policy where user_id=$1", [externalId]))
        .rows[0].status,
    ).toBe("active");
    const bypassUser = randomUUID();
    const bypassEmail = "owner-invited@example.test";
    const bypassInvite = randomBytes(32).toString("base64url");
    await pool.query('insert into "user" (id,name,email) values ($1,$2,$3)', [
      bypassUser,
      "Invited",
      bypassEmail,
    ]);
    await pool.query("insert into native_user_policy (user_id,status) values ($1,'pending')", [
      bypassUser,
    ]);
    await pool.query(
      "insert into native_invitation (token_digest,user_id,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,1,1,0,now()+interval '1 hour')",
      [createHash("sha256").update(bypassInvite).digest(), bypassUser],
    );
    const passwordMail: Array<{ url: string }> = [];
    const bypassHandler = createNativePasswordHandler({
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
          signupMode,
        }),
        sealMail: async (message) => {
          passwordMail.push(message);
          return new Uint8Array([1]);
        },
        deliverMail: async () => {},
      },
    });
    const bypassRequest = await bypassHandler.handle(
      new Request(`${origin}/api/auth/v1/send-verification-email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({ email: bypassEmail }),
      }),
    );
    expect(bypassRequest.status).toBe(200);
    const bypassVerification = passwordMail[0];
    if (!bypassVerification) throw new Error("missing_bypass_verification");
    expect((await bypassHandler.handle(new Request(bypassVerification.url))).status).toBe(400);
    expect(
      (await pool.query("select status from native_user_policy where user_id=$1", [bypassUser]))
        .rows[0].status,
    ).toBe("pending");
    await pool.query('delete from "rateLimit"');
    githubId = 77777;
    githubEmail = "provider-race@example.test";
    flipOnToken = false;
    providerEnabled = true;
    const raceStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    const raceState = new URL((await raceStart.json()).url).searchParams.get("state");
    if (!raceState) throw new Error("missing_race_state");
    const raceCookie = raceStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const beforeRace = successes.length;
    flipOnToken = true;
    const raceCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(raceState)}`,
        { headers: { cookie: raceCookie } },
      ),
    );
    flipOnToken = false;
    providerEnabled = true;
    expect(raceCallback.status).toBe(503);
    expect(successes).toHaveLength(beforeRace);
    expect((await pool.query('select id from "user" where email=$1', [githubEmail])).rowCount).toBe(
      0,
    );
    expect(
      (
        await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(raceState)}`,
            { headers: { cookie: raceCookie } },
          ),
        )
      ).status,
    ).toBe(403);
    signupMode = "invite-only";
    githubId = 55555;
    githubEmail = "invited@example.test";
    const invitedUser = randomUUID();
    const invitation = randomBytes(32).toString("base64url");
    await pool.query('insert into "user" (id,name,email) values ($1,$2,$3)', [
      invitedUser,
      "Invited",
      githubEmail,
    ]);
    await pool.query("insert into native_user_policy (user_id,status) values ($1,'pending')", [
      invitedUser,
    ]);
    await pool.query(
      "insert into native_invitation (token_digest,user_id,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,1,1,0,now()+interval '1 hour')",
      [createHash("sha256").update(invitation).digest(), invitedUser],
    );
    await pool.query('delete from "rateLimit"');
    const invitedStart = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-in/social`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/login",
          invitationToken: invitation,
        }),
      }),
    );
    expect(invitedStart.status).toBe(200);
    const invitedState = new URL((await invitedStart.json()).url).searchParams.get("state");
    if (!invitedState) throw new Error("missing_invite_state");
    const invitedCookie = invitedStart.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const invitedCallback = await handler.handle(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test&state=${encodeURIComponent(invitedState)}`,
        { headers: { cookie: invitedCookie } },
      ),
    );
    expect(invitedCallback.status).toBe(302);
    expect(invitedCallback.headers.get("location")).toBe("/login");
    const invited = await pool.query(
      "select status, recovery_verified_at from native_user_policy where user_id=$1",
      [invitedUser],
    );
    expect(invited.rows[0].status).toBe("active");
    expect(invited.rows[0].recovery_verified_at).not.toBeNull();
    expect(
      (
        await pool.query(
          'select "userId" from "account" where "providerId"=$1 and "accountId"=$2',
          ["github", String(githubId)],
        )
      ).rows[0].userId,
    ).toBe(invitedUser);
  } finally {
    vi.unstubAllGlobals();
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
