import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailTime } from "./auth.js";

const scope = z.strictObject({ organizationId: ulid, domainId: ulid });
const clocked = scope.extend({ now: mailTime });
const leased = clocked.extend({ leaseToken: ulid });
const desired = z.strictObject({
  provider_domain_id: z.string().nullable(),
  sending: z.boolean(),
  receiving: z.boolean(),
});
type Desired = z.output<typeof desired>;
interface Row {
  provider_domain_id: string | null;
  sending: number;
  receiving: number;
}
/** Original desired state; historical custody is separate from every sender's CURRENT ownership and proof. */
const DESIRED = `SELECT COALESCE(d.provider_domain_id,w.provider_domain_id) provider_domain_id,
 EXISTS(SELECT 1 FROM project_mail_domain_bindings b
 JOIN projects p ON p.organization_id=b.organization_id AND p.project_id=b.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 LEFT JOIN project_application_domain_identities i ON i.organization_id=b.organization_id AND i.project_id=b.project_id
 WHERE b.mail_domain_id=w.domain_id AND b.state='active' AND b.sending
 AND(b.legacy OR(i.state='verified' AND i.revision=b.application_identity_revision
 AND i.expires_at>?3 AND i.registrable_domain=w.registrable_domain))) sending,
 COALESCE(d.receiving AND NOT d.receiving_suspended AND d.deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=d.organization_id AND p.project_id=d.project_id
 AND p.owner_state='active' AND p.lifecycle_state='active'),0) receiving
 FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id
 WHERE w.organization_id=?1 AND w.domain_id=?2 AND w.status='active'`;
const params = (input: z.output<typeof clocked>) => [
  input.organizationId,
  input.domainId,
  input.now,
];
const rowOf = (row: Row | null): Desired | null =>
  row === null
    ? null
    : {
        provider_domain_id: row.provider_domain_id,
        sending: row.sending === 1,
        receiving: row.receiving === 1,
      };
function unknown(name: string): never {
  throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
}
/** Same two-minute local lease. An uncertain committed claim never reconstructs permission to call the provider. */
export async function claimWorkspaceMailCapabilities(context: CatalogContext, raw: unknown) {
  const input = mailInput(leased, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const sql =
    "SELECT capabilities_lease_token,capabilities_lease_until FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2 AND status='active' AND(capabilities_lease_until IS NULL OR capabilities_lease_until<=?3)";
  return runCommand(db, {
    name: "mail.claimWorkspaceCapabilities",
    input,
    lookup: async () => unknown("mail.claimWorkspaceCapabilities"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(sql)
        .bind(...params(input))
        .first(),
    decide: (row) =>
      row === null
        ? { replay: false }
        : {
            statements: [
              guard(db, "precondition_changed", `NOT EXISTS(${sql})`, params(input)),
              db
                .prepare(
                  "UPDATE workspace_mail_domains SET capabilities_lease_token=?3,capabilities_lease_until=?4 WHERE organization_id=?1 AND domain_id=?2",
                )
                .bind(
                  input.organizationId,
                  input.domainId,
                  input.leaseToken,
                  shiftStored(input.now, 120000),
                ),
            ],
            result: () => true,
          },
  });
}
export async function readWorkspaceMailCapabilities(
  context: CatalogContext,
  raw: unknown,
): Promise<Desired | null> {
  const input = mailInput(clocked, raw),
    { db } = await routeOrganization(context, input.organizationId);
  return rowOf(
    await db
      .prepare(DESIRED)
      .bind(...params(input))
      .first<Row>(),
  );
}
/** Original post-provider recheck and metadata acknowledgement share ONE consistent guarded transaction. */
export async function confirmWorkspaceMailCapabilities(context: CatalogContext, raw: unknown) {
  const input = mailInput(leased.extend({ desired }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  return runCommand(db, {
    name: "mail.confirmWorkspaceCapabilities",
    input,
    lookup: async () => unknown("mail.confirmWorkspaceCapabilities"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(DESIRED)
        .bind(...params(input))
        .first<Row>(),
    decide: (row) => {
      const current = rowOf(row);
      if (
        current?.provider_domain_id !== input.desired.provider_domain_id ||
        current.sending !== input.desired.sending ||
        current.receiving !== input.desired.receiving
      )
        return { replay: false };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${DESIRED}) current WHERE current.provider_domain_id IS ?4 AND current.sending=?5 AND current.receiving=?6)`,
            [
              ...params(input),
              input.desired.provider_domain_id,
              input.desired.sending ? 1 : 0,
              input.desired.receiving ? 1 : 0,
            ],
          ),
          db
            .prepare(
              "UPDATE resend_mail_domains SET sending=?3 WHERE domain_id=(SELECT legacy_domain_id FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2)",
            )
            .bind(
              input.organizationId,
              input.domainId,
              input.desired.sending || input.desired.receiving ? 1 : 0,
            ),
          db
            .prepare(
              "UPDATE workspace_mail_domains SET capabilities_dirty=0 WHERE organization_id=?1 AND domain_id=?2 AND capabilities_lease_token=?3",
            )
            .bind(input.organizationId, input.domainId, input.leaseToken),
        ],
        result: () => true,
      };
    },
  });
}
/** Only a settled local loop releases its own lease; unknown provider outcomes retain it. */
export async function releaseWorkspaceMailCapabilities(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(scope.extend({ leaseToken: ulid }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  await runCommand(db, {
    name: "mail.releaseWorkspaceCapabilities",
    input,
    lookup: async () => unknown("mail.releaseWorkspaceCapabilities"),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE workspace_mail_domains SET capabilities_lease_token=NULL,capabilities_lease_until=NULL WHERE organization_id=?1 AND domain_id=?2 AND capabilities_lease_token=?3",
          )
          .bind(input.organizationId, input.domainId, input.leaseToken),
      ],
      result: () => undefined,
    }),
  });
}
