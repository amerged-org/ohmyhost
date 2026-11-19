import { z } from "zod";

import {
  conflict,
  publicTimestamp,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";

export const readAuditEventsInput = z.strictObject({
  organizationId: ulid,
  /** Limits the feed to one project's events. Without it the feed holds the project events of the organization. */
  projectId: ulid.optional(),
  /** The authenticated credential's resource ceiling, applied before cursor/limit. */
  projectIds: z.array(ulid).max(1000).optional(),
  operationId: ulid.optional(),
  /** `organization` reads the organization-level events (no project) instead of the project feed. */
  scope: z.enum(["project", "organization"]).default("project"),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100),
});

export interface AuditFeedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly operationId: string | null;
  readonly billingEpochId: string | null;
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly summary: string;
  readonly occurredAt: string;
}

interface AuditRow {
  readonly audit_event_id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly operation_id: string | null;
  readonly billing_epoch_id: string | null;
  readonly event_type: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly summary: string;
  readonly occurred_at: string;
}

function encodeCursor(occurredAt: string, eventId: string): string {
  return btoa(JSON.stringify({ occurredAt, eventId }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(cursor: string): { occurredAt: string; eventId: string } {
  try {
    const parsed = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as {
      occurredAt?: unknown;
      eventId?: unknown;
    };
    if (typeof parsed.occurredAt !== "string" || typeof parsed.eventId !== "string") {
      throw new Error("missing cursor fields");
    }
    const stamp = Date.parse(parsed.occurredAt);
    if (Number.isNaN(stamp) || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(parsed.eventId)) {
      throw new Error("invalid cursor fields");
    }
    // Older cursors carry millisecond precision; widen them to the stored form.
    const occurredAt = /\.\d{6}Z$/u.test(parsed.occurredAt)
      ? parsed.occurredAt
      : `${new Date(stamp).toISOString().slice(0, 23)}000Z`;
    return { occurredAt, eventId: parsed.eventId };
  } catch (cause) {
    throw conflict("invalid_audit_cursor", `Invalid audit cursor: ${String(cause)}`);
  }
}

/** `readAuditEventsAfterCursor`: the newest-first audit feed, paged by (occurred_at, event id). */
export async function readAuditEvents(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly events: readonly AuditFeedEvent[]; readonly nextCursor: string | null }> {
  const input = readAuditEventsInput.parse(rawInput);
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const shard = await routeOrganization(context, input.organizationId);
  if (
    input.scope === "organization" &&
    (input.projectId !== undefined ||
      input.projectIds !== undefined ||
      input.operationId !== undefined)
  )
    return { events: [], nextCursor: null };
  const table = input.scope === "organization" ? "organization_audit_events" : "audit_events";
  const scopeColumns =
    input.scope === "organization"
      ? "NULL AS project_id,NULL AS operation_id,NULL AS billing_epoch_id"
      : "project_id,operation_id,billing_epoch_id";
  const values: unknown[] = [input.organizationId, input.limit + 1];
  const filters: string[] = [];
  const add = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    values.push(value);
    filters.push(`${column} = ?${values.length}`);
  };
  add("project_id", input.projectId);
  add("operation_id", input.operationId);
  if (input.projectIds !== undefined) {
    values.push(JSON.stringify(input.projectIds));
    filters.push(`project_id IN (SELECT value FROM json_each(?${values.length}))`);
  }
  if (cursor !== undefined) {
    values.push(cursor.occurredAt, cursor.eventId);
    filters.push(`(occurred_at, audit_event_id) < (?${values.length - 1}, ?${values.length})`);
  }
  const result = await shard.db
    .prepare(
      `SELECT audit_event_id, organization_id, ${scopeColumns}, event_type, actor_type, actor_id,
              substr('Audit event: ' || event_type, 1, 512) AS summary, occurred_at
       FROM ${table} WHERE organization_id = ?1 ${filters.length === 0 ? "" : `AND ${filters.join(" AND ")}`}
       ORDER BY occurred_at DESC, audit_event_id DESC LIMIT ?2`,
    )
    .bind(...values)
    .all<AuditRow>();
  const page = result.results.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      eventId: row.audit_event_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      operationId: row.operation_id,
      billingEpochId: row.billing_epoch_id,
      eventType: row.event_type,
      actorType: row.actor_type,
      actorId: row.actor_id,
      summary: row.summary,
      occurredAt: publicTimestamp(row.occurred_at),
    })),
    nextCursor:
      result.results.length > input.limit && last !== undefined
        ? encodeCursor(last.occurred_at, last.audit_event_id)
        : null,
  };
}
