import { createHash, createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { nativeClientRateKey } from "./client-rate-key.js";
import {
  endNativeLatency,
  startNativeLatency,
  type NativeLatencyProfile,
} from "./latency-profile.js";

/**
 * A private session check is charged to the session cookie it presents, so one realm's checks never share one budget.
 * Distinct cookies are distinct identities; a cookie-less check never reaches this helper because the caller refuses it first.
 */
export function nativeSessionRateIdentity(request: Request): string {
  return `private-session:${nativeSessionRateAddress(request.headers.get("cookie") ?? "")}`;
}

/**
 * The address that keys Better Auth's own limiter for one private session check. Better Auth otherwise shares one
 * bucket per path for every request without a trusted address, so each session check gets a synthetic IPv6 derived
 * from its cookie. The value is built only here, never from customer input.
 */
export function nativeSessionRateAddress(cookie: string): string {
  const digest = createHash("sha256").update(cookie).digest();
  return Array.from({ length: 8 }, (_, index) => digest.readUInt16BE(index * 2).toString(16)).join(
    ":",
  );
}

/** The durable bucket digest. The raw identity (address, e-mail or account id) is never stored. */
export function nativeRateBucketDigest(secret: string, category: string, identity: string): Buffer {
  return createHmac("sha256", secret)
    .update("native-auth-rate-v1\0")
    .update(category)
    .update("\0")
    .update(identity)
    .digest();
}

/** Counts one attempt in the caller's transaction and returns the bucket's count for the current minute. */
export async function countNativeRateAttempt(
  client: Pick<PoolClient, "query">,
  digest: Buffer,
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `insert into native_password_rate_limit (key_digest, window_start, count)
            values ($1, floor(extract(epoch from current_timestamp) / 60)::bigint, 1)
            on conflict (key_digest) do update set window_start = excluded.window_start,
              count = case when native_password_rate_limit.window_start = excluded.window_start then least(native_password_rate_limit.count + 1, 101) else 1 end,
              updated_at = current_timestamp returning count`,
    [digest],
  );
  return result.rows[0]?.count ?? 101;
}

/** Identity must come from an authenticated platform binding, never customer headers. */
export function createNativePasswordRateLimiter(input: {
  pool: Pool;
  secret: string;
  trustedClientIdentity(request: Request): Promise<string>;
  latency?: NativeLatencyProfile;
}) {
  if (input.secret.length < 32) throw new TypeError("invalid_native_rate_limit_secret");
  const key = (category: string, identity: string) =>
    nativeRateBucketDigest(input.secret, category, identity);
  return {
    async admitAttempt(request: Request): Promise<boolean> {
      const trusted = await input.trustedClientIdentity(request);
      if (!trusted || trusted.length > 512) throw new Error("native_rate_identity_unavailable");
      const identity = nativeClientRateKey(trusted);
      const path = new URL(request.url).pathname;
      const suffix = path.slice("/api/auth/v1".length);
      const limit =
        suffix === "/sign-in/email" || suffix === "/reauthenticate"
          ? 5
          : suffix === "/sign-up/email" ||
              suffix === "/request-password-reset" ||
              suffix === "/send-verification-email"
            ? 3
            : 100;
      let email = "";
      if (
        request.method === "POST" &&
        ["/sign-in/email", "/sign-up/email", "/request-password-reset"].includes(suffix)
      ) {
        try {
          const body: unknown = await request.clone().json();
          if (
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as Record<string, unknown>)["email"] === "string"
          )
            email = String((body as Record<string, unknown>)["email"])
              .trim()
              .toLowerCase()
              .slice(0, 254);
        } catch {
          /* The handler rejects malformed bodies. */
        }
      }
      const keys = [
        { digest: key("general", identity), limit: 100 },
        { digest: key(`route:${suffix}`, identity), limit },
      ];
      if (email) keys.push({ digest: key(`email:${suffix}`, email), limit });
      keys.sort((a, b) => Buffer.compare(a.digest, b.digest));
      const checkoutStarted = startNativeLatency(input.latency);
      let client;
      try {
        client = await input.pool.connect();
      } finally {
        endNativeLatency(input.latency, "limiterCheckoutMs", checkoutStarted);
      }
      const transactionStarted = startNativeLatency(input.latency);
      try {
        await client.query("begin");
        let allowed = true;
        for (const item of keys) {
          const count = await countNativeRateAttempt(client, item.digest);
          if (count > item.limit) allowed = false;
        }
        await client.query(
          `delete from native_password_rate_limit where ctid in (select ctid from native_password_rate_limit where updated_at < current_timestamp - interval '1 day' for update skip locked limit 32)`,
        );
        await client.query("commit");
        return allowed;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        endNativeLatency(input.latency, "limiterTransactionMs", transactionStarted);
        client.release();
      }
    },
  };
}
