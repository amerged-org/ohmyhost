import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../d1-types.js";
import { classifyFailure, guard } from "../guards.js";
import type { SharedCoreRoute, AuthorityRouter } from "../router.js";
import { CommandConflictError, runCommand, type Command } from "../run-command.js";
import { storedTimestamp } from "../timestamps.js";

/** What every catalog command needs: the Directory tables and the router; both are the one shared core database. */
export interface CatalogContext {
  readonly nativeAuthLaunchPolicy?: import("./identity/native-auth-launch-policy.js").NativeAuthLaunchPolicy;
  readonly directory: D1Database;
  readonly router: AuthorityRouter;
}

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
export const ulid = z.string().regex(ULID_PATTERN);
/** An ISO-8601 UTC instant of any precision, normalised to the stored microsecond form. */
export const instant = z.string().transform(storedTimestamp);
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const jsonRecord = z.record(z.string(), z.unknown());

export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** The stored microsecond form as a JavaScript ISO string (milliseconds), the form callers compare. */
export function publicTimestamp(stored: string): string {
  return `${stored.slice(0, 23)}Z`;
}

export function addMilliseconds(stored: string, milliseconds: number): string {
  return storedTimestamp(new Date(Date.parse(stored) + milliseconds).toISOString());
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fresh ULID: 48 bits of time, 80 random bits. Used for ids the store itself mints (never inside `decide`). */
export function newUlid(nowMilliseconds: number = Date.now()): string {
  let time = nowMilliseconds;
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = (CROCKFORD[time % 32] as string) + head;
    time = Math.floor(time / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let tail = "";
  let buffer = 0n;
  for (const byte of bytes) buffer = (buffer << 8n) | BigInt(byte);
  for (let index = 0; index < 16; index += 1) {
    tail = (CROCKFORD[Number(buffer & 31n)] as string) + tail;
    buffer >>= 5n;
  }
  return head + tail;
}

export async function routeOrganization(
  context: CatalogContext,
  organizationId: string,
): Promise<SharedCoreRoute> {
  return context.router.routeOrganization(organizationId);
}

/** Runs a command and turns the named guard codes into typed domain conflicts. */
export async function runMapped<Snapshot, Result>(
  db: D1Database,
  command: Command<Snapshot, Result>,
  conflicts: Readonly<Record<string, () => Error>>,
): Promise<Result> {
  try {
    return await runCommand(db, command);
  } catch (error) {
    const failure = classifyFailure(error);
    const mapped = failure.kind === "guard" ? conflicts[failure.code] : undefined;
    if (mapped !== undefined) throw mapped();
    throw error;
  }
}

export function conflict(code: string, message: string = code): CommandConflictError {
  return new CommandConflictError(code, message);
}

export type DoorbellKind =
  | "outbox"
  | "op_lease"
  | "inbox"
  | "secret_delivery"
  | "schedule"
  | "database"
  | "mail"
  | "recovery"
  | "retention";

/**
 * Rings the doorbell of a shard: the earliest due time wins and a later one performs no write. The ring
 * follows the shard batch and is repeated by every replay of the command, so a lost ring is re-sent by the
 * caller's retry and healed by the reconciliation pass otherwise.
 */
export async function ringDoorbell(
  directory: D1Database,
  kind: DoorbellKind,
  shardId: number,
  dueAt: string,
): Promise<void> {
  await directory
    .prepare(
      "INSERT INTO work_due(kind, shard_id, due_at) VALUES (?1, ?2, ?3) ON CONFLICT (kind, shard_id) DO UPDATE SET due_at = excluded.due_at WHERE excluded.due_at < work_due.due_at",
    )
    .bind(kind, shardId, dueAt)
    .run();
}

export interface AuditRecord {
  readonly auditEventId: string;
  readonly projectId: string | null;
  readonly operationId: string | null;
  readonly billingEpochId: string | null;
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export const auditRecordInput = z.strictObject({
  auditEventId: ulid,
  projectId: ulid.nullable().default(null),
  operationId: ulid.nullable().default(null),
  billingEpochId: ulid.nullable().default(null),
  eventType: z.string().trim().min(1),
  actorType: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  payload: jsonRecord.default({}),
  occurredAt: instant,
});

export function auditStatement(
  db: D1Database,
  organizationId: string,
  audit: AuditRecord,
): D1PreparedStatement {
  if (audit.projectId === null) {
    if (audit.operationId !== null || audit.billingEpochId !== null)
      throw new TypeError("Organization audit cannot discard operation or epoch scope");
    return db
      .prepare(
        "INSERT INTO organization_audit_events(organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
      )
      .bind(
        organizationId,
        audit.auditEventId,
        audit.eventType,
        audit.actorType,
        audit.actorId,
        JSON.stringify(audit.payload),
        audit.occurredAt,
      );
  }
  return db
    .prepare(
      "INSERT INTO audit_events(organization_id, audit_event_id, project_id, operation_id, billing_epoch_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      organizationId,
      audit.auditEventId,
      audit.projectId,
      audit.operationId,
      audit.billingEpochId,
      audit.eventType,
      audit.actorType,
      audit.actorId,
      JSON.stringify(audit.payload),
      audit.occurredAt,
    );
}

export const outboxRecordInput = z.strictObject({
  eventId: ulid,
  eventType: z.string().min(1).max(128),
  payload: jsonRecord.default({}),
  createdAt: instant,
  availableAt: instant.optional(),
  maxAttempts: z.number().int().min(1).max(2_147_483_647),
});

export interface OutboxRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly availableAt?: string | undefined;
  readonly maxAttempts: number;
}

export function outboxStatement(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly billingEpochId: string;
  },
  outbox: OutboxRecord,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO outbox_events(organization_id, event_id, project_id, operation_id, billing_epoch_id, event_type, payload, created_at, initial_available_at, available_at, max_attempts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
    )
    .bind(
      scope.organizationId,
      outbox.eventId,
      scope.projectId,
      scope.operationId,
      scope.billingEpochId,
      outbox.eventType,
      JSON.stringify(outbox.payload),
      outbox.createdAt,
      outbox.availableAt ?? outbox.createdAt,
      outbox.maxAttempts,
    );
}

/** The operation row and its revision-0 `OperationQueued` event: the start of every operation's history. The lease starts at the first transition, as before. */
export function queuedOperationStatements(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly billingEpochId: string;
  },
  queued: { readonly eventId: string; readonly occurredAt: string },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        "INSERT INTO operations(organization_id, operation_id, project_id, state, billing_epoch_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?5)",
      )
      .bind(
        scope.organizationId,
        scope.operationId,
        scope.projectId,
        scope.billingEpochId,
        queued.occurredAt,
      ),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id, operation_id, revision, event_id, project_id, event_type, payload, occurred_at) VALUES (?1, ?2, 0, ?3, ?4, 'OperationQueued', '{}', ?5)",
      )
      .bind(
        scope.organizationId,
        scope.operationId,
        queued.eventId,
        scope.projectId,
        queued.occurredAt,
      ),
  ];
}

/** A queued or running operation holds a lease it must keep renewing (15 minutes from every transition). */
export const OPERATION_LEASE_MILLISECONDS = 15 * 60 * 1000;
/** A handle a rename gives up stays held against other organizations for this long. */
export const HANDLE_QUARANTINE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/** Aborts the batch unless the organization exists and is not deleted. */
export function organizationLiveGuard(db: D1Database, organizationId: string): D1PreparedStatement {
  return guard(
    db,
    "organization_inactive",
    "NOT EXISTS (SELECT 1 FROM organizations WHERE organization_id = ? AND state <> 'deleted')",
    [organizationId],
  );
}

/** Aborts the batch unless the organization actively owns the project at the given ownership. */
export function ownershipGuard(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly billingEpochId?: string;
  },
): D1PreparedStatement {
  return guard(
    db,
    "scope_inactive",
    `NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND owner_state = 'active'${
      scope.billingEpochId === undefined ? "" : " AND active_billing_epoch_id = ?3"
    })`,
    scope.billingEpochId === undefined
      ? [scope.organizationId, scope.projectId]
      : [scope.organizationId, scope.projectId, scope.billingEpochId],
  );
}

/**
 * The ownership invariant of ONE project, checked in the batch that creates or moves it: exactly one scope row of the project
 * is current (not `transferred`), exactly one billing epoch of the project is open GLOBALLY, and the current scope points at
 * that very epoch. The creation batch and an ownership-history import (transfer or return) end with this same guard, so a
 * second current owner or a second open epoch can never commit, whichever organization wrote it.
 */
export function ownershipInvariantGuard(db: D1Database, projectId: string): D1PreparedStatement {
  return guard(
    db,
    "owner_changed",
    `(SELECT count(*) FROM projects WHERE project_id = ?1 AND owner_state <> 'transferred') <> 1
     OR (SELECT count(*) FROM billing_epochs WHERE project_id = ?1 AND ended_at IS NULL) <> 1
     OR NOT EXISTS (SELECT 1 FROM projects p JOIN billing_epochs e ON e.organization_id = p.organization_id
          AND e.billing_epoch_id = p.active_billing_epoch_id AND e.project_id = p.project_id AND e.ended_at IS NULL
        WHERE p.project_id = ?1 AND p.owner_state <> 'transferred')`,
    [projectId],
  );
}

/**
 * Sweepers drain a shard, not an organization, so the organization's fenced database does not protect them.
 * This predicate (over the row's `organization_id` column) skips every organization whose bucket is being
 * moved or has moved: its rows are being copied and must not change under the copy.
 */
export function notFencedOrganization(organizationColumn: string): string {
  return `NOT EXISTS (SELECT 1 FROM organizations fenced_org JOIN bucket_fences fence ON fence.bucket = fenced_org.bucket WHERE fenced_org.organization_id = ${organizationColumn})`;
}

/**
 * The in-batch twin of `notFencedOrganization` for shard-wide commands that read a candidate and then write it:
 * a fence set between that read and the write aborts the batch with `code`, and the command's retry reads the
 * candidates again (now without the fenced organization).
 */
export function fenceRaceGuard(
  db: D1Database,
  code: "claim_lost" | "operation_conflict",
  organizationId: string,
): D1PreparedStatement {
  return guard(
    db,
    code,
    "EXISTS (SELECT 1 FROM organizations fenced_org JOIN bucket_fences fence ON fence.bucket = fenced_org.bucket WHERE fenced_org.organization_id = ?1)",
    [organizationId],
  );
}

/** The rows of one result of a read batch, typed by the caller's SELECT; a missing result yields no rows. */
export function rowsOf<Row>(result: { readonly results: unknown[] } | undefined): Row[] {
  return (result?.results ?? []) as Row[];
}

export function parseJson<Value = unknown>(text: string | null): Value | null {
  return text === null ? null : (JSON.parse(text) as Value);
}
