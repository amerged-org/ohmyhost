import { z } from "zod";
import type { CatalogContext } from "../common.js";
import { publicTimestamp } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailHash, mailTime } from "./auth.js";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
const event = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  scope = z.strictObject({ eventId: event });
interface Receipt {
  event_id: string;
  request_sha256: string;
  first_attempt_at: string;
  lease_until: string;
  provider_message_id: string | null;
  accepted_at: string | null;
}
const receiptSql =
  "SELECT event_id,request_sha256,first_attempt_at,lease_until,provider_message_id,accepted_at FROM infrastructure_alert_receipts WHERE event_id=?";
/** Narrow original durable receipt observation; no readiness state or provider/configuration is written. */
export async function readInfrastructureAlertReceipt(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope, raw);
  await context.router.assertLayout();
  const row = await context.directory.prepare(receiptSql).bind(input.eventId).first<Receipt>();
  return row
    ? {
        eventId: row.event_id,
        requestSha256: row.request_sha256,
        firstAttemptAt: publicTimestamp(row.first_attempt_at),
        leaseUntil: publicTimestamp(row.lease_until),
        providerMessageId: row.provider_message_id,
        acceptedAt: row.accepted_at === null ? null : publicTimestamp(row.accepted_at),
      }
    : null;
}
/** Original30-second lease and conservative23-hour SAME provider identity replay window. */
export async function claimInfrastructureAlert(
  context: CatalogContext,
  raw: unknown,
): Promise<"send" | "wait" | "accepted" | "conflict"> {
  const input = mailInput(scope.extend({ requestSha256: mailHash, now: mailTime }), raw);
  await context.router.assertLayout();
  const db = context.directory;
  return runCommand<Receipt | null, "send" | "wait" | "accepted" | "conflict">(db, {
    name: "mail.claimInfrastructureAlert",
    input,
    naturalKeyTables: ["infrastructure_alert_receipts"],
    retryOn: ["row_version_conflict"],
    lookup: async () => {
      throw new StoreOutcomeUnknownError("mail.claimInfrastructureAlert: store_outcome_unknown");
    },
    read: (reader) => reader.prepare(receiptSql).bind(input.eventId).first<Receipt>(),
    decide: (row) => {
      if (row === null)
        return {
          statements: [
            db
              .prepare(
                "INSERT INTO infrastructure_alert_receipts(event_id,request_sha256,first_attempt_at,lease_until)VALUES(?,?,?,?)",
              )
              .bind(input.eventId, input.requestSha256, input.now, shiftStored(input.now, 30000)),
          ],
          result: () => "send",
        };
      if (row.request_sha256 !== input.requestSha256) return { replay: "conflict" };
      if (row.provider_message_id !== null) return { replay: "accepted" };
      // Original pg Date values have millisecond precision for both comparisons.
      if (
        Date.parse(input.now) - Date.parse(row.first_attempt_at) >= 23 * 3600000 ||
        Date.parse(row.lease_until) > Date.parse(input.now)
      )
        return { replay: "wait" };
      return {
        statements: [
          guard(
            db,
            "row_version_conflict",
            "NOT EXISTS(SELECT 1 FROM infrastructure_alert_receipts WHERE event_id=? AND request_sha256=? AND first_attempt_at=? AND lease_until=? AND provider_message_id IS NULL)",
            [input.eventId, input.requestSha256, row.first_attempt_at, row.lease_until],
          ),
          db
            .prepare("UPDATE infrastructure_alert_receipts SET lease_until=? WHERE event_id=?")
            .bind(shiftStored(input.now, 30000), input.eventId),
        ],
        result: () => "send",
      };
    },
  });
}
/** Original plain completion: one receipt, identical digest/message and first accepted_at retained. */
export async function completeInfrastructureAlert(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(
    scope.extend({
      requestSha256: mailHash,
      providerMessageId: z.string().min(1).max(256),
      acceptedAt: mailTime,
    }),
    raw,
  );
  await context.router.assertLayout();
  const db = context.directory;
  return runCommand<Receipt | null, boolean>(db, {
    name: "mail.completeInfrastructureAlert",
    input,
    retryOn: ["row_version_conflict"],
    lookup: async () => {
      throw new StoreOutcomeUnknownError("mail.completeInfrastructureAlert: store_outcome_unknown");
    },
    read: (reader) => reader.prepare(receiptSql).bind(input.eventId).first<Receipt>(),
    decide: (row) => {
      if (
        !row ||
        row.request_sha256 !== input.requestSha256 ||
        (row.provider_message_id !== null && row.provider_message_id !== input.providerMessageId)
      )
        return { replay: false };
      if (row.provider_message_id === input.providerMessageId) return { replay: true };
      return {
        statements: [
          guard(
            db,
            "row_version_conflict",
            "NOT EXISTS(SELECT 1 FROM infrastructure_alert_receipts WHERE event_id=? AND request_sha256=? AND provider_message_id IS NULL)",
            [input.eventId, input.requestSha256],
          ),
          db
            .prepare(
              "UPDATE infrastructure_alert_receipts SET provider_message_id=?,accepted_at=COALESCE(accepted_at,?) WHERE event_id=?",
            )
            .bind(input.providerMessageId, input.acceptedAt, input.eventId),
        ],
        result: () => true,
      };
    },
  });
}
