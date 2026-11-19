import { z } from "zod";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import { guard } from "../../guards.js";
import { routeOrganization, hexBytes, type CatalogContext } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailScope, mailTime, mailHash } from "./auth.js";
const scope = mailScope.extend({ key: z.string().min(1).max(128) }),
  clocked = scope.extend({ now: mailTime });
interface Row {
  hash: string;
  response: string | null;
  claimed_attempt: number | null;
  lease_until: string | null;
}
const read =
  "SELECT lower(hex(request_sha256)) hash,response,claimed_attempt,lease_until FROM resend_mail_commands WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4";
const values = (input: z.output<typeof scope>) => [
  input.organizationId,
  input.projectId,
  input.environmentId,
  input.key,
];
function unknown(name: string): never {
  throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
}
/** Original accepted manual-retry identity and lease; this stores only retry status, never message/signing material. */
export async function acceptMailDeliveryRetry(context: CatalogContext, raw: unknown) {
  const input = mailInput(clocked.extend({ digest: mailHash }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.acceptDeliveryRetry";
  return runCommand<
    Row | null,
    { created: boolean; response: unknown; claimedAttempt: number | null }
  >(db, {
    name,
    input,
    naturalKeyTables: ["resend_mail_commands"],
    lookup: async () => unknown(name),
    read: (reader) =>
      reader
        .prepare(read)
        .bind(...values(input))
        .first<Row>(),
    decide: (row) => {
      if (row) {
        if (row.hash !== input.digest) throw new Error("idempotency_key_reused");
        return {
          replay: {
            created: false,
            response: row.response === null ? null : JSON.parse(row.response),
            claimedAttempt: row.claimed_attempt,
          },
        };
      }
      return {
        statements: [
          db
            .prepare(
              "INSERT INTO resend_mail_commands(organization_id,project_id,environment_id,idempotency_key,request_sha256,created_at,lease_until)VALUES(?,?,?,?,?,?,?)",
            )
            .bind(
              ...values(input),
              hexBytes(input.digest),
              input.now,
              shiftStored(input.now, 120000),
            ),
        ],
        result: () => ({ created: true, response: null, claimedAttempt: null }),
      };
    },
  });
}
export async function resumeMailDeliveryRetry(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(clocked, raw),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.resumeDeliveryRetry",
    eligible = read + " AND claimed_attempt IS NULL AND response IS NULL AND lease_until<=?5";
  return runCommand<Row | null, boolean>(db, {
    name,
    input,
    lookup: async () => unknown(name),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(eligible)
        .bind(...values(input), input.now)
        .first<Row>(),
    decide: (row) =>
      row === null
        ? { replay: false }
        : {
            statements: [
              guard(db, "precondition_changed", `NOT EXISTS(${eligible})`, [
                ...values(input),
                input.now,
              ]),
              db
                .prepare(
                  "UPDATE resend_mail_commands SET lease_until=?5 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4",
                )
                .bind(...values(input), shiftStored(input.now, 120000)),
            ],
            result: () => true,
          },
  });
}
export async function completeMailDeliveryRetry(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(
      clocked.extend({
        response: z.strictObject({ attempted: z.boolean(), delivered: z.boolean().optional() }),
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.completeDeliveryRetry";
  await runCommand(db, {
    name,
    input,
    lookup: async () => unknown(name),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE resend_mail_commands SET response=?5,completed_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4 AND response IS NULL",
          )
          .bind(...values(input), JSON.stringify(input.response), input.now),
      ],
      result: () => undefined,
    }),
  });
}
