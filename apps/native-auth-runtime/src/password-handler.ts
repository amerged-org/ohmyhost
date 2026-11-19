import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { PostgresDialect, type PostgresPoolClient } from "kysely";
import type { Pool, PoolClient, QueryResult } from "pg";
import type { NativeAuthSession } from "@ohmyhost/contracts/native-auth";
import { createNativeAuthEngineOptions, type NativeAuthEngineConfiguration } from "./engine.js";
import { nativeApplicationFallbackPath } from "./application-redirect.js";
import { lockNativeRealmPolicy, type NativePreviewPolicyKey } from "./policy.js";
import {
  countNativeRateAttempt,
  nativeRateBucketDigest,
  nativeSessionRateAddress,
} from "./rate-limit.js";
import {
  endNativeLatency,
  startNativeLatency,
  type NativeLatencyProfile,
} from "./latency-profile.js";

export interface NativePasswordAuthority {
  readonly enabled: boolean;
  readonly revocationEpoch: number;
  readonly configurationRevision: number;
  readonly signupMode: "open" | "invite-only";
}
export interface NativePasswordPorts {
  /** Backed by a durable limiter using platform-authenticated client identity. */
  admitAttempt(request: Request): Promise<boolean>;
  /** Deliver and acknowledge these exact durable messages, or throw to report pending. */
  deliverMail(messageIds: readonly string[]): Promise<void>;
  currentAuthority(): Promise<NativePasswordAuthority | null>;
  /** Provider readiness from the live private realm configuration. */
  isProviderUsable?(provider: "google" | "github"): Promise<boolean>;
  /** Encrypt to the private sender; this function must establish sender readiness. */
  sealMail(message: {
    messageId: string;
    kind: "verification" | "password-reset";
    to: string;
    url: string;
    token: string;
  }): Promise<Uint8Array>;
}
export interface NativePasswordConfiguration
  extends Omit<NativeAuthEngineConfiguration, "database" | "sendMail"> {
  readonly pool: Pool;
  readonly ports: NativePasswordPorts;
  readonly deadlineAt?: number;
  readonly latency?: NativeLatencyProfile;
  readonly previewPolicy?: NativePreviewPolicyKey;
}

/** Kysely must never acquire another connection, release this client or commit it. */
export function boundDialect(client: PoolClient): PostgresDialect {
  return new PostgresDialect({
    pool: {
      options: {},
      async connect() {
        return {
          async query<R>(sql: string, parameters: readonly unknown[]) {
            if (
              /^\s*(?:begin|start\s+transaction|commit|rollback|savepoint|release\s+savepoint)\b/iu.test(
                sql,
              )
            )
              throw new Error("native_auth_nested_transaction");
            let result: QueryResult;
            try {
              result = await client.query(sql, [...parameters]);
            } catch (error) {
              // Better Auth's fallback join can log adapter errors directly; retain only a safe SQLSTATE.
              const safe = new Error("native_auth_database_unavailable");
              if (typeof error === "object" && error !== null) {
                try {
                  const code = Object.getOwnPropertyDescriptor(error, "code");
                  if (
                    code &&
                    "value" in code &&
                    typeof code.value === "string" &&
                    /^[0-9A-Z]{5}$/u.test(code.value)
                  )
                    Object.defineProperty(safe, "code", { value: code.value, enumerable: true });
                } catch {
                  // A hostile descriptor is not usable diagnostic data.
                }
              }
              throw safe;
            }
            if (!["UPDATE", "DELETE", "INSERT", "SELECT", "MERGE"].includes(result.command))
              throw new Error("native_auth_query_command");
            return {
              command: result.command as "UPDATE" | "DELETE" | "INSERT" | "SELECT" | "MERGE",
              rowCount: result.rowCount ?? 0,
              rows: result.rows as R[],
            };
          },
          release() {},
        } as unknown as PostgresPoolClient;
      },
      async end() {},
    },
  });
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Reauthentication and password change share this limit per authenticated account. Sign-in uses the submitted e-mail budget. */
const accountPasswordAttemptsPerMinute = 5;

/**
 * Every password check of one account spends one unit, from any client address or session. The limiter cannot see
 * the account, so the unit is counted inside the handler transaction. The caller commits an admitted attempt on every
 * outcome, so a refused guess keeps its own attempt.
 */
async function admitAccountPasswordAttempt(
  client: PoolClient,
  secret: string,
  userId: string,
): Promise<boolean> {
  const count = await countNativeRateAttempt(
    client,
    nativeRateBucketDigest(secret, "account-password", userId),
  );
  return count <= accountPasswordAttemptsPerMinute;
}

/** Every request uses one locked realm row and a single bounded PG transaction. */
export function createNativePasswordHandler(input: NativePasswordConfiguration) {
  return {
    async handle(request: Request, internalSession = false): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (
        internalSession &&
        (request.method !== "GET" ||
          path !== "/api/auth/v1/get-session" ||
          new URL(request.url).search !== "?disableRefresh=true")
      )
        throw new Error("native_auth_invalid_session");
      const supported = new Set([
        "/api/auth/v1/sign-up/email",
        "/api/auth/v1/sign-in/email",
        "/api/auth/v1/send-verification-email",
        "/api/auth/v1/verify-email",
        "/api/auth/v1/request-password-reset",
        "/api/auth/v1/reset-password",
        "/api/auth/v1/get-session",
        "/api/auth/v1/sign-out",
        "/api/auth/v1/change-password",
        "/api/auth/v1/reauthenticate",
        "/api/auth/v1/enroll-recovery",
        "/api/auth/v1/list-accounts",
        "/api/auth/v1/unlink-account",
      ]);
      if (!supported.has(path)) return new Response(null, { status: 404 });
      if (new URL(request.url).origin !== input.canonicalOrigin)
        return new Response(null, { status: 403 });
      // Custom mutations return before the engine's own CSRF middleware runs.
      if (request.method === "POST" && request.headers.get("origin") !== input.canonicalOrigin)
        return new Response(null, { status: 403 });
      if (
        path.endsWith("/verify-email") ||
        path.endsWith("/get-session") ||
        path.endsWith("/list-accounts")
          ? request.method !== "GET"
          : request.method !== "POST"
      )
        return new Response(null, { status: 405 });
      const allowedPaths = input.allowedRedirectPaths ?? [
        "/login",
        "/reset-password",
        "/accept-invitation",
      ];
      const redirectAllowed = (value: unknown) => {
        if (value === undefined || value === null || value === "") return true;
        if (typeof value !== "string") return false;
        try {
          const url = new URL(value, input.canonicalOrigin);
          return (
            url.origin === input.canonicalOrigin &&
            !url.search &&
            !url.hash &&
            allowedPaths.includes(url.pathname) &&
            (value === url.pathname || value === url.href)
          );
        } catch {
          return false;
        }
      };
      const url = new URL(request.url);
      let explicitCallbackURL: string | undefined;
      const redirectKeys = ["callbackURL", "redirectTo", "errorCallbackURL", "newUserCallbackURL"];
      if (
        redirectKeys.some(
          (key) =>
            url.searchParams.getAll(key).length > 1 || !redirectAllowed(url.searchParams.get(key)),
        )
      )
        return new Response(null, { status: 400 });
      if (request.method === "POST") {
        if (!request.headers.get("content-type")?.includes("application/json"))
          return new Response(null, { status: 415 });
        try {
          const value: unknown = await request.clone().json();
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            redirectKeys.some((key) => !redirectAllowed((value as Record<string, unknown>)[key]))
          )
            return new Response(null, { status: 400 });
          const callbackURL = (value as Record<string, unknown>)["callbackURL"];
          if (typeof callbackURL === "string" && callbackURL !== "")
            explicitCallbackURL = callbackURL;
        } catch {
          return new Response(null, { status: 400 });
        }
      }
      const sendsMail = [
        "/api/auth/v1/sign-up/email",
        "/api/auth/v1/send-verification-email",
        "/api/auth/v1/request-password-reset",
        "/api/auth/v1/enroll-recovery",
      ].includes(path);
      const requestId = sendsMail ? request.headers.get("idempotency-key") : null;
      if (sendsMail && (!requestId || requestId.length > 200))
        return new Response(null, { status: 400 });
      const requestDigest = requestId
        ? createHmac("sha256", input.secret)
            .update("native-password-request-v1\0")
            .update(path)
            .update("\0")
            .update(await request.clone().text())
            .digest()
        : null;
      if (!(await input.ports.admitAttempt(request)))
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      const deadline = Math.min(Date.now() + 14000, input.deadlineAt ?? Infinity);
      const checkoutStarted = startNativeLatency(input.latency);
      let client;
      try {
        client = await input.pool.connect();
      } finally {
        endNativeLatency(input.latency, "sessionCheckoutMs", checkoutStarted);
      }
      let capturedAuthority: NativePasswordAuthority | null = null;
      const commit = async () => {
        if (Date.now() >= deadline) throw new Error("native_auth_deadline");
        const live = await input.ports.currentAuthority();
        if (
          !capturedAuthority ||
          !live?.enabled ||
          live.revocationEpoch !== capturedAuthority.revocationEpoch ||
          live.configurationRevision !== capturedAuthority.configurationRevision ||
          live.signupMode !== capturedAuthority.signupMode
        )
          throw new Error("native_auth_authority_changed");
        const commitStarted = startNativeLatency(input.latency);
        try {
          await client.query("commit");
        } finally {
          endNativeLatency(input.latency, "commitMs", commitStarted);
        }
      };
      let open = false;
      let committed = false;
      const stagedMessages: string[] = [];
      try {
        const beginStarted = startNativeLatency(input.latency);
        try {
          await client.query("begin");
        } finally {
          endNativeLatency(input.latency, "sessionBeginMs", beginStarted);
        }
        open = true;
        const realmStarted = startNativeLatency(input.latency);
        let row;
        try {
          row = await lockNativeRealmPolicy(client, input.previewPolicy);
        } finally {
          endNativeLatency(input.latency, "realmLockMs", realmStarted);
        }
        const authority = await input.ports.currentAuthority();
        if (
          !row?.enabled ||
          !authority?.enabled ||
          String(authority.revocationEpoch) !== row.revocation_epoch ||
          String(authority.configurationRevision) !== row.configuration_revision
        )
          throw new Error("native_auth_unavailable");
        capturedAuthority = authority;
        if (requestId && requestDigest) {
          const previous = await client.query<{
            request_digest: Buffer;
            response_body: string;
            response_status: number;
          }>(
            "select request_digest, response_body, response_status from native_password_receipt where request_id = $1",
            [requestId],
          );
          if (previous.rows[0]) {
            if (!previous.rows[0].request_digest.equals(requestDigest)) {
              await client.query("rollback");
              open = false;
              return new Response(null, { status: 409 });
            }
            const pending = await client.query<{ message_id: string }>(
              "select message_id::text from native_auth_mail_outbox where request_id = $1 and delivered_at is null",
              [requestId],
            );
            stagedMessages.push(...pending.rows.map((entry) => entry.message_id));
            await commit();
            open = false;
            committed = true;
            return new Response(previous.rows[0].response_body, {
              status: previous.rows[0].response_status,
              headers: { "content-type": "application/json" },
            });
          }
        }
        if (path.endsWith("/sign-up/email") && authority.signupMode !== "open") {
          await client.query("rollback");
          open = false;
          return new Response(null, { status: 403 });
        }
        let mailFailure = false;
        const stageInner = async (message: {
          kind: "verification" | "password-reset";
          to: string;
          url: string;
          token: string;
        }) => {
          const messageId = randomUUID();
          const sealed = await input.ports.sealMail({ ...message, messageId });
          if (!sealed.byteLength || sealed.byteLength > 65536)
            throw new Error("native_mail_unavailable");
          if (message.kind === "verification" && path.endsWith("/sign-up/email")) {
            await client.query(
              `insert into native_user_policy (user_id, status) select id, 'pending' from "user" where lower(email) = lower($1) on conflict (user_id) do nothing`,
              [message.to],
            );
          }
          const user = await client.query<{ id: string; revocation_epoch: string }>(
            `select u.id, p.revocation_epoch from "user" u join native_user_policy p on p.user_id=u.id where lower(u.email) = lower($1)`,
            [message.to],
          );
          if (user.rowCount !== 1 || !user.rows[0])
            throw new Error("native_mail_recipient_missing");
          if (message.kind === "verification" && !path.endsWith("/enroll-recovery")) {
            await client.query(
              `insert into native_mail_challenge (token_digest, user_id, purpose, realm_epoch, configuration_revision, user_epoch, expires_at)
              values ($1, $2, 'verification', $3, $4, $5, current_timestamp + interval '1 hour')
              on conflict (user_id, purpose) do update set token_digest = excluded.token_digest, realm_epoch = excluded.realm_epoch, configuration_revision = excluded.configuration_revision, user_epoch = excluded.user_epoch, expires_at = excluded.expires_at`,
              [
                tokenHash(message.token),
                user.rows[0].id,
                authority.revocationEpoch,
                authority.configurationRevision,
                user.rows[0].revocation_epoch,
              ],
            );
          }
          await client.query(
            "insert into native_auth_mail_outbox (message_id, kind, sealed_payload, user_id, token_digest, realm_epoch, configuration_revision, request_id) values ($1, $2, $3, $4, $5, $6, $7, $8)",
            [
              messageId,
              message.kind,
              Buffer.from(sealed),
              user.rows[0].id,
              tokenHash(message.token),
              authority.revocationEpoch,
              authority.configurationRevision,
              requestId,
            ],
          );
          stagedMessages.push(messageId);
        };
        const stage = async (message: Parameters<typeof stageInner>[0]) => {
          try {
            await stageInner(message);
          } catch {
            mailFailure = true;
            throw new Error("native_mail_unavailable");
          }
        };
        const options = createNativeAuthEngineOptions({
          ...input,
          database: { dialect: boundDialect(client), type: "postgres", transaction: false },
          sendMail: stage,
        });
        if (options.emailVerification) {
          options.emailVerification.sendVerificationEmail = async ({ user, url }) => {
            const token = await createEmailVerificationToken(
              input.secret,
              user.email,
              undefined,
              3600,
              { jti: randomUUID() },
            );
            const target = new URL(url);
            target.searchParams.set("token", token);
            if (target.searchParams.get("callbackURL") === "/" && explicitCallbackURL === undefined)
              target.searchParams.set("callbackURL", nativeApplicationFallbackPath(allowedPaths));
            await stage({ kind: "verification", to: user.email, url: target.href, token });
          };
        }
        // Provider errors can contain credentials; only the platform emits redacted outcomes.
        options.logger = { disabled: true };
        options.databaseHooks = {
          user: {
            create: {
              after: async (user) => {
                await client.query(
                  "insert into native_user_policy (user_id, status) values ($1, 'pending') on conflict (user_id) do nothing",
                  [user.id],
                );
              },
            },
            update: {
              after: async (user) => {
                if (path !== "/api/auth/v1/verify-email" || !user.emailVerified) return;
                const policy = await client.query<{ status: string }>(
                  "select status from native_user_policy where user_id = $1 for update",
                  [user.id],
                );
                if (!policy.rows[0] || policy.rows[0].status === "suspended")
                  throw new Error("native_user_forbidden");
                const invite = await client.query(
                  "select 1 from native_invitation where user_id = $1 and consumed_at is null",
                  [user.id],
                );
                const pendingSocial = await client.query(
                  "select 1 from native_social_pending where user_id = $1",
                  [user.id],
                );
                if (
                  policy.rows[0].status === "pending" &&
                  invite.rowCount &&
                  pendingSocial.rowCount !== 1
                )
                  throw new Error("native_invitation_required");
                await client.query(
                  "update native_user_policy set status = case when exists (select 1 from native_social_pending where user_id = $1) then 'pending' else 'active' end, recovery_verified_at = current_timestamp where user_id = $1",
                  [user.id],
                );
              },
            },
          },
          session: {
            create: {
              before: async (session) => {
                const user = await client.query(
                  "select 1 from native_user_policy where user_id = $1 and status = 'active' for update",
                  [session.userId],
                );
                if (user.rowCount !== 1) throw new Error("native_user_forbidden");
              },
              after: async (session) => {
                await client.query(
                  "insert into native_session_policy (session_id, realm_epoch, user_epoch, authenticated_at) select $1, $2, revocation_epoch, current_timestamp from native_user_policy where user_id = $3 and status = 'active'",
                  [session.id, authority.revocationEpoch, session.userId],
                );
              },
            },
          },
        };
        const auth = betterAuth(options);
        if (path.endsWith("/request-password-reset") || path.endsWith("/reset-password")) {
          if (
            request.method !== "POST" ||
            !request.headers.get("content-type")?.includes("application/json") ||
            request.headers.get("origin") !== input.canonicalOrigin
          ) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 403 });
          }
          const body: unknown = await request.json();
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 400 });
          }
          const data = body as Record<string, unknown>;
          if (path.endsWith("/request-password-reset")) {
            if (typeof data["email"] !== "string" || data["email"].length > 254) {
              await client.query("rollback");
              open = false;
              return new Response(null, { status: 400 });
            }
            const user = await client.query<{
              id: string;
              email: string;
              revocation_epoch: string;
            }>(
              `select u.id, u.email, p.revocation_epoch from "user" u join native_user_policy p on p.user_id = u.id where lower(u.email) = lower($1) and p.status = 'active' and p.recovery_verified_at is not null for update of p`,
              [data["email"]],
            );
            if (user.rows[0] && user.rowCount === 1) {
              const token = randomBytes(32).toString("base64url");
              await client.query(
                `insert into native_mail_challenge (token_digest, user_id, purpose, realm_epoch, configuration_revision, user_epoch, expires_at)
                values ($1,$2,'password-reset',$3,$4,$5,current_timestamp + interval '1 hour') on conflict (user_id, purpose) do update set token_digest=excluded.token_digest, realm_epoch=excluded.realm_epoch, configuration_revision=excluded.configuration_revision, user_epoch=excluded.user_epoch, expires_at=excluded.expires_at`,
                [
                  tokenHash(token),
                  user.rows[0].id,
                  authority.revocationEpoch,
                  authority.configurationRevision,
                  user.rows[0].revocation_epoch,
                ],
              );
              const url = new URL(
                input.resetPasswordPath ?? "/reset-password",
                input.canonicalOrigin,
              );
              url.searchParams.set("token", token);
              await stage({ kind: "password-reset", to: user.rows[0].email, token, url: url.href });
            }
            const body = JSON.stringify({ status: true });
            await client.query(
              "insert into native_password_receipt (request_id, request_digest, response_body, response_status) values ($1, $2, $3, 200)",
              [requestId, requestDigest, body],
            );
            await commit();
            open = false;
            committed = true;
            return Response.json({ status: true });
          }
          if (
            typeof data["token"] !== "string" ||
            !/^[A-Za-z0-9_-]{43,128}$/u.test(data["token"]) ||
            typeof data["newPassword"] !== "string" ||
            data["newPassword"].length < 12 ||
            data["newPassword"].length > 128
          ) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 400 });
          }
          const challenge = await client.query<{ user_id: string }>(
            `select c.user_id from native_mail_challenge c join native_user_policy p on p.user_id=c.user_id where c.token_digest=$1 and c.purpose='password-reset' and c.expires_at > current_timestamp and c.realm_epoch=$2 and c.configuration_revision=$3 and c.user_epoch=p.revocation_epoch and p.status='active' and p.recovery_verified_at is not null for update of c,p`,
            [tokenHash(data["token"]), authority.revocationEpoch, authority.configurationRevision],
          );
          const userId = challenge.rows[0]?.user_id;
          if (!userId) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 400 });
          }
          const password = await hashPassword(data["newPassword"]);
          const credential = await client.query(
            `insert into "account" ("accountId","providerId","userId","password","updatedAt") values ($1::uuid::text,'credential',$1::uuid,$2,current_timestamp) on conflict ("providerId","accountId") do update set "password"=excluded."password", "updatedAt"=current_timestamp where "account"."userId"=excluded."userId"`,
            [userId, password],
          );
          if (credential.rowCount !== 1) throw new Error("native_auth_credential_conflict");
          await client.query("delete from native_mail_challenge where token_digest=$1", [
            tokenHash(data["token"]),
          ]);
          await client.query(
            "update native_user_policy set revocation_epoch=revocation_epoch+1 where user_id=$1",
            [userId],
          );
          await client.query('delete from "session" where "userId"=$1', [userId]);
          await commit();
          open = false;
          return Response.json({ status: true });
        }
        let recoveryAvailable: boolean | undefined;
        if (
          [
            "/api/auth/v1/get-session",
            "/api/auth/v1/sign-out",
            "/api/auth/v1/change-password",
            "/api/auth/v1/reauthenticate",
            "/api/auth/v1/enroll-recovery",
            "/api/auth/v1/list-accounts",
            "/api/auth/v1/unlink-account",
          ].includes(path)
        ) {
          // The private path still goes through Better Auth's HTTP rate limiter. Its
          // single no-refresh response supplies the session for the Native policy check.
          let session: Awaited<ReturnType<typeof auth.api.getSession>>;
          if (internalSession) {
            const engineStarted = startNativeLatency(input.latency);
            let response;
            try {
              response = await auth.handler(request);
            } finally {
              endNativeLatency(input.latency, "engineMs", engineStarted);
            }
            if (!response.ok) {
              await client.query("rollback");
              open = false;
              return response;
            }
            const value: unknown = await response.json();
            if (
              value !== null &&
              (typeof value !== "object" ||
                Array.isArray(value) ||
                typeof Reflect.get(value, "user") !== "object" ||
                Reflect.get(value, "user") === null ||
                typeof Reflect.get(value, "session") !== "object" ||
                Reflect.get(value, "session") === null)
            )
              throw new Error("native_auth_invalid_session");
            session = value as typeof session;
          } else {
            session = await auth.api.getSession({
              headers: request.headers,
              query: { disableRefresh: true },
            });
          }
          if (session) {
            const userStarted = startNativeLatency(input.latency);
            let eligible;
            try {
              eligible = await client.query<{ recovery_available: boolean }>(
                `select (p.recovery_verified_at is not null) as recovery_available from native_session_policy s join native_user_policy p on p.user_id=$2 where s.session_id=$1 and s.realm_epoch=$3 and s.user_epoch=p.revocation_epoch and p.status='active' for update of p`,
                [session.session.id, session.user.id, authority.revocationEpoch],
              );
            } finally {
              endNativeLatency(input.latency, "userLockMs", userStarted);
            }
            if (eligible.rowCount !== 1) {
              await client.query("rollback");
              open = false;
              return path.endsWith("/get-session")
                ? Response.json(null)
                : new Response(null, { status: 401 });
            }
            recoveryAvailable = eligible.rows[0]?.recovery_available;
            if (internalSession) {
              const rawExpiresAt: unknown = session.session.expiresAt;
              if (typeof rawExpiresAt !== "string") throw new Error("native_auth_invalid_session");
              const expiresAt = Date.parse(rawExpiresAt);
              if (!Number.isFinite(expiresAt)) throw new Error("native_auth_invalid_session");
              await commit();
              open = false;
              committed = true;
              // The user-policy lock and the final authority RPC can outlive the session.
              // Never return a positive result after the sampled session expires.
              if (expiresAt <= Date.now()) return Response.json(null);
              return Response.json({
                user: { id: session.user.id, email: session.user.email },
                session: { id: session.session.id, expiresAt: session.session.expiresAt },
              });
            }
            if (path.endsWith("/list-accounts")) {
              const accounts = await client.query<{
                id: string;
                provider_id: string;
                account_id: string;
                created_at: Date;
                updated_at: Date;
                scope: string | null;
              }>(
                'select id::text, "providerId" as provider_id, "accountId" as account_id, "createdAt" as created_at, "updatedAt" as updated_at, scope from "account" where "userId"=$1 order by "createdAt",id',
                [session.user.id],
              );
              await commit();
              open = false;
              committed = true;
              return Response.json(
                accounts.rows.map((account) => ({
                  id: account.id,
                  providerId: account.provider_id,
                  accountId: account.account_id,
                  userId: session.user.id,
                  createdAt: account.created_at.toISOString(),
                  updatedAt: account.updated_at.toISOString(),
                  scopes: account.scope?.split(",").filter(Boolean) ?? [],
                })),
              );
            }
            if (path.endsWith("/unlink-account")) {
              const body: unknown = await request.clone().json();
              const accountId =
                body && typeof body === "object" && !Array.isArray(body)
                  ? (body as Record<string, unknown>)["accountId"]
                  : undefined;
              if (
                typeof accountId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
                  accountId,
                )
              ) {
                await client.query("rollback");
                open = false;
                return new Response(null, { status: 400 });
              }
              const accounts = await client.query<{
                id: string;
                provider_id: string;
                password: string | null;
              }>(
                'select id::text, "providerId" as provider_id, password from "account" where "userId"=$1 for update',
                [session.user.id],
              );
              if (!accounts.rows.some((account) => account.id === accountId)) {
                await client.query("rollback");
                open = false;
                return new Response(null, { status: 404 });
              }
              let usable = false;
              for (const account of accounts.rows) {
                if (account.id === accountId) continue;
                if (account.provider_id === "credential" && account.password) usable = true;
                if (
                  (account.provider_id === "google" || account.provider_id === "github") &&
                  (await input.ports.isProviderUsable?.(account.provider_id)) === true
                )
                  usable = true;
              }
              if (!usable) {
                await client.query("rollback");
                open = false;
                return Response.json({ error: "last_login_method" }, { status: 409 });
              }
              await client.query('delete from "account" where id=$1 and "userId"=$2', [
                accountId,
                session.user.id,
              ]);
              await commit();
              open = false;
              committed = true;
              return Response.json({ status: true });
            }
            if (path.endsWith("/reauthenticate")) {
              const value: unknown = await request.clone().json();
              const password =
                value && typeof value === "object" && !Array.isArray(value)
                  ? (value as Record<string, unknown>)["password"]
                  : undefined;
              if (typeof password !== "string" || password.length > 128) {
                await client.query("rollback");
                open = false;
                return new Response(null, { status: 400 });
              }
              if (!(await admitAccountPasswordAttempt(client, input.secret, session.user.id))) {
                await client.query("rollback");
                open = false;
                return new Response(null, { status: 429, headers: { "retry-after": "60" } });
              }
              const account = await client.query<{ password: string | null }>(
                `select password from "account" where "userId"=$1 and "providerId"='credential'`,
                [session.user.id],
              );
              if (
                !account.rows[0]?.password ||
                !(await verifyPassword({ hash: account.rows[0].password, password }))
              ) {
                // The attempt just counted must survive the refusal, so this commits rather than rolls back.
                await commit();
                open = false;
                committed = true;
                return new Response(null, { status: 403 });
              }
              const updated = await client.query<{ authenticated_at: Date }>(
                "update native_session_policy set authenticated_at=current_timestamp where session_id=$1 returning authenticated_at",
                [session.session.id],
              );
              await commit();
              open = false;
              committed = true;
              return Response.json({
                authenticatedAt: updated.rows[0]?.authenticated_at.toISOString(),
              });
            }
            if (path.endsWith("/change-password")) {
              // Better Auth verifies the current password itself. Its 4xx refusals come before it writes the new
              // password, and its database rate-limit row must survive them, so they commit with the admitted attempt.
              // Its 500 can follow the write (new sessions are created after it), so only that answer rolls the handler's
              // writes back, to a savepoint taken after the attempt was counted.
              if (!(await admitAccountPasswordAttempt(client, input.secret, session.user.id))) {
                await client.query("rollback");
                open = false;
                return new Response(null, { status: 429, headers: { "retry-after": "60" } });
              }
              await client.query("savepoint change_password");
              const response = await auth.handler(request);
              if (mailFailure) throw new Error("native_mail_unavailable");
              if (response.status >= 500)
                await client.query("rollback to savepoint change_password");
              await commit();
              open = false;
              committed = true;
              return response;
            }
            if (path.endsWith("/enroll-recovery")) {
              const token = await createEmailVerificationToken(
                input.secret,
                session.user.email,
                undefined,
                3600,
                { jti: randomUUID() },
              );
              const user = await client.query<{ revocation_epoch: string }>(
                "select revocation_epoch from native_user_policy where user_id=$1 and status='active' for update",
                [session.user.id],
              );
              if (!user.rows[0]) throw new Error("native_user_forbidden");
              await client.query(
                `insert into native_mail_challenge (token_digest,user_id,purpose,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,'recovery',$3,$4,$5,current_timestamp + interval '1 hour') on conflict (user_id,purpose) do update set token_digest=excluded.token_digest,realm_epoch=excluded.realm_epoch,configuration_revision=excluded.configuration_revision,user_epoch=excluded.user_epoch,expires_at=excluded.expires_at`,
                [
                  tokenHash(token),
                  session.user.id,
                  authority.revocationEpoch,
                  authority.configurationRevision,
                  user.rows[0].revocation_epoch,
                ],
              );
              const target = new URL("/api/auth/v1/verify-email", input.canonicalOrigin);
              target.searchParams.set("token", token);
              target.searchParams.set(
                "callbackURL",
                explicitCallbackURL ?? nativeApplicationFallbackPath(allowedPaths),
              );
              await stage({
                kind: "verification",
                to: session.user.email,
                url: target.href,
                token,
              });
              const body = JSON.stringify({ status: "sent" });
              await client.query(
                "insert into native_password_receipt (request_id,request_digest,response_body,response_status) values ($1,$2,$3,200)",
                [requestId, requestDigest, body],
              );
              await commit();
              open = false;
              committed = true;
              return Response.json({ status: "sent" });
            }
          } else if (!path.endsWith("/get-session")) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 401 });
          }
        }
        let verificationDigest: Buffer | undefined;
        let recoveryUserId: string | null = null;
        if (path === "/api/auth/v1/verify-email") {
          const token = new URL(request.url).searchParams.get("token");
          if (!token || token.length > 4096) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 400 });
          }
          verificationDigest = tokenHash(token);
          const proof = await client.query<{ user_id: string; purpose: string }>(
            `select c.user_id::text, c.purpose from native_mail_challenge c join native_user_policy p on p.user_id = c.user_id where c.token_digest = $1 and c.expires_at > current_timestamp and c.realm_epoch = $2 and c.configuration_revision = $3 and c.user_epoch = p.revocation_epoch and ((c.purpose = 'verification' and p.status = 'pending' and (not exists (select 1 from native_invitation i where i.user_id = c.user_id and i.consumed_at is null) or exists (select 1 from native_social_pending sp where sp.user_id = c.user_id))) or (c.purpose = 'recovery' and p.status = 'active')) for update of c, p`,
            [verificationDigest, authority.revocationEpoch, authority.configurationRevision],
          );
          if (proof.rows[0]?.purpose === "recovery") recoveryUserId = proof.rows[0].user_id;
          if (proof.rowCount !== 1) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 400 });
          }
        }
        if (internalSession) {
          await commit();
          open = false;
          committed = true;
          return Response.json(null);
        }
        const response = await auth.handler(request);
        if (mailFailure) throw new Error("native_mail_unavailable");
        if (response.status >= 400) {
          await client.query("rollback");
          open = false;
          return response;
        }
        if (verificationDigest)
          await client.query(
            "delete from native_mail_challenge where token_digest = $1 and purpose in ('verification','recovery')",
            [verificationDigest],
          );
        if (recoveryUserId)
          await client.query(
            "update native_user_policy set recovery_verified_at=current_timestamp where user_id=$1 and status='active'",
            [recoveryUserId],
          );
        let resultResponse = response;
        if (
          (path.endsWith("/sign-in/email") || path.endsWith("/get-session")) &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const value: unknown = await response.json();
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const object = value as Record<string, unknown>;
            delete object["token"];
            if (path.endsWith("/get-session") && object["user"] !== undefined) {
              const user = object["user"];
              if (
                !user ||
                typeof user !== "object" ||
                Array.isArray(user) ||
                recoveryAvailable === undefined
              )
                throw new Error("native_auth_invalid_session");
              (user as Record<string, unknown>)["recoveryAvailable"] = recoveryAvailable;
            }
            if (
              object["session"] &&
              typeof object["session"] === "object" &&
              !Array.isArray(object["session"])
            )
              delete (object["session"] as Record<string, unknown>)["token"];
          }
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          resultResponse = new Response(JSON.stringify(value), {
            status: response.status,
            headers,
          });
        }
        if (requestId && requestDigest) {
          const body = await resultResponse.clone().text();
          await client.query(
            "insert into native_password_receipt (request_id, request_digest, response_body, response_status) values ($1, $2, $3, $4)",
            [requestId, requestDigest, body, resultResponse.status],
          );
        }
        await commit();
        open = false;
        committed = true;
        return resultResponse;
      } catch {
        if (open) await client.query("rollback");
        return Response.json({ error: "auth_unavailable" }, { status: 503 });
      } finally {
        client.release();
        if (committed && stagedMessages.length) await input.ports.deliverMail(stagedMessages);
      }
    },
    async validateSession(cookie: string): Promise<NativeAuthSession | null> {
      if (cookie.length > 16384) return null;
      const response = await this.handle(
        new Request(`${input.canonicalOrigin}/api/auth/v1/get-session?disableRefresh=true`, {
          headers: { cookie, "cf-connecting-ip": nativeSessionRateAddress(cookie) },
        }),
        true,
      );
      if (!response.ok) throw new Error("native_auth_unavailable");
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      const user = record["user"] as Record<string, unknown> | null;
      const session = record["session"] as Record<string, unknown> | null;
      if (
        !user ||
        !session ||
        typeof user["id"] !== "string" ||
        typeof user["email"] !== "string" ||
        typeof session["id"] !== "string" ||
        typeof session["expiresAt"] !== "string"
      )
        throw new Error("native_auth_invalid_session");
      return {
        user: { id: user["id"], email: user["email"] },
        session: { id: session["id"], expiresAt: session["expiresAt"] },
      };
    },
  };
}

/** A private sender must use messageId as its durable idempotency key. */
export function createNativePasswordMailDispatcher(input: {
  pool: Pool;
  currentAuthority(): Promise<NativePasswordAuthority | null>;
  send(message: { messageId: string; sealedPayload: Uint8Array }): Promise<void>;
  previewPolicy?: NativePreviewPolicyKey;
}) {
  return {
    async dispatchOne(messageId?: string): Promise<boolean> {
      if (messageId !== undefined && !/^[0-9a-f-]{36}$/iu.test(messageId))
        throw new TypeError("invalid_native_message_id");
      const client = await input.pool.connect();
      const lease = randomUUID();
      let active = false;
      let message: { message_id: string; sealed_payload: Buffer } | undefined;
      try {
        await client.query("begin");
        active = true;
        const row = await lockNativeRealmPolicy(client, input.previewPolicy);
        const live = await input.currentAuthority();
        if (
          row?.enabled &&
          live?.enabled &&
          String(live.revocationEpoch) === row.revocation_epoch &&
          String(live.configurationRevision) === row.configuration_revision
        ) {
          const claimed = await client.query<{ message_id: string; sealed_payload: Buffer }>(
            `with candidate as (
            select o.message_id from native_auth_mail_outbox o join native_user_policy p on p.user_id = o.user_id
            where ($4::uuid is null or o.message_id = $4::uuid) and o.delivered_at is null and (o.lease_expires_at is null or o.lease_expires_at < current_timestamp)
              and o.created_at > current_timestamp - interval '1 hour' and o.realm_epoch = $2 and o.configuration_revision = $3
              and ((o.kind = 'verification' and exists (select 1 from native_mail_challenge c where c.user_id = o.user_id and c.token_digest = o.token_digest and ((c.purpose = 'verification' and p.status='pending') or (c.purpose='recovery' and p.status='active')) and c.expires_at > current_timestamp and c.user_epoch = p.revocation_epoch)) or (o.kind = 'password-reset' and p.status = 'active' and p.recovery_verified_at is not null and exists (select 1 from native_mail_challenge c where c.user_id = o.user_id and c.token_digest = o.token_digest and c.purpose = 'password-reset' and c.expires_at > current_timestamp and c.user_epoch = p.revocation_epoch)))
            order by o.created_at for update of o skip locked limit 1
          ) update native_auth_mail_outbox o set lease_id = $1, lease_expires_at = current_timestamp + interval '1 minute' from candidate c where o.message_id = c.message_id returning o.message_id::text, o.sealed_payload`,
            [lease, live.revocationEpoch, live.configurationRevision, messageId ?? null],
          );
          message = claimed.rows[0];
        }
        await client.query("commit");
        active = false;
      } catch (error) {
        if (active) await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      if (!message) {
        if (!messageId) return false;
        const delivered = await input.pool.query(
          "select 1 from native_auth_mail_outbox where message_id = $1 and delivered_at is not null",
          [messageId],
        );
        return delivered.rowCount === 1;
      }
      await input.send({ messageId: message.message_id, sealedPayload: message.sealed_payload });
      await input.pool.query(
        "update native_auth_mail_outbox set delivered_at = current_timestamp, lease_id = null, lease_expires_at = null where message_id = $1 and lease_id = $2 and delivered_at is null",
        [message.message_id, lease],
      );
      return true;
    },
  };
}
