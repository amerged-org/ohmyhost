import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativeAuthBoundary } from "../src/boundary.js";
import {
  NativeAuthDeadlineExceeded,
  nativeDeadlinePool,
  nativeRequestDeadline,
} from "../src/deadline.js";
import { createNativePasswordHandler } from "../src/password-handler.js";

it("releases a PostgreSQL realm lock on stalled authority and refuses a late signup commit", async () => {
  const db = await startTestPostgres();
  const schema = `native_deadline_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString: db.pool.options.connectionString,
    options: `-c search_path=${schema}`,
    max: 1,
  });
  try {
    await db.pool.query(`create schema ${schema}`);
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy(enabled, revocation_epoch, configuration_revision) values(true, 1, 1)",
    );
    const origin = "https://app.example";
    const scope = {
      projectId: "fixture",
      environmentId: "fixture",
      canonicalOrigin: origin,
      realmGeneration: 1,
      configurationRevision: 1,
    };
    const authority = {
      enabled: true,
      revocationEpoch: 1,
      configurationRevision: 1,
      signupMode: "open" as const,
    };
    for (const stage of ["entry", "commit"] as const) {
      let resume!: () => void;
      const stalled = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let calls = 0;
      let staged = false;
      const deadline = nativeRequestDeadline(Date.now() + 1200);
      const email = `${stage}@example.test`;
      const handler = createNativePasswordHandler({
        pool: nativeDeadlinePool(pool, deadline),
        deadlineAt: deadline.at,
        canonicalOrigin: origin,
        applicationName: "Test",
        secret: "test-secret-at-least-32-characters-long",
        ports: {
          admitAttempt: async () => true,
          currentAuthority: () =>
            deadline.run(async () => {
              calls++;
              if (calls === (stage === "entry" ? 1 : 2)) await stalled;
              return authority;
            }),
          sealMail: async () => {
            staged = true;
            return new Uint8Array([1]);
          },
          deliverMail: async () => {
            throw new Error("unexpected_delivery");
          },
        },
      });
      const boundary = createNativeAuthBoundary({
        resolve: async () => ({
          ...authority,
          realm: scope,
          sourceCapable: true,
          paidAllowed: true,
          runtimeAllowed: true,
        }),
        handle: (request) => handler.handle(request),
        validate: async () => null,
      });
      try {
        const response = await boundary.fetchPublic(
          new Request(`${origin}/api/auth/v1/sign-up/email`, {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            },
            body: JSON.stringify({ email, name: "Test", password: "correct-horse-battery-123" }), // gitleaks:allow -- disposable local test password
          }),
          scope,
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "auth_unavailable" });
        expect(staged).toBe(stage === "commit");
        const observer = await pool.connect();
        try {
          await observer.query("begin");
          await observer.query("set local lock_timeout='100ms'");
          await expect(
            observer.query("select 1 from native_realm_policy for update"),
          ).resolves.toHaveProperty("rowCount", 1);
          await observer.query("rollback");
        } finally {
          observer.release();
        }
        resume();
        await new Promise((resolve) => setImmediate(resolve));
        expect((await pool.query('select 1 from "user" where email=$1', [email])).rowCount).toBe(0);
        expect((await pool.query("select 1 from native_auth_mail_outbox")).rowCount).toBe(0);
      } finally {
        resume();
      }
    }
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);

it("disposes late pool acquisitions and cancels active SQL at the same absolute deadline", async () => {
  const db = await startTestPostgres();
  const pool = new Pool({ connectionString: db.pool.options.connectionString, max: 1 });
  try {
    const held = await pool.connect();
    try {
      const bounded = nativeDeadlinePool(pool, nativeRequestDeadline(Date.now() + 50));
      await expect(bounded.query("select 1")).rejects.toThrow("auth_unavailable");
    } finally {
      held.release();
    }
    // A late queued acquisition must return its client rather than monopolize max=1.
    await expect(pool.query("select 1 as ready")).resolves.toHaveProperty("rows", [{ ready: 1 }]);
    const bounded = nativeDeadlinePool(pool, nativeRequestDeadline(Date.now() + 50));
    await expect(bounded.query("select pg_sleep(2)")).rejects.toThrow("auth_unavailable");
    const begun = Date.now();
    await expect(pool.query("select 1 as ready")).resolves.toHaveProperty("rows", [{ ready: 1 }]);
    expect(Date.now() - begun).toBeLessThan(1000);
  } finally {
    await pool.end();
    await db.stop();
  }
}, 30_000);

it("caps a trusted absolute deadline at the receiver without extending shorter or expired budgets", async () => {
  const receiverNow = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(receiverNow);
  try {
    const before = clock.mock.calls.length;
    expect(nativeRequestDeadline().at).toBe(receiverNow + 15_000);
    expect(clock.mock.calls.length - before).toBe(1);
    for (const suppliedAt of [
      receiverNow + 15_001,
      receiverNow + 30_000,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const deadline = nativeRequestDeadline(suppliedAt);
      expect(deadline.at).toBe(receiverNow + 15_000);
      expect(deadline.at).toBeLessThanOrEqual(suppliedAt);
      await expect(deadline.run(async () => "ready")).resolves.toBe("ready");
    }
    const shorter = nativeRequestDeadline(receiverNow + 7);
    expect(shorter.at).toBe(receiverNow + 7);
    clock.mockReturnValue(receiverNow + 3);
    expect(nativeRequestDeadline(shorter.at).at).toBe(shorter.at);
    for (const invalid of [
      null,
      NaN,
      Infinity,
      -1,
      receiverNow + 0.5,
      "invalid",
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() => nativeRequestDeadline(invalid as never)).toThrow("auth_unavailable");
    let invoked = false;
    const onTimeout = vi.fn();
    const expired = nativeRequestDeadline(receiverNow - 1);
    expect(expired.at).toBe(receiverNow - 1);
    await expect(
      expired.run(async () => {
        invoked = true;
      }, onTimeout),
    ).rejects.toBeInstanceOf(NativeAuthDeadlineExceeded);
    expect(invoked).toBe(false);
    expect(onTimeout).toHaveBeenCalledOnce();
    clock.mockReturnValue(receiverNow + 8);
    await expect(
      shorter.run(async () => {
        invoked = true;
      }, onTimeout),
    ).rejects.toBeInstanceOf(NativeAuthDeadlineExceeded);
    expect(invoked).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});
