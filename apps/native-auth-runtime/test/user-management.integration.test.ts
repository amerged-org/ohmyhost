import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativePostgresPolicy } from "../src/policy.js";
import {
  createNativeInvitationDispatcher,
  createNativeUserManagement,
} from "../src/user-management.js";

it("keeps owner changes, redacted audit, replay and invitation outbox atomic", async () => {
  const db = await startTestPostgres();
  const schema = `native_admin_${randomUUID().replaceAll("-", "")}`;
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
    const current = { revocationEpoch: 1, configurationRevision: 1, enabled: true };
    const policy = createNativePostgresPolicy(
      pool,
      { currentAuthority: async () => current },
      "private-invitation-receipt-key-long-enough",
    );
    await policy.applyRealmPolicy(current);
    const scope = { organizationId: "org", projectId: "project", environmentId: "dev" };
    const messages: Array<{ email: string; token: string; messageId: string }> = [];
    const admin = createNativeUserManagement(pool, scope, {
      authorize: async (actual, proof) => actual.projectId === "project" && proof === "owner-proof",
      currentAuthority: async () => current,
      sealInvitation: async (payload) => {
        messages.push(payload);
        return new Uint8Array([1, 2, 3]);
      },
    });
    const requestId = randomUUID();
    const canonicalDigest = new Uint8Array(32).fill(7);
    const input = {
      action: "create-invite" as const,
      email: "Person@Example.test",
      name: "Person",
    };
    await expect(admin.mutate("member", requestId, canonicalDigest, input)).rejects.toThrow(
      "native_admin_forbidden",
    );
    const [created, replayed] = await Promise.all([
      admin.mutate("owner-proof", requestId, canonicalDigest, input),
      admin.mutate("owner-proof", requestId, canonicalDigest, input),
    ]);
    expect(replayed).toEqual(created);
    expect(created.user).toMatchObject({
      id: created.userId,
      email: "person@example.test",
      status: "pending",
      recoveryAvailable: false,
    });
    expect(typeof created.user?.createdAt).toBe("string");
    expect(messages).toHaveLength(1);
    await expect(
      admin.mutate("owner-proof", requestId, canonicalDigest, { ...input, name: "Changed" }),
    ).rejects.toThrow("native_admin_idempotency_conflict");
    expect(await admin.list("owner-proof", { search: "PERSON" })).toMatchObject([
      { id: created.userId, status: "pending", recoveryAvailable: false },
    ]);
    await admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
      action: "resend-invitation",
      userId: created.userId,
    });
    expect(messages).toHaveLength(2);
    expect(
      (
        await pool.query(
          "select count(*)::int as n from native_mail_outbox where cancelled_at is not null",
        )
      ).rows[0].n,
    ).toBe(1);
    const sent: string[] = [];
    const dispatcher = createNativeInvitationDispatcher(pool, scope, {
      currentAuthority: async () => current,
      send: async (_scope, message) => {
        sent.push(message.messageId);
      },
    });
    const deliveries = await Promise.all([dispatcher.dispatchOne(), dispatcher.dispatchOne()]);
    expect(deliveries.sort()).toEqual([false, true]);
    expect(sent).toEqual([messages[1]?.messageId]);
    expect(await dispatcher.dispatchOne()).toBe(false);
    const old = messages[0];
    const latest = messages[1];
    if (!old || !latest) throw new Error("missing_test_message");
    expect(
      await policy.acceptInvitation({
        token: old.token,
        password: "a-long-correct-password",
        requestId: randomUUID(),
      }),
    ).toBe(false);
    const acceptId = randomUUID();
    expect(
      await policy.acceptInvitation({
        token: latest.token,
        password: "a-long-correct-password",
        requestId: acceptId,
      }),
    ).toBe(true);
    expect(
      await policy.acceptInvitation({
        token: latest.token,
        password: "another-correct-password",
        requestId: acceptId,
      }),
    ).toBe(false);
    expect(
      await policy.acceptInvitation({
        token: latest.token,
        password: "a-long-correct-password",
        name: "Changed",
        requestId: acceptId,
      }),
    ).toBe(false);
    expect(
      await policy.acceptInvitation({
        token: latest.token,
        password: "a-long-correct-password",
        requestId: acceptId,
      }),
    ).toBe(true);
    expect(
      await policy.acceptInvitation({
        token: latest.token,
        password: "a-long-correct-password",
        requestId: randomUUID(),
      }),
    ).toBe(false);
    await admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
      action: "suspend",
      userId: created.userId,
    });
    expect((await admin.get("owner-proof", created.userId))?.status).toBe("suspended");
    await admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
      action: "reactivate",
      userId: created.userId,
    });
    await admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
      action: "revoke-sessions",
      userId: created.userId,
    });
    await admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
      action: "delete",
      userId: created.userId,
    });
    expect(await admin.get("owner-proof", created.userId)).toBeNull();
    const audit = await pool.query("select action, user_id from native_admin_audit");
    expect(audit.rowCount).toBe(6);
    expect(JSON.stringify(audit.rows)).not.toContain(latest.token);
    const failing = createNativeUserManagement(pool, scope, {
      authorize: async () => true,
      currentAuthority: async () => current,
      sealInvitation: async () => {
        throw new Error("mail_not_ready");
      },
    });
    await expect(
      failing.mutate("owner-proof", randomUUID(), canonicalDigest, {
        action: "create-invite",
        email: "failed@example.test",
      }),
    ).rejects.toThrow("mail_not_ready");
    expect(
      (await pool.query('select id from "user" where email = $1', ["failed@example.test"]))
        .rowCount,
    ).toBe(0);
    let ownerStillAuthorized = true;
    const ownerRace = createNativeUserManagement(pool, scope, {
      authorize: async () => ownerStillAuthorized,
      currentAuthority: async () => current,
      sealInvitation: async () => {
        ownerStillAuthorized = false;
        return new Uint8Array([1]);
      },
    });
    const raceKey = randomUUID();
    await expect(
      ownerRace.mutate("owner-proof", raceKey, canonicalDigest, {
        action: "create-invite",
        email: "race@example.test",
      }),
    ).rejects.toThrow("native_admin_forbidden");
    expect(
      (await pool.query('select id from "user" where email=$1', ["race@example.test"])).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query("select request_id from native_admin_receipt where request_id=$1", [
          raceKey,
        ])
      ).rowCount,
    ).toBe(0);
    const replacement = await admin.mutate("owner-proof", randomUUID(), canonicalDigest, input);
    expect(replacement.userId).not.toBe(created.userId);
    current.enabled = false;
    current.configurationRevision = 2;
    current.revocationEpoch = 2;
    expect(await policy.applyRealmPolicy(current)).toBe(true);
    await expect(
      admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
        action: "resend-invitation",
        userId: replacement.userId,
      }),
    ).rejects.toThrow("native_realm_unavailable");
    await admin.mutate("owner-proof", randomUUID(), canonicalDigest, {
      action: "delete",
      userId: replacement.userId,
    });
    expect(await admin.get("owner-proof", replacement.userId)).toBeNull();
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("refuses a second invitation for an existing email with a stable code and no partial user", async () => {
  const db = await startTestPostgres();
  const schema = `native_admin_${randomUUID().replaceAll("-", "")}`;
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
    const current = { revocationEpoch: 1, configurationRevision: 1, enabled: true };
    await createNativePostgresPolicy(
      pool,
      { currentAuthority: async () => current },
      "private-invitation-receipt-key-long-enough",
    ).applyRealmPolicy(current);
    const scope = { organizationId: "org", projectId: "project", environmentId: "dev" };
    const admin = createNativeUserManagement(pool, scope, {
      authorize: async () => true,
      currentAuthority: async () => current,
      sealInvitation: async () => new Uint8Array([1, 2, 3]),
    });
    const canonicalDigest = new Uint8Array(32).fill(3);
    await admin.mutate("owner", randomUUID(), canonicalDigest, {
      action: "create-invite",
      email: "taken@example.test",
    });
    await expect(
      admin.mutate("owner", randomUUID(), canonicalDigest, {
        action: "create-invite",
        email: "TAKEN@example.test",
      }),
    ).rejects.toThrow("native_user_email_exists");
    expect(await admin.list("owner", { search: "taken" })).toHaveLength(1);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("refuses replays of an invitation and its resend once the user is deleted, and erases the address from the receipts", async () => {
  // The delete erases the address from every receipt of the user, so a replay on that user answers as a missing user.
  const db = await startTestPostgres();
  const schema = `native_replay_${randomUUID().replaceAll("-", "")}`;
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
    const current = { revocationEpoch: 1, configurationRevision: 1, enabled: true };
    await createNativePostgresPolicy(
      pool,
      { currentAuthority: async () => current },
      "private-invitation-receipt-key-long-enough",
    ).applyRealmPolicy(current);
    const scope = { organizationId: "org", projectId: "project", environmentId: "dev" };
    const admin = createNativeUserManagement(pool, scope, {
      authorize: async () => true,
      currentAuthority: async () => current,
      sealInvitation: async () => new Uint8Array([1, 2, 3]),
    });
    const digest = new Uint8Array(32).fill(4);
    const email = "replay@example.test";
    const invite = { action: "create-invite" as const, email, name: "Replay" };
    const resend = { action: "resend-invitation" as const };
    const inviteRequest = randomUUID();
    const resendRequest = randomUUID();
    const created = await admin.mutate("owner", inviteRequest, digest, invite);
    expect(
      await admin.mutate("owner", resendRequest, digest, {
        ...resend,
        userId: created.userId,
      }),
    ).toMatchObject({ user: { email } });
    await admin.mutate("owner", randomUUID(), digest, { action: "delete", userId: created.userId });
    expect(
      (
        await pool.query<{ n: number }>(
          "select count(*)::int as n from native_admin_receipt where position($1 in response::text) > 0",
          [email],
        )
      ).rows[0]?.n,
    ).toBe(0);
    await expect(admin.mutate("owner", inviteRequest, digest, invite)).rejects.toThrow(
      "native_user_not_found",
    );
    await expect(
      admin.mutate("owner", resendRequest, digest, {
        ...resend,
        userId: created.userId,
      }),
    ).rejects.toThrow("native_user_not_found");
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("erases a deleted user's address from admin receipts and invitation mail while replays still answer", async () => {
  const db = await startTestPostgres();
  const schema = `native_erase_${randomUUID().replaceAll("-", "")}`;
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
    const current = { revocationEpoch: 1, configurationRevision: 1, enabled: true };
    const policy = createNativePostgresPolicy(
      pool,
      { currentAuthority: async () => current },
      "private-invitation-receipt-key-long-enough",
    );
    await policy.applyRealmPolicy(current);
    const scope = { organizationId: "org", projectId: "project", environmentId: "dev" };
    const messages: Array<{ email: string; token: string; messageId: string }> = [];
    const admin = createNativeUserManagement(pool, scope, {
      authorize: async () => true,
      currentAuthority: async () => current,
      // The test seal is plain JSON so the stored bytes visibly carry the address.
      sealInvitation: async (payload) => {
        messages.push(payload);
        return new TextEncoder().encode(JSON.stringify(payload));
      },
    });
    const sent: string[] = [];
    const dispatcher = createNativeInvitationDispatcher(pool, scope, {
      currentAuthority: async () => current,
      send: async (_scope, message) => {
        sent.push(message.messageId);
      },
    });
    const email = "erase@example.test";
    const digest = new Uint8Array(32).fill(9);
    const input = { action: "create-invite" as const, email, name: "Erase" };
    const inviteRequest = randomUUID();
    const created = await admin.mutate("owner", inviteRequest, digest, input);
    // Delivery is the proof that replays of the invitation answer, so it must survive the erasure.
    expect(await dispatcher.dispatchOne(inviteRequest, created.userId)).toBe(true);
    const invitation = messages[0];
    if (!invitation) throw new Error("missing_test_invitation");
    expect(
      await policy.acceptInvitation({
        token: invitation.token,
        password: "a-long-correct-password",
        requestId: randomUUID(),
      }),
    ).toBe(true);
    const suspendRequest = randomUUID();
    await admin.mutate("owner", suspendRequest, digest, {
      action: "suspend",
      userId: created.userId,
    });
    const deleteRequest = randomUUID();
    await admin.mutate("owner", deleteRequest, digest, {
      action: "delete",
      userId: created.userId,
    });
    expect(
      (
        await pool.query<{ n: number }>(
          "select count(*)::int as n from native_admin_receipt where position($1 in response::text) > 0",
          [email],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (await pool.query<{ n: number }>("select count(*)::int as n from native_admin_receipt"))
        .rows[0]?.n,
    ).toBe(3);
    expect(
      (
        await pool.query<{ n: number }>(
          "select count(*)::int as n from native_mail_outbox where position(convert_to($1, 'UTF8') in sealed_payload) > 0",
          [email],
        )
      ).rows[0]?.n,
    ).toBe(0);
    await expect(admin.mutate("owner", inviteRequest, digest, input)).rejects.toThrow(
      "native_user_not_found",
    );
    await expect(
      admin.mutate("owner", suspendRequest, digest, { action: "suspend", userId: created.userId }),
    ).rejects.toThrow("native_user_not_found");
    // The delete keeps answering its own replay; the invitation's delivery proof survives the erasure.
    expect(
      await admin.mutate("owner", deleteRequest, digest, {
        action: "delete",
        userId: created.userId,
      }),
    ).toMatchObject({ userId: created.userId, action: "delete", user: null });
    expect(await dispatcher.dispatchOne(inviteRequest, created.userId)).toBe(true);
    expect(sent).toEqual([invitation.messageId]);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
