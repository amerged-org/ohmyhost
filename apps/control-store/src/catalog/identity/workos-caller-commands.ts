import { z } from "zod";

import { guard } from "../../guards.js";
import { CommandConflictError, runCommand, type Command, type Plan } from "../../run-command.js";
import {
  auditStatement,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { sessionId, workosOrganizationId, workosUserId } from "./shared.js";

/**
 * Commands the WorkOS management Worker needs beyond the snapshot, barrier, revocation, eligibility and
 * API-key request commands of the identity lane. Each is one original authoritative operation:
 *
 * - `readSessionRevocation` answers the original's pre-provider lookup of a terminal session revocation
 *   (`SELECT workos_user_id FROM workos_terminal_revocations WHERE kind='session' AND resource_id=$1`), so a
 *   repeated logout is answered from the primary and a session of another user is refused. `recordTerminal
 *   Revocation` cannot answer it: it reports a different source event on the same session as `existing`.
 * - `recordUserApiKeyRevocationAudit` is the original `recordOrganizationAuditEvent` call of the key revoke, as a
 *   closed command: the event type is one of the two revocation stages, the actor is the user, and the payload
 *   is the key id. It never accepts an arbitrary event type, actor or payload.
 */

/** The store's `fenced` wrapper: bucket fence, one stale-route retry, then the command. */
export type BindIdentityCommand = <Result>(
  command: (context: CatalogContext, input: unknown) => Promise<Result>,
) => (input: unknown) => Promise<Result>;

const failure = (code: "invalid_request" | "resource_not_found" | "result_conflict") =>
  new CommandConflictError(code);

const sessionRevocationInput = z.strictObject({ sessionId });

export interface SessionRevocationRecord {
  readonly workosUserId: string | null;
}

/** `readSessionRevocation`: the user a terminally revoked session belongs to, or null when it was never revoked. */
export async function readSessionRevocation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<SessionRevocationRecord | null> {
  const parsed = sessionRevocationInput.safeParse(rawInput);
  if (!parsed.success) throw failure("invalid_request");
  const row = await context.directory
    .prepare("SELECT workos_user_id FROM revocations WHERE kind = 'session' AND resource_id = ?1")
    .bind(parsed.data.sessionId)
    .first<{ workos_user_id: string | null }>();
  return row === null ? null : { workosUserId: row.workos_user_id };
}

const EVENT_TYPES = {
  requested: "UserApiKeyRevocationRequested",
  revoked: "UserApiKeyRevoked",
} as const;

const revocationAuditInput = z.strictObject({
  organizationId: ulid,
  workosOrganizationId,
  userId: workosUserId,
  keyId: z.string().regex(/^api_key_[A-Za-z0-9_]{1,120}$/u),
  stage: z.enum(["requested", "revoked"]),
  auditEventId: ulid,
  now: instant,
});

interface AuditSnapshot {
  readonly workos_organization_id: string;
  readonly event_type: string | null;
  readonly actor_type: string | null;
  readonly actor_id: string | null;
  readonly payload: string | null;
  readonly occurred_at: string | null;
  /** 1 when the organization holds the requested event of this user's key, else 0. */
  readonly key_requested: number;
  /** 1 when the organization already holds the revoked event of this user's key, else 0. */
  readonly key_revoked: number;
}

const SNAPSHOT_SQL =
  "SELECT o.workos_organization_id, a.event_type, a.actor_type, a.actor_id, a.payload, a.occurred_at, EXISTS (SELECT 1 FROM organization_audit_events k WHERE k.organization_id = ?1 AND k.event_type = ?3 AND k.actor_id = ?5 AND k.payload = ?6) AS key_requested, EXISTS (SELECT 1 FROM organization_audit_events k WHERE k.organization_id = ?1 AND k.event_type = ?4 AND k.actor_id = ?5 AND k.payload = ?6) AS key_revoked FROM organizations o LEFT JOIN organization_audit_events a ON a.organization_id = o.organization_id AND a.audit_event_id = ?2 WHERE o.organization_id = ?1";

/**
 * `recordUserApiKeyRevocationAudit`: one audit event of the key revocation. Naming another organization's id,
 * another WorkOS organization or an unknown organization is `resource_not_found`; a repeat of the same event id
 * with the same content is a no-op (a lost response is retried safely) and with other content `result_conflict`.
 * The revoked stage is recorded once per user and key, and only for a key the user requested: a retry with a fresh
 * event id, or a key never requested, writes nothing and still answers `recorded`.
 * It does not re-authorize: the original recorded `UserApiKeyRevoked` after the provider effect whether or not
 * the membership still held, and refusing the record then would lose the evidence of an effect that happened.
 */
export async function recordUserApiKeyRevocationAudit(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly recorded: true }> {
  const parsed = revocationAuditInput.safeParse(rawInput);
  if (!parsed.success) throw failure("invalid_request");
  const input = parsed.data;
  const shard = await routeOrganization(context, input.organizationId);
  const db = shard.db;
  const eventType = EVENT_TYPES[input.stage];
  const payload = JSON.stringify({ key_id: input.keyId });
  const same = (row: AuditSnapshot) =>
    row.event_type === eventType &&
    row.actor_type === "principal" &&
    row.actor_id === `user:${input.userId}` &&
    row.payload === payload &&
    row.occurred_at === input.now;
  const recorded = { recorded: true } as const;
  const command: Command<AuditSnapshot | null, { readonly recorded: true }> = {
    name: "identity.recordUserApiKeyRevocationAudit",
    input,
    // A mapping that changed after the read makes the guard fire: the read is repeated and then names the truth.
    retryOn: ["scope_inactive", "precondition_changed"],
    naturalKeyTables: ["organization_audit_events"],
    read: (reader) =>
      reader
        .prepare(SNAPSHOT_SQL)
        .bind(
          input.organizationId,
          input.auditEventId,
          EVENT_TYPES.requested,
          EVENT_TYPES.revoked,
          `user:${input.userId}`,
          payload,
        )
        .first<AuditSnapshot>(),
    decide: (row): Plan<{ readonly recorded: true }> => {
      if (row === null || row.workos_organization_id !== input.workosOrganizationId) {
        return { reject: failure("resource_not_found") };
      }
      if (row.event_type !== null) {
        return same(row) ? { replay: recorded } : { reject: failure("result_conflict") };
      }
      if (input.stage === "revoked" && (row.key_revoked === 1 || row.key_requested === 0)) {
        return { replay: recorded };
      }
      // A revoked stage that lands after this read aborts the batch; the retry then finds it and writes nothing.
      const revokedGuards =
        input.stage === "revoked"
          ? [
              guard(
                db,
                "precondition_changed",
                "EXISTS (SELECT 1 FROM organization_audit_events WHERE organization_id = ?1 AND event_type = ?2 AND actor_id = ?3 AND payload = ?4)",
                [input.organizationId, EVENT_TYPES.revoked, `user:${input.userId}`, payload],
              ),
            ]
          : [];
      return {
        statements: [
          guard(
            db,
            "scope_inactive",
            "NOT EXISTS (SELECT 1 FROM organizations WHERE organization_id = ?1 AND workos_organization_id = ?2)",
            [input.organizationId, input.workosOrganizationId],
          ),
          ...revokedGuards,
          auditStatement(db, input.organizationId, {
            auditEventId: input.auditEventId,
            projectId: null,
            operationId: null,
            billingEpochId: null,
            eventType,
            actorType: "principal",
            actorId: `user:${input.userId}`,
            payload: { key_id: input.keyId },
            occurredAt: input.now,
          }),
        ],
        result: () => recorded,
      };
    },
  };
  return runCommand(db, command);
}

/**
 * The WorkOS caller commands bound with the store's bucket fence and route refresh. Merge the result into
 * `store.identity` (`...createWorkosCallerCommands(fenced)`), exactly as `createPlatformCommands` is merged.
 */
export function createWorkosCallerCommands(bind: BindIdentityCommand) {
  return Object.freeze({
    readSessionRevocation: bind(readSessionRevocation),
    recordUserApiKeyRevocationAudit: bind(recordUserApiKeyRevocationAudit),
  });
}
