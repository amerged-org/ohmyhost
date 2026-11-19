import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailScope, mailTime, mailHash } from "./auth.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";
import { unknownOutcome } from "../unknown-outcome.js";

const commandScope = mailScope.extend({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  }),
  params = (input: z.output<typeof commandScope>) => [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.idempotencyKey,
  ],
  ROW =
    "SELECT lower(hex(request_sha256)) request_sha256,response,lease_until FROM resend_mail_commands WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4";
interface Row {
  request_sha256: string;
  response: string | null;
  lease_until: string | null;
}
const response = (value: string | null): unknown => (value === null ? null : JSON.parse(value));
/** Existing narrow receipt lookup doubles as an actual-method proof; no readiness permission is created. */
export async function readMailManagementCommand(context: CatalogContext, raw: unknown) {
  const input = mailInput(commandScope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(ROW)
      .bind(...params(input))
      .first<Row>();
  return row === null
    ? null
    : { requestSha256: row.request_sha256, response: response(row.response) };
}
export async function beginMailManagementCommand(context: CatalogContext, raw: unknown) {
  const input = mailInput(commandScope.extend({ requestSha256: mailHash, now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  return runCommand(db, {
    name: "mail.beginManagementCommand",
    input,
    lookup: unknownOutcome("mail.beginManagementCommand"),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["resend_mail_commands"],
    read: (reader) =>
      reader
        .prepare(ROW)
        .bind(...params(input))
        .first<Row>(),
    decide: (row) => {
      if (row) {
        if (row.request_sha256 !== input.requestSha256) throw new Error("idempotency_key_reused");
        return { replay: { created: false, response: response(row.response) } };
      }
      return {
        statements: [
          db
            .prepare(
              "INSERT INTO resend_mail_commands(organization_id,project_id,environment_id,idempotency_key,request_sha256,created_at,lease_until)VALUES(?1,?2,?3,?4,unhex(?5),?6,?7)",
            )
            .bind(...params(input), input.requestSha256, input.now, shiftStored(input.now, 120000)),
        ],
        result: () => ({ created: true, response: null }),
      };
    },
  });
}
export async function resumeMailManagementCommand(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(commandScope.extend({ now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  return runCommand<Row | null, boolean>(db, {
    name: "mail.resumeManagementCommand",
    input,
    lookup: unknownOutcome("mail.resumeManagementCommand"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(ROW)
        .bind(...params(input))
        .first<Row>(),
    decide: (row) => {
      if (!row || row.response !== null || row.lease_until === null || row.lease_until > input.now)
        return { replay: false };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(${ROW} AND response IS NULL AND lease_until=?5)`,
            [...params(input), row.lease_until],
          ),
          db
            .prepare(
              "UPDATE resend_mail_commands SET lease_until=?5 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4 AND response IS NULL",
            )
            .bind(...params(input), shiftStored(input.now, 120000)),
        ],
        result: () => true,
      };
    },
  });
}
/** The provider result is already safely minimized by Mail; never store a reconstructed webhook signing secret. */
export async function completeMailManagementCommand(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(
      commandScope.extend({
        response: z
          .record(z.string(), z.unknown())
          .refine((value) => !Object.hasOwn(value, "signing_secret")),
        now: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    text = mailMetadataJsonb(input.response);
  await runCommand(db, {
    name: "mail.completeManagementCommand",
    input,
    lookup: unknownOutcome("mail.completeManagementCommand"),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE resend_mail_commands SET response=?5,completed_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4 AND response IS NULL",
          )
          .bind(...params(input), text, input.now),
      ],
      result: () => undefined,
    }),
  });
}
const workspaceScope = z.strictObject({
  organizationId: ulid,
  domainId: ulid,
  idempotencyKey: z.string(),
  principalId: z.string(),
  operation: z.enum(["create", "retire", "bind", "detach"]),
  requestSha256: mailHash,
});
export async function readWorkspaceMailManagementCommand(context: CatalogContext, raw: unknown) {
  const input = mailInput(workspaceScope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(
        "SELECT response FROM workspace_mail_commands WHERE organization_id=?1 AND domain_id=?2 AND idempotency_key=?3 AND principal_id=?4 AND operation=?5 AND request_sha256=unhex(?6)",
      )
      .bind(
        input.organizationId,
        input.domainId,
        input.idempotencyKey,
        input.principalId,
        input.operation,
        input.requestSha256,
      )
      .first<{ response: string | null }>();
  if (!row) throw new Error("mail_scope_unavailable");
  return response(row.response);
}
export async function claimWorkspaceMailRetirementCommand(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(
      z.strictObject({ organizationId: ulid, idempotencyKey: z.string(), now: mailTime }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    sql =
      "SELECT 1 FROM workspace_mail_commands WHERE organization_id=?1 AND idempotency_key=?2 AND response IS NULL AND(lease_until IS NULL OR lease_until<=?3)",
    values = [input.organizationId, input.idempotencyKey, input.now];
  return runCommand<Record<string, unknown> | null, boolean>(db, {
    name: "mail.claimWorkspaceRetirementCommand",
    input,
    lookup: unknownOutcome("mail.claimWorkspaceRetirementCommand"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(sql)
        .bind(...values)
        .first(),
    decide: (row) =>
      row === null
        ? { replay: false }
        : {
            statements: [
              guard(db, "precondition_changed", `NOT EXISTS(${sql})`, values),
              db
                .prepare(
                  "UPDATE workspace_mail_commands SET lease_until=?3 WHERE organization_id=?1 AND idempotency_key=?2 AND response IS NULL",
                )
                .bind(input.organizationId, input.idempotencyKey, shiftStored(input.now, 120000)),
            ],
            result: () => true,
          },
  });
}
