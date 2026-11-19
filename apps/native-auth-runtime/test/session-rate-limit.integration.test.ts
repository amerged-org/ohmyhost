import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativePasswordHandler } from "../src/password-handler.js";
import { createNativePasswordRateLimiter, nativeSessionRateIdentity } from "../src/rate-limit.js";

it("keeps private session checks of one realm from sharing one rate-limit identity", async () => {
  const db = await startTestPostgres();
  const schema = `native_session_limit_${randomUUID().replaceAll("-", "")}`;
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
    const origin = "https://native-auth.example.test";
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      // Each private session check is charged to the cookie it presents, as in production.
      trustedClientIdentity: async (request) => nativeSessionRateIdentity(request),
    });
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
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
        sealMail: async () => new Uint8Array([1]),
      },
    });
    // A hundred and fifty distinct session checks, each with its own cookie: none is a flood of one client.
    for (let check = 0; check < 150; check++) {
      expect(
        await handler.validateSession(`omh_native.session_token=unknown-${check}-${randomUUID()}`),
      ).toBeNull();
    }
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);
