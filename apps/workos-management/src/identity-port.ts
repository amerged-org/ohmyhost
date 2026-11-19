/**
 * The closed identity port of the WorkOS management Worker: the only Control persistence the user-key
 * lifecycle, the session revocation and the session status check use. It carries no database client type;
 * `d1-identity-port.ts` implements it with typed commands over the private WorkosRuntime service binding.
 */

export type UserApiKeyRequestCode =
  | "invalid_request"
  | "resource_not_found"
  | "idempotency_key_reused"
  | "result_conflict";

export const USER_API_KEY_REQUEST_CODES: readonly UserApiKeyRequestCode[] = [
  "invalid_request",
  "resource_not_found",
  "idempotency_key_reused",
  "result_conflict",
];

/** The closed error set of the original `UserApiKeyRequestError`; the private handler maps it to a status. */
export class UserApiKeyRequestError extends Error {
  constructor(readonly code: UserApiKeyRequestCode) {
    super(code);
  }
}

/** The verified subject, organization and session of the caller; `now` is the Worker's own clock. */
export interface UserKeyScopeInput {
  readonly organizationId: string;
  readonly workosOrganizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly now: string;
}

export interface UserApiKeyClaim {
  readonly action: "create" | "observe";
  readonly requestId: string;
  readonly providerName: string;
  readonly permissions: readonly string[];
  readonly expiresAt: string | null;
  readonly keyId: string | null;
}

export type UserApiKeyFinishOutcome =
  | { readonly kind: "created"; readonly keyId: string }
  | {
      readonly kind: "rejected";
      /** A creation that failed before its provider request was sent (CORE-46). */
      readonly code: "KEY_PERMISSIONS_UNAVAILABLE" | "KEY_CREATION_NOT_SENT";
    };

export interface WorkosUserKeyIdentityPort {
  /** Refuses with `resource_not_found` unless the user, organization and session are all currently allowed. */
  authorizeUserApiKeyScope(input: UserKeyScopeInput): Promise<void>;
  /** Commits the request BEFORE any provider key is created. The permissions are never caller input. */
  claimUserApiKeyCreation(
    input: UserKeyScopeInput & {
      readonly requestId: string;
      readonly auditEventId: string;
      readonly name: string;
      readonly idempotencyKey: string;
    },
  ): Promise<UserApiKeyClaim>;
  finishUserApiKeyCreation(
    input: UserKeyScopeInput & {
      readonly requestId: string;
      readonly auditEventId: string;
      readonly outcome: UserApiKeyFinishOutcome;
    },
  ): Promise<void>;
  readUserApiKeyNames(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly keyIds: readonly string[];
  }): Promise<ReadonlyMap<string, string>>;
  /** One closed audit event of the key revocation; never an arbitrary event type, actor or payload. */
  recordUserApiKeyRevocationAudit(input: {
    readonly organizationId: string;
    readonly workosOrganizationId: string;
    readonly userId: string;
    readonly keyId: string;
    readonly stage: "requested" | "revoked";
    readonly auditEventId: string;
    readonly now: string;
  }): Promise<void>;
}

export interface WorkosSessionRevocationIdentityPort {
  /** The user a terminally revoked session belongs to (null user when unknown), or null when never revoked. */
  readSessionRevocation(input: {
    readonly sessionId: string;
  }): Promise<{ readonly workosUserId: string | null } | null>;
  recordTerminalRevocation(input: {
    readonly kind: "session";
    readonly sessionId: string;
    readonly workosUserId: string;
    readonly sourceEventId: string;
    readonly effectiveAt: string;
  }): Promise<"created" | "existing">;
}

export interface WorkosSessionEligibilityPort {
  isSessionEligible(input: {
    readonly sessionId: string;
    readonly workosUserId: string;
    readonly workosOrganizationId: string | null;
    readonly observedAt: string;
  }): Promise<boolean>;
}

export type WorkosIdentityPort = WorkosUserKeyIdentityPort &
  WorkosSessionRevocationIdentityPort &
  WorkosSessionEligibilityPort;
