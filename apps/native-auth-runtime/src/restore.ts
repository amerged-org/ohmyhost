import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { NativeAdminScope } from "./user-management.js";

/** This is a private Core authority, not a customer-provided restore declaration. */
export interface NativeRestoreAuthority {
  current(scope: NativeAdminScope): Promise<{
    scope: NativeAdminScope;
    restoreId: string;
    claimId: string;
    databaseId: string;
    offline: boolean;
    revocationEpoch: number;
    configurationRevision: number;
    /** The Core accepted-operation fence installed for the restore generation. */
    acceptedMutationEpoch: number;
  } | null>;
}
export interface NativeRestoreInput {
  readonly pool: Pool;
  readonly scope: NativeAdminScope;
  readonly restoreId: string;
  readonly claimId: string;
  /** Verified database identity from the active private registry receipt. */
  readonly databaseId: string;
  /** Private realm key; it never enters the snapshot or the receipt. */
  readonly receiptKey: string;
  /** Bounded historical HMAC keys, preserving their original string representation. */
  readonly additionalReceiptKeys?: readonly string[];
  readonly authority: NativeRestoreAuthority;
}
export interface NativeRestoreReceipt {
  readonly status: "sanitized";
  readonly revocationEpoch: number;
  readonly configurationRevision: number;
}

/**
 * Sanitizes an already-restored, offline realm. External Core must fence old
 * accepted mutations before this call and keep the realm offline through commit.
 * The pool must be bound to the verified same-project, same-environment schema.
 */
export async function sanitizeRestoredNativeRealm(
  input: NativeRestoreInput,
): Promise<NativeRestoreReceipt> {
  const { scope, restoreId, claimId, databaseId } = input;
  if (
    !scope.organizationId ||
    !scope.projectId ||
    !scope.environmentId ||
    !restoreId ||
    restoreId.length > 200 ||
    !claimId ||
    claimId.length > 200 ||
    !/^[a-z][a-z0-9]{19}$/u.test(databaseId) ||
    typeof input.receiptKey !== "string" ||
    input.receiptKey.length < 32 ||
    (input.additionalReceiptKeys !== undefined &&
      (!Array.isArray(input.additionalReceiptKeys) ||
        input.additionalReceiptKeys.length > 8 ||
        input.additionalReceiptKeys.some((key) => typeof key !== "string" || key.length < 32)))
  )
    throw new TypeError("invalid_native_restore_scope");
  const canonical = JSON.stringify([
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    databaseId,
    restoreId,
  ]);
  const receiptFor = (key: string) => ({
    id: `native-restore:${createHmac("sha256", key)
      .update("native-restore-id-v1\0")
      .update(canonical)
      .digest("hex")}`,
    fingerprint: createHmac("sha256", key)
      .update("native-restore-receipt-v1\0")
      .update(canonical)
      .digest(),
  });
  const currentReceipt = receiptFor(input.receiptKey);
  const oldKeys = new Set(input.additionalReceiptKeys ?? []);
  oldKeys.delete(input.receiptKey);
  const candidates = [currentReceipt, ...Array.from(oldKeys, receiptFor)];
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `ohmyho-native-restore/v1:${scope.organizationId}:${scope.projectId}:${databaseId}`,
    ]);
    const locked = await client.query<{
      enabled: boolean;
      revocation_epoch: string;
      configuration_revision: string;
    }>(
      "select enabled, revocation_epoch, configuration_revision from native_realm_policy where singleton=true for update",
    );
    const row = locked.rows[0];
    const current = await input.authority.current(scope);
    const valid = (value: Awaited<ReturnType<NativeRestoreAuthority["current"]>>) =>
      !!value &&
      value.offline &&
      value.restoreId === restoreId &&
      value.claimId === claimId &&
      value.databaseId === databaseId &&
      value.scope.organizationId === scope.organizationId &&
      value.scope.projectId === scope.projectId &&
      value.scope.environmentId === scope.environmentId &&
      Number.isSafeInteger(value.revocationEpoch) &&
      Number.isSafeInteger(value.configurationRevision) &&
      Number.isSafeInteger(value.acceptedMutationEpoch) &&
      value.revocationEpoch >= 0 &&
      value.configurationRevision >= 0 &&
      value.acceptedMutationEpoch >= value.revocationEpoch;
    if (!row || !valid(current) || !current) throw new Error("native_restore_authority_invalid");
    const prior = await client.query<{
      request_id: string;
      request_digest: Buffer;
      response: NativeRestoreReceipt;
    }>(
      "select request_id,request_digest,response from native_admin_receipt where request_id=any($1::text[])",
      [candidates.map((candidate) => candidate.id)],
    );
    if (prior.rows.length > 1) throw new Error("native_restore_receipt_conflict");
    if (prior.rows[0]) {
      const saved = prior.rows[0];
      const candidate = candidates.find((value) => value.id === saved.request_id);
      if (
        !candidate ||
        saved.request_digest.length !== candidate.fingerprint.length ||
        !timingSafeEqual(saved.request_digest, candidate.fingerprint) ||
        saved.response.status !== "sanitized" ||
        saved.response.revocationEpoch !== current.revocationEpoch ||
        saved.response.configurationRevision !== current.configurationRevision ||
        row.enabled ||
        row.revocation_epoch !== String(current.revocationEpoch) ||
        row.configuration_revision !== String(current.configurationRevision)
      )
        throw new Error("native_restore_receipt_conflict");
      const live = await input.authority.current(scope);
      if (
        !valid(live) ||
        !live ||
        live.revocationEpoch !== current.revocationEpoch ||
        live.configurationRevision !== current.configurationRevision
      )
        throw new Error("native_restore_authority_changed");
      await client.query("commit");
      return saved.response;
    }
    if (
      BigInt(row.revocation_epoch) >= BigInt(current.revocationEpoch) ||
      BigInt(row.configuration_revision) >= BigInt(current.configurationRevision)
    )
      throw new Error("native_restore_generation_not_advanced");
    // Preserve audit and admin receipts: Core's accepted-operation generation fence
    // prevents historical management commands from being accepted after restoration.
    await client.query('delete from "session"');
    await client.query('delete from "verification"');
    await client.query("delete from native_mail_challenge");
    await client.query("delete from native_invitation");
    await client.query("delete from native_social_flow");
    await client.query("delete from native_auth_mail_outbox");
    await client.query("delete from native_mail_outbox");
    await client.query("delete from native_invitation_accept_receipt");
    await client.query(
      `update native_password_receipt set response_status=409, response_body='{"error":"restore_invalidated"}'`,
    );
    // Pending identities retain provider subject and invitation origin, but must
    // establish a new mailbox proof under the newly active realm generation.
    await client.query(
      "update native_user_policy set recovery_verified_at=null where status='pending'",
    );
    await client.query(
      'update "user" u set "emailVerified"=false, "updatedAt"=current_timestamp from native_user_policy p where p.user_id=u.id and p.status=\'pending\'',
    );
    await client.query(
      "update native_realm_policy set enabled=false, revocation_epoch=$1, configuration_revision=$2 where singleton=true",
      [current.revocationEpoch, current.configurationRevision],
    );
    const receipt: NativeRestoreReceipt = {
      status: "sanitized",
      revocationEpoch: current.revocationEpoch,
      configurationRevision: current.configurationRevision,
    };
    await client.query(
      "insert into native_admin_receipt (request_id,request_digest,response) values ($1,$2,$3)",
      [currentReceipt.id, currentReceipt.fingerprint, receipt],
    );
    const live = await input.authority.current(scope);
    if (
      !valid(live) ||
      !live ||
      live.revocationEpoch !== current.revocationEpoch ||
      live.configurationRevision !== current.configurationRevision
    )
      throw new Error("native_restore_authority_changed");
    await client.query("commit");
    return receipt;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
