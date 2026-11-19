import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativePostgresPolicy } from "../src/policy.js";

it("serializes invitation, recovery, session and realm revocation against real PostgreSQL", async () => {
  const db = await startTestPostgres();
  const schema = `native_policy_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(
        new URL("../migrations/002-invitation-receipt-digest.sql", import.meta.url),
        "utf8",
      ),
    );
    let liveEpoch = 1;
    let liveRevision = 1;
    const policy = createNativePostgresPolicy(
      pool,
      {
        currentAuthority: async () => ({
          revocationEpoch: liveEpoch,
          configurationRevision: liveRevision,
          enabled: true,
        }),
      },
      "private-invitation-receipt-key-long-enough",
    );
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 1,
        configurationRevision: 1,
        enabled: true,
      }),
    ).toBe(true);
    const user = randomUUID();
    await pool.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
      user,
      "Example",
      "policy@example.test",
    ]);
    await pool.query("insert into native_user_policy (user_id, status) values ($1, 'pending')", [
      user,
    ]);
    const token = () => randomBytes(32).toString("base64url");
    const invitation = token();
    expect(
      await policy.issueMailChallenge(
        user,
        "password-reset",
        token(),
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);
    expect(await policy.issueInvitation(user, invitation, new Date(Date.now() + 60_000))).toBe(
      true,
    );
    expect(
      await policy.acceptInvitation({
        token: token(),
        password: "a-long-correct-password",
        requestId: randomUUID(),
      }),
    ).toBe(false);
    const acceptance = await Promise.all([
      policy.acceptInvitation({
        token: invitation,
        password: "a-long-correct-password",
        requestId: randomUUID(),
      }),
      policy.acceptInvitation({
        token: invitation,
        password: "a-long-correct-password",
        requestId: randomUUID(),
      }),
    ]);
    expect(acceptance.sort()).toEqual([false, true]);
    const session = {
      id: randomUUID(),
      userId: user,
      token: token(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await policy.insertSession(session)).toBe(true);
    const reset = token();
    expect(
      await policy.requestPasswordReset(
        "policy@example.test",
        reset,
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    const results = await Promise.all([
      policy.consumePasswordReset(reset, "a-long-correct-password"),
      policy.consumePasswordReset(reset, "a-long-correct-password"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    const account = await pool.query('select password from "account" where "userId" = $1', [user]);
    expect(
      await verifyPassword({ hash: account.rows[0].password, password: "a-long-correct-password" }),
    ).toBe(true);
    expect(
      (await pool.query('select id from "session" where "userId" = $1', [user])).rowCount,
    ).toBe(0);
    const stale = token();
    expect(
      await policy.issueMailChallenge(user, "password-reset", stale, new Date(Date.now() + 60_000)),
    ).toBe(true);
    expect(await policy.revokeUser(user, "suspended")).toBe(true);
    expect(await policy.consumePasswordReset(stale, "a-long-correct-password")).toBe(false);
    expect(await policy.insertSession({ ...session, id: randomUUID() })).toBe(false);
    expect(await policy.revokeUser(user, "active")).toBe(true);
    expect(await policy.consumePasswordReset(stale, "a-long-correct-password")).toBe(false);
    liveEpoch = 2;
    liveRevision = 2;
    expect(await policy.insertSession({ ...session, id: randomUUID() })).toBe(false);
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 2,
        configurationRevision: 2,
        enabled: false,
      }),
    ).toBe(true);
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 1,
        configurationRevision: 1,
        enabled: true,
      }),
    ).toBe(false);
    expect(await policy.insertSession({ ...session, id: randomUUID() })).toBe(false);
    liveRevision = 3;
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 2,
        configurationRevision: 3,
        enabled: true,
      }),
    ).toBe(true);
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 2,
        configurationRevision: 2,
        enabled: false,
      }),
    ).toBe(false);
    expect(await policy.insertSession({ ...session, id: randomUUID() })).toBe(true);
    await Promise.all([
      policy.applyRealmPolicy({ revocationEpoch: 2, configurationRevision: 4, enabled: true }),
      policy.applyRealmPolicy({ revocationEpoch: 3, configurationRevision: 5, enabled: false }),
    ]);
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 4,
        configurationRevision: 5,
        enabled: false,
      }),
    ).toBe(true);
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 3,
        configurationRevision: 5,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      await policy.applyRealmPolicy({
        revocationEpoch: 4,
        configurationRevision: 5,
        enabled: true,
      }),
    ).toBe(false);
    const finalRealm = await pool.query(
      "select revocation_epoch, configuration_revision, enabled from native_realm_policy",
    );
    expect(finalRealm.rows[0]).toMatchObject({
      revocation_epoch: "4",
      configuration_revision: "5",
      enabled: false,
    });
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
