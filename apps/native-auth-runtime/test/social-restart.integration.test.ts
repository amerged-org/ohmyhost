import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativePasswordHandler } from "../src/password-handler.js";
import { createNativeSocialHandler } from "../src/social-handler.js";

it("restarts pending third-party mailbox proof only with the same provider subject and current invitation authority", async () => {
  const db = await startTestPostgres();
  const schema = `native_restart_${randomUUID().replaceAll("-", "")}`;
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
      "insert into native_realm_policy (enabled,revocation_epoch,configuration_revision) values (true,1,1)",
    );
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = {
      ...keys.publicKey.export({ format: "jwk" }),
      kid: "key",
      alg: "RS256",
      use: "sig",
    };
    let email = "open@example.test";
    let subject = "open-sub";
    let nonce = "";
    let revocationEpoch = 1;
    let configurationRevision = 1;
    let signupMode: "open" | "invite-only" = "open";
    let failSeal = false;
    const messages: Array<{ url: string; token: string }> = [];
    vi.stubGlobal("fetch", async (target: string | URL | Request) => {
      const url = String(target instanceof Request ? target.url : target);
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [jwk] });
      if (url === "https://oauth2.googleapis.com/token") {
        const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const data = `${enc({ alg: "RS256", kid: "key" })}.${enc({ iss: "https://accounts.google.com", aud: "client", sub: subject, email, email_verified: true, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
        return Response.json({
          access_token: "provider-token",
          token_type: "bearer",
          id_token: `${data}.${sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64url")}`,
        });
      }
      throw new Error("unexpected_fetch");
    });
    const origin = "https://native-auth.example.test";
    const authority = async () => ({
      enabled: true,
      revocationEpoch,
      configurationRevision,
      signupMode,
    });
    const handler = createNativeSocialHandler({
      pool,
      canonicalOrigin: origin,
      allowedRedirectPaths: ["/signin", "/recover", "/join"],
      resetPasswordPath: "/recover",
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        currentAuthority: authority,
        provider: async () => ({
          enabled: true,
          clientId: "client",
          clientSecret: "secret",
          configurationRevision,
        }),
        sealMail: async (value) => {
          if (failSeal) throw new Error("synthetic-private-mail-token");
          messages.push(value);
          return new Uint8Array([1]);
        },
        deliverMail: async () => {},
        recordProviderSuccess: async () => {},
      },
    });
    const password = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      allowedRedirectPaths: ["/signin", "/recover", "/join"],
      resetPasswordPath: "/recover",
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        currentAuthority: authority,
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
      },
    });
    const login = async (invitationToken?: string, callbackURL?: string) => {
      await pool.query('delete from "rateLimit"');
      const start = await handler.handle(
        new Request(`${origin}/api/auth/v1/sign-in/social`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            provider: "google",
            ...(callbackURL === undefined ? {} : { callbackURL }),
            ...(invitationToken ? { invitationToken } : {}),
          }),
        }),
      );
      expect(start.status).toBe(200);
      const url = new URL((await start.json()).url);
      nonce = url.searchParams.get("nonce") ?? "";
      const state = url.searchParams.get("state");
      if (!state) throw new Error("missing_state");
      const cookie = start.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      return handler.handle(
        new Request(
          `${origin}/api/auth/v1/callback/google?code=test&state=${encodeURIComponent(state)}`,
          { headers: { cookie } },
        ),
      );
    };
    email = "unavailable@example.test";
    subject = "unavailable-sub";
    failSeal = true;
    const logs = vi.spyOn(console, "error");
    const unavailable = await login();
    const logged = logs.mock.calls
      .flat()
      .map((value: unknown) => String(value))
      .join(" ");
    logs.mockRestore();
    expect(logged).not.toContain("synthetic-private-mail-token");
    expect(unavailable.status).toBe(503);
    expect(
      unavailable.headers.getSetCookie().some((value) => value.includes("session_token=")),
    ).toBe(false);
    expect((await pool.query('select id from "user" where email=$1', [email])).rowCount).toBe(0);
    expect(
      (
        await pool.query('select id from "account" where "providerId"=$1 and "accountId"=$2', [
          "google",
          subject,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await pool.query("select user_id from native_social_pending where subject=$1", [subject]))
        .rowCount,
    ).toBe(0);
    expect((await pool.query('select id from "session"')).rowCount).toBe(0);
    expect(messages).toHaveLength(0);
    failSeal = false;
    email = "open@example.test";
    subject = "open-sub";
    expect(
      (await login(randomBytes(32).toString("base64url"), "/join")).headers.get("location"),
    ).toBe("/join?error=verification_required");
    expect(
      (
        await pool.query("select invitation_digest from native_social_pending where subject=$1", [
          subject,
        ])
      ).rows[0].invitation_digest,
    ).toBeNull();
    const first = messages.at(-1);
    if (!first) throw new Error("missing_first");
    expect(new URL(first.url).searchParams.get("callbackURL")).toBe("/join");
    const firstVerified = await password.handle(new Request(first.url));
    expect(firstVerified.status).toBe(302);
    expect(firstVerified.headers.get("location")).toBe("/join");
    configurationRevision = 2;
    await pool.query("update native_realm_policy set configuration_revision=2");
    expect((await login()).headers.get("location")).toBe("/signin?error=verification_required");
    const second = messages.at(-1);
    if (!second) throw new Error("missing_second");
    expect(second.token).not.toBe(first.token);
    expect(
      (
        await pool.query(
          'select recovery_verified_at from native_user_policy where user_id=(select id from "user" where email=$1)',
          [email],
        )
      ).rows[0].recovery_verified_at,
    ).toBeNull();
    expect((await password.handle(new Request(first.url))).status).toBe(400);
    expect(new URL(second.url).searchParams.get("callbackURL")).toBe("/signin");
    const restartedVerified = await password.handle(new Request(second.url));
    expect(restartedVerified.status).toBe(302);
    expect(restartedVerified.headers.get("location")).toBe("/signin");
    revocationEpoch = 2;
    await pool.query("update native_realm_policy set revocation_epoch=2");
    expect((await login()).headers.get("location")).toBe("/signin?error=verification_required");
    const third = messages.at(-1);
    if (!third) throw new Error("missing_third");
    expect(third.token).not.toBe(second.token);
    await pool.query(
      "update native_mail_challenge set expires_at=now()-interval '1 second' where token_digest=$1",
      [createHash("sha256").update(third.token).digest()],
    );
    expect((await login()).headers.get("location")).toBe("/signin?error=verification_required");
    const fourth = messages.at(-1);
    if (!fourth) throw new Error("missing_fourth");
    expect(fourth.token).not.toBe(third.token);
    expect((await password.handle(new Request(third.url))).status).toBe(400);
    signupMode = "invite-only";
    subject = "invite-sub";
    email = "invited@example.test";
    const user = randomUUID();
    const oldInvite = randomBytes(32).toString("base64url");
    await pool.query('insert into "user" (id,name,email) values ($1,$2,$3)', [
      user,
      "Invited",
      email,
    ]);
    await pool.query("insert into native_user_policy (user_id,status) values ($1,'pending')", [
      user,
    ]);
    await pool.query(
      "insert into native_invitation (user_id,token_digest,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,2,2,0,now()+interval '1 hour')",
      [user, createHash("sha256").update(oldInvite).digest()],
    );
    expect((await login(oldInvite)).headers.get("location")).toBe(
      "/signin?error=verification_required",
    );
    const oldVerification = messages.at(-1);
    if (!oldVerification) throw new Error("missing_invite_proof");
    configurationRevision = 3;
    await pool.query("update native_realm_policy set configuration_revision=3");
    const before = messages.length;
    expect((await login()).headers.get("location")).not.toBe("/signin?error=verification_required");
    expect(messages).toHaveLength(before);
    const freshInvite = randomBytes(32).toString("base64url");
    await pool.query(
      "update native_invitation set token_digest=$2,configuration_revision=3,expires_at=now()+interval '1 hour' where user_id=$1",
      [user, createHash("sha256").update(freshInvite).digest()],
    );
    expect((await login(freshInvite)).headers.get("location")).toBe(
      "/signin?error=verification_required",
    );
    expect(messages).toHaveLength(before + 1);
    expect((await password.handle(new Request(oldVerification.url))).status).toBe(400);
    await pool.query("update native_user_policy set status='suspended' where user_id=$1", [user]);
    expect((await login(freshInvite)).headers.get("location")).not.toBe(
      "/signin?error=verification_required",
    );
    expect(messages).toHaveLength(before + 1);
    const active = randomUUID();
    email = "existing@example.test";
    subject = "unlinked-sub";
    await pool.query('insert into "user" (id,name,email,"emailVerified") values ($1,$2,$3,true)', [
      active,
      "Existing",
      email,
    ]);
    await pool.query("insert into native_user_policy (user_id,status) values ($1,'active')", [
      active,
    ]);
    const sameEmail = await login();
    expect(
      new URL(sameEmail.headers.get("location") ?? "/", origin).searchParams.get("error"),
    ).toBe("account_not_linked");
    expect(new URL(sameEmail.headers.get("location") ?? "/", origin).pathname).toBe("/signin");
    expect(
      (
        await pool.query('select id from "account" where "providerId"=$1 and "accountId"=$2', [
          "google",
          subject,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
