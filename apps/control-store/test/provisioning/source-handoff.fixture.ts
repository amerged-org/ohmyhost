import { parseUlid } from "@ohmyhost/platform";
import { newUlid } from "../../src/catalog/common.js";
import { prepareSourceLinkQueueDeliveryRecovery } from "../../src/catalog/provisioning/queue-delivery-recovery.js";
import type { sourceLinkFixture } from "./source-link.fixture.js";
/** Fresh synthetic exact original five-attempt trace. The Prepared audit is written by the Core's own prepare. */
export async function prepareSourceHandoff(r: Awaited<ReturnType<typeof sourceLinkFixture>>) {
  const attempts = Array.from({ length: 5 }, () => parseUlid(newUlid())),
    stamp = (minute: number, second = 0) =>
      `2026-10-28T11:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000000Z`,
    failedAt = stamp(6, 30);
  const rows = attempts.map((attempt_id, index) => ({
      attempt_id,
      event_id: r.eventId,
      attempt_number: index + 1,
      claimed_at: stamp(index + 2),
      lease_expires_at: stamp(index + 2, 30),
      failed_at: index === 0 ? stamp(2, 10) : index === 4 ? failedAt : null,
      next_available_at: index === 0 ? stamp(2, 15) : null,
      error_code:
        index === 0
          ? "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN"
          : index === 4
            ? "FINAL_ATTEMPT_LEASE_EXPIRED"
            : null,
      acknowledged_at: null,
      status: index === 0 ? "retry_scheduled" : index === 4 ? "reconciliation_required" : "claimed",
    })),
    columns = Object.keys(rows[0] as Record<string, unknown>);
  await r.control.core.batch([
    r.control.core.prepare("PRAGMA defer_foreign_keys=ON"),
    r.control.core
      .prepare(
        "UPDATE outbox_events SET current_attempt_id=?2,attempt_count=5,last_error_code='FINAL_ATTEMPT_LEASE_EXPIRED',reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
      )
      .bind(r.eventId, attempts[4], failedAt),
    ...rows.map((row) =>
      r.control.core
        .prepare(`INSERT INTO delivery_attempts(${columns}) VALUES(${columns.map(() => "?")})`)
        .bind(...Object.values(row)),
    ),
  ]);
  const input = {
    organizationId: parseUlid(r.base.p.organizationId),
    operationId: r.operationId,
    reconciliationId: parseUlid(newUlid()),
    preparedAuditEventId: parseUlid(newUlid()),
    finalAuditEventId: parseUlid(newUlid()),
    actorId: "user:fixture",
    idempotencySha256: `sha256:${"a".repeat(64)}` as const,
    preparedAt: "2026-10-28T11:07:00.000Z",
  };
  const prepared = await prepareSourceLinkQueueDeliveryRecovery(r.ctx, input);
  if (prepared.outcome !== "prepared") throw new Error("Source handoff not prepared");
  return { input, prepared };
}
