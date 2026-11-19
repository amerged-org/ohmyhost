import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS,
  DATABASE_RUNTIME_GRANT_STATEMENTS,
  createDatabaseRoleBootstrapStatements,
  executeExpandOnlyMigrations,
} from "@ohmyhost/platform";
import pg from "pg";

import { createCustomerAuth, createCustomerAuthPostgresPool } from "../dist/index.js";

const { Client } = pg;
const origin = "https://auth-proof.example.test";

async function connected(connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  return client;
}

async function digest(body) {
  return `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
}

async function request(auth, path, init = {}) {
  return auth.handler(
    new globalThis.Request(`${origin}${path}`, {
      ...init,
      headers: {
        origin,
        "cf-connecting-ip": "192.0.2.10",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    }),
  );
}

function cookie(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function databaseUrl(connectionString, databaseName) {
  const url = new globalThis.URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.href;
}

async function main() {
  const adminUrl =
    process.env.BETTER_AUTH_PROOF_ADMIN_URL ??
    "postgresql://ohmyhost:ohmyhost_local@127.0.0.1:5432/ohmyhost_project";
  const migrationUrl =
    process.env.BETTER_AUTH_PROOF_MIGRATION_URL ??
    "postgresql://ohmyho_migration:ohmyho_migration_local@127.0.0.1:5432/ohmyhost_project";
  const runtimeUrl =
    process.env.BETTER_AUTH_PROOF_RUNTIME_URL ??
    "postgresql://ohmyho_runtime:ohmyho_runtime_local@127.0.0.1:5432/ohmyhost_project";
  const clusterAdmin = await connected(databaseUrl(adminUrl, "postgres"));
  try {
    const existing = await clusterAdmin.query(
      "SELECT 1 FROM pg_database WHERE datname='ohmyhost_other_project'",
    );
    if (existing.rowCount === 0) await clusterAdmin.query("CREATE DATABASE ohmyhost_other_project");
    await clusterAdmin.query("REVOKE CONNECT ON DATABASE ohmyhost_other_project FROM PUBLIC");
  } finally {
    await clusterAdmin.end();
  }
  const otherProject = new Client({
    connectionString: databaseUrl(runtimeUrl, "ohmyhost_other_project"),
    connectionTimeoutMillis: 5_000,
  });
  let crossProjectDenied = false;
  try {
    await otherProject.connect();
  } catch (error) {
    crossProjectDenied = error?.code === "42501";
  } finally {
    await otherProject.end().catch(() => undefined);
  }
  if (!crossProjectDenied) throw new Error("Cross-project database isolation proof failed");
  const admin = await connected(adminUrl);
  try {
    await admin.query("BEGIN");
    for (const sql of createDatabaseRoleBootstrapStatements("ohmyhost_project")) {
      await admin.query(sql);
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }

  const body = new Uint8Array(
    await readFile(
      new globalThis.URL("../migrations/20260822000000_better_auth.sql", import.meta.url),
    ),
  );
  const migration = await connected(migrationUrl);
  try {
    await executeExpandOnlyMigrations(migration, [
      {
        path: "20260822000000_better_auth.sql",
        body,
        size: body.byteLength,
        digest: await digest(body),
      },
    ]);
    await migration.query("BEGIN");
    for (const sql of [
      ...DATABASE_RUNTIME_GRANT_STATEMENTS,
      ...DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS,
    ]) {
      await migration.query(sql);
    }
    await migration.query("COMMIT");
  } catch (error) {
    await migration.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await migration.end();
  }

  const emails = [];
  const pool = createCustomerAuthPostgresPool(runtimeUrl);
  const auth = createCustomerAuth({
    appName: "Better Auth Proof",
    publicOrigin: origin,
    database: pool,
    secret: crypto.randomBytes(32).toString("base64url"),
    email: { send: async (message) => void emails.push(message) },
  });
  const email = `proof-${crypto.randomUUID()}@example.test`;
  try {
    const crossOrigin = await auth.handler(
      new globalThis.Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "cf-connecting-ip": "192.0.2.10",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Proof User", email, password: "correct-horse-123" }),
      }),
    );
    const signup = await request(auth, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name: "Proof User", email, password: "correct-horse-123" }),
    });
    const verification = emails.find((message) => message.kind === "verification");
    if (signup.status !== 200 || verification === undefined) throw new Error("Signup proof failed");
    const verify = await auth.handler(
      new globalThis.Request(verification.url, {
        headers: { origin, "cf-connecting-ip": "192.0.2.10" },
      }),
    );
    if (verify.status !== 302) throw new Error("Verification proof failed");
    const signin = await request(auth, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "correct-horse-123" }),
    });
    const sessionCookie = cookie(signin);
    const sessionSetCookie = signin.headers
      .getSetCookie()
      .find((value) => /^(?:__Secure-)?better-auth\.session_token=/u.test(value));
    if (
      sessionSetCookie === undefined ||
      !/;\s*HttpOnly(?:;|$)/iu.test(sessionSetCookie) ||
      !/;\s*Secure(?:;|$)/iu.test(sessionSetCookie) ||
      !/;\s*SameSite=Lax(?:;|$)/iu.test(sessionSetCookie) ||
      /;\s*Domain=/iu.test(sessionSetCookie)
    ) {
      throw new Error("Session cookie proof failed");
    }
    if (signin.status !== 200 || sessionCookie.length === 0) throw new Error("Signin proof failed");
    const session = await request(auth, "/api/auth/get-session", {
      headers: { cookie: sessionCookie },
    });
    const sessionBody = await session.json();
    if (session.status !== 200 || sessionBody?.user?.email !== email) {
      throw new Error("Session proof failed");
    }
    const signout = await request(auth, "/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: sessionCookie },
      body: "{}",
    });
    const clearedCookie = cookie(signout);
    const after = await request(auth, "/api/auth/get-session", {
      headers: { cookie: clearedCookie },
    });
    const afterBody = await after.json();
    if (
      signout.status !== 200 ||
      afterBody !== null ||
      crossOrigin.status < 400 ||
      !crossProjectDenied
    ) {
      throw new Error("Session revocation proof failed");
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        signup: signup.status,
        verification: verify.status,
        signin: signin.status,
        session: session.status,
        signout: signout.status,
        crossOriginDenied: true,
        crossProjectDenied: true,
        hostOnlySecureCookie: true,
        secretExposed: false,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

await main();
