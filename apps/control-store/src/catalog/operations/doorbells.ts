import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import { instant, ringDoorbell, ulid, type CatalogContext, type DoorbellKind } from "../common.js";

const kind = z.enum([
  "outbox",
  "op_lease",
  "inbox",
  "secret_delivery",
  "schedule",
  "database",
  "mail",
  "recovery",
  "retention",
]);

export const ringDoorbellInput = z.strictObject({
  kind,
  shardId: z.number().int().min(0).max(1023),
  dueAt: instant,
});

/** Writers ring after their shard batch commits; the earliest due time wins and a later one writes nothing. */
export async function ring(context: CatalogContext, rawInput: unknown): Promise<void> {
  const input = ringDoorbellInput.parse(rawInput);
  await ringDoorbell(context.directory, input.kind, input.shardId, input.dueAt);
}

export const claimDoorbellsInput = z.strictObject({
  now: instant,
  limit: z.number().int().min(1).max(64),
  claimToken: ulid,
  claimMilliseconds: z.number().int().min(1_000).max(600_000).default(90_000),
});

export interface ClaimedDoorbell {
  readonly kind: DoorbellKind;
  readonly shardId: number;
  readonly dueAt: string;
}

/**
 * The sweeper's drain step: one statement claims the most overdue doorbells that nobody holds, so two
 * sweepers never drain the same shard for the same kind at once. A claim that is never settled lapses.
 */
export async function claimDoorbells(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ClaimedDoorbell[]> {
  const input = claimDoorbellsInput.parse(rawInput);
  const until = new Date(Date.parse(input.now) + input.claimMilliseconds);
  const result = await context.directory
    .prepare(
      `UPDATE work_due SET claim_token = ?1, claim_until = ?2
       WHERE (kind, shard_id) IN (
         SELECT kind, shard_id FROM work_due
         WHERE due_at <= ?3 AND (claim_until IS NULL OR claim_until <= ?3)
         ORDER BY due_at LIMIT ?4)
       RETURNING kind, shard_id, due_at`,
    )
    .bind(input.claimToken, `${until.toISOString().slice(0, 23)}000Z`, input.now, input.limit)
    .all<{ kind: DoorbellKind; shard_id: number; due_at: string }>();
  return result.results.map((row) => ({
    kind: row.kind,
    shardId: row.shard_id,
    dueAt: row.due_at,
  }));
}

/** The earliest moment each kind of work of this shard is due, from the partial indexes; null when none is. */
const DUE_SQL: Partial<Record<DoorbellKind, string>> = {
  outbox: `SELECT min(due) AS due FROM (
      SELECT min(available_at) AS due FROM outbox_events
        WHERE acknowledged_at IS NULL AND reconciliation_required_at IS NULL AND attempt_count < max_attempts
      UNION ALL
      SELECT min(lease_expires_at) FROM outbox_events
        WHERE acknowledged_at IS NULL AND reconciliation_required_at IS NULL AND current_attempt_id IS NOT NULL
          AND lease_expires_at IS NOT NULL AND attempt_count = max_attempts)`,
  op_lease:
    "SELECT min(lease_expires_at) AS due FROM operations WHERE lease_expires_at IS NOT NULL",
  inbox: `SELECT min(due) AS due FROM (
      SELECT min(available_at) AS due FROM webhook_inbox
        WHERE state IN ('pending','retry_wait') AND acknowledged_at IS NULL
      UNION ALL
      SELECT min(lease_expires_at) FROM webhook_inbox WHERE state = 'processing' AND acknowledged_at IS NULL)`,
  retention: `SELECT min(due) AS due FROM (
      SELECT min(expires_at) AS due FROM api_idempotency_records
      UNION ALL SELECT strftime('%Y-%m-%dT%H:%M:%f000Z', julianday(min(acknowledged_at)) + 7.0) FROM outbox_events WHERE acknowledged_at IS NOT NULL
      UNION ALL SELECT strftime('%Y-%m-%dT%H:%M:%f000Z', julianday(min(acknowledged_at)) + 7.0) FROM webhook_inbox WHERE acknowledged_at IS NOT NULL)`,
};

export const OWNED_DOORBELL_KINDS = Object.keys(DUE_SQL) as DoorbellKind[];

async function shardDue(db: D1Database, doorbell: DoorbellKind): Promise<string | null> {
  const sql = DUE_SQL[doorbell];
  if (sql === undefined) {
    throw new RangeError(`the ${doorbell} doorbell is re-armed by the command family that owns it`);
  }
  return (await db.prepare(sql).first<{ due: string | null }>())?.due ?? null;
}

export const settleDoorbellInput = z.strictObject({
  kind: z.enum(["outbox", "op_lease", "inbox", "retention"]),
  shardId: z.number().int().min(0).max(1023),
  claimToken: ulid,
});

/**
 * The sweeper's re-arm step: recomputes the next due time of the kind from the shard's own index and writes
 * it with the claim token (or removes the doorbell when nothing is pending). False when the claim lapsed and
 * someone else owns the doorbell now.
 */
export async function settleDoorbell(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly settled: boolean; readonly nextDueAt: string | null }> {
  const input = settleDoorbellInput.parse(rawInput);
  const shard = await context.router.routeShard(input.shardId);
  const due = await shardDue(shard.db, input.kind);
  const statement =
    due === null
      ? context.directory
          .prepare("DELETE FROM work_due WHERE kind = ?1 AND shard_id = ?2 AND claim_token = ?3")
          .bind(input.kind, input.shardId, input.claimToken)
      : context.directory
          .prepare(
            "UPDATE work_due SET due_at = ?4, claim_token = NULL, claim_until = NULL WHERE kind = ?1 AND shard_id = ?2 AND claim_token = ?3",
          )
          .bind(input.kind, input.shardId, input.claimToken, due);
  const result = await statement.run();
  return { settled: result.meta.changes === 1, nextDueAt: due };
}

export const healDoorbellsInput = z.strictObject({ shardId: z.number().int().min(0).max(1023) });

/**
 * The heal step: one shard is reconciled against its own rows. A kind with pending work and no doorbell
 * gets one, a doorbell with nothing behind it is removed (unless a sweeper holds it), so a lost ring delays
 * work by one reconciliation round and never loses it.
 */
export async function healDoorbells(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly rung: DoorbellKind[]; readonly removed: DoorbellKind[] }> {
  const input = healDoorbellsInput.parse(rawInput);
  const shard = await context.router.routeShard(input.shardId);
  const rung: DoorbellKind[] = [];
  const removed: DoorbellKind[] = [];
  for (const doorbell of OWNED_DOORBELL_KINDS) {
    const due = await shardDue(shard.db, doorbell);
    if (due !== null) {
      await ringDoorbell(context.directory, doorbell, input.shardId, due);
      rung.push(doorbell);
      continue;
    }
    const result = await context.directory
      .prepare("DELETE FROM work_due WHERE kind = ?1 AND shard_id = ?2 AND claim_token IS NULL")
      .bind(doorbell, input.shardId)
      .run();
    if (result.meta.changes === 1) removed.push(doorbell);
  }
  return { rung, removed };
}
