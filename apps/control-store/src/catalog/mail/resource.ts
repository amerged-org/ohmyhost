import { z } from "zod";
import { classifyCustomerMailDomain } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { bytesOf } from "../platform-support.js";
import { mailInput, mailTime, MailScopeError } from "./auth.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";
import { unknownOutcome } from "../unknown-outcome.js";

export const RESEND_RESOURCE_COLUMNS =
  "domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending,receiving,receiving_suspended,last_entitlement_check_at,last_reconcile_at,sending_status,receiving_status,records,dns_receipts,webhook_url,webhook_secret_generation,webhook_verified_at,configured_at,observed_at,deleted_at".split(
    ",",
  );
const BLOBS = new Set(["sending_key_ciphertext", "sending_key_nonce", "sending_key_sha256"]);
const expression = (column: string, alias = "d") =>
  column === "webhook_secret_generation"
    ? `COALESCE(${alias}.${column}, 0)`
    : BLOBS.has(column)
      ? `CASE WHEN ${alias}.${column} IS NULL THEN NULL ELSE lower(hex(${alias}.${column})) END`
      : `${alias}.${column}`;
const selected = RESEND_RESOURCE_COLUMNS.map((column) => `${expression(column)} ${column}`).join(
  ",",
);
export function mailResourceJsonSql() {
  return `json_object(${RESEND_RESOURCE_COLUMNS.flatMap((column) => [`'${column}'`, expression(column)]).join(",")})`;
}
export const MAIL_RESOURCE_ROW_SQL = `SELECT ${selected},json_array(${RESEND_RESOURCE_COLUMNS.map((column) => expression(column)).join(",")}) signature,
 (SELECT status FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id) workspace_status
 FROM resend_mail_domains d WHERE d.domain_id=?1`;
const ROW = MAIL_RESOURCE_ROW_SQL;
type ResourceRow = Record<string, unknown> & {
  signature: string;
  workspace_status: string | null;
  organization_id: string;
};
export function resourceWire(row: Record<string, unknown> | null) {
  return row === null
    ? null
    : Object.fromEntries(
        RESEND_RESOURCE_COLUMNS.map((column) => {
          const value = row[column];
          return [
            column,
            BLOBS.has(column) && value !== null && typeof value !== "string"
              ? Array.from(bytesOf(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
              : value,
          ];
        }),
      );
}
const scoped = z.strictObject({ organizationId: ulid, domainId: ulid });
export async function readMailResourceCustody(context: CatalogContext, raw: unknown) {
  const input = mailInput(scoped, raw),
    { db } = await routeOrganization(context, input.organizationId);
  return resourceWire(
    await db
      .prepare(`${ROW} AND d.organization_id=?2 AND d.deleted_at IS NULL`)
      .bind(input.domainId, input.organizationId)
      .first(),
  );
}
export async function readMailLegacyWorkspaceResource(context: CatalogContext, raw: unknown) {
  const input = mailInput(scoped.extend({ status: z.enum(["active", "retiring"]) }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  const sql = ROW.replace(
    "WHERE d.domain_id=?1",
    "WHERE d.deleted_at IS NULL AND EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id AND w.organization_id=?1 AND w.domain_id=?2 AND w.status=?3)",
  );
  return resourceWire(
    await db.prepare(sql).bind(input.organizationId, input.domainId, input.status).first(),
  );
}
export async function readMailResourceWorkspaceStatus(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ domainId: ulid }), raw);
  await context.router.assertLayout();
  const row = await context.directory
    .prepare("SELECT organization_id FROM resend_mail_domains WHERE domain_id=?")
    .bind(input.domainId)
    .first<{ organization_id: string }>();
  if (!row) return null;
  const { db } = await routeOrganization(context, row.organization_id);
  return (
    (
      await db
        .prepare("SELECT status FROM workspace_mail_domains WHERE legacy_domain_id=?")
        .bind(input.domainId)
        .first<{ status: string }>()
    )?.status ?? null
  );
}
export async function isMailReceivingOwner(context: CatalogContext, raw: unknown) {
  const input = mailInput(scoped.extend({ projectId: ulid, environmentId: ulid }), raw),
    { db } = await routeOrganization(context, input.organizationId);
  return (
    (await db
      .prepare(
        "SELECT 1 FROM resend_mail_domains WHERE domain_id=? AND organization_id=? AND project_id=? AND environment_id=? AND deleted_at IS NULL",
      )
      .bind(input.domainId, input.organizationId, input.projectId, input.environmentId)
      .first()) !== null
  );
}
export async function hasLiveMailResourceName(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ domain: z.string() }), raw);
  await context.router.assertLayout();
  return (
    (await context.directory
      .prepare("SELECT 1 FROM resend_mail_domains WHERE domain=? AND deleted_at IS NULL")
      .bind(input.domain)
      .first()) !== null
  );
}
const id = { domainId: ulid };
const simple = [
  "claimCreation",
  "recordPreflight",
  "claimVerification",
  "claimKey",
  "recoverKey",
  "clearCreation",
  "clearKey",
  "disableReceiving",
  "finishRetirement",
] as const;
const change = z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(simple), ...id }),
  z.strictObject({
    action: z.literal("resetUnpreparedCreation"),
    ...id,
    expectedClaimedAt: mailTime,
  }),
  z.strictObject({ action: z.literal("releaseKeyRecovery"), ...id, expectedClaimedAt: mailTime }),
  z.strictObject({ action: z.literal("clearVerification"), ...id, providerDomainId: z.string() }),
  z.strictObject({ action: z.literal("recordFound"), ...id, providerDomainId: z.string() }),
  z.strictObject({ action: z.literal("prepareWebhook"), ...id, url: z.string() }),
  z.strictObject({ action: z.literal("verifyWebhook"), ...id, url: z.string() }),
  z.strictObject({ action: z.literal("rotateWebhookSecret"), ...id }),
  z.strictObject({
    action: z.literal("saveObservation"),
    value: z.strictObject({
      domainId: ulid,
      providerId: z.string(),
      sendingStatus: z.enum(["disabled", "pending", "ready", "failed"]),
      receivingStatus: z.enum(["disabled", "pending", "ready", "failed"]),
      records: z.array(z.unknown()),
    }),
  }),
  z.strictObject({
    action: z.literal("saveKey"),
    value: z.strictObject({
      domainId: ulid,
      providerDomainId: z.string(),
      keyId: z.string(),
      ciphertext: z.string().regex(/^(?:[a-f0-9]{2})*$/u),
      nonce: z.string().regex(/^[a-f0-9]{24}$/u),
      valueSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      keyVersion: z.number().int().min(1).max(2147483647),
    }),
  }),
]);
/** Every action is one original fixed provider-resource boundary. SQL, columns and callback authority are not inputs. */
export async function changeMailResource(context: CatalogContext, raw: unknown): Promise<boolean> {
  const clocked = new Set([
    "claimCreation",
    "recordPreflight",
    "claimVerification",
    "claimKey",
    "recoverKey",
    "saveObservation",
    "verifyWebhook",
    "finishRetirement",
  ]);
  const input = mailInput(
      z
        .strictObject({ change, now: mailTime.optional() })
        .refine((value) => clocked.has(value.change.action) === (value.now !== undefined)),
      raw,
    ),
    command = input.change,
    domainId = "domainId" in command ? command.domainId : command.value.domainId;
  const clock = () => {
    if (input.now === undefined) throw new TypeError("Invalid mail input");
    return input.now;
  };
  await context.router.assertLayout();
  const owner = await context.directory
    .prepare("SELECT organization_id FROM resend_mail_domains WHERE domain_id=?")
    .bind(domainId)
    .first<{ organization_id: string }>();
  if (!owner) {
    if (command.action === "recordFound") throw new Error("Mail domain receipt conflict");
    if (["claimCreation", "claimVerification", "claimKey", "recoverKey"].includes(command.action))
      return false;
    if (
      ["recordPreflight", "saveObservation", "saveKey", "recordFound", "verifyWebhook"].includes(
        command.action,
      )
    )
      throw new MailScopeError();
    return true;
  }
  const { db } = await routeOrganization(context, owner.organization_id),
    name = `mail.resource.${command.action}`;
  return runCommand<ResourceRow | null, boolean>(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    read: (reader) => reader.prepare(ROW).bind(domainId).first<ResourceRow>(),
    decide: (row) => {
      if (!row) throw new MailScopeError();
      // Key recovery is cleanup here; its replacement is separately fenced by claimKey.
      if (
        ["claimCreation", "recordPreflight", "claimKey", "claimVerification"].includes(
          command.action,
        )
      ) {
        try {
          classifyCustomerMailDomain(String(row["domain"]));
        } catch {
          throw new MailScopeError();
        }
      }
      const active = row.workspace_status === null || row.workspace_status === "active",
        live = row["deleted_at"] === null,
        empty = row["provider_domain_id"] === null,
        bareKey = row["sending_key_id"] === null;
      const statement = (sql: string, values: unknown[]) => db.prepare(sql).bind(...values);
      let sql: string, values: unknown[];
      switch (command.action) {
        case "claimCreation":
          if (!active || !live || !empty || row["provider_claimed_at"] !== null)
            return { replay: false };
          sql = "UPDATE resend_mail_domains SET provider_claimed_at=?2 WHERE domain_id=?1";
          values = [domainId, clock()];
          break;
        case "recordPreflight":
          if (
            !active ||
            !live ||
            !empty ||
            row["provider_claimed_at"] === null ||
            row["provider_preflight_at"] !== null
          )
            throw new MailScopeError();
          sql = "UPDATE resend_mail_domains SET provider_preflight_at=?2 WHERE domain_id=?1";
          values = [domainId, clock()];
          break;
        case "claimVerification":
          if (
            !active ||
            !live ||
            empty ||
            (row["verify_requested_at"] !== null &&
              String(row["verify_requested_at"]) > shiftStored(clock(), -600000))
          )
            return { replay: false };
          sql = "UPDATE resend_mail_domains SET verify_requested_at=?2 WHERE domain_id=?1";
          values = [domainId, clock()];
          break;
        case "claimKey":
          if (
            !active ||
            !live ||
            empty ||
            row["sending_status"] !== "ready" ||
            (row["sending"] !== 1 && row.workspace_status !== "active") ||
            !bareKey ||
            row["sending_key_claimed_at"] !== null
          )
            return { replay: false };
          sql = "UPDATE resend_mail_domains SET sending_key_claimed_at=?2 WHERE domain_id=?1";
          values = [domainId, clock()];
          break;
        case "recoverKey":
          if (!active) throw new MailScopeError();
          if (
            !live ||
            !bareKey ||
            row["sending_key_claimed_at"] === null ||
            String(row["sending_key_claimed_at"]) > shiftStored(clock(), -300000)
          )
            return { replay: false };
          sql = "UPDATE resend_mail_domains SET sending_key_claimed_at=?2 WHERE domain_id=?1";
          values = [domainId, clock()];
          break;
        case "resetUnpreparedCreation":
          sql =
            "UPDATE resend_mail_domains SET provider_claimed_at=NULL WHERE domain_id=?1 AND provider_domain_id IS NULL AND provider_preflight_at IS NULL AND provider_claimed_at=?2";
          values = [domainId, command.expectedClaimedAt];
          break;
        case "clearCreation":
          sql =
            "UPDATE resend_mail_domains SET provider_claimed_at=NULL,provider_preflight_at=NULL WHERE domain_id=?1 AND provider_domain_id IS NULL";
          values = [domainId];
          break;
        case "clearVerification":
          sql =
            "UPDATE resend_mail_domains SET verify_requested_at=NULL WHERE domain_id=?1 AND provider_domain_id=?2";
          values = [domainId, command.providerDomainId];
          break;
        case "releaseKeyRecovery":
          sql =
            "UPDATE resend_mail_domains SET sending_key_claimed_at=NULL WHERE domain_id=?1 AND sending_key_id IS NULL AND sending_key_claimed_at=?2";
          values = [domainId, command.expectedClaimedAt];
          break;
        case "clearKey":
          sql =
            "UPDATE resend_mail_domains SET sending_key_claimed_at=NULL WHERE domain_id=?1 AND sending_key_id IS NULL";
          values = [domainId];
          break;
        case "saveObservation": {
          const value = command.value;
          if (!live || (!empty && row["provider_domain_id"] !== value.providerId))
            throw new MailScopeError();
          sql =
            "UPDATE resend_mail_domains SET provider_domain_id=?2,sending_status=?3,receiving_status=?4,records=?5,observed_at=?6 WHERE domain_id=?1";
          values = [
            domainId,
            value.providerId,
            value.sendingStatus,
            value.receivingStatus,
            mailMetadataJsonb(value.records),
            clock(),
          ];
          break;
        }
        case "saveKey": {
          const value = command.value;
          if (
            !live ||
            row["provider_domain_id"] !== value.providerDomainId ||
            row["sending_key_claimed_at"] === null ||
            !bareKey
          )
            throw new MailScopeError();
          sql =
            "UPDATE resend_mail_domains SET sending_key_id=?2,sending_key_ciphertext=unhex(?3),sending_key_nonce=unhex(?4),sending_key_sha256=unhex(?5),sending_key_version=?6 WHERE domain_id=?1";
          values = [
            domainId,
            value.keyId,
            value.ciphertext,
            value.nonce,
            value.valueSha256,
            value.keyVersion,
          ];
          break;
        }
        case "recordFound":
          if (!empty && row["provider_domain_id"] !== command.providerDomainId)
            throw new Error("Mail domain receipt conflict");
          sql = "UPDATE resend_mail_domains SET provider_domain_id=?2 WHERE domain_id=?1";
          values = [domainId, command.providerDomainId];
          break;
        case "prepareWebhook":
          if (!active) throw new MailScopeError();
          sql =
            "UPDATE resend_mail_domains SET receiving=0,receiving_status='disabled',webhook_secret_generation=webhook_secret_generation+CASE WHEN webhook_url IS ?2 THEN 0 ELSE 1 END,webhook_url=?2,webhook_verified_at=NULL WHERE domain_id=?1 AND deleted_at IS NULL";
          values = [domainId, command.url];
          break;
        case "rotateWebhookSecret":
          if (!active) throw new MailScopeError();
          if (row["webhook_url"] === null) throw new Error("mail_webhook_required");
          sql =
            "UPDATE resend_mail_domains SET receiving=0,receiving_status='disabled',webhook_secret_generation=webhook_secret_generation+1,webhook_verified_at=NULL WHERE domain_id=?1 AND deleted_at IS NULL";
          values = [domainId];
          break;
        case "verifyWebhook":
          if (!active) throw new MailScopeError();
          if (!live || row["webhook_url"] !== command.url) throw new Error("mail_webhook_changed");
          sql =
            "UPDATE resend_mail_domains SET webhook_verified_at=?2,sending=1,receiving=1,receiving_suspended=0,receiving_status='pending' WHERE domain_id=?1";
          values = [domainId, clock()];
          break;
        case "disableReceiving":
          if (!active) throw new MailScopeError();
          sql =
            "UPDATE resend_mail_domains SET receiving=0,receiving_status='disabled',webhook_url=NULL,webhook_verified_at=NULL WHERE domain_id=?1";
          values = [domainId];
          break;
        case "finishRetirement":
          sql =
            "UPDATE workspace_mail_domains SET status='retired',retired_at=?2 WHERE legacy_domain_id=?1 AND status='retiring'";
          values = [domainId, clock()];
          break;
      }
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${ROW}) current WHERE current.signature=?2 AND current.workspace_status IS ?3)`,
            [domainId, row.signature, row.workspace_status],
          ),
          statement(sql, values),
        ],
        result: () => true,
      };
    },
  });
}
