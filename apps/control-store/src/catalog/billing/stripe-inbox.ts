import { z } from "zod";
import { storedTimestamp } from "../../timestamps.js";
import { type CatalogContext, ulid } from "../common.js";

const now = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);
const scope = z.strictObject({
  accountId: z.string().regex(/^acct_[A-Za-z0-9_]{1,128}$/u),
  mode: z.enum(["test", "live"]),
  now,
});
const claim = scope.extend({ claimId: ulid });
const finish = z.strictObject({
  inboxEventId: ulid,
  claimId: ulid,
  now,
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/u)
    .nullable(),
});

/** Original GLOBAL Stripe claim. A routing organization is neither required nor payer authorization. */
export async function claimStripeInboxEvent(
  context: CatalogContext,
  raw: unknown,
): Promise<{ inbox_event_id: string; payload: unknown } | null> {
  const input = claim.parse(raw);
  await context.router.assertLayout();
  // One delivery only: an ambiguous result is NOT turned into a cached claim success or blindly retried.
  const row = await context.directory
    .prepare(
      `WITH candidate AS (
    SELECT inbox_event_id FROM webhook_inbox WHERE provider='stripe' AND json_extract(payload,'$.accountId')=?1 AND json_extract(payload,'$.mode')=?2
    AND acknowledged_at IS NULL AND (attempt_count<max_attempts OR state='reconciliation_required') AND available_at<=?4
    AND julianday(?4)-julianday(received_at)<30
    AND(state IN('pending','retry_wait','reconciliation_required') OR(state='processing' AND lease_expires_at<=?4))
    ORDER BY available_at,received_at,inbox_event_id LIMIT 1)
    UPDATE webhook_inbox SET state='processing',claim_id=?3,claimed_at=?4,
      lease_expires_at=strftime('%Y-%m-%dT%H:%M:%S',substr(?4,1,19),'+2 minutes')||substr(?4,20),
      attempt_count=attempt_count+1,
      max_attempts=CASE WHEN state='reconciliation_required' THEN attempt_count+1 ELSE max_attempts END,
      last_error_code=NULL
    WHERE inbox_event_id=(SELECT inbox_event_id FROM candidate)
    RETURNING inbox_event_id,payload`,
    )
    .bind(input.accountId, input.mode, input.claimId, input.now)
    .first<{ inbox_event_id: string; payload: string }>();
  return row
    ? { inbox_event_id: row.inbox_event_id, payload: JSON.parse(row.payload) as unknown }
    : null;
}

/**
 * A provider outage within three days of the event's receipt. A failure that never was an outage (the provider
 * adapter calls every error without a status one) therefore parks the row after three days like any other.
 */
const OUTAGE = `(?4='STRIPE_UNAVAILABLE' AND julianday(?3)-julianday(received_at)<3)`;

/**
 * Original separate final ACK/retry CAS; deliberately not a financial-admission or inbox/money transaction.
 * A provider outage (STRIPE_UNAVAILABLE) gives its claim back and does not park the row for three days: the wait
 * doubles every ten minutes the row has been waiting (1, 2, 4 ... 32 minutes, then one hour). Any other failure
 * waits 1, 2, 4 ... 60 minutes, and a parked row (reconciliation_required) is re-driven by claimStripeInboxEvent
 * with a fresh attempt, so an event parked by a rejection or an outage is not dropped. Stripe keeps an event about
 * thirty days, so a row received longer ago is never claimed again and stays reconciliation_required for an operator.
 */
export async function finishStripeInboxEvent(
  context: CatalogContext,
  raw: unknown,
): Promise<{ finished: boolean; parked: boolean }> {
  const input = finish.parse(raw);
  await context.router.assertLayout();
  const rows = await context.directory
    .prepare(
      `UPDATE webhook_inbox SET
    state=CASE WHEN ?4 IS NULL THEN 'acknowledged'
      WHEN ${OUTAGE} THEN CASE WHEN attempt_count=1 THEN 'pending' ELSE 'retry_wait' END
      WHEN attempt_count=max_attempts THEN 'reconciliation_required' ELSE 'retry_wait' END,
    attempt_count=CASE WHEN ${OUTAGE} THEN attempt_count-1 ELSE attempt_count END,
    park_count=park_count+CASE WHEN ?4 IS NOT NULL AND NOT ${OUTAGE} AND attempt_count=max_attempts THEN 1 ELSE 0 END,
    acknowledged_at=CASE WHEN ?4 IS NULL THEN ?3 ELSE NULL END,
    available_at=CASE WHEN ${OUTAGE}
      THEN strftime('%Y-%m-%dT%H:%M:%S',substr(?3,1,19),'+'||MIN(60,1<<MIN(6,MAX(0,CAST((julianday(?3)-julianday(received_at))*1440 AS INTEGER))/10))||' minutes')||substr(?3,20)
      ELSE strftime('%Y-%m-%dT%H:%M:%S',substr(?3,1,19),'+'||MIN(60,1<<MIN(6,attempt_count-1))||' minutes')||substr(?3,20) END,
    last_error_code=?4,claim_id=NULL,claimed_at=NULL,lease_expires_at=NULL
    WHERE provider='stripe' AND inbox_event_id=?1 AND claim_id=?2 AND state='processing' AND lease_expires_at>?3
    RETURNING state,park_count`,
    )
    .bind(input.inboxEventId, input.claimId, input.now, input.errorCode)
    .all<{ state: string; park_count: number }>();
  const [row] = rows.results;
  return {
    finished: rows.results.length === 1,
    parked: row?.state === "reconciliation_required" && row.park_count === 1,
  };
}

export async function recoverExpiredStripeInboxClaims(
  context: CatalogContext,
  raw: unknown,
): Promise<{ count: number; parkedIds: string[] }> {
  const input = scope.parse(raw);
  await context.router.assertLayout();
  const rows = await context.directory
    .prepare(
      `UPDATE webhook_inbox SET state='reconciliation_required',last_error_code='STRIPE_PROCESSING_INTERRUPTED',claim_id=NULL,claimed_at=NULL,lease_expires_at=NULL,park_count=park_count+1
    WHERE provider='stripe' AND json_extract(payload,'$.accountId')=?1 AND json_extract(payload,'$.mode')=?2
    AND state='processing' AND attempt_count=max_attempts AND lease_expires_at<=?3
    RETURNING inbox_event_id,park_count`,
    )
    .bind(input.accountId, input.mode, input.now)
    .all<{ inbox_event_id: string; park_count: number }>();
  return {
    count: rows.results.length,
    parkedIds: rows.results.filter((row) => row.park_count === 1).map((row) => row.inbox_event_id),
  };
}
