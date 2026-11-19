import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { mailInput, mailTime, MailScopeError } from "./auth.js";
import { mailResourceJsonSql, changeMailResource } from "./resource.js";
import {
  LEGACY_MAIL_ABSENCE_SQL,
  legacyMailResourcesStatement,
  requireLegacyMailAbsence,
  type LegacyMailResourceRow,
} from "./legacy-resources.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";
import { unknownOutcome } from "../unknown-outcome.js";

const scope = z.strictObject({ organizationId: ulid, projectId: ulid, operationId: ulid });
export const MAIL_DELETION_SCOPE_SQL =
  "SELECT 1 FROM product_command_intents i JOIN projects p ON p.project_id=i.project_id AND p.owner_state='active' AND p.lifecycle_state='deleting' JOIN operations o ON o.organization_id=i.organization_id AND o.project_id=i.project_id AND o.operation_id=i.operation_id AND o.state IN('queued','running') WHERE i.organization_id=?1 AND i.project_id=?2 AND i.operation_id=?3 AND i.event_type='ProjectDeletionRequestedV1'";
const INVENTORY =
  "SELECT lower(hex(external_ref_hash)) hash FROM run_resource_inventory WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND((provider='resend' AND resource_kind='mail-domain') OR(provider='cloudflare' AND resource_kind='mail-dns-record')) ORDER BY external_ref_hash";
const DOMAINS = `SELECT json_object('resource',${mailResourceJsonSql()},'workspace_id',w.domain_id,'workspace_status',w.status,
 'desired_sending',EXISTS(SELECT 1 FROM project_mail_domain_bindings b WHERE b.mail_domain_id=d.domain_id AND b.state='active' AND b.sending),
 'retirement_completed',EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id AND c.response IS NOT NULL)) facts
 FROM resend_mail_domains d LEFT JOIN workspace_mail_domains w ON w.legacy_domain_id=d.domain_id WHERE d.organization_id=?1 AND d.project_id=?2 ORDER BY d.domain_id`;
const inventoryFingerprint = `SELECT json_group_array(hash) FROM(${INVENTORY})`,
  domainsFingerprint = `SELECT json_group_array(json(facts)) FROM(${DOMAINS})`,
  legacyFingerprint = `SELECT json_group_array(json_object('kind',resource_kind,'locator',locator,'observed_at',observed_at)) FROM(${LEGACY_MAIL_ABSENCE_SQL})`;
interface DomainFact {
  resource: Record<string, unknown>;
  workspace_id: string | null;
  workspace_status: string | null;
  desired_sending: number;
  retirement_completed: number;
}
export async function readMailDeletionScope(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope, raw),
    { db } = await routeOrganization(context, input.organizationId);
  return (
    (await db
      .prepare(MAIL_DELETION_SCOPE_SQL)
      .bind(input.organizationId, input.projectId, input.operationId)
      .first()) !== null
  );
}
export async function recordMailDeletionFoundResource(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(z.strictObject({ domainId: ulid, providerDomainId: z.string() }), raw);
  await changeMailResource(context, { change: { action: "recordFound", ...input } });
}
/** Original frozen inventory, real historical absence and admission closure share ONE Core effect. */
export async function prepareMailProjectDeletion(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    values = [input.organizationId, input.projectId, input.operationId];
  return runCommand(db, {
    name: "mail.prepareProjectDeletion",
    input,
    lookup: unknownOutcome("mail.prepareProjectDeletion"),
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(MAIL_DELETION_SCOPE_SQL).bind(...values),
        reader.prepare(INVENTORY).bind(...values),
        legacyMailResourcesStatement(reader, input),
        reader.prepare(DOMAINS).bind(input.organizationId, input.projectId),
        reader.prepare(inventoryFingerprint).bind(...values),
        reader.prepare(domainsFingerprint).bind(input.organizationId, input.projectId),
        reader.prepare(legacyFingerprint).bind(input.organizationId, input.projectId),
      ]);
      return {
        authorized: rows[0]?.results.length === 1,
        inventory: rows[1]?.results ?? [],
        legacy: (rows[2]?.results ?? []) as unknown as LegacyMailResourceRow[],
        domains: (rows[3]?.results ?? []).map(
          (row) => JSON.parse(String(row["facts"])) as DomainFact,
        ),
        fingerprints: [rows[4]?.results[0], rows[5]?.results[0], rows[6]?.results[0]].map((row) =>
          row ? Object.values(row)[0] : undefined,
        ),
      };
    },
    decide: (snapshot) => {
      if (!snapshot.authorized) throw new Error("Mail deletion scope unavailable");
      const legacy = requireLegacyMailAbsence(snapshot.legacy),
        retained: { domain_id: string; provider_domain_id: string; sending: boolean }[] = [],
        domains: Record<string, unknown>[] = [];
      for (const fact of snapshot.domains) {
        const d = fact.resource;
        if (
          fact.workspace_status === "active" &&
          typeof d["provider_domain_id"] === "string" &&
          d["provider_domain_id"] !== ""
        )
          retained.push({
            domain_id: String(d["domain_id"]),
            provider_domain_id: d["provider_domain_id"],
            sending: fact.desired_sending === 1,
          });
        if (fact.workspace_id === null)
          domains.push({
            domain_id: d["domain_id"],
            provider_domain_id: d["provider_domain_id"],
            sending_key_id: d["sending_key_id"],
            sending_key_claimed_at: d["sending_key_claimed_at"],
            provider_claimed_at: d["provider_claimed_at"],
            provider_preflight_at: d["provider_preflight_at"],
            domain: d["domain"],
            retirement_completed: fact.retirement_completed === 1,
          });
      }
      return {
        statements: [
          guard(db, "precondition_changed", `NOT EXISTS(${MAIL_DELETION_SCOPE_SQL})`, values),
          guard(db, "precondition_changed", `(${inventoryFingerprint}) IS NOT ?4`, [
            ...values,
            snapshot.fingerprints[0],
          ]),
          guard(db, "precondition_changed", `(${domainsFingerprint}) IS NOT ?3`, [
            input.organizationId,
            input.projectId,
            snapshot.fingerprints[1],
          ]),
          guard(db, "precondition_changed", `(${legacyFingerprint}) IS NOT ?3`, [
            input.organizationId,
            input.projectId,
            snapshot.fingerprints[2],
          ]),
          db
            .prepare(
              "UPDATE resend_mail_domains SET receiving=0,receiving_status='disabled',webhook_url=NULL,webhook_verified_at=NULL,sending=EXISTS(SELECT 1 FROM project_mail_domain_bindings b WHERE b.mail_domain_id=resend_mail_domains.domain_id AND b.state='active' AND b.sending) WHERE organization_id=?1 AND project_id=?2 AND EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=resend_mail_domains.domain_id AND w.status='active')",
            )
            .bind(input.organizationId, input.projectId),
          db
            .prepare(
              "UPDATE resend_mail_domains SET sending=0,receiving=0,sending_status='disabled',receiving_status='disabled' WHERE organization_id=?1 AND project_id=?2 AND NOT EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=resend_mail_domains.domain_id)",
            )
            .bind(input.organizationId, input.projectId),
        ],
        result: () => ({
          inventory: snapshot.inventory.map((row) => String(row["hash"])),
          legacy,
          retained,
          domains,
        }),
      };
    },
  });
}
/** Provider cleanup is already observed. Its immutable row and unfinished retirement responses complete atomically. */
export async function finishMailProjectDeletionResource(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(
    z.strictObject({ domainId: ulid, deletedAt: mailTime, completedAt: mailTime }),
    raw,
  );
  await context.router.assertLayout();
  const owner = await context.directory
    .prepare("SELECT organization_id FROM resend_mail_domains WHERE domain_id=?")
    .bind(input.domainId)
    .first<{ organization_id: string }>();
  if (!owner) return;
  const { db } = await routeOrganization(context, owner.organization_id);
  await runCommand(db, {
    name: "mail.finishProjectDeletionResource",
    input,
    lookup: unknownOutcome("mail.finishProjectDeletionResource"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare("SELECT domain,records,deleted_at FROM resend_mail_domains WHERE domain_id=?")
        .bind(input.domainId)
        .first<{ domain: string; records: string; deleted_at: string | null }>(),
    decide: (row) => {
      if (!row) throw new MailScopeError();
      // Keep captured canonical JSONB payload bytes verbatim inside the new original fixed JSONB wrapper.
      const response =
        '{"domain": ' +
        mailMetadataJsonb(row.domain) +
        ', "status": "deleted", "dns_records": ' +
        row.records +
        "}";
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM resend_mail_domains WHERE domain_id=?1 AND domain=?2 AND records=?3 AND deleted_at IS ?4)",
            [input.domainId, row.domain, row.records, row.deleted_at],
          ),
          db
            .prepare(
              "UPDATE resend_mail_domains SET deleted_at=COALESCE(deleted_at,?2) WHERE domain_id=?1",
            )
            .bind(input.domainId, input.deletedAt),
          db
            .prepare(
              "UPDATE resend_mail_commands SET response=?2,completed_at=?3 WHERE domain_id=?1 AND response IS NULL",
            )
            .bind(input.domainId, response, input.completedAt),
        ],
        result: () => undefined,
      };
    },
  });
}
