import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import {
  applyNativePreviewRealmPolicy,
  applyNativeRealmPolicy,
  createNativePostgresPolicy,
  drainNativePreviewPolicy,
  lockNativeRealmPolicy,
} from "../src/policy.js";
import { createNativePasswordHandler } from "../src/password-handler.js";

it("allows only the current preview policy while deployment policy stays disabled", async () => {
  const db = await startTestPostgres();
  const schema = `preview_policy_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("test_postgres_unavailable");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    const preview = { previewId: "01J00000000000000000000001", authGeneration: 1 };
    expect(
      await applyNativeRealmPolicy(pool, {
        enabled: false,
        revocationEpoch: 1,
        configurationRevision: 1,
      }),
    ).toBe(true);
    const legacy = await pool.connect();
    try {
      await legacy.query("begin");
      await expect(drainNativePreviewPolicy(legacy, preview)).resolves.toBeUndefined();
      await legacy.query("commit");
    } finally {
      legacy.release();
    }
    await pool.query(
      await readFile(new URL("../migrations/004-preview-policy.sql", import.meta.url), "utf8"),
    );
    expect(
      await applyNativePreviewRealmPolicy(pool, {
        ...preview,
        revocationEpoch: 1,
        configurationRevision: 1,
      }),
    ).toBe(true);
    const userId = randomUUID();
    await pool.query('insert into "user" (id,name,email) values($1,$2,$3)', [
      userId,
      "Test",
      "preview@example.test",
    ]);
    await pool.query("insert into native_user_policy(user_id,status) values($1,'active')", [
      userId,
    ]);
    let enabled = true;
    const authority = {
      currentAuthority: async () => ({ enabled, revocationEpoch: 1, configurationRevision: 1 }),
    };
    const previewPolicy = createNativePostgresPolicy(pool, authority, undefined, preview);
    const deployedPolicy = createNativePostgresPolicy(pool, authority);
    const otherGeneration = createNativePostgresPolicy(pool, authority, undefined, {
      ...preview,
      authGeneration: 2,
    });
    const session = () => ({
      id: randomUUID(),
      userId,
      token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await previewPolicy.insertSession(session())).toBe(true);
    expect(await deployedPolicy.insertSession(session())).toBe(false);
    expect(await otherGeneration.insertSession(session())).toBe(false);
    const origin = `https://${"a".repeat(52)}.preview.dev.omh.st`;
    const handler = createNativePasswordHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Preview",
      secret: "local-test-secret-at-least-32-characters",
      previewId: preview.previewId,
      previewPolicy: preview,
      ports: {
        admitAttempt: async () => true,
        currentAuthority: async () => ({
          enabled,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
      },
    });
    const signup = await handler.handle(
      new Request(`${origin}/api/auth/v1/sign-up/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({
          name: "Preview",
          email: "new-preview@example.test",
          password: "local-long-test-password-123",
        }),
      }),
    ); // gitleaks:allow -- disposable local test password
    expect(signup.status).toBe(200);
    expect(
      (await pool.query('select id from "user" where email=$1', ["new-preview@example.test"]))
        .rowCount,
    ).toBe(1);
    enabled = false;
    expect(await previewPolicy.insertSession(session())).toBe(false);
    const held = await pool.connect();
    await held.query("begin");
    await lockNativeRealmPolicy(held, preview);
    let committed = false;
    const revoke = applyNativeRealmPolicy(pool, {
      enabled: false,
      revocationEpoch: 2,
      configurationRevision: 2,
    }).then((result) => {
      committed = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(committed).toBe(false);
    } finally {
      await held.query("commit");
      held.release();
    }
    expect(await revoke).toBe(true);
  } finally {
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
