import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailTime } from "./auth.js";
import { unknownOutcome } from "../unknown-outcome.js";

const clocked = z.strictObject({ now: mailTime });
const PENDING_LEGACY = `SELECT domain_id,organization_id,project_id,environment_id FROM resend_mail_domains WHERE deleted_at IS NULL AND sending
 AND(provider_domain_id IS NULL OR sending_status IN('pending','failed') OR(receiving AND receiving_status IN('pending','failed')) OR(sending_status='ready' AND sending_key_id IS NULL AND(sending_key_claimed_at IS NULL OR sending_key_claimed_at<=strftime('%Y-%m-%dT%H:%M:%f','now','-5 minutes')||'000Z')))
 ORDER BY last_reconcile_at NULLS FIRST,domain_id LIMIT 20`;
const DUE_IDENTITY = `SELECT i.organization_id,i.project_id,CAST(i.revision AS TEXT) revision,i.expires_at,i.automatic_revalidation_attempted_at
 FROM project_application_domain_identities i
 JOIN project_mail_domain_bindings b ON b.organization_id=i.organization_id AND b.project_id=i.project_id AND b.state='active' AND NOT b.legacy AND b.application_identity_revision=i.revision
 JOIN workspace_mail_domains w ON w.domain_id=b.mail_domain_id AND w.organization_id=b.organization_id AND w.status='active' AND w.registrable_domain=i.registrable_domain
 JOIN projects p ON p.organization_id=i.organization_id AND p.project_id=i.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 WHERE i.state='verified' AND i.expires_at>?1 AND i.expires_at<=?2 AND(i.automatic_revalidation_attempted_at IS NULL OR i.automatic_revalidation_attempted_at<=?3)
 ORDER BY i.expires_at,i.project_id LIMIT 20`;
const EXPIRED =
  "SELECT b.organization_id,b.project_id FROM project_mail_domain_bindings b WHERE b.state='active' AND NOT b.legacy AND NOT EXISTS(SELECT 1 FROM project_application_domain_identities i WHERE i.organization_id=b.organization_id AND i.project_id=b.project_id AND i.state='verified' AND i.revision=b.application_identity_revision AND i.expires_at>?1)";
const PENDING_WORKSPACES = `SELECT w.organization_id,w.domain_id,(COALESCE(d.provider_domain_id,w.provider_domain_id) IS NULL OR COALESCE(d.sending_status,w.sending_status) IN('pending','failed') OR COALESCE(d.sending_key_id,w.sending_key_id) IS NULL) provisioning
 FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id WHERE w.status='active'
 AND(w.capabilities_dirty OR COALESCE(d.provider_domain_id,w.provider_domain_id) IS NULL OR COALESCE(d.sending_status,w.sending_status) IN('pending','failed') OR COALESCE(d.sending_key_id,w.sending_key_id) IS NULL)
 AND(w.last_reconcile_at IS NULL OR w.last_reconcile_at<?1) ORDER BY w.last_reconcile_at NULLS FIRST,w.domain_id LIMIT 20`;
function cohortFences(db: D1Database, source: string, values: unknown[]) {
  return [
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM(${source}) selected LEFT JOIN organizations org ON org.organization_id=selected.organization_id WHERE org.organization_id IS NULL)`,
      values,
    ),
    guard(
      db,
      "bucket_fenced",
      `EXISTS(SELECT 1 FROM(${source}) selected JOIN organizations org ON org.organization_id=selected.organization_id JOIN bucket_fences fence ON fence.bucket=org.bucket)`,
      values,
    ),
  ];
}
/** Global scan authority is kept off ordinary Mail resource/command bindings. */
export async function listPendingMailLegacyResources(context: CatalogContext, raw: unknown) {
  mailInput(z.strictObject({}), raw);
  const { db } = await context.router.routeShard(0);
  return (await db.prepare(PENDING_LEGACY).all()).results;
}
export async function claimMailLegacyReconciliation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(z.strictObject({ domainId: ulid, now: mailTime }), raw);
  await context.router.assertLayout();
  const owner = await context.directory
    .prepare("SELECT organization_id FROM resend_mail_domains WHERE domain_id=?")
    .bind(input.domainId)
    .first<{ organization_id: string }>();
  if (!owner) return false;
  const { db } = await routeOrganization(context, owner.organization_id),
    sql =
      "SELECT 1 FROM resend_mail_domains WHERE domain_id=?1 AND deleted_at IS NULL AND(last_reconcile_at IS NULL OR last_reconcile_at<?2)",
    values = [input.domainId, shiftStored(input.now, -30000)];
  return runCommand<Record<string, unknown> | null, boolean>(db, {
    name: "mail.claimLegacyReconciliation",
    input,
    lookup: unknownOutcome("mail.claimLegacyReconciliation"),
    retryOn: ["precondition_changed"],
    read: (r) =>
      r
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
                .prepare("UPDATE resend_mail_domains SET last_reconcile_at=?2 WHERE domain_id=?1")
                .bind(input.domainId, input.now),
            ],
            result: () => true,
          },
  });
}
/** Original20-project daily claim and seven-day window, atomic across the selected cohort. */
export async function claimMailIdentityRevalidation(context: CatalogContext, raw: unknown) {
  const input = mailInput(clocked, raw),
    { db } = await context.router.routeShard(0),
    values = [input.now, shiftStored(input.now, 7 * 86400000), shiftStored(input.now, -86400000)],
    fingerprint = `SELECT json_group_array(json_object('org',organization_id,'project',project_id,'revision',revision,'expires',expires_at,'attempt',automatic_revalidation_attempted_at)) facts FROM(${DUE_IDENTITY})`;
  return runCommand(db, {
    name: "mail.claimIdentityRevalidation",
    input,
    lookup: unknownOutcome("mail.claimIdentityRevalidation"),
    retryOn: ["precondition_changed"],
    read: (r) =>
      r
        .prepare(fingerprint)
        .bind(...values)
        .first<{ facts: string }>(),
    decide: (row) => {
      if (!row) throw new Error("mail_identity_revalidation_unavailable");
      const selected = JSON.parse(row.facts) as {
        org: string;
        project: string;
        revision: string;
      }[];
      if (selected.length === 0) return { replay: [] };
      const ids = selected.map((value) => value.project);
      return {
        statements: [
          ...cohortFences(db, DUE_IDENTITY, values),
          guard(db, "precondition_changed", `(SELECT facts FROM(${fingerprint})) IS NOT ?4`, [
            ...values,
            row.facts,
          ]),
          db
            .prepare(
              `UPDATE project_application_domain_identities SET automatic_revalidation_attempted_at=?1 WHERE project_id IN(${ids.map((_, index) => `?${index + 2}`).join(",")}) RETURNING organization_id,project_id,CAST(revision AS TEXT) revision`,
            )
            .bind(input.now, ...ids),
        ],
        result: (rows) => rows.at(-1)?.results ?? [],
      };
    },
  });
}
/** Original whole-cohort proof expiration update remains one batch, with existing bucket quarantine. */
export async function suspendExpiredMailBindings(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(clocked, raw),
    { db } = await context.router.routeShard(0);
  await runCommand(db, {
    name: "mail.suspendExpiredBindings",
    input,
    lookup: unknownOutcome("mail.suspendExpiredBindings"),
    read: async () => null,
    decide: () => ({
      statements: [
        ...cohortFences(db, EXPIRED, [input.now]),
        db
          .prepare(
            `UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=?1 WHERE project_id IN(SELECT project_id FROM(${EXPIRED}))`,
          )
          .bind(input.now),
      ],
      result: () => undefined,
    }),
  });
}
export async function listPendingMailWorkspaceResources(context: CatalogContext, raw: unknown) {
  const input = mailInput(clocked, raw),
    { db } = await context.router.routeShard(0),
    rows = (await db.prepare(PENDING_WORKSPACES).bind(shiftStored(input.now, -30000)).all())
      .results;
  return rows.map((row) => ({
    organization_id: row["organization_id"],
    domain_id: row["domain_id"],
    provisioning: row["provisioning"] === 1,
  }));
}
export async function claimMailWorkspaceReconciliation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(
      z.strictObject({ organizationId: ulid, domainId: ulid, now: mailTime }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    sql =
      "SELECT 1 FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2 AND status='active' AND(last_reconcile_at IS NULL OR last_reconcile_at<?3)",
    values = [input.organizationId, input.domainId, shiftStored(input.now, -30000)];
  return runCommand<Record<string, unknown> | null, boolean>(db, {
    name: "mail.claimWorkspaceReconciliation",
    input,
    lookup: unknownOutcome("mail.claimWorkspaceReconciliation"),
    retryOn: ["precondition_changed"],
    read: (r) =>
      r
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
                  "UPDATE workspace_mail_domains SET last_reconcile_at=?3 WHERE organization_id=?1 AND domain_id=?2",
                )
                .bind(input.organizationId, input.domainId, input.now),
            ],
            result: () => true,
          },
  });
}
