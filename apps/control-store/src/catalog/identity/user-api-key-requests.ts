import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { CommandConflictError, runCommand, type Command, type Plan } from "../../run-command.js";
import {
  auditStatement,
  instant,
  routeOrganization,
  runMapped,
  ulid,
  type CatalogContext,
} from "../common.js";
import { isSessionEligible } from "./membership-state.js";
import { bytesToHex, sessionId, workosOrganizationId, workosUserId } from "./shared.js";

/** The closed error set of the original `UserApiKeyRequestError`. */
export type UserApiKeyRequestCode =
  | "invalid_request"
  | "resource_not_found"
  | "idempotency_key_reused"
  | "result_conflict";

const failure = (code: UserApiKeyRequestCode) => new CommandConflictError(code);

const requestName = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value.trim() === value && !/\p{Cc}/u.test(value));
const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
/**
 * The permissions of every own key: the source stores `AUTHORIZATION_ACTIONS` without `api-keys:manage` and takes
 * no permission input, so a caller cannot widen or narrow them. Mirrored here because the control Worker bundle
 * does not import the platform package (it would widen the bundle and the lockfile for one list of strings);
 * `identity-q1.test.ts` compares this list, order included, with the actual `AUTHORIZATION_ACTIONS` constant, so
 * a new platform action turns that test red until it is mirrored or deliberately excluded.
 */
export const USER_API_KEY_PERMISSIONS: readonly string[] = [
  "feedback:create",
  "credits:read",
  "billing:manage",
  "projects:create",
  "projects:read",
  "projects:write",
  "projects:dev-access",
  "projects:rollback-plan",
  "projects:rollback",
  "projects:promote-plan",
  "projects:promote",
  "projects:delete-plan",
  "projects:delete",
  "sources:link",
  "sources:read",
  "deployments:plan",
  "deployments:create",
  "deployments:read",
  "operations:read",
  "operations:reconcile",
  "logs:read",
  "integrations:read",
  "integrations:manage",
  "auth:read",
  "auth:manage",
  "secrets:read",
  "secrets:write",
  "secrets:delete",
  "audit:read",
  "mail-domains:read",
  "mail-domains:use",
  "mail-domains:admin",
];

const scope = {
  organizationId: ulid,
  workosOrganizationId,
  userId: workosUserId,
  sessionId,
  now: instant,
};

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * The own-key authorization of the original (`api-keys:manage` + active mapping + current session): an active
 * member with a fitting organization grant, an active and beta-admitted organization carrying this WorkOS
 * organization id, and no open membership barrier. One definition for the read and the in-batch guard.
 */
const AUTHORIZED_SQL = `EXISTS (
  SELECT 1 FROM organizations o
  JOIN organization_memberships m ON m.organization_id = o.organization_id AND m.workos_user_id = ?2 AND m.state = 'active'
  JOIN local_authorization_grants g ON g.organization_id = o.organization_id AND g.principal_kind = 'user'
    AND g.principal_id = 'user:' || ?2 AND g.project_id IS NULL AND g.environment_id IS NULL AND g.revoked_at IS NULL
    AND ((g.role = 'owner' AND m.role IN ('admin','owner')) OR (g.role = 'member' AND m.role = 'member'))
  WHERE o.organization_id = ?1 AND o.workos_organization_id = ?3 AND o.state = 'active' AND o.beta_admitted_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM workos_membership_sync_barriers b
      WHERE b.organization_id = o.organization_id AND b.workos_user_id = ?2 AND b.reconciled_at IS NULL))`;

async function assertAuthorized(
  context: CatalogContext,
  input: {
    readonly organizationId: string;
    readonly workosOrganizationId: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly now: string;
  },
): Promise<D1Database> {
  const shard = await routeOrganization(context, input.organizationId);
  const row = await shard.db
    .prepare(`SELECT ${AUTHORIZED_SQL} AS ok`)
    .bind(input.organizationId, input.userId, input.workosOrganizationId)
    .first<{ ok: number }>();
  const eligible = await isSessionEligible(context, {
    sessionId: input.sessionId,
    workosUserId: input.userId,
    workosOrganizationId: input.workosOrganizationId,
    observedAt: `${input.now.slice(0, 23)}Z`,
  });
  if (row?.ok !== 1 || !eligible) throw failure("resource_not_found");
  return shard.db;
}

const authorizeInput = z.strictObject(scope);

/** `authorizeUserApiKeyScope`: the same session, membership and beta authorization for every own-key action. */
export async function authorizeUserApiKeyScope(
  context: CatalogContext,
  rawInput: unknown,
): Promise<void> {
  const parsed = authorizeInput.safeParse(rawInput);
  if (!parsed.success) throw failure("invalid_request");
  await assertAuthorized(context, parsed.data);
}

const claimInput = z.strictObject({
  ...scope,
  requestId: ulid,
  auditEventId: ulid,
  name: requestName,
  idempotencyKey,
});

interface RequestRow {
  readonly request_id: string;
  readonly request_sha256: unknown;
  readonly name: string;
  readonly permissions: string;
  readonly expires_at: string | null;
  readonly provider_key_id: string | null;
  readonly failure_code: "KEY_PERMISSIONS_UNAVAILABLE" | "KEY_CREATION_NOT_SENT" | null;
}

export interface UserApiKeyClaim {
  readonly action: "create" | "observe";
  readonly requestId: string;
  readonly providerName: string;
  readonly permissions: readonly string[];
  readonly expiresAt: string | null;
  readonly keyId: string | null;
}

function claimOf(row: RequestRow, action: "create" | "observe"): UserApiKeyClaim {
  return {
    action,
    requestId: row.request_id,
    providerName: `${row.name} [${row.request_id}]`,
    permissions: JSON.parse(row.permissions) as string[],
    expiresAt: row.expires_at === null ? null : `${row.expires_at.slice(0, 23)}Z`,
    keyId: row.provider_key_id,
  };
}

/**
 * `claimUserApiKeyCreation`: commit this claim BEFORE provider creation (WorkOS does not deduplicate API-key
 * creates). The claim, its authorization guard and the audit event are one shard batch; a repeat of the same
 * idempotency key answers `observe` with the original request unless that attempt was rejected (no provider key
 * exists), which the repeat replaces with a fresh `create`. Another request under the key is
 * `idempotency_key_reused`, and a scope that lost its authorization is `resource_not_found`.
 */
export async function claimUserApiKeyCreation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<UserApiKeyClaim> {
  const parsed = claimInput.safeParse(rawInput);
  if (!parsed.success) throw failure("invalid_request");
  const input = parsed.data;
  const db = await assertAuthorized(context, input);
  const idempotency = await sha256(input.idempotencyKey);
  const requestHash = await sha256(JSON.stringify([input.workosOrganizationId, input.name]));
  const command: Command<RequestRow | null, UserApiKeyClaim> = {
    name: "identity.claimUserApiKeyCreation",
    input: { ...input, now: undefined },
    retryOn: ["row_version_conflict"],
    naturalKeyTables: ["user_api_key_requests"],
    // A lost response of OUR committed claim (the row carries this attempt's own request id) is still `create`:
    // answering `observe` would make the caller skip the provider creation it owns.
    lookup: async (reader) => {
      const row = await reader
        .prepare(
          "SELECT request_id, request_sha256, name, permissions, expires_at, provider_key_id, failure_code FROM user_api_key_requests WHERE organization_id = ?1 AND workos_user_id = ?2 AND idempotency_sha256 = ?3 AND request_id = ?4",
        )
        .bind(input.organizationId, input.userId, idempotency, input.requestId)
        .first<RequestRow>();
      return row === null || bytesToHex(row.request_sha256) !== bytesToHex(requestHash)
        ? undefined
        : claimOf(row, "create");
    },
    read: (shard) =>
      shard
        .prepare(
          "SELECT request_id, request_sha256, name, permissions, expires_at, provider_key_id, failure_code FROM user_api_key_requests WHERE organization_id = ?1 AND workos_user_id = ?2 AND idempotency_sha256 = ?3",
        )
        .bind(input.organizationId, input.userId, idempotency)
        .first<RequestRow>(),
    decide: (existing): Plan<UserApiKeyClaim> => {
      if (existing !== null && bytesToHex(existing.request_sha256) !== bytesToHex(requestHash))
        return { reject: failure("idempotency_key_reused") };
      if (existing !== null && existing.failure_code === null)
        return { replay: claimOf(existing, "observe") };
      const row: RequestRow = {
        request_id: input.requestId,
        request_sha256: requestHash,
        name: input.name,
        permissions: JSON.stringify(USER_API_KEY_PERMISSIONS),
        expires_at: null,
        provider_key_id: null,
        failure_code: null,
      };
      return {
        statements: [
          // Losing the authorization between the check and the write refuses the claim whole: it is final (the
          // original re-checked inside its transaction), not a stale snapshot to decide again.
          guard(db, "scope_inactive", `NOT ${AUTHORIZED_SQL}`, [
            input.organizationId,
            input.userId,
            input.workosOrganizationId,
          ]),
          // A rejection created no provider key, so a repeat under the same idempotency key replaces the rejected
          // attempt and creates again; it never replays the stale rejection once the cause is fixed.
          ...(existing === null
            ? []
            : [
                db
                  .prepare(
                    "DELETE FROM user_api_key_requests WHERE organization_id = ?1 AND workos_user_id = ?2 AND idempotency_sha256 = ?3 AND request_id = ?4 AND failure_code IS NOT NULL",
                  )
                  .bind(input.organizationId, input.userId, idempotency, existing.request_id),
                guard(db, "row_version_conflict", "changes() = 0"),
              ]),
          db
            .prepare(
              "INSERT INTO user_api_key_requests(organization_id, request_id, workos_user_id, workos_organization_id, idempotency_sha256, request_sha256, name, permissions, requested_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
            )
            .bind(
              input.organizationId,
              input.requestId,
              input.userId,
              input.workosOrganizationId,
              idempotency,
              requestHash,
              input.name,
              row.permissions,
              input.now,
            ),
          auditStatement(db, input.organizationId, {
            auditEventId: input.auditEventId,
            projectId: null,
            operationId: null,
            billingEpochId: null,
            eventType: "UserApiKeyCreationStarted",
            actorType: "principal",
            actorId: `user:${input.userId}`,
            payload: { request_id: input.requestId, expires_at: null },
            occurredAt: input.now,
          }),
        ],
        result: () => claimOf(row, "create"),
      };
    },
  };
  return runMapped(db, command, {
    scope_inactive: () => failure("resource_not_found"),
  });
}

const finishInput = z.strictObject({
  ...scope,
  requestId: ulid,
  auditEventId: ulid,
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("created"),
      keyId: z.string().regex(/^api_key_[A-Za-z0-9_]{1,120}$/u),
    }),
    z.strictObject({
      kind: z.literal("rejected"),
      code: z.enum(["KEY_PERMISSIONS_UNAVAILABLE", "KEY_CREATION_NOT_SENT"]),
    }),
  ]),
});

/** `finishUserApiKeyCreation`: records the provider result once; an identical repeat is a no-op, another result a conflict. */
export async function finishUserApiKeyCreation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<void> {
  const parsed = finishInput.safeParse(rawInput);
  if (!parsed.success) throw failure("invalid_request");
  const input = parsed.data;
  const shard = await routeOrganization(context, input.organizationId);
  const db = shard.db;
  const keyId = input.outcome.kind === "created" ? input.outcome.keyId : null;
  const failureCode = input.outcome.kind === "rejected" ? input.outcome.code : null;
  const command: Command<RequestRow | null, void> = {
    name: "identity.finishUserApiKeyCreation",
    input: { ...input, now: undefined },
    retryOn: ["row_version_conflict"],
    read: (reader) =>
      reader
        .prepare(
          "SELECT request_id, request_sha256, name, permissions, expires_at, provider_key_id, failure_code FROM user_api_key_requests WHERE organization_id = ?1 AND request_id = ?2 AND workos_user_id = ?3",
        )
        .bind(input.organizationId, input.requestId, input.userId)
        .first<RequestRow>(),
    decide: (row): Plan<void> => {
      if (row === null) return { reject: failure("resource_not_found") };
      if (row.provider_key_id !== null || row.failure_code !== null) {
        return row.provider_key_id !== keyId || row.failure_code !== failureCode
          ? { reject: failure("result_conflict") }
          : { replay: undefined };
      }
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            "UPDATE user_api_key_requests SET provider_key_id = ?4, failure_code = ?5, finished_at = ?6 WHERE organization_id = ?1 AND request_id = ?2 AND workos_user_id = ?3 AND finished_at IS NULL",
          )
          .bind(input.organizationId, input.requestId, input.userId, keyId, failureCode, input.now),
        guard(db, "row_version_conflict", "changes() = 0"),
        auditStatement(db, input.organizationId, {
          auditEventId: input.auditEventId,
          projectId: null,
          operationId: null,
          billingEpochId: null,
          eventType: keyId === null ? "UserApiKeyCreationRejected" : "UserApiKeyCreationCompleted",
          actorType: "principal",
          actorId: `user:${input.userId}`,
          payload: { request_id: input.requestId, key_id: keyId, failure_code: failureCode },
          occurredAt: input.now,
        }),
      ];
      return { statements, result: () => undefined };
    },
  };
  // Source parity: the original maps nothing from the database. A finish stamped before `requested_at` (the
  // `finished_at >= requested_at` CHECK) or a provider key already recorded on another request (UNIQUE
  // provider_key_id) is an uncaught constraint violation there, so here the whole batch (update and audit event)
  // rolls back and the raw D1 error propagates; `result_conflict` stays the same-request mismatch only.
  await runCommand(db, command);
}

const namesInput = z.strictObject({
  organizationId: ulid,
  userId: workosUserId,
  keyIds: z.array(z.string().min(1).max(128)).max(1000),
});

/** `readUserApiKeyNames`: the recorded names of the caller's own provider keys. */
export async function readUserApiKeyNames(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ReadonlyMap<string, string>> {
  const parsed = namesInput.safeParse(rawInput);
  if (!parsed.success) throw failure("invalid_request");
  const input = parsed.data;
  const shard = await routeOrganization(context, input.organizationId);
  const rows = await shard.db
    .prepare(
      "SELECT provider_key_id, name FROM user_api_key_requests WHERE organization_id = ?1 AND workos_user_id = ?2 AND provider_key_id IN (SELECT value FROM json_each(?3))",
    )
    .bind(input.organizationId, input.userId, JSON.stringify(input.keyIds))
    .all<{ provider_key_id: string; name: string }>();
  return new Map(rows.results.map((row) => [row.provider_key_id, row.name]));
}
