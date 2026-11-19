import { z } from "zod";
import { classifyCustomerMailDomain, classifyApplicationMailIdentity } from "@ohmyhost/platform";
import type { D1Database } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";
import { type CatalogContext, routeOrganization, ulid } from "../common.js";

export const mailTime = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);
export const mailScope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
});
export const mailHash = z.string().regex(/^[a-f0-9]{64}$/u);
export class MailScopeError extends Error {
  readonly code = "mail_scope_unavailable";
  constructor() {
    super("mail_scope_unavailable");
  }
}
export class MailReputationSuspended extends Error {
  readonly code = "mail_reputation_suspended";
  constructor() {
    super("mail_reputation_suspended");
  }
}
export function mailInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid mail input");
  return result.data;
}
const ACTIVE =
  "p.organization_id=b.organization_id AND p.project_id=b.project_id AND p.owner_state='active' AND p.lifecycle_state='active'";
/** Fixed original sender read; encrypted key custody always comes from the resource, never the sending app. */
export const SENDER_SQL = `SELECT w.domain_id,w.domain,CAST(b.revision AS TEXT) bindingRevision,b.legacy,b.sender_addresses senderAddresses,b.default_from defaultFrom,b.default_reply_to defaultReplyTo,
 w.custody_organization_id keyOrganizationId,w.custody_project_id keyProjectId,w.custody_environment_id keyEnvironmentId,w.reputation_state reputationState,w.registrable_domain registrableDomain,i.hostname applicationHostname,
 CASE WHEN COALESCE(d.sending_key_ciphertext,w.sending_key_ciphertext) IS NULL THEN NULL ELSE lower(hex(COALESCE(d.sending_key_ciphertext,w.sending_key_ciphertext))) END ciphertext,
 CASE WHEN COALESCE(d.sending_key_nonce,w.sending_key_nonce) IS NULL THEN NULL ELSE lower(hex(COALESCE(d.sending_key_nonce,w.sending_key_nonce))) END nonce,
 CASE WHEN COALESCE(d.sending_key_sha256,w.sending_key_sha256) IS NULL THEN NULL ELSE lower(hex(COALESCE(d.sending_key_sha256,w.sending_key_sha256))) END valueSha256,
 COALESCE(d.sending_key_version,w.sending_key_version) keyVersion
 FROM project_mail_domain_bindings b JOIN workspace_mail_domains w ON w.domain_id=b.mail_domain_id AND w.organization_id=b.organization_id
 LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id
 JOIN projects p ON ${ACTIVE}
 JOIN environments e ON e.organization_id=b.organization_id AND e.project_id=b.project_id AND e.environment_id=?3
 LEFT JOIN project_application_domain_identities i ON i.project_id=b.project_id AND i.organization_id=b.organization_id
 WHERE b.organization_id=?1 AND b.project_id=?2 AND b.state='active' AND b.sending=1 AND w.status='active'
 AND COALESCE(d.sending_status,w.sending_status)='ready' AND COALESCE(d.sending_key_id,w.sending_key_id) IS NOT NULL
 AND(b.legacy=1 OR(i.state='verified' AND i.expires_at>?4 AND i.revision=b.application_identity_revision AND i.registrable_domain=w.registrable_domain))`;
export interface MailSender {
  domainId: string;
  domain: string;
  registrableDomain: string | null;
  bindingRevision: string;
  legacy: boolean;
  senderAddresses: readonly string[] | null;
  defaultFrom: string | null;
  defaultReplyTo: string | null;
  keyOrganizationId: string;
  keyProjectId: string;
  keyEnvironmentId: string;
  ciphertext: string;
  nonce: string;
  valueSha256: string;
  keyVersion: number;
}
export function senderOf(row: Record<string, unknown> | undefined): MailSender {
  if (
    !row ||
    row["ciphertext"] === null ||
    row["nonce"] === null ||
    row["valueSha256"] === null ||
    !row["keyVersion"]
  )
    throw new MailScopeError();
  if (row["reputationState"] === "suspended") throw new MailReputationSuspended();
  try {
    const main = classifyCustomerMailDomain(String(row["domain"])).registrableDomain;
    if (row["legacy"] !== 1) {
      const application = classifyApplicationMailIdentity(
        String(row["applicationHostname"]),
      ).registrableDomain;
      if (main !== application || main !== row["registrableDomain"]) throw new MailScopeError();
    }
  } catch {
    throw new MailScopeError();
  }
  return {
    domainId: String(row["domain_id"]),
    domain: String(row["domain"]),
    registrableDomain: row["registrableDomain"] as string | null,
    bindingRevision: String(row["bindingRevision"]),
    legacy: row["legacy"] === 1,
    senderAddresses:
      row["legacy"] === 1 ? null : (JSON.parse(String(row["senderAddresses"])) as string[]),
    defaultFrom: row["defaultFrom"] as string | null,
    defaultReplyTo: row["defaultReplyTo"] as string | null,
    keyOrganizationId: String(row["keyOrganizationId"]),
    keyProjectId: String(row["keyProjectId"]),
    keyEnvironmentId: String(row["keyEnvironmentId"]),
    ciphertext: String(row["ciphertext"]),
    nonce: String(row["nonce"]),
    valueSha256: String(row["valueSha256"]),
    keyVersion: Number(row["keyVersion"]),
  };
}
export async function readSender(
  db: D1Database,
  input: { organizationId: string; projectId: string; environmentId: string; now: string },
): Promise<MailSender> {
  const result = await db
    .prepare(SENDER_SQL)
    .bind(input.organizationId, input.projectId, input.environmentId, input.now)
    .all<Record<string, unknown>>();
  if (result.results.length !== 1) throw new MailScopeError();
  return senderOf(result.results[0]);
}
const authorizeKey = z.strictObject({
  projectId: ulid,
  keySha256: mailHash,
  receiving: z.boolean().optional(),
});
/** Original environment-key authority and cross-Dev/Prod digest ambiguity; no plaintext key crosses this call. */
export async function authorizeMailGatewayKey(context: CatalogContext, raw: unknown) {
  const input = mailInput(authorizeKey, raw);
  await context.router.assertLayout();
  const rows = (
    await context.directory
      .prepare(
        `SELECT s.organization_id,s.project_id,s.environment_id,d.domain FROM environment_secrets s
 LEFT JOIN resend_mail_domains d ON d.organization_id=s.organization_id AND d.project_id=s.project_id AND s.environment_id=d.environment_id AND d.receiving=1 AND d.webhook_verified_at IS NOT NULL AND d.deleted_at IS NULL
 JOIN projects p ON p.organization_id=s.organization_id AND p.project_id=s.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 WHERE s.project_id=?1 AND s.name='OHMYHOST_MAIL_KEY' AND s.value_sha256=unhex(?2)
 AND(?3=0 OR d.domain_id IS NOT NULL)
 AND(SELECT COUNT(*) FROM environment_secrets other WHERE other.project_id=s.project_id AND other.name=s.name AND other.value_sha256=s.value_sha256)=1`,
      )
      .bind(input.projectId, input.keySha256, input.receiving === true ? 1 : 0)
      .all<{
        organization_id: string;
        project_id: string;
        environment_id: string;
        domain: string | null;
      }>()
  ).results;
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  const { db } = await routeOrganization(context, row.organization_id),
    scope = {
      organizationId: row.organization_id,
      projectId: row.project_id,
      environmentId: row.environment_id,
    };
  if (input.receiving === true)
    return row.domain === null ? null : { ...scope, domain: row.domain };
  try {
    const clock = await db
      .prepare("SELECT(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') now")
      .first<{ now: string }>();
    if (!clock) throw new Error("mail_unavailable");
    const sender = await readSender(db, { ...scope, now: clock.now });
    return { ...scope, domain: sender.domain };
  } catch (error) {
    if (error instanceof MailScopeError) return null;
    throw error;
  }
}
export async function readMailSendingKey(context: CatalogContext, raw: unknown) {
  const input = mailInput(mailScope.extend({ now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    sender = await readSender(db, input);
  return {
    domainId: sender.domainId,
    keyOrganizationId: sender.keyOrganizationId,
    keyProjectId: sender.keyProjectId,
    keyEnvironmentId: sender.keyEnvironmentId,
    ciphertext: sender.ciphertext,
    nonce: sender.nonce,
    valueSha256: sender.valueSha256,
    keyVersion: sender.keyVersion,
  };
}
