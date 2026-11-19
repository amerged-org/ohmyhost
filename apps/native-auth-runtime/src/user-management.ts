import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { NativeAuthUser } from "@ohmyhost/contracts/native-auth";

/** Resolved by a private binding, never by customer-provided roles or headers. */
export interface NativeAdminScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}
export interface NativeAdminAuthority {
  /** Verify the live Owner operation grant for this scope and request. */
  authorize(scope: NativeAdminScope, proof: string): Promise<boolean>;
  currentAuthority(scope: NativeAdminScope): Promise<{
    enabled: boolean;
    revocationEpoch: number;
    configurationRevision: number;
  } | null>;
  /** Encrypt a purpose-bound payload to private mail custody. Never log the payload. */
  sealInvitation(payload: { email: string; token: string; messageId: string }): Promise<Uint8Array>;
}
export type NativeUserMutation =
  | { action: "create-invite"; email: string; name?: string }
  | {
      action: "resend-invitation" | "suspend" | "reactivate" | "delete" | "revoke-sessions";
      userId: string;
    };
export interface NativeUserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: "pending" | "active" | "suspended";
  readonly recoveryAvailable: boolean;
  readonly createdAt: Date;
}

async function transact<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
  beforeCommit?: () => Promise<void>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await action(client);
    await beforeCommit?.();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function validateScope(scope: NativeAdminScope): void {
  if (
    ![scope.organizationId, scope.projectId, scope.environmentId].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
    )
  )
    throw new TypeError("invalid_native_admin_scope");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Each pool must use a private credential bound to the exact scope's schema. */
export function createNativeUserManagement(
  pool: Pool,
  scope: NativeAdminScope,
  authority: NativeAdminAuthority,
) {
  validateScope(scope);
  async function authorize(proof: string): Promise<void> {
    if (!proof || !(await authority.authorize(scope, proof)))
      throw new Error("native_admin_forbidden");
  }
  async function lockRealm(client: PoolClient, proof: string) {
    const realm = await client.query<{
      enabled: boolean;
      revocation_epoch: string;
      configuration_revision: string;
    }>(
      "select enabled, revocation_epoch, configuration_revision from native_realm_policy where singleton = true for update",
    );
    await authorize(proof);
    const current = await authority.currentAuthority(scope);
    const row = realm.rows[0];
    if (
      !row ||
      !current ||
      row.enabled !== current.enabled ||
      String(current.revocationEpoch) !== row.revocation_epoch ||
      String(current.configurationRevision) !== row.configuration_revision
    )
      throw new Error("native_realm_unavailable");
    return current;
  }
  const select = `select u.id::text, u.email, u.name, p.status, u."createdAt", (p.recovery_verified_at is not null) as "recoveryAvailable" from "user" u join native_user_policy p on p.user_id = u.id`;
  return {
    async list(
      proof: string,
      options: { limit?: number; after?: string; search?: string } = {},
    ): Promise<NativeUserRecord[]> {
      await authorize(proof);
      const limit = options.limit ?? 50;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 101 ||
        (options.after !== undefined && !uuid.test(options.after)) ||
        (options.search?.length ?? 0) > 320
      )
        throw new TypeError("invalid_native_user_query");
      const search = options.search?.trim().toLowerCase() ?? "";
      const result = await pool.query<NativeUserRecord>(
        `${select} where ($1::uuid is null or u.id > $1::uuid) and ($2 = '' or position($2 in lower(u.email)) > 0 or position($2 in lower(u.name)) > 0) order by u.id limit $3`,
        [options.after ?? null, search, limit],
      );
      return result.rows;
    },
    async get(proof: string, userId: string): Promise<NativeUserRecord | null> {
      await authorize(proof);
      if (!uuid.test(userId)) throw new TypeError("invalid_native_user_id");
      const result = await pool.query<NativeUserRecord>(`${select} where u.id = $1`, [userId]);
      return result.rows[0] ?? null;
    },
    async mutate(
      proof: string,
      requestId: string,
      canonicalRequestDigest: Uint8Array,
      mutation: NativeUserMutation,
    ): Promise<{
      userId: string;
      action: NativeUserMutation["action"];
      user: NativeAuthUser | null;
    }> {
      await authorize(proof);
      if (requestId.length < 1 || requestId.length > 200)
        throw new TypeError("invalid_native_request_id");
      if (canonicalRequestDigest.byteLength !== 32)
        throw new TypeError("invalid_native_request_digest");
      let normalized: NativeUserMutation;
      if (mutation.action === "create-invite") {
        const email = mutation.email.trim().toLowerCase();
        const name = mutation.name?.trim() ?? email;
        if (
          email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
          name.length === 0 ||
          name.length > 256
        )
          throw new TypeError("invalid_native_user");
        normalized = { action: mutation.action, email, name };
      } else {
        if (
          !uuid.test(mutation.userId) ||
          !["resend-invitation", "suspend", "reactivate", "delete", "revoke-sessions"].includes(
            mutation.action,
          )
        )
          throw new TypeError("invalid_native_mutation");
        normalized = { action: mutation.action, userId: mutation.userId };
      }
      const requestDigest = digest(
        JSON.stringify({
          scope,
          mutation: normalized,
          canonicalDigest: Buffer.from(canonicalRequestDigest).toString("hex"),
        }),
      );
      let observed: {
        enabled: boolean;
        revocationEpoch: number;
        configurationRevision: number;
      } | null = null;
      return transact(
        pool,
        async (client) => {
          const realm = await lockRealm(client, proof);
          observed = realm;
          const prior = await client.query<{
            request_digest: Buffer;
            response: {
              userId: string;
              action: NativeUserMutation["action"];
              user: NativeAuthUser | null;
            };
          }>("select request_digest, response from native_admin_receipt where request_id = $1", [
            requestId,
          ]);
          if (prior.rows[0]) {
            if (!prior.rows[0].request_digest.equals(requestDigest))
              throw new Error("native_admin_idempotency_conflict");
            // Delete erases the address from the receipts of its user, so a replay of an action on that user refuses as
            // the missing user does. The delete's own receipt keeps answering.
            if (prior.rows[0].response.action !== "delete") {
              const exists = await client.query('select 1 from "user" where id = $1', [
                prior.rows[0].response.userId,
              ]);
              if (exists.rowCount !== 1) throw new Error("native_user_not_found");
            }
            return prior.rows[0].response;
          }
          if (
            !realm.enabled &&
            (normalized.action === "create-invite" || normalized.action === "resend-invitation")
          )
            throw new Error("native_realm_unavailable");
          const userId = normalized.action === "create-invite" ? randomUUID() : normalized.userId;
          let email: string | undefined;
          if (normalized.action === "create-invite") {
            email = normalized.email;
            try {
              await client.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
                userId,
                normalized.name,
                email,
              ]);
            } catch (error) {
              // The normalized email is unique per realm: a duplicate is a stable refusal, not a storage fault.
              if (
                error !== null &&
                typeof error === "object" &&
                Reflect.get(error, "code") === "23505"
              )
                throw new Error("native_user_email_exists");
              throw error;
            }
            await client.query(
              "insert into native_user_policy (user_id, status) values ($1, 'pending')",
              [userId],
            );
          } else {
            const result = await client.query<{
              email: string;
              status: string;
              revocation_epoch: string;
            }>(
              'select u.email, p.status, p.revocation_epoch from native_user_policy p join "user" u on u.id = p.user_id where p.user_id = $1 for update of p',
              [userId],
            );
            const user = result.rows[0];
            if (!user) throw new Error("native_user_not_found");
            email = user.email;
            if (normalized.action === "resend-invitation" && user.status !== "pending")
              throw new Error("native_user_not_pending");
            if (
              (normalized.action === "suspend" || normalized.action === "reactivate") &&
              user.status === "pending"
            )
              throw new Error("native_user_pending");
            if (normalized.action === "delete") {
              await client.query('delete from "user" where id = $1', [userId]);
              // Receipts keep their replay answers without the address. An invitation row keeps the delivery record
              // that a replayed invitation proves delivery from, so only its sealed payload is emptied.
              await client.query(
                `update native_admin_receipt set response = jsonb_set(response, '{user,email}', '""')
                  where jsonb_typeof(response -> 'user') = 'object'
                    and request_id in (select request_id from native_admin_audit where user_id = $1)`,
                [userId],
              );
              await client.query(
                "update native_mail_outbox set sealed_payload = ''::bytea where user_id = $1 and octet_length(sealed_payload) > 0",
                [userId],
              );
            }
            if (
              normalized.action === "suspend" ||
              normalized.action === "reactivate" ||
              normalized.action === "revoke-sessions"
            ) {
              const status =
                normalized.action === "suspend"
                  ? "suspended"
                  : normalized.action === "reactivate"
                    ? "active"
                    : user.status;
              await client.query(
                "update native_user_policy set status = $2, revocation_epoch = revocation_epoch + 1 where user_id = $1",
                [userId, status],
              );
              await client.query('delete from "session" where "userId" = $1', [userId]);
            }
          }
          if (normalized.action === "resend-invitation" || normalized.action === "delete") {
            await client.query(
              "update native_mail_outbox set cancelled_at = current_timestamp where user_id = $1 and delivered_at is null and cancelled_at is null",
              [userId],
            );
          }
          const resultUser =
            normalized.action === "delete"
              ? null
              : (await client.query<NativeUserRecord>(`${select} where u.id = $1`, [userId]))
                  .rows[0];
          if (normalized.action !== "delete" && !resultUser)
            throw new Error("native_user_not_found");
          const response = {
            userId,
            action: normalized.action,
            user: resultUser
              ? {
                  id: resultUser.id,
                  email: resultUser.email,
                  status: resultUser.status,
                  recoveryAvailable: resultUser.recoveryAvailable,
                  createdAt: resultUser.createdAt.toISOString(),
                }
              : null,
          };
          await client.query(
            "insert into native_admin_receipt (request_id, request_digest, response) values ($1, $2, $3)",
            [requestId, requestDigest, response],
          );
          await client.query(
            "insert into native_admin_audit (request_id, action, user_id) values ($1, $2, $3)",
            [requestId, normalized.action, userId],
          );
          if (normalized.action === "create-invite" || normalized.action === "resend-invitation") {
            const token = randomBytes(32).toString("base64url");
            const messageId = randomUUID();
            const sealed = await authority.sealInvitation({ email, token, messageId });
            if (sealed.byteLength === 0 || sealed.byteLength > 65536)
              throw new Error("native_mail_envelope_invalid");
            await client.query(
              `insert into native_invitation (token_digest, user_id, realm_epoch, configuration_revision, user_epoch, expires_at)
            select $1, user_id, $3, $4, revocation_epoch, current_timestamp + interval '24 hours' from native_user_policy where user_id = $2 and status = 'pending'
            on conflict (user_id) do update set token_digest = excluded.token_digest, realm_epoch = excluded.realm_epoch, configuration_revision = excluded.configuration_revision, user_epoch = excluded.user_epoch, expires_at = excluded.expires_at, consumed_at = null`,
              [digest(token), userId, realm.revocationEpoch, realm.configurationRevision],
            );
            await client.query(
              "insert into native_mail_outbox (message_id, request_id, user_id, kind, sealed_payload, token_digest) values ($1, $2, $3, 'invitation', $4, $5)",
              [messageId, requestId, userId, Buffer.from(sealed), digest(token)],
            );
          }
          return response;
        },
        async () => {
          await authorize(proof);
          const live = await authority.currentAuthority(scope);
          if (
            !observed ||
            !live ||
            live.enabled !== observed.enabled ||
            live.revocationEpoch !== observed.revocationEpoch ||
            live.configurationRevision !== observed.configurationRevision
          )
            throw new Error("native_admin_authority_changed");
        },
      );
    },
  };
}

/** The private sender must deduplicate retries by messageId and never expose the envelope. */
export interface NativeInvitationSender {
  currentAuthority(
    scope: NativeAdminScope,
  ): Promise<{ enabled: boolean; revocationEpoch: number; configurationRevision: number } | null>;
  send(
    scope: NativeAdminScope,
    message: { messageId: string; sealedPayload: Uint8Array },
  ): Promise<void>;
}

/** Claims one live invitation, releases PostgreSQL, then sends using its durable message identity. */
export function createNativeInvitationDispatcher(
  pool: Pool,
  scope: NativeAdminScope,
  sender: NativeInvitationSender,
) {
  validateScope(scope);
  return {
    async dispatchOne(requestId?: string, expectedUserId?: string): Promise<boolean> {
      if (expectedUserId !== undefined && !uuid.test(expectedUserId))
        throw new TypeError("invalid_native_user_id");
      if (requestId !== undefined && (requestId.length < 1 || requestId.length > 200))
        throw new TypeError("invalid_native_request_id");
      const leaseId = randomUUID();
      const message = await transact(pool, async (client) => {
        const realm = await client.query<{
          enabled: boolean;
          revocation_epoch: string;
          configuration_revision: string;
        }>(
          "select enabled, revocation_epoch, configuration_revision from native_realm_policy where singleton = true for update",
        );
        const live = await sender.currentAuthority(scope);
        const row = realm.rows[0];
        if (
          !row?.enabled ||
          !live?.enabled ||
          String(live.revocationEpoch) !== row.revocation_epoch ||
          String(live.configurationRevision) !== row.configuration_revision
        )
          return null;
        const claimed = await client.query<{ message_id: string; sealed_payload: Buffer }>(
          `with candidate as (
          select o.message_id from native_mail_outbox o
          join native_invitation i on i.user_id = o.user_id and i.token_digest = o.token_digest
          join native_user_policy p on p.user_id = i.user_id
          where ($4::text is null or o.request_id = $4) and ($5::uuid is null or o.user_id = $5::uuid) and o.delivered_at is null and o.cancelled_at is null and (o.lease_expires_at is null or o.lease_expires_at < current_timestamp)
            and i.consumed_at is null and i.expires_at > current_timestamp and i.realm_epoch = $2 and i.configuration_revision = $3
            and i.user_epoch = p.revocation_epoch and p.status = 'pending'
          order by o.created_at for update of o skip locked limit 1
        ) update native_mail_outbox o set lease_id = $1, lease_expires_at = current_timestamp + interval '1 minute'
          from candidate c where o.message_id = c.message_id returning o.message_id::text, o.sealed_payload`,
          [
            leaseId,
            live.revocationEpoch,
            live.configurationRevision,
            requestId ?? null,
            expectedUserId ?? null,
          ],
        );
        return claimed.rows[0] ?? null;
      });
      if (!message) {
        if (requestId === undefined) return false;
        const delivered = await pool.query(
          "select 1 from native_mail_outbox where request_id = $1 and ($2::uuid is null or user_id = $2::uuid) and delivered_at is not null",
          [requestId, expectedUserId ?? null],
        );
        return delivered.rowCount === 1;
      }
      await sender.send(scope, {
        messageId: message.message_id,
        sealedPayload: message.sealed_payload,
      });
      await pool.query(
        "update native_mail_outbox set delivered_at = current_timestamp, lease_id = null, lease_expires_at = null where message_id = $1 and lease_id = $2 and delivered_at is null",
        [message.message_id, leaseId],
      );
      return true;
    },
  };
}
