import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { mailInput, mailScope, mailTime, MailScopeError } from "./auth.js";
import { mailResourceJsonSql, resourceWire } from "./resource.js";
import { unknownOutcome } from "../unknown-outcome.js";

const RELEASED_DNS =
  "CASE WHEN json_type(dns_receipts,'$.records') IS NOT NULL THEN '{\"released\": '||dns_receipts||'}' ELSE dns_receipts END";
const rawRow = mailResourceJsonSql();
/** Original workspace retirement updates immutable legacy custody, returning its prior cleanup facts. */
export async function retireMailLegacyWorkspaceResource(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      z.strictObject({ organizationId: ulid, domainId: ulid, now: mailTime }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    sql = `SELECT ${rawRow} resource FROM resend_mail_domains d JOIN workspace_mail_domains w ON w.legacy_domain_id=d.domain_id WHERE w.organization_id=?1 AND w.domain_id=?2 AND w.status='retiring'`;
  return runCommand(db, {
    name: "mail.retireWorkspaceLegacy",
    input,
    lookup: unknownOutcome("mail.retireWorkspaceLegacy"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader.prepare(sql).bind(input.organizationId, input.domainId).first<{ resource: string }>(),
    decide: (row) => {
      if (!row) throw new MailScopeError();
      const resource = JSON.parse(row.resource) as Record<string, unknown>;
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${sql}) current WHERE current.resource=?3)`,
            [input.organizationId, input.domainId, row.resource],
          ),
          db
            .prepare(
              `UPDATE resend_mail_domains SET sending=0,receiving=0,sending_status='disabled',receiving_status='disabled',webhook_url=NULL,webhook_verified_at=NULL,deleted_at=COALESCE(deleted_at,?2),dns_receipts=${RELEASED_DNS} WHERE domain_id=?1`,
            )
            .bind(resource["domain_id"], input.now),
        ],
        result: () => resourceWire(resource),
      };
    },
  });
}
const COMMAND =
  "SELECT domain_id FROM resend_mail_commands WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4";
const liveWhere =
  "d.organization_id=?1 AND d.project_id=?2 AND d.environment_id=?3 AND d.deleted_at IS NULL";
const retiredWhere =
  "d.organization_id=?1 AND d.project_id=?2 AND d.environment_id=?3 AND d.deleted_at IS NOT NULL";
const CANDIDATE = `SELECT ${rawRow} FROM resend_mail_domains d WHERE ${liveWhere}`;
const candidateId = `(SELECT d.domain_id FROM resend_mail_domains d WHERE ${liveWhere})`;
const SNAPSHOT = `SELECT json_object(
 'command',(SELECT json_object('domain_id',domain_id,'request',lower(hex(request_sha256)),'response',response,'created_at',created_at,'completed_at',completed_at,'lease_until',lease_until,'attempt',claimed_attempt) FROM resend_mail_commands WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4),
 'bound',(SELECT ${rawRow} FROM resend_mail_domains d WHERE ${retiredWhere} AND d.domain_id=(${COMMAND})),
 'candidate',(${CANDIDATE}),
 'unfinished',(SELECT ${rawRow} FROM resend_mail_domains d WHERE ${retiredWhere} AND EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id) AND NOT EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id AND c.response IS NOT NULL)),
 'live_owned',EXISTS(SELECT 1 FROM resend_mail_domains d JOIN projects p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE ${liveWhere}),
 'shared',EXISTS(SELECT 1 FROM workspace_mail_domains WHERE legacy_domain_id=${candidateId} AND status<>'retired'),
 'original_binding',EXISTS(SELECT 1 FROM project_mail_domain_bindings WHERE mail_domain_id=${candidateId} AND organization_id=?1 AND project_id=?2 AND environment_id=?3 AND legacy AND state='active'),
 'other_refs',EXISTS(SELECT 1 FROM project_mail_domain_bindings WHERE mail_domain_id=${candidateId} AND project_id<>?2 AND state<>'detached')
 ) fingerprint`;
interface Facts {
  command: { domain_id: string | null } | null;
  bound: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  unfinished: Record<string, unknown> | null;
  live_owned: number;
  shared: number;
  original_binding: number;
  other_refs: number;
}
/** Original one-command retirement closes admissions before uncertain provider cleanup, retaining raw custody. */
export async function retireMailResource(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      mailScope.extend({ idempotencyKey: z.string().min(1).max(128), now: mailTime }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    values = [input.organizationId, input.projectId, input.environmentId, input.idempotencyKey];
  return runCommand(db, {
    name: "mail.retireResource",
    input,
    lookup: unknownOutcome("mail.retireResource"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(SNAPSHOT)
        .bind(...values)
        .first<{ fingerprint: string }>(),
    decide: (row) => {
      if (!row) throw new MailScopeError();
      const facts = JSON.parse(row.fingerprint) as Facts;
      if (!facts.command) throw new Error("mail_operation_pending");
      if (facts.command.domain_id !== null) {
        if (!facts.bound) throw new MailScopeError();
        return { replay: resourceWire(facts.bound) };
      }
      const resource = facts.candidate ?? facts.unfinished;
      if (!resource) throw new MailScopeError();
      const fence = guard(db, "precondition_changed", `(${SNAPSHOT}) IS NOT ?5`, [
          ...values,
          row.fingerprint,
        ]),
        bind = db
          .prepare(
            "UPDATE resend_mail_commands SET domain_id=?5 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND idempotency_key=?4 AND domain_id IS NULL",
          )
          .bind(...values, resource["domain_id"]);
      if (!facts.candidate)
        return { statements: [fence, bind], result: () => resourceWire(resource) };
      if (facts.live_owned !== 1) throw new MailScopeError();
      if (facts.shared && (facts.original_binding !== 1 || facts.other_refs))
        throw new Error("mail_domain_conflict");
      if (
        resource["provider_domain_id"] === null &&
        resource["provider_preflight_at"] !== null &&
        Date.parse(input.now) - Date.parse(String(resource["provider_preflight_at"])) < 120000
      )
        throw new Error("mail_domain_creation_unresolved");
      if (
        resource["sending_key_id"] === null &&
        resource["sending_key_claimed_at"] !== null &&
        Date.parse(input.now) - Date.parse(String(resource["sending_key_claimed_at"])) < 300000
      )
        throw new Error("mail_operation_pending");
      const statements = [fence];
      if (facts.shared)
        statements.push(
          db
            .prepare(
              "UPDATE project_mail_domain_bindings SET state='detached',sending=0,revision=revision+1,updated_at=?2 WHERE mail_domain_id=?1 AND state<>'detached'",
            )
            .bind(resource["domain_id"], input.now),
          db
            .prepare(
              "UPDATE workspace_mail_domains SET status='retiring',revision=revision+1 WHERE domain_id=?1 AND status='active'",
            )
            .bind(resource["domain_id"]),
        );
      statements.push(
        db
          .prepare(
            `UPDATE resend_mail_domains SET sending=0,receiving=0,sending_status='disabled',receiving_status='disabled',webhook_url=NULL,webhook_verified_at=NULL,dns_receipts=${RELEASED_DNS},deleted_at=?2 WHERE domain_id=?1 AND deleted_at IS NULL RETURNING *`,
          )
          .bind(resource["domain_id"], input.now),
        bind,
      );
      return { statements, result: (results) => resourceWire(results.at(-2)?.results[0] ?? null) };
    },
  });
}
