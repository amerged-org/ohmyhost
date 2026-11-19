import { z } from "zod";
import type { D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { type CatalogContext, routeOrganization, ulid, publicTimestamp } from "../common.js";
import { chargeOrg } from "../credit/index.js";
import { mailInput, mailTime } from "./auth.js";
import { mailChargeMicros, mailPriceSql, type MailPrice } from "./credit.js";
import { unknownOutcome } from "../unknown-outcome.js";

const messageSql = `SELECT m.organization_id,m.project_id,m.environment_id,m.received_at
 FROM mail_received_messages m WHERE m.message_id=?1 AND m.billed_at IS NULL`;
interface Message {
  organization_id: string;
  project_id: string;
  environment_id: string;
  received_at: string;
}

/** The receipt-time billing queue: the oldest messages that no charge was booked for. */
export async function listUnbilledReceivedMail(context: CatalogContext, raw: unknown) {
  mailInput(z.strictObject({}), raw);
  await context.router.assertLayout();
  return (
    await context.directory
      .prepare(
        "SELECT message_id FROM mail_received_messages WHERE billed_at IS NULL ORDER BY received_at LIMIT 20",
      )
      .all<{ message_id: string }>()
  ).results.map((row) => row.message_id);
}

/**
 * Charges one received message once (`mailrecv:<messageId>`) at the price in force when it arrived and marks it billed
 * in the SAME batch. A message that arrived before the meter was activated is marked billed without a charge, so it
 * cannot hold the head of the queue.
 */
export async function billReceivedMail(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(z.strictObject({ messageId: ulid, now: mailTime }), raw);
  const deadline = Date.now() + 15000;
  await context.router.assertLayout();
  const message = await context.directory
    .prepare(messageSql)
    .bind(input.messageId)
    .first<Message>();
  if (message === null) return;
  const { db } = await routeOrganization(context, message.organization_id),
    name = "mail.billReceived";
  await runCommand<{ message: Message | undefined; price: MailPrice | null }, undefined>(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["credit_log"],
    read: async (reader) => {
      const [current, price] = await reader.batch([
        reader.prepare(messageSql).bind(input.messageId),
        reader
          .prepare(
            `SELECT ${mailPriceSql("mail.received", "(SELECT received_at FROM mail_received_messages WHERE message_id=?1)")} price`,
          )
          .bind(input.messageId),
      ]);
      const quote = (price?.results[0] as { price: string | null } | undefined)?.price ?? null;
      return {
        message: current?.results[0] as Message | undefined,
        price: quote === null ? null : (JSON.parse(quote) as MailPrice),
      };
    },
    decide: (snapshot) => {
      const row = snapshot.message;
      if (!row) return { replay: undefined };
      if (
        Object.keys(message).some(
          (key) => row[key as keyof Message] !== message[key as keyof Message],
        )
      )
        throw new Error("mail_received_source_changed");
      const charge = snapshot.price === null ? 0 : mailChargeMicros(snapshot.price.rate);
      if (charge === null) throw new Error("mail_pricing_unavailable");
      const statements: D1PreparedStatement[] = [
        guard(
          db,
          "precondition_changed",
          `NOT EXISTS(${messageSql} AND m.organization_id=?2 AND m.project_id=?3 AND m.environment_id=?4 AND m.received_at=?5)`,
          [
            input.messageId,
            message.organization_id,
            message.project_id,
            message.environment_id,
            message.received_at,
          ],
        ),
      ];
      if (charge > 0 && snapshot.price !== null)
        statements.push(
          ...chargeOrg(db, {
            organizationId: message.organization_id,
            key: `mailrecv:${input.messageId}`,
            amountMicros: charge,
            now: input.now,
            detail: {
              source: "mail",
              messageId: input.messageId,
              projectId: message.project_id,
              environmentId: message.environment_id,
              meter: "mail.received",
              quantity: "1",
              unit: "message",
              receivedAt: publicTimestamp(message.received_at),
              rateCardId: snapshot.price.card,
              chargeMicros: charge,
              lines: [
                {
                  projectId: message.project_id,
                  environmentId: message.environment_id,
                  meter: "mail.received",
                  unit: "message",
                  rateCardId: snapshot.price.card,
                  quantity: "1",
                  chargeMicros: charge,
                },
              ],
            },
            projects: [{ projectId: message.project_id, amountMicros: charge }],
          }).statements,
        );
      statements.push(
        db
          .prepare(
            "UPDATE mail_received_messages SET billed_at=?2 WHERE message_id=?1 AND billed_at IS NULL",
          )
          .bind(input.messageId, input.now),
        guard(
          db,
          "precondition_changed",
          "CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)>?",
          [deadline],
        ),
      );
      return { statements, result: () => undefined };
    },
  });
}
