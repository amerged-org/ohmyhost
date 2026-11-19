import { z } from "zod";
import { classifyCustomerMailDomain, classifyMailDomain } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { publicTimestamp, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailTime, MailScopeError } from "./auth.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";
import { unknownOutcome } from "../unknown-outcome.js";

export const MAIL_WORKSPACE_SOURCE_COLUMNS =
  "domain_id,organization_id,domain,registrable_domain,legacy_domain_id,custody_organization_id,custody_project_id,custody_environment_id,revision,status,reputation_state,reputation_suspended_at,reputation_suspension_reason,reputation_triggering_event_id,reputation_version,capabilities_lease_until,capabilities_lease_token,last_reconcile_at,capabilities_dirty,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending_status,receiving_status,records,dns_receipts,configured_at,observed_at,retired_at".split(
    ",",
  );
const BLOB = new Set(["sending_key_ciphertext", "sending_key_nonce", "sending_key_sha256"]);
const field = (column: string) =>
  BLOB.has(column)
    ? `CASE WHEN w.${column} IS NULL THEN NULL ELSE lower(hex(w.${column})) END`
    : column === "revision" || column === "reputation_version"
      ? `CAST(w.${column} AS TEXT)`
      : `w.${column}`;
const selected = MAIL_WORKSPACE_SOURCE_COLUMNS.map((column) => `${field(column)} ${column}`).join(
    ",",
  ),
  signature = `json_array(${MAIL_WORKSPACE_SOURCE_COLUMNS.map(field).join(",")})`,
  ROW = `SELECT ${selected},${signature} signature FROM workspace_mail_domains w WHERE w.organization_id=?1 AND w.domain_id=?2`,
  scope = z.strictObject({ organizationId: ulid, domainId: ulid });
const PROVIDER_COLUMNS =
  "domain_id,organization_id,domain,legacy_domain_id,status,revision,custody_organization_id,custody_project_id,custody_environment_id,provider_domain_id,provider_claimed_at,provider_preflight_at,verify_requested_at,sending_key_id,sending_key_claimed_at,records".split(
    ",",
  );
const providerWire = (row: Record<string, unknown>) =>
  Object.fromEntries(PROVIDER_COLUMNS.map((column) => [column, row[column]]));
type Row = Record<string, unknown> & { signature: string };
export async function readMailWorkspaceResource(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db.prepare(ROW).bind(input.organizationId, input.domainId).first<Row>();
  return row === null ? null : providerWire(row);
}
const VIEW_SQL = `SELECT w.domain_id,w.organization_id,w.domain,CAST(w.revision AS TEXT) revision,w.status,w.configured_at,
 CASE WHEN COALESCE(d.sending_status,w.sending_status)='ready' AND COALESCE(d.sending_key_id,w.sending_key_id) IS NULL THEN 'pending' ELSE COALESCE(d.sending_status,w.sending_status) END sending,
 COALESCE(d.receiving_status,w.receiving_status) receiving,COALESCE(d.records,w.records) records,COALESCE(d.observed_at,w.observed_at) observed_at,
 (SELECT count(*) FROM project_mail_domain_bindings b WHERE b.mail_domain_id=w.domain_id AND b.state='active') bindings_count
 FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id`;
/** The original customer view of one workspace sender; `row` is a VIEW_SQL row. */
export function workspaceMailView(row: Record<string, unknown>) {
  if (
    typeof row["configured_at"] !== "string" ||
    typeof row["domain"] !== "string" ||
    Number(row["bindings_count"]) > 2147483647
  )
    throw new MailScopeError();
  return {
    domain_id: row["domain_id"],
    organization_id: row["organization_id"],
    domain: row["domain"],
    registrable_domain: classifyMailDomain(row["domain"]).registrableDomain,
    revision: Number(row["revision"]),
    status: row["status"],
    sending: row["sending"],
    receiving: row["receiving"],
    configured_at: publicTimestamp(row["configured_at"]),
    observed_at: row["observed_at"] === null ? null : publicTimestamp(String(row["observed_at"])),
    dns_records: JSON.parse(String(row["records"])) as unknown[],
    bindings_count: Number(row["bindings_count"]),
  };
}
/** Original resource view, including retained retired resources and all state='active' reference counts. */
export async function readMailWorkspaceView(context: CatalogContext, raw: unknown) {
  const input = mailInput(scope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(`${VIEW_SQL} WHERE w.organization_id=?1 AND w.domain_id=?2`)
      .bind(input.organizationId, input.domainId)
      .first<Record<string, unknown>>();
  if (!row) throw new MailScopeError();
  return workspaceMailView(row);
}
/** Every live (not retired) workspace sender of the organization, oldest first. */
export async function listMailWorkspaceViews(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ organizationId: ulid }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    rows = await db
      .prepare(
        `${VIEW_SQL} WHERE w.organization_id=?1 AND w.status<>'retired' ORDER BY w.configured_at,w.domain_id`,
      )
      .bind(input.organizationId)
      .all<Record<string, unknown>>();
  return rows.results.map(workspaceMailView);
}
const actions = [
    "recoverKey",
    "claimKey",
    "clearKey",
    "resetCreation",
    "claimCreation",
    "releaseUnpreparedCreation",
    "recordPreflight",
    "clearCreation",
    "claimVerification",
  ] as const,
  change = z.discriminatedUnion("action", [
    z.strictObject({ action: z.enum(actions) }),
    z.strictObject({
      action: z.literal("observe"),
      providerDomainId: z.string(),
      records: z.array(z.unknown()),
      sendingStatus: z.enum(["ready", "failed", "pending"]),
    }),
    z.strictObject({ action: z.enum(["claimDns", "releaseDns"]), leaseToken: ulid }),
    z.strictObject({ action: z.literal("recordFound"), providerDomainId: z.string() }),
    z.strictObject({ action: z.literal("clearVerification"), providerDomainId: z.string() }),
    z.strictObject({
      action: z.literal("saveKey"),
      keyId: z.string(),
      ciphertext: z.string().regex(/^(?:[a-f0-9]{2}){17,}$/u),
      nonce: z.string().regex(/^[a-f0-9]{24}$/u),
      valueSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      keyVersion: z.number().int().min(1).max(2147483647),
    }),
  ]),
  CLOCKED = new Set([
    "observe",
    "claimDns",
    "recoverKey",
    "claimKey",
    "claimCreation",
    "recordPreflight",
    "claimVerification",
  ]);
/** The live-name index of workspace senders (0643): another sender of this name that is not retired and holds it. */
const NAME_HELD_BY_ANOTHER_SQL = `EXISTS(SELECT 1 FROM workspace_mail_domains other WHERE other.domain=workspace_mail_domains.domain
  AND other.domain_id<>workspace_mail_domains.domain_id AND other.status<>'retired' AND(other.sending_status='ready' OR other.legacy_domain_id IS NOT NULL))`;
/** Fixed native workspace provider phases; clocks, opaque IDs and original source guards remain independent. */
export async function changeMailWorkspaceResource(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(
      scope
        .extend({ change, now: mailTime.optional() })
        .refine((value) => CLOCKED.has(value.change.action) === (value.now !== undefined)),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    command = input.change,
    clock = () => {
      if (input.now === undefined) throw new TypeError("Invalid mail input");
      return input.now;
    },
    name = `mail.workspace.${command.action}`,
    values = [input.organizationId, input.domainId];
  return runCommand<Row | null, boolean>(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(ROW)
        .bind(...values)
        .first<Row>(),
    decide: (row) => {
      const active = row?.["status"] === "active",
        bareKey = row?.["sending_key_id"] === null,
        empty = row?.["provider_domain_id"] === null;
      let sql: string, params: unknown[];
      if (!row)
        return {
          replay: ![
            "observe",
            "claimDns",
            "recoverKey",
            "claimKey",
            "saveKey",
            "claimCreation",
            "recordPreflight",
            "claimVerification",
          ].includes(command.action),
        };
      // recoverKey also creates a replacement key in the workspace provider workflow.
      if (
        [
          "claimCreation",
          "recordPreflight",
          "claimKey",
          "recoverKey",
          "claimVerification",
        ].includes(command.action)
      ) {
        try {
          classifyCustomerMailDomain(String(row["domain"]));
        } catch {
          throw new MailScopeError();
        }
      }
      switch (command.action) {
        case "observe":
          if (!active || (!empty && row["provider_domain_id"] !== command.providerDomainId))
            return { replay: false };
          // A verified name that another organization's live sender already holds is taken: this sender is retired in
          // the same write, so the live-name index never sees two verified senders of one name, and the observer's
          // pending list (active senders only) stops offering it.
          sql = `UPDATE workspace_mail_domains SET provider_domain_id=?3,records=?4,sending_status=?5,observed_at=?6,
 status=CASE WHEN ?5='ready' AND status='active' AND ${NAME_HELD_BY_ANOTHER_SQL} THEN 'retired' ELSE status END,
 retired_at=CASE WHEN ?5='ready' AND status='active' AND ${NAME_HELD_BY_ANOTHER_SQL} THEN ?6 ELSE retired_at END
 WHERE organization_id=?1 AND domain_id=?2`;
          params = [
            ...values,
            command.providerDomainId,
            mailMetadataJsonb(command.records),
            command.sendingStatus,
            clock(),
          ];
          break;
        case "claimDns":
          if (
            !active ||
            (row["capabilities_lease_until"] !== null &&
              String(row["capabilities_lease_until"]) > clock())
          )
            return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET capabilities_lease_token=?3,capabilities_lease_until=?4 WHERE organization_id=?1 AND domain_id=?2";
          params = [...values, command.leaseToken, shiftStored(clock(), 120000)];
          break;
        case "releaseDns":
          sql =
            "UPDATE workspace_mail_domains SET capabilities_lease_token=NULL,capabilities_lease_until=NULL WHERE organization_id=?1 AND domain_id=?2 AND capabilities_lease_token=?3";
          params = [...values, command.leaseToken];
          break;
        case "recoverKey":
          if (
            !active ||
            !bareKey ||
            row["sending_key_claimed_at"] === null ||
            String(row["sending_key_claimed_at"]) > shiftStored(clock(), -300000)
          )
            return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET sending_key_claimed_at=?3 WHERE organization_id=?1 AND domain_id=?2";
          params = [...values, clock()];
          break;
        case "claimKey":
          if (!active || !bareKey || row["sending_key_claimed_at"] !== null)
            return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET sending_key_claimed_at=?3 WHERE organization_id=?1 AND domain_id=?2";
          params = [...values, clock()];
          break;
        case "clearKey":
          sql =
            "UPDATE workspace_mail_domains SET sending_key_claimed_at=NULL WHERE organization_id=?1 AND domain_id=?2 AND sending_key_id IS NULL";
          params = values;
          break;
        case "saveKey":
          if (!active || !bareKey) return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET sending_key_id=?3,sending_key_ciphertext=unhex(?4),sending_key_nonce=unhex(?5),sending_key_sha256=unhex(?6),sending_key_version=?7 WHERE organization_id=?1 AND domain_id=?2";
          params = [
            ...values,
            command.keyId,
            command.ciphertext,
            command.nonce,
            command.valueSha256,
            command.keyVersion,
          ];
          break;
        case "resetCreation":
          sql =
            "UPDATE workspace_mail_domains SET provider_claimed_at=NULL WHERE organization_id=?1 AND domain_id=?2 AND provider_preflight_at IS NULL AND provider_domain_id IS NULL";
          params = values;
          break;
        case "claimCreation":
          if (!active || !empty || row["provider_claimed_at"] !== null) return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET provider_claimed_at=?3 WHERE organization_id=?1 AND domain_id=?2";
          params = [...values, clock()];
          break;
        case "releaseUnpreparedCreation":
          sql =
            "UPDATE workspace_mail_domains SET provider_claimed_at=NULL WHERE organization_id=?1 AND domain_id=?2 AND provider_preflight_at IS NULL";
          params = values;
          break;
        case "recordPreflight":
          if (!active || !empty) return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET provider_preflight_at=?3 WHERE organization_id=?1 AND domain_id=?2";
          params = [...values, clock()];
          break;
        case "clearCreation":
          sql =
            "UPDATE workspace_mail_domains SET provider_claimed_at=NULL,provider_preflight_at=NULL WHERE organization_id=?1 AND domain_id=?2 AND provider_domain_id IS NULL";
          params = values;
          break;
        case "claimVerification":
          if (
            !active ||
            (row["verify_requested_at"] !== null &&
              String(row["verify_requested_at"]) > shiftStored(clock(), -600000))
          )
            return { replay: false };
          sql =
            "UPDATE workspace_mail_domains SET verify_requested_at=?3 WHERE organization_id=?1 AND domain_id=?2";
          params = [...values, clock()];
          break;
        case "clearVerification":
          // A definite provider refusal did not start verification: the claim is released, not clocked.
          sql =
            "UPDATE workspace_mail_domains SET verify_requested_at=NULL WHERE organization_id=?1 AND domain_id=?2 AND provider_domain_id=?3";
          params = [...values, command.providerDomainId];
          break;
        case "recordFound":
          sql =
            "UPDATE workspace_mail_domains SET provider_domain_id=?3 WHERE organization_id=?1 AND domain_id=?2 AND provider_domain_id IS NULL";
          params = [...values, command.providerDomainId];
          break;
      }
      // An observation answers whether the sender is still active: a name taken by another organization retires it.
      const readBack =
        command.action === "observe"
          ? [
              db
                .prepare(
                  "SELECT status FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2",
                )
                .bind(...values),
            ]
          : [];
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${ROW}) current WHERE current.signature=?3)`,
            [...values, row.signature],
          ),
          db.prepare(sql).bind(...params),
          ...readBack,
        ],
        result: (results) =>
          command.action !== "observe" || results.at(-1)?.results[0]?.["status"] === "active",
      };
    },
  });
}
const LEGACY_INTENT_SQL =
  "SELECT json_object('provider_domain_id',d.provider_domain_id,'provider_preflight_at',d.provider_preflight_at,'sending_key_id',d.sending_key_id,'sending_key_claimed_at',d.sending_key_claimed_at) facts FROM resend_mail_domains d JOIN workspace_mail_domains w ON w.legacy_domain_id=d.domain_id WHERE w.organization_id=?1 AND w.domain_id=?2";
/**
 * A send requested longer ago than this can no longer start or be resent: a reserved one never starts and an
 * uncertain one is not resent. A later signed provider event can still settle its state, but that needs no sending
 * key, so it does not hold the domain. Only the sends newer than this hold a domain against retirement, so one stale
 * row cannot block it forever.
 */
const SEND_SETTLE_WINDOW_MS = 86_400_000;
const REFERENCES = `SELECT json_object('sending_bindings',(SELECT count(*) FROM project_mail_domain_bindings b WHERE b.mail_domain_id=w.domain_id AND b.state='active'),
 'receiving',EXISTS(SELECT 1 FROM resend_mail_domains d JOIN projects p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE d.domain_id=w.legacy_domain_id AND d.receiving AND d.deleted_at IS NULL),
 'in_flight',EXISTS(SELECT 1 FROM mail_send_requests r WHERE r.mail_domain_id=w.domain_id AND r.state IN('reserved','uncertain') AND r.requested_at>?3)) refs
 FROM workspace_mail_domains w WHERE w.organization_id=?1 AND w.domain_id=?2`;
function requireRetirable(refs: string | null) {
  if (refs === null) throw new MailScopeError();
  const value = JSON.parse(refs) as {
    sending_bindings: number;
    receiving: number;
    in_flight: number;
  };
  if (value.sending_bindings !== 0 || value.receiving || value.in_flight)
    throw new Error("mail_domain_in_use");
}
/** Exact original references and unknown-provider windows close local admission before cleanup. */
export async function beginMailWorkspaceRetirement(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      scope.extend({
        expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        now: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    values = [input.organizationId, input.domainId];
  return runCommand(db, {
    name: "mail.beginWorkspaceRetirement",
    input,
    lookup: unknownOutcome("mail.beginWorkspaceRetirement"),
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(ROW).bind(...values),
        reader.prepare(REFERENCES).bind(...values, shiftStored(input.now, -SEND_SETTLE_WINDOW_MS)),
        reader.prepare(LEGACY_INTENT_SQL).bind(...values),
      ]);
      return {
        row: rows[0]?.results[0] as Row | undefined,
        refs: rows[1]?.results[0]?.["refs"] as string | undefined,
        legacy: rows[2]?.results[0]?.["facts"] as string | undefined,
      };
    },
    decide: (snapshot) => {
      requireRetirable(snapshot.refs ?? null);
      const row = snapshot.row;
      if (!row) throw new MailScopeError();
      if (row["status"] === "active" && Number(row["revision"]) !== input.expectedRevision)
        throw new Error("mail_resource_revision_conflict");
      const intent =
        row["legacy_domain_id"] !== null
          ? snapshot.legacy === undefined
            ? undefined
            : (JSON.parse(snapshot.legacy) as Record<string, unknown>)
          : row;
      if (!intent) throw new MailScopeError();
      if (
        (intent["provider_preflight_at"] !== null &&
          !intent["provider_domain_id"] &&
          Date.parse(input.now) - Date.parse(String(intent["provider_preflight_at"])) < 120000) ||
        (intent["sending_key_claimed_at"] !== null &&
          !intent["sending_key_id"] &&
          Date.parse(input.now) - Date.parse(String(intent["sending_key_claimed_at"])) < 300000)
      )
        throw new Error("mail_operation_pending");
      const statements = [
        guard(
          db,
          "precondition_changed",
          `NOT EXISTS(SELECT 1 FROM(${ROW}) current WHERE current.signature=?3)`,
          [...values, row.signature],
        ),
        guard(db, "precondition_changed", `(SELECT refs FROM(${REFERENCES})) IS NOT ?4`, [
          ...values,
          shiftStored(input.now, -SEND_SETTLE_WINDOW_MS),
          snapshot.refs,
        ]),
      ];
      if (row["legacy_domain_id"] !== null)
        statements.push(
          guard(db, "precondition_changed", `(SELECT facts FROM(${LEGACY_INTENT_SQL})) IS NOT ?3`, [
            ...values,
            snapshot.legacy,
          ]),
        );
      statements.push(
        db
          .prepare(
            "UPDATE workspace_mail_domains SET status='retiring' WHERE organization_id=?1 AND domain_id=?2 AND status='active'",
          )
          .bind(...values),
      );
      return { statements, result: () => providerWire(row) };
    },
  });
}
export async function finishMailWorkspaceRetirement(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(scope.extend({ now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    values = [input.organizationId, input.domainId];
  await runCommand(db, {
    name: "mail.finishWorkspaceRetirement",
    input,
    lookup: unknownOutcome("mail.finishWorkspaceRetirement"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(REFERENCES)
        .bind(...values, shiftStored(input.now, -SEND_SETTLE_WINDOW_MS))
        .first<{ refs: string }>(),
    decide: (row) => {
      requireRetirable(row?.refs ?? null);
      return {
        statements: [
          guard(db, "precondition_changed", `(SELECT refs FROM(${REFERENCES})) IS NOT ?4`, [
            ...values,
            shiftStored(input.now, -SEND_SETTLE_WINDOW_MS),
            row?.refs,
          ]),
          db
            .prepare(
              "UPDATE workspace_mail_domains SET status='retired',revision=revision+1,retired_at=?3,sending_status='disabled',receiving_status='disabled',dns_receipts=CASE WHEN json_type(dns_receipts,'$.records') IS NOT NULL THEN '{\"released\": '||dns_receipts||'}' ELSE dns_receipts END WHERE organization_id=?1 AND domain_id=?2 AND status<>'retired'",
            )
            .bind(...values, input.now),
        ],
        result: () => undefined,
      };
    },
  });
}
