import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createNativeSocialHandler } from "../src/social-handler.js";

it("bounds provider exchange, key lookup and profile bodies while consuming failed callback state", async () => {
  const db = await startTestPostgres();
  const schema = `native_deadline_${randomUUID().replaceAll("-", "")}`;
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  await db.pool.query(`create schema ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const wallNow = Date.now.bind(Date);
  let callbackClockAt: number | undefined;
  let providerClockStartedAt: number | undefined;
  // Isolate the provider fixture's clock from real PostgreSQL/authority preparation.
  // Once the first provider starts, one advancing clock covers the entire provider chain.
  vi.spyOn(Date, "now").mockImplementation(() =>
    callbackClockAt === undefined
      ? wallNow()
      : callbackClockAt +
        (providerClockStartedAt === undefined ? 0 : wallNow() - providerClockStartedAt),
  );
  try {
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "insert into native_realm_policy (enabled,revocation_epoch,configuration_revision) values (true,1,1)",
    );
    const origin = "https://native-auth.example.test";
    let mode: "token" | "jwks" | "profile" = "token";
    let fault:
      | "hang"
      | "stream-hang"
      | "oversized"
      | "declared-large"
      | "malformed-length"
      | "cancel-failure" = "hang";
    let streams: Array<{ pulled: number; cancelled: boolean }> = [];
    let nonce = "";
    let aborted = false;
    let providerCalls = 0;
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const hang = (signal?: AbortSignal | null) =>
      new Promise<Response>(() => {
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
      });
    const failedProviderResponse = (signal?: AbortSignal | null) => {
      if (fault === "hang") return hang(signal);
      const observed = { pulled: 0, cancelled: false };
      streams.push(observed);
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (fault === "stream-hang") return;
          if (observed.pulled >= 4 * 1024 * 1024) controller.close();
          else {
            observed.pulled += 65536;
            controller.enqueue(new Uint8Array(65536));
          }
        },
        cancel() {
          observed.cancelled = true;
          if (fault === "cancel-failure") throw new Error("fixture_cancel_failure");
        },
      });
      return Promise.resolve(
        new Response(stream, {
          headers:
            fault === "declared-large"
              ? { "content-length": String(4 * 1024 * 1024) }
              : fault === "malformed-length"
                ? { "content-length": "invalid" }
                : {},
        }),
      );
    };
    vi.stubGlobal("fetch", async (target: string | URL | Request, init?: RequestInit) => {
      const url = String(target instanceof Request ? target.url : target);
      if (callbackClockAt !== undefined) providerClockStartedAt ??= wallNow();
      providerCalls += 1;
      // Model synchronous provider-call work before the first parallel response returns.
      // The shared absolute deadline must cover it, and both bodies must be cancelled before return.
      if (mode === "profile" && fault === "stream-hang" && url === "https://api.github.com/user") {
        const until = wallNow() + 20;
        while (wallNow() < until) {
          /* synchronous work */
        }
      }
      if (
        url === "https://github.com/login/oauth/access_token" ||
        url === "https://oauth2.googleapis.com/token"
      ) {
        if (mode === "token") return failedProviderResponse(init?.signal);
        if (url.includes("googleapis")) {
          const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
          const body = `${enc({ alg: "RS256", kid: "test" })}.${enc({ iss: "https://accounts.google.com", aud: "client", sub: "test", email: "user@gmail.com", email_verified: true, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
          return Response.json({
            access_token: "token",
            token_type: "bearer",
            id_token: `${body}.${sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url")}`,
          });
        }
        return Response.json({ access_token: "token", token_type: "bearer" });
      }
      if (
        url === "https://www.googleapis.com/oauth2/v3/certs" ||
        url.startsWith("https://api.github.com/")
      )
        return failedProviderResponse(init?.signal);
      throw new Error("unexpected_fetch");
    });
    const handler = createNativeSocialHandler({
      pool,
      canonicalOrigin: origin,
      applicationName: "Test",
      secret: "test-secret-at-least-32-characters-long",
      providerTimeoutMs: 100,
      ports: {
        recordProviderSuccess: async () => {},
        admitAttempt: async () => true,
        currentAuthority: async () => ({
          enabled: true,
          revocationEpoch: 1,
          configurationRevision: 1,
          signupMode: "open",
        }),
        provider: async () => ({
          enabled: true,
          clientId: "client",
          clientSecret: "secret",
          configurationRevision: 1,
        }),
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
      },
    });
    for (const phase of ["token", "jwks", "profile"] as const) {
      for (const failure of [
        "hang",
        "stream-hang",
        "oversized",
        "declared-large",
        "malformed-length",
        "cancel-failure",
      ] as const) {
        mode = phase;
        fault = failure;
        streams = [];
        aborted = false;
        providerCalls = 0;
        await pool.query('delete from "rateLimit"');
        const provider = phase === "jwks" ? "google" : "github";
        const start = await handler.handle(
          new Request(`${origin}/api/auth/v1/sign-in/social`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ provider, callbackURL: "/login" }),
          }),
        );
        expect(start.status).toBe(200);
        const destination = new URL((await start.json()).url);
        const state = destination.searchParams.get("state");
        nonce = destination.searchParams.get("nonce") ?? "";
        if (!state) throw new Error("missing_state");
        const cookie = start.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .join("; ");
        const begun = wallNow();
        callbackClockAt = begun;
        providerClockStartedAt = undefined;
        const response = await handler.handle(
          new Request(
            `${origin}/api/auth/v1/callback/${provider}?code=test&state=${encodeURIComponent(state)}`,
            { headers: { cookie } },
          ),
        );
        callbackClockAt = undefined;
        providerClockStartedAt = undefined;
        expect(wallNow() - begun).toBeLessThan(3000);
        expect(response.headers.get("location")).not.toBe("/login");
        expect(
          providerCalls,
          JSON.stringify({ phase, failure, providerCalls, streams }),
        ).toBeGreaterThan(0);
        expect(aborted, JSON.stringify({ phase, failure, providerCalls, streams })).toBe(true);
        if (failure !== "hang") {
          expect(streams.length).toBeGreaterThan(0);
          for (const stream of streams) {
            expect(stream.cancelled, JSON.stringify({ phase, failure, streams })).toBe(true);
            expect(stream.pulled).toBeLessThanOrEqual(
              failure === "oversized" || failure === "cancel-failure" ? 1048576 + 2 * 65536 : 65536,
            );
          }
        }
        expect(
          (await pool.query("select count(*)::int as count from native_social_flow")).rows[0].count,
        ).toBe(0);
        expect(
          (
            await handler.handle(
              new Request(
                `${origin}/api/auth/v1/callback/${provider}?code=test&state=${encodeURIComponent(state)}`,
                { headers: { cookie } },
              ),
            )
          ).status,
        ).toBe(403);
        expect((await pool.query('select count(*)::int as count from "user"')).rows[0].count).toBe(
          0,
        );
      }
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await pool.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await db.stop();
  }
}, 30_000);
