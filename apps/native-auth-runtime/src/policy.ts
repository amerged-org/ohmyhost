import { hashPassword } from "better-auth/crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** The selector is supplied by the trusted Native worker, never by a guest connection or GUC. */
export interface NativePreviewPolicyKey {
  readonly previewId: string;
  readonly authGeneration: number;
}
interface NativeRealmPolicyRow {
  readonly enabled: boolean;
  readonly revocation_epoch: string;
  readonly configuration_revision: string;
}
/** All authority writers lock the selected platform policy row before native_user_policy. */
export async function lockNativeRealmPolicy(
  client: PoolClient,
  preview?: NativePreviewPolicyKey,
): Promise<NativeRealmPolicyRow | undefined> {
  const global = (
    await client.query<NativeRealmPolicyRow>(
      "select enabled, revocation_epoch, configuration_revision from native_realm_policy where singleton = true for update",
    )
  ).rows[0];
  if (preview === undefined) return global;
  if (!global) return undefined;
  if (
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(preview.previewId) ||
    !Number.isSafeInteger(preview.authGeneration) ||
    preview.authGeneration < 1
  )
    throw new Error("auth_unavailable");
  const selected = (
    await client.query<NativeRealmPolicyRow>(
      "select enabled, revocation_epoch, configuration_revision from native_preview_realm_policy where preview_id = $1 and auth_generation = $2 for update",
      [preview.previewId, preview.authGeneration],
    )
  ).rows[0];
  if (
    !selected ||
    selected.revocation_epoch !== global.revocation_epoch ||
    selected.configuration_revision !== global.configuration_revision
  )
    return undefined;
  return selected;
}

/** Drain legacy realms where no preview policy table was ever provisioned. */
export async function drainNativePreviewPolicy(
  client: PoolClient,
  preview: NativePreviewPolicyKey,
): Promise<void> {
  if (
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(preview.previewId) ||
    !Number.isSafeInteger(preview.authGeneration) ||
    preview.authGeneration < 1
  )
    throw new Error("auth_unavailable");
  await lockNativeRealmPolicy(client);
  const present = await client.query<{ present: boolean }>(
    "select to_regclass(format('%I.native_preview_realm_policy', current_schema())) is not null as present",
  );
  if (present.rows[0]?.present !== true) return;
  await client.query(
    "select 1 from native_preview_realm_policy where preview_id=$1 and auth_generation=$2 for update",
    [preview.previewId, preview.authGeneration],
  );
}

export interface NativePolicyAuthority {
  /** Live external authority. The caller synchronizes revocations through native_realm_policy. */
  currentAuthority(): Promise<{
    revocationEpoch: number;
    configurationRevision: number;
    enabled: boolean;
  } | null>;
}

async function digest(token: string): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/u.test(token);
}

async function transaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function lockRealm(
  client: PoolClient,
  authority: NativePolicyAuthority,
  preview?: NativePreviewPolicyKey,
): Promise<{ epoch: number; revision: number } | null> {
  const row = await lockNativeRealmPolicy(client, preview);
  const live = await authority.currentAuthority();
  if (
    !row?.enabled ||
    !live?.enabled ||
    !Number.isSafeInteger(live.revocationEpoch) ||
    live.revocationEpoch < 0 ||
    !Number.isSafeInteger(live.configurationRevision) ||
    live.configurationRevision < 0 ||
    String(live.revocationEpoch) !== row.revocation_epoch ||
    String(live.configurationRevision) !== row.configuration_revision
  )
    return null;
  return { epoch: live.revocationEpoch, revision: live.configurationRevision };
}

/** Core publishes first, then waits for this monotonic SQL projection before acknowledging. */
export async function applyNativeRealmPolicy(
  pool: Pool,
  input: { revocationEpoch: number; configurationRevision: number; enabled: boolean },
): Promise<boolean> {
  const { revocationEpoch, configurationRevision, enabled } = input;
  if (
    !Number.isSafeInteger(revocationEpoch) ||
    revocationEpoch < 0 ||
    !Number.isSafeInteger(configurationRevision) ||
    configurationRevision < 0
  )
    return false;
  return transaction(pool, async (client) => {
    const result = await client.query(
      `insert into native_realm_policy (singleton, enabled, revocation_epoch, configuration_revision) values (true, $1, $2, $3)
           on conflict (singleton) do update set enabled = excluded.enabled, revocation_epoch = excluded.revocation_epoch, configuration_revision = excluded.configuration_revision
           where (native_realm_policy.configuration_revision < excluded.configuration_revision and native_realm_policy.revocation_epoch <= excluded.revocation_epoch)
              or (native_realm_policy.configuration_revision = excluded.configuration_revision and native_realm_policy.revocation_epoch <= excluded.revocation_epoch and native_realm_policy.enabled = excluded.enabled)`,
      [enabled, revocationEpoch, configurationRevision],
    );
    return result.rowCount === 1;
  });
}

/** A private preview projection; the global row remains the shared revocation mutex. */
export async function applyNativePreviewRealmPolicy(
  pool: Pool,
  input: NativePreviewPolicyKey & { revocationEpoch: number; configurationRevision: number },
): Promise<boolean> {
  if (
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(input.previewId) ||
    !Number.isSafeInteger(input.authGeneration) ||
    input.authGeneration < 1 ||
    !Number.isSafeInteger(input.revocationEpoch) ||
    input.revocationEpoch < 1 ||
    !Number.isSafeInteger(input.configurationRevision) ||
    input.configurationRevision < 1
  )
    return false;
  return transaction(pool, async (client) => {
    const global = await lockNativeRealmPolicy(client);
    if (
      !global ||
      global.revocation_epoch !== String(input.revocationEpoch) ||
      global.configuration_revision !== String(input.configurationRevision)
    )
      return false;
    const result = await client.query(
      `insert into native_preview_realm_policy(preview_id,auth_generation,enabled,revocation_epoch,configuration_revision) values($1,$2,true,$3,$4)
      on conflict(preview_id,auth_generation) do update set enabled=excluded.enabled,revocation_epoch=excluded.revocation_epoch,configuration_revision=excluded.configuration_revision
      where (native_preview_realm_policy.configuration_revision < excluded.configuration_revision and native_preview_realm_policy.revocation_epoch <= excluded.revocation_epoch)
        or (native_preview_realm_policy.configuration_revision = excluded.configuration_revision and native_preview_realm_policy.revocation_epoch <= excluded.revocation_epoch and native_preview_realm_policy.enabled = excluded.enabled)`,
      [input.previewId, input.authGeneration, input.revocationEpoch, input.configurationRevision],
    );
    return result.rowCount === 1;
  });
}

/**
 * Private realm policy. Callers must not treat this as a Better Auth route wrapper:
 * credential and session writes must go through these transactions, or equivalent
 * transactions which acquire the same locks and enforce the same conditions.
 */
export function createNativePostgresPolicy(
  pool: Pool,
  authority: NativePolicyAuthority,
  receiptKey?: string,
  preview?: NativePreviewPolicyKey,
) {
  const guarded = (action: (client: PoolClient) => Promise<boolean>) =>
    transaction(pool, async (client) => {
      const result = await action(client);
      if (result && (await lockRealm(client, authority, preview)) === null)
        throw new Error("native_auth_authority_changed");
      return result;
    });
  return {
    /** The Core authority publishes first, then waits for this lock before acknowledging. */
    async applyRealmPolicy(input: {
      revocationEpoch: number;
      configurationRevision: number;
      enabled: boolean;
    }): Promise<boolean> {
      return applyNativeRealmPolicy(pool, input);
    },
    /** Serialize user revocation with reset and issuance. */
    async revokeUser(userId: string, status: "active" | "suspended"): Promise<boolean> {
      return guarded(async (client) => {
        if ((await lockRealm(client, authority, preview)) === null) return false;
        const result = await client.query(
          "update native_user_policy set status = $2, revocation_epoch = revocation_epoch + 1 where user_id = $1 and status <> 'pending'",
          [userId, status],
        );
        if (result.rowCount !== 1) return false;
        await client.query('delete from "session" where "userId" = $1', [userId]);
        return true;
      });
    },
    /** Create a session and bind both revocation generations under the same locks. */
    async insertSession(input: {
      id: string;
      userId: string;
      token: string;
      expiresAt: Date;
    }): Promise<boolean> {
      return guarded(async (client) => {
        const epoch = await lockRealm(client, authority, preview);
        if (epoch === null) return false;
        const user = await client.query<{ revocation_epoch: string }>(
          "select revocation_epoch from native_user_policy where user_id = $1 and status = 'active' for update",
          [input.userId],
        );
        if (!user.rows[0]) return false;
        const inserted = await client.query(
          `insert into "session" (id, "userId", token, "expiresAt", "updatedAt")
          select $1, $2, $3, $4, current_timestamp where $4::timestamptz > current_timestamp`,
          [input.id, input.userId, input.token, input.expiresAt],
        );
        if (inserted.rowCount !== 1) return false;
        await client.query(
          "insert into native_session_policy (session_id, realm_epoch, user_epoch, authenticated_at) values ($1, $2, $3, current_timestamp)",
          [input.id, epoch.epoch, user.rows[0].revocation_epoch],
        );
        return true;
      });
    },
    /** Issue only after sender readiness is established. Secret tokens never persist. */
    async issueMailChallenge(
      userId: string,
      purpose: "invitation" | "password-reset",
      token: string,
      expiresAt: Date,
    ): Promise<boolean> {
      if (!validToken(token) || !Number.isFinite(expiresAt.getTime())) return false;
      const tokenDigest = await digest(token);
      return guarded(async (client) => {
        const epoch = await lockRealm(client, authority, preview);
        if (epoch === null) return false;
        const user = await client.query<{
          status: string;
          recovery_verified_at: Date | null;
          revocation_epoch: string;
        }>(
          "select status, recovery_verified_at, revocation_epoch from native_user_policy where user_id = $1 for update",
          [userId],
        );
        const row = user.rows[0];
        if (
          !row ||
          (purpose === "invitation"
            ? row.status !== "pending"
            : row.status !== "active" || row.recovery_verified_at === null)
        )
          return false;
        const result = await client.query(
          `insert into native_mail_challenge (token_digest, user_id, purpose, realm_epoch, configuration_revision, user_epoch, expires_at)
           select $1, $2, $3, $4, $7, $5, $6 where $6::timestamptz > current_timestamp and $6::timestamptz <= current_timestamp + interval '1 hour'
           on conflict (user_id, purpose) do update set token_digest = excluded.token_digest, realm_epoch = excluded.realm_epoch, configuration_revision = excluded.configuration_revision, user_epoch = excluded.user_epoch, expires_at = excluded.expires_at`,
          [
            tokenDigest,
            userId,
            purpose,
            epoch.epoch,
            row.revocation_epoch,
            expiresAt,
            epoch.revision,
          ],
        );
        return result.rowCount === 1;
      });
    },
    /** Return a generic accepted response to callers regardless of this private result. */
    async requestPasswordReset(email: string, token: string, expiresAt: Date): Promise<boolean> {
      if (!validToken(token) || !Number.isFinite(expiresAt.getTime())) return false;
      const tokenDigest = await digest(token);
      return guarded(async (client) => {
        const epoch = await lockRealm(client, authority, preview);
        if (epoch === null) return false;
        const user = await client.query<{ user_id: string; revocation_epoch: string }>(
          `select p.user_id, p.revocation_epoch from native_user_policy p join "user" u on u.id = p.user_id
           where lower(u.email) = lower($1) and p.status = 'active' and p.recovery_verified_at is not null for update of p`,
          [email],
        );
        const row = user.rows[0];
        if (!row || user.rowCount !== 1) return false;
        const result = await client.query(
          `insert into native_mail_challenge (token_digest, user_id, purpose, realm_epoch, configuration_revision, user_epoch, expires_at)
           select $1, $2, 'password-reset', $3, $6, $4, $5 where $5::timestamptz > current_timestamp and $5::timestamptz <= current_timestamp + interval '1 hour'
           on conflict (user_id, purpose) do update set token_digest = excluded.token_digest, realm_epoch = excluded.realm_epoch, configuration_revision = excluded.configuration_revision, user_epoch = excluded.user_epoch, expires_at = excluded.expires_at`,
          [tokenDigest, row.user_id, epoch.epoch, row.revocation_epoch, expiresAt, epoch.revision],
        );
        return result.rowCount === 1;
      });
    },
    /** Called only after private mail readiness; the invitation is sent to this exact user's email. */
    async issueInvitation(userId: string, token: string, expiresAt: Date): Promise<boolean> {
      if (!validToken(token) || !Number.isFinite(expiresAt.getTime())) return false;
      const tokenDigest = await digest(token);
      return guarded(async (client) => {
        const realm = await lockRealm(client, authority, preview);
        if (!realm) return false;
        const result = await client.query<{ revocation_epoch: string }>(
          "select revocation_epoch from native_user_policy where user_id = $1 and status = 'pending' for update",
          [userId],
        );
        const user = result.rows[0];
        if (!user) return false;
        const issued = await client.query(
          `insert into native_invitation (token_digest, user_id, realm_epoch, configuration_revision, user_epoch, expires_at)
          select $1, $2, $3, $4, $5, $6 where $6::timestamptz > current_timestamp and $6::timestamptz <= current_timestamp + interval '24 hours'
          on conflict (user_id) do update set token_digest = excluded.token_digest, realm_epoch = excluded.realm_epoch, configuration_revision = excluded.configuration_revision, user_epoch = excluded.user_epoch, expires_at = excluded.expires_at, consumed_at = null`,
          [tokenDigest, userId, realm.epoch, realm.revision, user.revocation_epoch, expiresAt],
        );
        return issued.rowCount === 1;
      });
    },
    /** An invitation mailed to the invited address proves both possession and that mailbox. */
    async acceptInvitation(input: {
      token: string;
      password: string;
      name?: string;
      requestId: string;
    }): Promise<boolean> {
      if (
        !receiptKey ||
        receiptKey.length < 32 ||
        !validToken(input.token) ||
        input.requestId.length < 1 ||
        input.requestId.length > 200 ||
        input.password.length < 12 ||
        input.password.length > 128 ||
        (input.name !== undefined && (input.name.trim().length === 0 || input.name.length > 256))
      )
        return false;
      const requestDigest = createHmac("sha256", receiptKey)
        .update("native-invitation-accept-v1\0")
        .update(
          JSON.stringify({
            token: input.token,
            password: input.password,
            name: input.name ?? null,
          }),
        )
        .digest();
      const [invitationDigest, passwordHash] = await Promise.all([
        digest(input.token),
        hashPassword(input.password),
      ]);
      return guarded(async (client) => {
        const realm = await lockRealm(client, authority, preview);
        if (!realm) return false;
        const replay = await client.query<{ request_digest: Buffer | null }>(
          "select request_digest from native_invitation_accept_receipt where request_id = $1",
          [input.requestId],
        );
        if (replay.rows[0])
          return (
            replay.rows[0].request_digest?.length === requestDigest.length &&
            timingSafeEqual(replay.rows[0].request_digest, requestDigest)
          );
        const found = await client.query<{ user_id: string }>(
          `select i.user_id from native_invitation i join native_user_policy u on u.user_id = i.user_id
          where i.token_digest = $1 and i.consumed_at is null and i.expires_at > current_timestamp and i.realm_epoch = $2 and i.configuration_revision = $3 and i.user_epoch = u.revocation_epoch and u.status = 'pending'
          for update of i, u`,
          [invitationDigest, realm.epoch, realm.revision],
        );
        const userId = found.rows[0]?.user_id;
        if (!userId) return false;
        const credential = await client.query(
          `insert into "account" ("accountId", "providerId", "userId", "password", "updatedAt")
          values ($1::uuid::text, 'credential', $1::uuid, $2, current_timestamp) on conflict ("providerId", "accountId") do nothing`,
          [userId, passwordHash],
        );
        if (credential.rowCount !== 1) return false;
        await client.query(
          "update native_invitation set consumed_at = current_timestamp where token_digest = $1",
          [invitationDigest],
        );
        await client.query(
          "insert into native_invitation_accept_receipt (request_id, token_digest, user_id, request_digest) values ($1, $2, $3, $4)",
          [input.requestId, invitationDigest, userId, requestDigest],
        );
        await client.query(
          "update native_user_policy set status = 'active', recovery_verified_at = current_timestamp where user_id = $1",
          [userId],
        );
        await client.query(
          'update "user" set "emailVerified" = true, name = coalesce($2, name), "updatedAt" = current_timestamp where id = $1',
          [userId, input.name ?? null],
        );
        return true;
      });
    },
    /** Reset consumes only a reset challenge and never changes account status or email proof. */
    async consumePasswordReset(token: string, password: string): Promise<boolean> {
      if (!validToken(token) || password.length < 12 || password.length > 128) return false;
      const [tokenDigest, passwordHash] = await Promise.all([
        digest(token),
        hashPassword(password),
      ]);
      return guarded(async (client) => {
        const epoch = await lockRealm(client, authority, preview);
        if (epoch === null) return false;
        const found = await client.query<{ user_id: string }>(
          `select c.user_id from native_mail_challenge c join native_user_policy u on u.user_id = c.user_id
           where c.token_digest = $1 and c.purpose = 'password-reset' and c.expires_at > current_timestamp
             and c.realm_epoch = $2 and c.configuration_revision = $3 and c.user_epoch = u.revocation_epoch and u.status = 'active'
             and u.recovery_verified_at is not null for update of c, u`,
          [tokenDigest, epoch.epoch, epoch.revision],
        );
        const userId = found.rows[0]?.user_id;
        if (!userId) return false;
        const credential = await client.query(
          `insert into "account" ("accountId", "providerId", "userId", "password", "updatedAt")
          values ($1::uuid::text, 'credential', $1::uuid, $2, current_timestamp)
          on conflict ("providerId", "accountId") do update set "password" = excluded."password", "updatedAt" = current_timestamp
          where "account"."userId" = excluded."userId"`,
          [userId, passwordHash],
        );
        if (credential.rowCount !== 1) return false;
        await client.query("delete from native_mail_challenge where token_digest = $1", [
          tokenDigest,
        ]);
        await client.query(
          "update native_user_policy set revocation_epoch = revocation_epoch + 1 where user_id = $1",
          [userId],
        );
        await client.query('delete from "session" where "userId" = $1', [userId]);
        return true;
      });
    },
  };
}
