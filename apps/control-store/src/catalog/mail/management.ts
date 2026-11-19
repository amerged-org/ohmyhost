import { z } from "zod";
import { classifyCustomerMailDomain } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readAccount, readRuntimeDecision } from "../credit/index.js";
import { OrganizationCreditError } from "../billing/errors.js";
import { requireMailAccess } from "./credit.js";
import { RESEND_RESOURCE_COLUMNS, resourceWire } from "./resource.js";
import { mailInput, mailTime, mailScope, MailScopeError } from "./auth.js";
import { unknownOutcome } from "../unknown-outcome.js";
import { shiftStored } from "../../timestamps.js";
/** An unverified sender name is reserved for this long; after it the name is free again. */
export const RESERVATION_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NOW = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
const TARGET = `SELECT p.organization_id,p.project_id,e.environment_id FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='prod'
 WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND(?3 IS NULL OR e.environment_id=?3)`;
const OWNER =
  "(d.domain_id IS NOT NULL AND d.organization_id=target.organization_id AND d.project_id=target.project_id AND d.environment_id=target.environment_id AND d.deleted_at IS NULL)";
const SENDING = `COALESCE(b.sending AND b.state='active' AND(w.legacy_domain_id IS NULL OR d.deleted_at IS NULL)
 AND(b.legacy OR(i.state='verified' AND i.expires_at>${DB_NOW} AND i.revision=b.application_identity_revision AND i.registrable_domain=w.registrable_domain)),0)`;
const WS_FIELDS = new Set(
  "domain_id,organization_id,domain,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,last_reconcile_at,sending_status,receiving_status,records,dns_receipts,configured_at,observed_at".split(
    ",",
  ),
);
const BLOBS = new Set(["sending_key_ciphertext", "sending_key_nonce", "sending_key_sha256"]);
/** Literal equivalent of original readResendMailDomain jsonb-populate-record projection, including disabled bindings. */
export function mailResourceProjectionSql(receivingOwnerSql: "?4" | "1" | "0" = "?4") {
  const overrides: Record<string, string> = {
    domain_id: "w.domain_id",
    organization_id: "target.organization_id",
    project_id: "target.project_id",
    environment_id: "target.environment_id",
    sending: SENDING,
    sending_status: `CASE WHEN ${SENDING} THEN CASE WHEN d.domain_id IS NULL THEN w.sending_status ELSE d.sending_status END ELSE 'disabled' END`,
    receiving: `CASE WHEN ${OWNER} THEN d.receiving ELSE 0 END`,
    receiving_suspended: `CASE WHEN ${OWNER} THEN d.receiving_suspended ELSE 0 END`,
    receiving_status: `CASE WHEN ${OWNER} THEN d.receiving_status ELSE 'disabled' END`,
    webhook_url: `CASE WHEN ${OWNER} THEN d.webhook_url ELSE NULL END`,
    webhook_secret_generation: "COALESCE(d.webhook_secret_generation, 0)",
    webhook_verified_at: `CASE WHEN ${OWNER} THEN d.webhook_verified_at ELSE NULL END`,
    deleted_at: "NULL",
  };
  const columns = RESEND_RESOURCE_COLUMNS.map((column) => {
    let value =
      overrides[column] ??
      (WS_FIELDS.has(column)
        ? `CASE WHEN d.domain_id IS NULL THEN w.${column} ELSE d.${column} END`
        : `d.${column}`);
    if (BLOBS.has(column))
      value = `CASE WHEN (${value}) IS NULL THEN NULL ELSE lower(hex(${value})) END`;
    return `${value} ${column}`;
  });
  return `WITH target AS(${TARGET}) SELECT ${columns.join(",")} FROM target
 JOIN workspace_mail_domains w ON w.organization_id=target.organization_id AND w.status='active'
 LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id
 LEFT JOIN project_mail_domain_bindings b ON b.organization_id=target.organization_id AND b.project_id=target.project_id AND b.environment_id=target.environment_id AND b.mail_domain_id=w.domain_id
 LEFT JOIN project_application_domain_identities i ON i.organization_id=target.organization_id AND i.project_id=target.project_id
 WHERE(${OWNER} OR b.state<>'detached') AND(NOT ${receivingOwnerSql} OR ${OWNER})
 ORDER BY ${SENDING} DESC,(${OWNER} AND d.receiving AND d.webhook_verified_at IS NOT NULL) DESC,(b.state<>'detached') DESC NULLS LAST,w.domain_id LIMIT 1`;
}
export async function readMailDomainProjection(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      z.strictObject({
        organizationId: ulid,
        projectId: ulid,
        environmentId: ulid.optional(),
        receivingOwner: z.boolean().optional(),
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId);
  return resourceWire(
    await db
      .prepare(mailResourceProjectionSql())
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId ?? null,
        input.receivingOwner ? 1 : 0,
      )
      .first(),
  );
}
export async function requireMailOrganizationPaid(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(z.strictObject({ organizationId: ulid, now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  requireMailAccess(await readAccount(db, input.organizationId, input.now));
}
/** Receiving needs Paid, credit inside its grace, a project budget with room and an activated receiving price. */
export async function admitMailReceiving(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(mailScope.extend({ now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    [decision, price] = await Promise.all([
      readRuntimeDecision(db, input),
      db
        .prepare(
          "SELECT count(*) count FROM usage_meter_activations WHERE meter='mail.received' AND starts_at<=?1",
        )
        .bind(input.now)
        .first<{ count: number }>(),
    ]);
  if (decision.reason === "project_unavailable")
    throw new OrganizationCreditError("organization_credit_scope_missing");
  if (decision.reason === "insufficient_organization_credits")
    throw new OrganizationCreditError(decision.reason);
  if (!decision.paidAllowed) throw new OrganizationCreditError("paid_plan_required");
  if (decision.reason) throw new OrganizationCreditError(decision.reason);
  if ((price?.count ?? 0) < 1) throw new Error("mail_pricing_unavailable");
}
const configureInput = mailScope
  .extend({
    domainId: ulid,
    domain: z
      .string()
      .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u),
    sending: z.literal(true),
    receiving: z.boolean(),
    webhookUrl: z.string().nullable(),
    now: mailTime,
  })
  .refine((v) => !v.receiving || v.webhookUrl !== null);
export function configureFactsSql() {
  return `SELECT json_object('retirement',EXISTS(SELECT 1 FROM resend_mail_domains d WHERE d.deleted_at IS NOT NULL AND(d.project_id=?2 OR d.domain=?5) AND EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id) AND NOT EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id AND c.response IS NOT NULL)),
 'occupied',EXISTS(SELECT 1 FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id WHERE w.domain=?5 AND((w.status<>'retired' AND(w.sending_status='ready' OR w.legacy_domain_id IS NOT NULL OR w.configured_at>?6) AND(d.project_id IS NOT ?2 OR w.organization_id<>?1)) OR(w.status='retired' AND w.reputation_state='suspended'))),
 'workspace',(SELECT w.status FROM workspace_mail_domains w JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id WHERE d.organization_id=?1 AND d.project_id=?2 AND d.environment_id=?3 AND d.deleted_at IS NULL),
 'domain',COALESCE((SELECT domain FROM(${mailResourceProjectionSql("1")})),(SELECT domain FROM(${mailResourceProjectionSql("0")}))),
 'owned',EXISTS(${TARGET})) fingerprint`;
}
/** Original legacy configure, including global name serialization, Paid, exact original UPSERT and mirror effects. */
export async function configureMailResource(context: CatalogContext, raw: unknown) {
  const input = mailInput(configureInput, raw);
  classifyCustomerMailDomain(input.domain);
  const { db } = await routeOrganization(context, input.organizationId),
    sql = configureFactsSql(),
    values = [
      input.organizationId,
      input.projectId,
      input.environmentId,
      0,
      input.domain,
      shiftStored(input.now, -RESERVATION_MS),
    ];
  return runCommand(db, {
    name: "mail.configureResource",
    input,
    lookup: unknownOutcome("mail.configureResource"),
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const [row, account] = await Promise.all([
        reader
          .prepare(sql)
          .bind(...values)
          .first<{ fingerprint: unknown }>(),
        readAccount(reader, input.organizationId, input.now),
      ]);
      return { fingerprint: row?.fingerprint, account };
    },
    decide: (snapshot) => {
      const text = snapshot.fingerprint;
      if (typeof text !== "string") throw new Error("mail_scope_unavailable");
      const facts = JSON.parse(text) as {
        retirement: number;
        occupied: number;
        workspace: string | null;
        domain: string | null;
        owned: number;
      };
      if (facts.retirement) throw new Error("mail_retirement_pending");
      if (facts.occupied) throw new Error("mail_domain_conflict");
      requireMailAccess(snapshot.account);
      if (facts.workspace !== null && facts.workspace !== "active")
        throw new Error("mail_domain_conflict");
      if (facts.domain !== null && facts.domain !== input.domain)
        throw new Error("mail_domain_conflict");
      if (facts.owned !== 1) throw new MailScopeError();
      return {
        statements: [
          guard(db, "precondition_changed", `(${sql}) IS NOT ?7`, [...values, text]),
          db
            .prepare(
              `INSERT INTO resend_mail_domains(domain_id,organization_id,project_id,environment_id,domain,sending,receiving,webhook_url,webhook_verified_at,configured_at)
 VALUES(?4,?1,?2,?3,?5,1,?6,?7,CASE WHEN ?7 IS NULL THEN NULL ELSE ?8 END,?8)
 ON CONFLICT(project_id) WHERE deleted_at IS NULL DO UPDATE SET sending=excluded.sending,receiving=excluded.receiving,receiving_suspended=CASE WHEN excluded.receiving THEN 0 ELSE resend_mail_domains.receiving_suspended END,webhook_url=excluded.webhook_url,webhook_verified_at=excluded.webhook_verified_at
 WHERE resend_mail_domains.domain=excluded.domain AND resend_mail_domains.environment_id=excluded.environment_id RETURNING *`,
            )
            .bind(
              input.organizationId,
              input.projectId,
              input.environmentId,
              input.domainId,
              input.domain,
              input.receiving ? 1 : 0,
              input.webhookUrl,
              input.now,
            ),
          guard(db, "precondition_changed", "changes()<>1"),
          db
            .prepare(
              "UPDATE project_mail_domain_bindings SET sending=1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND mail_domain_id=(SELECT domain_id FROM resend_mail_domains WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND deleted_at IS NULL) AND legacy AND state='active'",
            )
            .bind(input.organizationId, input.projectId, input.environmentId, input.now),
        ],
        result: (results) => resourceWire(results.at(-3)?.results[0] ?? null),
      };
    },
  });
}
