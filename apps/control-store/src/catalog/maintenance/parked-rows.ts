import { z } from "zod";
import { routeOrganization, ulid, rowsOf, type CatalogContext } from "../common.js";

const request = z.strictObject({
  organizationId: ulid,
  limit: z.number().int().min(1).max(200),
});

export interface ParkedRow {
  readonly kind: "stripe_inbox" | "outbox_event" | "r2_bucket_reservation" | "operation";
  readonly id: string;
  readonly organizationId: string | null;
  readonly state: string;
  readonly errorCode: string | null;
  readonly since: string | null;
}

/**
 * The operator's one read of rows that need a person: parked Stripe inbox events (global), unacknowledged outbox
 * events that exhausted their attempts, live operations waiting on such an event, and R2 bucket reservations whose
 * operation ended without a receipt. Each row is already a terminal-but-reconcilable state; nothing here changes them.
 */
export async function listParkedRows(context: CatalogContext, raw: unknown): Promise<ParkedRow[]> {
  const i = request.parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const stripe = rowsOf<{
    inbox_event_id: string;
    last_error_code: string | null;
    received_at: string;
  }>(
    await context.directory
      .prepare(
        "SELECT inbox_event_id,last_error_code,received_at FROM webhook_inbox WHERE provider='stripe' AND state='reconciliation_required' ORDER BY received_at,inbox_event_id LIMIT ?1",
      )
      .bind(i.limit)
      .all(),
  );
  const outbox = rowsOf<{
    event_id: string;
    last_error_code: string | null;
    reconciliation_required_at: string;
  }>(
    await db
      .prepare(
        "SELECT event_id,last_error_code,reconciliation_required_at FROM outbox_events WHERE organization_id=?1 AND acknowledged_at IS NULL AND reconciliation_required_at IS NOT NULL ORDER BY reconciliation_required_at,event_id LIMIT ?2",
      )
      .bind(i.organizationId, i.limit)
      .all(),
  );
  const operations = rowsOf<{ operation_id: string; state: string; created_at: string }>(
    await db
      .prepare(
        "SELECT o.operation_id,o.state,o.created_at FROM operations o WHERE o.organization_id=?1 AND o.state IN ('queued','running') AND EXISTS(SELECT 1 FROM outbox_events e WHERE e.organization_id=o.organization_id AND e.operation_id=o.operation_id AND e.acknowledged_at IS NULL AND e.reconciliation_required_at IS NOT NULL) ORDER BY o.created_at,o.operation_id LIMIT ?2",
      )
      .bind(i.organizationId, i.limit)
      .all(),
  );
  const reservations = rowsOf<{
    claim_id: string;
    bucket_name: string;
    reserved_at: string;
    state: string;
  }>(
    await db
      .prepare(
        "SELECT r.claim_id,r.bucket_name,r.reserved_at,o.state FROM project_r2_bucket_reservations r JOIN operations o ON o.organization_id=r.organization_id AND o.project_id=r.project_id AND o.operation_id=r.operation_id WHERE r.organization_id=?1 AND o.state IN ('succeeded','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM project_r2_bucket_receipts p WHERE p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.environment_id=r.environment_id AND p.claim_id=r.claim_id) ORDER BY r.reserved_at,r.claim_id LIMIT ?2",
      )
      .bind(i.organizationId, i.limit)
      .all(),
  );
  return [
    ...stripe.map((row) => ({
      kind: "stripe_inbox" as const,
      id: row.inbox_event_id,
      organizationId: null,
      state: "reconciliation_required",
      errorCode: row.last_error_code,
      since: row.received_at,
    })),
    ...outbox.map((row) => ({
      kind: "outbox_event" as const,
      id: row.event_id,
      organizationId: i.organizationId,
      state: "reconciliation_required",
      errorCode: row.last_error_code,
      since: row.reconciliation_required_at,
    })),
    ...operations.map((row) => ({
      kind: "operation" as const,
      id: row.operation_id,
      organizationId: i.organizationId,
      state: row.state,
      errorCode: null,
      since: row.created_at,
    })),
    ...reservations.map((row) => ({
      kind: "r2_bucket_reservation" as const,
      id: row.claim_id,
      organizationId: i.organizationId,
      state: row.state,
      errorCode: null,
      since: row.reserved_at,
    })),
  ];
}
