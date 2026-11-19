import type { NativeAuthSession } from "@ohmyhost/contracts/native-auth";

/** Query must target the private role and schema of this realm. */
export interface NativeAuthSessionQuery {
  query(sql: string, parameters: readonly unknown[]): Promise<{ readonly rowCount: number | null }>;
}

/** Checks authoritative SQL state on every lookup; never maintains a positive cache. */
export async function validateNativeSessionPolicy(
  database: NativeAuthSessionQuery,
  session: NativeAuthSession,
  currentRealmEpoch: number,
): Promise<NativeAuthSession | null> {
  if (!Number.isSafeInteger(currentRealmEpoch) || currentRealmEpoch < 0) {
    throw new TypeError("invalid_native_auth_epoch");
  }
  const result = await database.query(
    `select 1 from "session" s
      join "user" u on u.id = s."userId"
      join native_session_policy sp on sp.session_id = s.id
      join native_user_policy up on up.user_id = u.id
      where s.id = $1 and u.id = $2 and u.email = $3
        and s."expiresAt" > current_timestamp and up.status = 'active'
        and sp.realm_epoch = $4 and sp.user_epoch = up.revocation_epoch`,
    [session.session.id, session.user.id, session.user.email, currentRealmEpoch],
  );
  return result.rowCount === 1 ? session : null;
}
