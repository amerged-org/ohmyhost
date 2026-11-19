import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativePasswordRateLimiter } from "../src/rate-limit.js";

it("refuses the fourth verification mail one client asks for within a minute, and keeps other clients' budgets", async () => {
  const db = await startTestPostgres();
  const schema = `native_verification_limit_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    const origin = "https://native-auth.example.test";
    const limiter = createNativePasswordRateLimiter({
      pool,
      secret: "private-rate-limit-secret-32-characters",
      trustedClientIdentity: async (request) => request.headers.get("x-test-client") ?? "",
    });
    const send = (client: string) =>
      limiter.admitAttempt(
        new Request(`${origin}/api/auth/v1/send-verification-email`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-client": client },
          body: JSON.stringify({ email: "pending@example.test" }),
        }),
      );
    const admitted = [];
    for (let attempt = 0; attempt < 4; attempt++) admitted.push(await send("client-a"));
    expect(admitted).toEqual([true, true, true, false]);
    expect(await send("client-b")).toBe(true);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 60_000);
