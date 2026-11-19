import { createHash, randomUUID } from "node:crypto";
import { createEmailVerificationToken, getOAuthState } from "better-auth/api";
import { betterAuth } from "better-auth";
import { authorizationCodeRequest, getOAuth2Tokens } from "better-auth/oauth2";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { type GoogleProfile, type GithubProfile } from "better-auth/social-providers";
import type { Pool } from "pg";
import { createNativeSocialEngineOptions, type NativeAuthEngineConfiguration } from "./engine.js";
import { boundDialect, type NativePasswordAuthority } from "./password-handler.js";
import { nativeApplicationFallbackPath } from "./application-redirect.js";

export interface NativeSocialProvider {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly configurationRevision: number;
}
export interface NativeSocialPorts {
  /** Platform-authenticated edge and durable rate admission. */
  admitAttempt(request: Request): Promise<boolean>;
  /** Includes current Paid, deployment capability, canonical domain and runtime admission. */
  currentAuthority(): Promise<NativePasswordAuthority | null>;
  provider(id: "google" | "github"): Promise<NativeSocialProvider | null>;
  sealMail(message: {
    messageId: string;
    kind: "verification";
    to: string;
    url: string;
    token: string;
  }): Promise<Uint8Array>;
  deliverMail(messageIds: readonly string[]): Promise<void>;
  /** Best-effort projection after a committed, validated provider flow. */
  recordProviderSuccess(result: {
    provider: "google" | "github";
    configurationRevision: number;
    revocationEpoch: number;
  }): Promise<void>;
}
export interface NativeSocialConfiguration
  extends Omit<NativeAuthEngineConfiguration, "database" | "sendMail"> {
  readonly pool: Pool;
  readonly ports: NativeSocialPorts;
  /** A lower timeout may be supplied for local provider fixtures. */
  readonly providerTimeoutMs?: number;
  readonly deadlineAt?: number;
}
const sha = (value: string) => createHash("sha256").update(value).digest();

/** Fixed-scope engine OAuth, fenced by the realm transaction and a one-use private state. */
export function createNativeSocialHandler(input: NativeSocialConfiguration) {
  return {
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const callback = /^\/api\/auth\/v1\/callback\/(google|github)$/u.exec(url.pathname);
      const initiation =
        url.pathname === "/api/auth/v1/sign-in/social" ||
        url.pathname === "/api/auth/v1/link-social" ||
        url.pathname === "/api/auth/v1/reauthenticate";
      if (url.origin !== input.canonicalOrigin || (!callback && !initiation))
        return new Response(null, { status: 404 });
      if (callback ? request.method !== "GET" : request.method !== "POST")
        return new Response(null, { status: 405 });
      let providerId: "google" | "github";
      let body: Record<string, unknown> = {};
      let pendingRedirect = nativeApplicationFallbackPath(input.allowedRedirectPaths);
      let invitationDigest: Buffer | null = null;
      let engineRequest = request;
      if (callback) providerId = callback[1] as "google" | "github";
      else {
        if (
          request.headers.get("origin") !== input.canonicalOrigin ||
          !request.headers.get("content-type")?.includes("application/json")
        )
          return new Response(null, { status: 403 });
        try {
          const value: unknown = await request.clone().json();
          if (!value || typeof value !== "object" || Array.isArray(value))
            return new Response(null, { status: 400 });
          body = value as Record<string, unknown>;
        } catch {
          return new Response(null, { status: 400 });
        }
        if (body["provider"] !== "google" && body["provider"] !== "github")
          return new Response(null, { status: 400 });
        providerId = body["provider"];
        if (url.pathname === "/api/auth/v1/reauthenticate") {
          if (Object.keys(body).some((key) => !["provider", "callbackURL"].includes(key)))
            return new Response(null, { status: 400 });
          engineRequest = new Request(`${input.canonicalOrigin}/api/auth/v1/sign-in/social`, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(body),
          });
        }
        if (body["invitationToken"] !== undefined) {
          if (
            url.pathname !== "/api/auth/v1/sign-in/social" ||
            typeof body["invitationToken"] !== "string" ||
            !/^[A-Za-z0-9_-]{43,128}$/u.test(body["invitationToken"])
          )
            return new Response(null, { status: 400 });
          invitationDigest = sha(body["invitationToken"]);
          delete body["invitationToken"];
          engineRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(body),
          });
        }
        if (
          Object.keys(body).some(
            (key) =>
              ![
                "provider",
                "callbackURL",
                "errorCallbackURL",
                "newUserCallbackURL",
                "disableRedirect",
              ].includes(key),
          )
        )
          return new Response(null, { status: 400 });
        for (const key of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
          const value = body[key];
          if (value === undefined) continue;
          if (typeof value !== "string") return new Response(null, { status: 400 });
          try {
            const target = new URL(value, input.canonicalOrigin);
            if (
              target.origin !== input.canonicalOrigin ||
              target.search ||
              target.hash ||
              !(
                input.allowedRedirectPaths ?? ["/login", "/reset-password", "/accept-invitation"]
              ).includes(target.pathname) ||
              (value !== target.pathname && value !== target.href)
            )
              return new Response(null, { status: 400 });
          } catch {
            return new Response(null, { status: 400 });
          }
        }
        body["callbackURL"] ??= pendingRedirect;
        body["errorCallbackURL"] ??= body["callbackURL"];
        engineRequest = new Request(engineRequest.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        });
      }
      if (!(await input.ports.admitAttempt(request)))
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      const deadline = Math.min(Date.now() + 14000, input.deadlineAt ?? Infinity);
      const timeout = input.providerTimeoutMs ?? 10000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000)
        return new Response(null, { status: 503 });
      const providerDeadline = Math.min(Date.now() + timeout, deadline - 1000);
      const providerFetch = async (
        target: string | URL,
        init: RequestInit = {},
      ): Promise<Response> => {
        const remaining = providerDeadline - Date.now();
        if (remaining <= 0) throw new Error("native_provider_timeout");
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  controller.abort();
                  reject(new Error("native_provider_timeout"));
                },
                Math.max(0, providerDeadline - Date.now()),
              );
            }),
            (async () => {
              const response = await fetch(target, {
                ...init,
                redirect: "error",
                signal: controller.signal,
              });
              const reader = response.body?.getReader();
              if (!reader) {
                if (controller.signal.aborted || Date.now() >= providerDeadline)
                  throw new Error("native_provider_timeout");
                return response;
              }
              const cancel = () => {
                void reader.cancel().catch(() => undefined);
              };
              controller.signal.addEventListener("abort", cancel, { once: true });
              try {
                const declared = response.headers.get("content-length");
                if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 1048576))
                  throw new Error("native_provider_response_too_large");
                const chunks: Uint8Array[] = [];
                let total = 0;
                while (true) {
                  if (controller.signal.aborted || Date.now() >= providerDeadline)
                    throw new Error("native_provider_timeout");
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  total += chunk.value.byteLength;
                  if (total > 1048576) throw new Error("native_provider_response_too_large");
                  chunks.push(chunk.value);
                }
                if (controller.signal.aborted || Date.now() >= providerDeadline)
                  throw new Error("native_provider_timeout");
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                return new Response(bytes, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              } finally {
                controller.signal.removeEventListener("abort", cancel);
                cancel();
                reader.releaseLock();
              }
            })(),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
      };
      const client = await input.pool.connect();
      let open = false;
      let claimedState = false;
      let committed = false;
      let successProjection: {
        provider: "google" | "github";
        configurationRevision: number;
        revocationEpoch: number;
      } | null = null;
      let authorityFence: (() => Promise<void>) | null = null;
      const stagedMessages: string[] = [];
      try {
        await client.query("begin");
        open = true;
        const locked = await client.query<{
          enabled: boolean;
          revocation_epoch: string;
          configuration_revision: string;
        }>(
          "select enabled, revocation_epoch, configuration_revision from native_realm_policy where singleton = true for update",
        );
        const authority = await input.ports.currentAuthority();
        const row = locked.rows[0];
        if (
          !row?.enabled ||
          !authority?.enabled ||
          String(authority.revocationEpoch) !== row.revocation_epoch ||
          String(authority.configurationRevision) !== row.configuration_revision
        )
          throw new Error("native_auth_unavailable");
        authorityFence = async () => {
          const current = await input.ports.currentAuthority();
          if (
            !current?.enabled ||
            current.revocationEpoch !== authority.revocationEpoch ||
            current.configurationRevision !== authority.configurationRevision ||
            current.signupMode !== authority.signupMode
          )
            throw new Error("native_auth_authority_changed");
        };
        const provider = await input.ports.provider(providerId);
        if (
          !provider?.enabled ||
          !provider.clientId ||
          !provider.clientSecret ||
          provider.configurationRevision !== authority.configurationRevision
        ) {
          if (callback) {
            const state = url.searchParams.get("state");
            if (state && state.length <= 1024 && url.searchParams.getAll("state").length === 1) {
              await client.query(
                "delete from native_social_flow where state_digest=$1 and provider=$2 and realm_epoch=$3 and configuration_revision=$4",
                [
                  sha(state),
                  providerId,
                  authority.revocationEpoch,
                  authority.configurationRevision,
                ],
              );
              await authorityFence();
              await client.query("commit");
            } else await client.query("rollback");
          } else await client.query("rollback");
          open = false;
          return Response.json({ error: "provider_disabled" }, { status: 403 });
        }
        let identity: { email: string; verified: boolean } | null = null;
        let invitedBinding: { userId: string; subject: string } | null = null;
        let flowInvitation: Buffer | null = null;
        let flowIntent = "login";
        let flowUserId: string | null = null;
        let allowInviteLink = false;
        let pendingVerification = false;
        let accountLinkRequired = false;
        const stageThirdPartyVerification = async (
          email: string,
          subject: string,
          name: string,
        ): Promise<boolean> => {
          const known = await client.query<{ id: string; status: string }>(
            `select u.id, p.status from "account" a join "user" u on u.id=a."userId" join native_user_policy p on p.user_id=u.id where a."providerId"='google' and a."accountId"=$1 for update of p`,
            [subject],
          );
          let userId = known.rows[0]?.id;
          let pendingInvitation: Buffer | null = null;
          if (known.rows[0] && known.rows[0].status !== "pending") return false;
          if (!userId) {
            const existing = await client.query<{ id: string; status: string }>(
              `select u.id,p.status from "user" u join native_user_policy p on p.user_id=u.id where lower(u.email)=lower($1) for update of p`,
              [email],
            );
            userId = existing.rows[0]?.id;
            if (userId) {
              if (existing.rows[0]?.status === "active") accountLinkRequired = true;
              if (existing.rows[0]?.status !== "pending" || !flowInvitation) return false;
              const invited = await client.query(
                "select 1 from native_invitation where token_digest=$1 and user_id=$2 and consumed_at is null and expires_at > current_timestamp and realm_epoch=$3 and configuration_revision=$4 and user_epoch=(select revocation_epoch from native_user_policy where user_id=$2) for update",
                [
                  flowInvitation,
                  userId,
                  authority.revocationEpoch,
                  authority.configurationRevision,
                ],
              );
              if (invited.rowCount !== 1) return false;
              pendingInvitation = flowInvitation;
            } else {
              if (authority.signupMode !== "open") return false;
              userId = randomUUID();
              await client.query('insert into "user" (id,name,email) values ($1,$2,$3)', [
                userId,
                name,
                email,
              ]);
              await client.query(
                "insert into native_user_policy (user_id,status) values ($1,'pending')",
                [userId],
              );
            }
            await client.query(
              `insert into "account" ("accountId","providerId","userId","updatedAt") values ($1,'google',$2,current_timestamp)`,
              [subject, userId],
            );
            await client.query(
              "insert into native_social_pending (user_id,provider,subject,realm_epoch,configuration_revision,invitation_digest) values ($1,'google',$2,$3,$4,$5)",
              [
                userId,
                subject,
                authority.revocationEpoch,
                authority.configurationRevision,
                pendingInvitation,
              ],
            );
          } else {
            const pending = await client.query<{
              realm_epoch: string;
              configuration_revision: string;
              invitation_digest: Buffer | null;
            }>(
              "select realm_epoch,configuration_revision,invitation_digest from native_social_pending where user_id=$1 and provider='google' and subject=$2 for update",
              [userId, subject],
            );
            const previous = pending.rows[0];
            if (!previous) return false;
            const stored = await client.query<{ email: string }>(
              'select email from "user" where id=$1',
              [userId],
            );
            if (stored.rows[0]?.email.toLowerCase() !== email) return false;
            let currentInvitation: Buffer | null = null;
            if (previous.invitation_digest) {
              if (!flowInvitation) return false;
              const invited = await client.query(
                "select 1 from native_invitation where token_digest=$1 and user_id=$2 and consumed_at is null and expires_at > current_timestamp and realm_epoch=$3 and configuration_revision=$4 and user_epoch=(select revocation_epoch from native_user_policy where user_id=$2) for update",
                [
                  flowInvitation,
                  userId,
                  authority.revocationEpoch,
                  authority.configurationRevision,
                ],
              );
              if (invited.rowCount !== 1) return false;
              currentInvitation = flowInvitation;
            }
            const stale =
              previous.realm_epoch !== String(authority.revocationEpoch) ||
              previous.configuration_revision !== String(authority.configurationRevision);
            if (stale) {
              await client.query(
                "update native_user_policy set recovery_verified_at=null where user_id=$1",
                [userId],
              );
              await client.query(
                'update "user" set "emailVerified"=false, "updatedAt"=current_timestamp where id=$1',
                [userId],
              );
            }
            await client.query(
              "update native_social_pending set realm_epoch=$2,configuration_revision=$3,invitation_digest=$4 where user_id=$1",
              [
                userId,
                authority.revocationEpoch,
                authority.configurationRevision,
                currentInvitation,
              ],
            );
          }
          const token = await createEmailVerificationToken(input.secret, email, undefined, 3600, {
            jti: randomUUID(),
          });
          const messageId = randomUUID();
          const verifyUrl = new URL("/api/auth/v1/verify-email", input.canonicalOrigin);
          const state = await getOAuthState();
          if (state?.callbackURL) {
            const target = new URL(state.callbackURL, input.canonicalOrigin);
            if (
              target.origin !== input.canonicalOrigin ||
              target.search ||
              target.hash ||
              !(
                input.allowedRedirectPaths ?? ["/login", "/reset-password", "/accept-invitation"]
              ).includes(target.pathname)
            )
              throw new Error("native_social_invalid_redirect");
            pendingRedirect = target.pathname;
          }
          verifyUrl.searchParams.set("token", token);
          verifyUrl.searchParams.set("callbackURL", pendingRedirect);
          const sealed = await input.ports.sealMail({
            messageId,
            kind: "verification",
            to: email,
            url: verifyUrl.href,
            token,
          });
          if (!sealed.byteLength || sealed.byteLength > 65536)
            throw new Error("native_social_mail_unavailable");
          await client.query(
            `insert into native_mail_challenge (token_digest,user_id,purpose,realm_epoch,configuration_revision,user_epoch,expires_at) select $1,user_id,'verification',$3,$4,revocation_epoch,current_timestamp + interval '1 hour' from native_user_policy where user_id=$2 and status='pending' on conflict (user_id,purpose) do update set token_digest=excluded.token_digest,realm_epoch=excluded.realm_epoch,configuration_revision=excluded.configuration_revision,user_epoch=excluded.user_epoch,expires_at=excluded.expires_at`,
            [sha(token), userId, authority.revocationEpoch, authority.configurationRevision],
          );
          await client.query(
            "insert into native_auth_mail_outbox (message_id,request_id,kind,sealed_payload,user_id,token_digest,realm_epoch,configuration_revision) values ($1,$2,'verification',$3,$4,$5,$6,$7)",
            [
              messageId,
              `social:${messageId}`,
              Buffer.from(sealed),
              userId,
              sha(token),
              authority.revocationEpoch,
              authority.configurationRevision,
            ],
          );
          stagedMessages.push(messageId);
          pendingVerification = true;
          return true;
        };
        const prepareIdentity = async (email: string, subject: string): Promise<boolean> => {
          const linked = await client.query(
            'select 1 from "account" where "providerId"=$1 and "accountId"=$2',
            [providerId, subject],
          );
          if (flowIntent === "reauth") {
            if (!flowUserId || linked.rowCount !== 1) return false;
            const owner = await client.query(
              'select 1 from "account" where "providerId"=$1 and "accountId"=$2 and "userId"=$3',
              [providerId, subject, flowUserId],
            );
            if (owner.rowCount !== 1) return false;
          }
          if (linked.rowCount === 1) {
            const bound = await client.query<{
              user_id: string;
              status: string;
              recovery_verified_at: Date | null;
              invitation_digest: Buffer | null;
            }>(
              `select p.user_id::text, p.status, p.recovery_verified_at, sp.invitation_digest from "account" a join native_user_policy p on p.user_id=a."userId" left join native_social_pending sp on sp.user_id=p.user_id and sp.realm_epoch=$3 and sp.configuration_revision=$4 where a."providerId"=$1 and a."accountId"=$2 for update of p`,
              [providerId, subject, authority.revocationEpoch, authority.configurationRevision],
            );
            const user = bound.rows[0];
            if (!user || user.status === "suspended") return false;
            if (user.status === "pending") {
              if (!user.recovery_verified_at || providerId !== "google") return false;
              const pending = await client.query(
                "select 1 from native_social_pending where user_id=$1 and provider='google' and subject=$2 and realm_epoch=$3 and configuration_revision=$4",
                [user.user_id, subject, authority.revocationEpoch, authority.configurationRevision],
              );
              if (pending.rowCount !== 1) return false;
              if (user.invitation_digest) {
                const consumed = await client.query(
                  "update native_invitation set consumed_at=current_timestamp where token_digest=$1 and user_id=$2 and consumed_at is null and expires_at > current_timestamp and realm_epoch=$3 and configuration_revision=$4 and user_epoch=(select revocation_epoch from native_user_policy where user_id=$2)",
                  [
                    user.invitation_digest,
                    user.user_id,
                    authority.revocationEpoch,
                    authority.configurationRevision,
                  ],
                );
                if (consumed.rowCount !== 1) return false;
              }
              await client.query("update native_user_policy set status='active' where user_id=$1", [
                user.user_id,
              ]);
              await client.query("delete from native_social_pending where user_id=$1", [
                user.user_id,
              ]);
            }
            return true;
          }
          const existing = await client.query<{ id: string; status: string }>(
            `select u.id, p.status from "user" u join native_user_policy p on p.user_id=u.id where lower(u.email)=lower($1) for update of p`,
            [email],
          );
          if (!existing.rows[0]) return authority.signupMode === "open";
          if (existing.rows[0].status !== "pending" || !flowInvitation) return true;
          const invited = await client.query(
            "select 1 from native_invitation where token_digest=$1 and user_id=$2 and consumed_at is null and expires_at > current_timestamp and realm_epoch=$3 and configuration_revision=$4 and user_epoch=(select revocation_epoch from native_user_policy where user_id=$2) for update",
            [
              flowInvitation,
              existing.rows[0].id,
              authority.revocationEpoch,
              authority.configurationRevision,
            ],
          );
          if (invited.rowCount !== 1) return false;
          await client.query(
            "update native_invitation set consumed_at=current_timestamp where token_digest=$1",
            [flowInvitation],
          );
          await client.query(
            "update native_user_policy set status='active', recovery_verified_at=current_timestamp where user_id=$1",
            [existing.rows[0].id],
          );
          await client.query(
            'update "user" set "emailVerified"=true, "updatedAt"=current_timestamp where id=$1',
            [existing.rows[0].id],
          );
          invitedBinding = { userId: existing.rows[0].id, subject };
          allowInviteLink = true;
          if (options.account?.accountLinking)
            options.account.accountLinking.disableImplicitLinking = false;
          return true;
        };
        const options = createNativeSocialEngineOptions({
          ...input,
          database: { dialect: boundDialect(client), type: "postgres", transaction: false },
        });
        options.socialProviders = {
          ...(providerId === "google"
            ? {
                google: {
                  clientId: provider.clientId,
                  clientSecret: provider.clientSecret,
                  includeGrantedScopes: false,
                  getUserInfo: async (tokens) => {
                    const expectedNonce = (
                      tokens as typeof tokens & { expectedIdTokenNonce?: string }
                    ).expectedIdTokenNonce;
                    if (!tokens.idToken || !expectedNonce) return null;
                    const keys = createRemoteJWKSet(
                      new URL("https://www.googleapis.com/oauth2/v3/certs"),
                      { [customFetch]: (target, init) => providerFetch(target, init) },
                    );
                    let claims;
                    try {
                      const verified = await jwtVerify(tokens.idToken, keys, {
                        algorithms: ["RS256"],
                        issuer: ["https://accounts.google.com", "accounts.google.com"],
                        audience: provider.clientId,
                        maxTokenAge: "1h",
                      });
                      claims = verified.payload;
                      if (claims["nonce"] !== expectedNonce || typeof claims.exp !== "number")
                        return null;
                    } catch {
                      return null;
                    }
                    if (
                      !claims ||
                      typeof claims.sub !== "string" ||
                      typeof claims["email"] !== "string" ||
                      claims["email_verified"] !== true
                    )
                      return null;
                    const email = claims["email"].toLowerCase();
                    const domain = email.split("@")[1];
                    const authoritative =
                      domain === "gmail.com" ||
                      (typeof claims["hd"] === "string" && claims["hd"].toLowerCase() === domain);
                    if (!authoritative) {
                      const active = await client.query(
                        `select 1 from "account" a join native_user_policy p on p.user_id=a."userId" where a."providerId"='google' and a."accountId"=$1 and (p.status='active' or (p.status='pending' and p.recovery_verified_at is not null and exists (select 1 from native_social_pending sp where sp.user_id=p.user_id and sp.subject=$1 and sp.realm_epoch=$2 and sp.configuration_revision=$3 and (sp.invitation_digest is null or exists (select 1 from native_invitation i where i.user_id=p.user_id and i.token_digest=sp.invitation_digest and i.consumed_at is null and i.expires_at > current_timestamp and i.realm_epoch=$2 and i.configuration_revision=$3 and i.user_epoch=p.revocation_epoch)))))`,
                        [claims.sub, authority.revocationEpoch, authority.configurationRevision],
                      );
                      if (active.rowCount !== 1) {
                        if (flowIntent === "link" && flowUserId) {
                          const localProof = await client.query(
                            `select 1 from native_user_policy p join "user" u on u.id=p.user_id where p.user_id=$1 and p.status='active' and p.recovery_verified_at is not null and lower(u.email)=lower($2)`,
                            [flowUserId, email],
                          );
                          if (localProof.rowCount !== 1) return null;
                        } else if (flowIntent !== "login") return null;
                        else {
                          await stageThirdPartyVerification(
                            email,
                            claims.sub,
                            typeof claims["name"] === "string" ? claims["name"] : "",
                          );
                          return null;
                        }
                      }
                    }
                    if (!(await prepareIdentity(email, claims.sub))) return null;
                    identity = { email, verified: true };
                    return {
                      user: {
                        email,
                        emailVerified: true,
                        name: typeof claims["name"] === "string" ? claims["name"] : "",
                      },
                      data: claims as unknown as GoogleProfile,
                    };
                  },
                },
              }
            : {}),
          ...(providerId === "github"
            ? {
                github: {
                  clientId: provider.clientId,
                  clientSecret: provider.clientSecret,
                  getUserInfo: async (tokens) => {
                    if (!tokens.accessToken) return null;
                    const headers = {
                      authorization: `Bearer ${tokens.accessToken}`,
                      "user-agent": "ohmyhost-native-auth",
                      accept: "application/vnd.github+json",
                    };
                    const [profileResult, emailResult] = await Promise.allSettled([
                      providerFetch("https://api.github.com/user", {
                        headers,
                        redirect: "error",
                        signal: AbortSignal.timeout(10000),
                      }),
                      providerFetch("https://api.github.com/user/emails", {
                        headers,
                        redirect: "error",
                        signal: AbortSignal.timeout(10000),
                      }),
                    ]);
                    if (profileResult.status === "rejected") throw profileResult.reason;
                    if (emailResult.status === "rejected") throw emailResult.reason;
                    const profileResponse = profileResult.value;
                    const emailResponse = emailResult.value;
                    if (!profileResponse.ok || !emailResponse.ok) return null;
                    const profile: unknown = await profileResponse.json();
                    const emails: unknown = await emailResponse.json();
                    if (
                      !profile ||
                      typeof profile !== "object" ||
                      Array.isArray(profile) ||
                      !Array.isArray(emails)
                    )
                      return null;
                    const raw = profile as Record<string, unknown>;
                    const primary = emails.find(
                      (entry: unknown) =>
                        !!entry &&
                        typeof entry === "object" &&
                        !Array.isArray(entry) &&
                        (entry as Record<string, unknown>)["primary"] === true &&
                        (entry as Record<string, unknown>)["verified"] === true,
                    ) as Record<string, unknown> | undefined;
                    if (
                      !primary ||
                      typeof primary["email"] !== "string" ||
                      !Number.isSafeInteger(raw["id"])
                    )
                      return null;
                    const email = primary["email"].toLowerCase();
                    if (!(await prepareIdentity(email, String(raw["id"])))) return null;
                    identity = { email, verified: true };
                    return {
                      user: {
                        email,
                        emailVerified: true,
                        name:
                          typeof raw["name"] === "string"
                            ? raw["name"]
                            : typeof raw["login"] === "string"
                              ? raw["login"]
                              : "",
                      },
                      data: raw as unknown as GithubProfile,
                    };
                  },
                },
              }
            : {}),
        };
        // Provider errors can contain credentials; only the platform emits redacted outcomes.
        options.logger = { disabled: true };
        options.databaseHooks = {
          user: {
            create: {
              after: async (user) => {
                if (
                  authority.signupMode !== "open" ||
                  !identity ||
                  !identity.verified ||
                  identity.email !== user.email.toLowerCase()
                )
                  throw new Error("native_social_signup_forbidden");
                await client.query(
                  "insert into native_user_policy (user_id, status) values ($1, 'active')",
                  [user.id],
                );
              },
            },
          },
          account: {
            create: {
              before: async (account) => ({
                data: {
                  ...account,
                  accessToken: null,
                  refreshToken: null,
                  idToken: null,
                  accessTokenExpiresAt: null,
                  refreshTokenExpiresAt: null,
                },
              }),
            },
            update: {
              before: async (account) => ({
                data: {
                  ...account,
                  accessToken: null,
                  refreshToken: null,
                  idToken: null,
                  accessTokenExpiresAt: null,
                  refreshTokenExpiresAt: null,
                },
              }),
            },
          },
          session: {
            create: {
              before: async (session) => {
                const eligible = await client.query(
                  "select 1 from native_user_policy where user_id=$1 and status='active' for update",
                  [session.userId],
                );
                if (eligible.rowCount !== 1) throw new Error("native_social_user_forbidden");
              },
              after: async (session) => {
                await client.query(
                  "insert into native_session_policy (session_id,realm_epoch,user_epoch,authenticated_at) select $1,$2,revocation_epoch,current_timestamp from native_user_policy where user_id=$3 and status='active'",
                  [session.id, authority.revocationEpoch, session.userId],
                );
              },
            },
          },
        };
        const auth = betterAuth(options);
        const context = await auth.$context;
        const engineProvider = context.socialProviders.find((entry) => entry.id === providerId);
        if (!engineProvider) throw new Error("native_social_provider_missing");
        engineProvider.validateAuthorizationCode = async (params) => {
          const tokenEndpoint =
            providerId === "google"
              ? "https://oauth2.googleapis.com/token"
              : "https://github.com/login/oauth/access_token";
          const prepared = await authorizationCodeRequest({
            code: params.code,
            codeVerifier: params.codeVerifier,
            redirectURI: params.redirectURI,
            options: { clientId: provider.clientId, clientSecret: provider.clientSecret },
            tokenEndpoint,
          });
          const response = await providerFetch(tokenEndpoint, {
            method: "POST",
            headers: prepared.headers,
            body: prepared.body,
          });
          if (!response.ok) return null;
          const data: unknown = await response.json();
          if (!data || typeof data !== "object" || Array.isArray(data) || "error" in data)
            return null;
          return getOAuth2Tokens(data as Record<string, unknown>);
        };
        if (providerId === "google") {
          engineProvider.requiresIdTokenNonce = true;
          const original = engineProvider.createAuthorizationURL;
          engineProvider.createAuthorizationURL = async (params) => {
            const result = await original(params);
            if (!params.idTokenNonce) throw new Error("native_social_nonce_missing");
            result.searchParams.set("nonce", params.idTokenNonce);
            return result;
          };
        }
        let sessionId: string | null = null;
        let userId: string | null = null;
        let freshSession = false;
        if (
          url.pathname === "/api/auth/v1/link-social" ||
          url.pathname === "/api/auth/v1/reauthenticate" ||
          callback
        ) {
          const session = await auth.api.getSession({
            headers: request.headers,
            query: { disableRefresh: true },
          });
          if (session) {
            const valid = await client.query<{ fresh: boolean }>(
              "select s.authenticated_at > current_timestamp - interval '5 minutes' as fresh from native_session_policy s join native_user_policy p on p.user_id=$2 where s.session_id=$1 and s.realm_epoch=$3 and s.user_epoch=p.revocation_epoch and p.status='active' for update of p",
              [session.session.id, session.user.id, authority.revocationEpoch],
            );
            if (valid.rowCount === 1) {
              sessionId = session.session.id;
              userId = session.user.id;
              freshSession = valid.rows[0]?.fresh === true;
            }
          }
          if (
            (url.pathname === "/api/auth/v1/link-social" && (!sessionId || !freshSession)) ||
            (url.pathname === "/api/auth/v1/reauthenticate" && !sessionId)
          ) {
            await client.query("rollback");
            open = false;
            return Response.json({ error: "reauthentication_required" }, { status: 403 });
          }
        }
        let stateDigest: Buffer | null = null;
        if (callback) {
          const state = url.searchParams.get("state");
          if (!state || state.length > 1024 || url.searchParams.getAll("state").length !== 1) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 400 });
          }
          stateDigest = sha(state);
          const flow = await client.query<{
            intent: string;
            session_id: string | null;
            user_id: string | null;
            invitation_digest: Buffer | null;
          }>(
            "select intent, session_id::text, user_id::text, invitation_digest from native_social_flow where state_digest=$1 and provider=$2 and realm_epoch=$3 and configuration_revision=$4 and expires_at > current_timestamp for update",
            [stateDigest, providerId, authority.revocationEpoch, authority.configurationRevision],
          );
          flowInvitation = flow.rows[0]?.invitation_digest ?? null;
          flowIntent = flow.rows[0]?.intent ?? "login";
          flowUserId = flow.rows[0]?.user_id ?? null;
          if (
            flow.rows[0]?.intent === "link" &&
            flow.rows[0].session_id === sessionId &&
            flow.rows[0].user_id === userId &&
            !freshSession
          ) {
            await client.query("delete from native_social_flow where state_digest=$1", [
              stateDigest,
            ]);
            if (Date.now() >= deadline) throw new Error("native_auth_deadline");
            await authorityFence();
            await client.query("commit");
            open = false;
            committed = true;
            return Response.json({ error: "reauthentication_required" }, { status: 403 });
          }
          if (
            !flow.rows[0] ||
            ((flow.rows[0].intent === "link" || flow.rows[0].intent === "reauth") &&
              (flow.rows[0].session_id !== sessionId ||
                flow.rows[0].user_id !== userId ||
                (flow.rows[0].intent === "link" && !freshSession)))
          ) {
            await client.query("rollback");
            open = false;
            return new Response(null, { status: 403 });
          }
        }
        if (stateDigest) {
          await client.query("delete from native_social_flow where state_digest=$1", [stateDigest]);
          await client.query("savepoint native_oauth_effects");
          claimedState = true;
        }
        const response = await auth.handler(engineRequest);
        if (response.status >= 400) {
          if (claimedState) {
            await client.query("rollback to savepoint native_oauth_effects");
            stagedMessages.length = 0;
            await authorityFence();
            await client.query("commit");
          } else await client.query("rollback");
          open = false;
          return response;
        }
        const redirectLocation = response.headers.get("location");
        if (
          callback &&
          !pendingVerification &&
          redirectLocation &&
          new URL(redirectLocation, input.canonicalOrigin).searchParams.has("error")
        ) {
          await client.query("rollback to savepoint native_oauth_effects");
          stagedMessages.length = 0;
          await authorityFence();
          await client.query("commit");
          open = false;
          if (accountLinkRequired) {
            const allowed = input.allowedRedirectPaths ?? [
              "/login",
              "/reset-password",
              "/accept-invitation",
            ];
            let target = new URL(redirectLocation, input.canonicalOrigin);
            if (target.origin !== input.canonicalOrigin || !allowed.includes(target.pathname))
              target = new URL(nativeApplicationFallbackPath(allowed), input.canonicalOrigin);
            target.searchParams.set("error", "account_not_linked");
            const headers = new Headers(response.headers);
            headers.set("location", target.href);
            return new Response(null, { status: response.status, headers });
          }
          return response;
        }
        if (allowInviteLink && invitedBinding) {
          const expected = invitedBinding as { userId: string; subject: string };
          const account = await client.query(
            'select 1 from "account" where "providerId"=$1 and "accountId"=$2 and "userId"=$3',
            [providerId, expected.subject, expected.userId],
          );
          if (account.rowCount !== 1) throw new Error("native_social_invitation_incomplete");
        }
        if (initiation) {
          await client.query(
            "delete from native_social_flow where ctid in (select ctid from native_social_flow where expires_at < current_timestamp for update skip locked limit 32)",
          );
          const payload: unknown = await response.clone().json();
          if (
            !payload ||
            typeof payload !== "object" ||
            typeof (payload as Record<string, unknown>)["url"] !== "string"
          )
            throw new Error("native_social_invalid_redirect");
          const destination = new URL((payload as { url: string }).url);
          const state = destination.searchParams.get("state");
          if (!state) throw new Error("native_social_state_missing");
          await client.query(
            "insert into native_social_flow (state_digest,provider,intent,realm_epoch,configuration_revision,session_id,user_id,invitation_digest,expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,current_timestamp + interval '10 minutes')",
            [
              sha(state),
              providerId,
              url.pathname.endsWith("/link-social")
                ? "link"
                : url.pathname.endsWith("/reauthenticate")
                  ? "reauth"
                  : "login",
              authority.revocationEpoch,
              authority.configurationRevision,
              sessionId,
              userId,
              invitationDigest,
            ],
          );
        }
        if (Date.now() >= deadline) throw new Error("native_auth_deadline");
        await authorityFence();
        const currentProvider = await input.ports.provider(providerId);
        if (
          !currentProvider?.enabled ||
          currentProvider.configurationRevision !== authority.configurationRevision ||
          currentProvider.clientId !== provider.clientId ||
          currentProvider.clientSecret !== provider.clientSecret
        )
          throw new Error("native_provider_changed");
        await client.query("commit");
        open = false;
        committed = true;
        if (callback && !pendingVerification)
          successProjection = {
            provider: providerId,
            configurationRevision: authority.configurationRevision,
            revocationEpoch: authority.revocationEpoch,
          };
        if (pendingVerification) {
          const headers = new Headers(response.headers);
          headers.set("location", `${pendingRedirect}?error=verification_required`);
          return new Response(null, { status: 302, headers });
        }
        return response;
      } catch {
        if (open) {
          if (claimedState) {
            try {
              await client.query("rollback to savepoint native_oauth_effects");
              stagedMessages.length = 0;
              await authorityFence?.();
              await client.query("commit");
            } catch {
              await client.query("rollback");
            }
          } else await client.query("rollback");
        }
        return new Response(null, { status: 503 });
      } finally {
        client.release();
        if (committed && stagedMessages.length) await input.ports.deliverMail(stagedMessages);
        if (successProjection) {
          try {
            await input.ports.recordProviderSuccess(successProjection);
          } catch {
            /* Projection failure never changes the committed authentication result. */
          }
        }
      }
    },
  };
}
