import { z } from "zod";
import {
  classifyCustomerMailDomain,
  classifyApplicationMailIdentity,
  validateMailSenderSettings,
} from "@ohmyhost/platform";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { publicTimestamp, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { mailHash, mailInput, mailTime, MailScopeError } from "./auth.js";
import { RESERVATION_MS, requireMailOrganizationPaid } from "./management.js";
import { unknownOutcome } from "../unknown-outcome.js";
import { shiftStored } from "../../timestamps.js";

/**
 * Customer admission of the shared-mail resources: workspace senders, their command receipts and the project
 * bindings. The provider phases of a sender stay with Mail; these commands only decide and record, in one batch
 * each, what the original control-api decided in one transaction.
 */
const command = z.strictObject({
  organizationId: ulid,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  principalId: z.string().min(1).max(256),
  requestSha256: mailHash,
  now: mailTime,
});
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** A project binding starts at revision 0: none yet. */
const bindingRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const projectScope = z.strictObject({ projectId: ulid, environmentId: ulid });
const settings = z.strictObject({
  sending: z.boolean(),
  senderAddresses: z.array(z.string()).max(64),
  defaultFrom: z.string(),
  defaultReplyTo: z.string().nullable(),
});

interface Prior {
  domain_id: string;
  operation: string;
  principal_id: string;
  request_sha256: string;
  response: string | null;
}
const PRIOR =
  "SELECT domain_id,operation,principal_id,lower(hex(request_sha256)) request_sha256,response FROM workspace_mail_commands WHERE organization_id=?1 AND idempotency_key=?2";
const parsed = (value: string | null): unknown => (value === null ? null : JSON.parse(value));
/** The receipt of an earlier identical request, or null; a key owned by another request is refused. */
function earlier(
  row: Prior | null | undefined,
  input: z.output<typeof command>,
  operation: string,
): Prior | null {
  if (!row) return null;
  if (
    row.operation !== operation ||
    row.principal_id !== input.principalId ||
    row.request_sha256 !== input.requestSha256
  )
    throw new Error("idempotency_key_reused");
  return row;
}
const readPrior = (db: D1Database, input: z.output<typeof command>) =>
  db.prepare(PRIOR).bind(input.organizationId, input.idempotencyKey).first<Prior>();
const record = (
  db: D1Database,
  input: z.output<typeof command>,
  operation: string,
  domainId: string,
  response: unknown,
) =>
  db
    .prepare(
      "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,response,created_at,completed_at)VALUES(?1,?2,?3,?4,?5,unhex(?6),?7,?8,?9)",
    )
    .bind(
      input.organizationId,
      input.idempotencyKey,
      domainId,
      operation,
      input.principalId,
      input.requestSha256,
      response === null ? null : JSON.stringify(response),
      input.now,
      response === null ? null : input.now,
    );

/**
 * Unverified workspace senders one organization may hold at once: live senders created here (no legacy
 * project domain behind them: the status of a mirrored legacy row is kept in `resend_mail_domains`, not in
 * this table) whose sending is not ready. An owner-adjustable product default, not a provider limit; it stops
 * a Paid organization from reserving unlimited names on the platform's shared provider account.
 */
const PENDING_MAIL_DOMAIN_LIMIT = 5;
const PENDING_COUNT = `(SELECT count(*) FROM workspace_mail_domains WHERE organization_id=?1 AND legacy_domain_id IS NULL AND status<>'retired' AND sending_status<>'ready')`;
/**
 * A sender name is held for every organization only once its domain is provider verified (`sending_status` ready) or
 * it is a legacy mirror; before that, a reservation holds it for seven days (?2 is the start of that window) and frees it.
 */
const NAME_TAKEN = `EXISTS(SELECT 1 FROM workspace_mail_domains WHERE domain=?1 AND status<>'retired' AND(sending_status='ready' OR legacy_domain_id IS NOT NULL OR configured_at>?2))
 OR EXISTS(SELECT 1 FROM workspace_mail_domains WHERE domain=?1 AND reputation_state='suspended')
 OR EXISTS(SELECT 1 FROM resend_mail_domains d WHERE d.domain=?1 AND(d.deleted_at IS NULL OR(
   EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id)
   AND NOT EXISTS(SELECT 1 FROM resend_mail_commands c WHERE c.domain_id=d.domain_id AND c.response IS NOT NULL))))`;
/** Registers a workspace sender for the organization and opens its create receipt; the provider call follows. */
export async function createSharedMailDomain(context: CatalogContext, raw: unknown) {
  const input = mailInput(command.extend({ domainId: ulid, domain: z.string() }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    domain = classifyCustomerMailDomain(input.domain),
    name = "mail.shared.createDomain",
    first = earlier(await readPrior(db, input), input, "create"),
    reservationSince = shiftStored(input.now, -RESERVATION_MS);
  if (first) return { domainId: first.domain_id, response: parsed(first.response) };
  await requireMailOrganizationPaid(context, {
    organizationId: input.organizationId,
    now: publicTimestamp(input.now),
  });
  return runCommand(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["workspace_mail_commands"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(PRIOR).bind(input.organizationId, input.idempotencyKey),
        reader.prepare(`SELECT ${NAME_TAKEN} taken`).bind(domain.hostname, reservationSince),
        reader.prepare(`SELECT ${PENDING_COUNT} pending`).bind(input.organizationId),
      ]);
      return {
        prior: (rows[0]?.results[0] as Prior | undefined) ?? null,
        taken: rows[1]?.results[0]?.["taken"] === 1,
        pending: Number(rows[2]?.results[0]?.["pending"]),
      };
    },
    decide: (snapshot) => {
      const prior = earlier(snapshot.prior, input, "create");
      if (prior) return { replay: { domainId: prior.domain_id, response: parsed(prior.response) } };
      if (snapshot.taken) return { reject: new Error("mail_domain_conflict") };
      if (snapshot.pending >= PENDING_MAIL_DOMAIN_LIMIT)
        return { reject: new Error("mail_domain_pending_limit") };
      return {
        statements: [
          guard(db, "precondition_changed", `(SELECT ${NAME_TAKEN})`, [
            domain.hostname,
            reservationSince,
          ]),
          guard(db, "precondition_changed", `${PENDING_COUNT} >= ${PENDING_MAIL_DOMAIN_LIMIT}`, [
            input.organizationId,
          ]),
          db
            .prepare(
              "INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,registrable_domain,custody_organization_id,custody_project_id,custody_environment_id,configured_at)VALUES(?1,?2,?3,?4,?2,?1,?1,?5)",
            )
            .bind(
              input.domainId,
              input.organizationId,
              domain.hostname,
              domain.registrableDomain,
              input.now,
            ),
          record(db, input, "create", input.domainId, null),
        ],
        result: () => ({ domainId: input.domainId, response: null as unknown }),
      };
    },
  });
}

/** Opens the retire receipt of a workspace sender at its expected revision; the provider cleanup follows. */
export async function beginSharedMailRetire(context: CatalogContext, raw: unknown) {
  const input = mailInput(command.extend({ domainId: ulid, expectedRevision: revision }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.shared.beginRetire",
    SQL =
      "SELECT CAST(revision AS TEXT) revision FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2";
  return runCommand(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["workspace_mail_commands"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(PRIOR).bind(input.organizationId, input.idempotencyKey),
        reader.prepare(SQL).bind(input.organizationId, input.domainId),
      ]);
      return {
        prior: (rows[0]?.results[0] as Prior | undefined) ?? null,
        revision: rows[1]?.results[0]?.["revision"] as string | undefined,
      };
    },
    decide: (snapshot) => {
      const prior = earlier(snapshot.prior, input, "retire");
      if (prior) return { replay: { response: parsed(prior.response) } };
      if (snapshot.revision === undefined) return { reject: new MailScopeError() };
      if (Number(snapshot.revision) !== input.expectedRevision)
        return { reject: new Error("mail_resource_revision_conflict") };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2 AND revision=?3)",
            [input.organizationId, input.domainId, input.expectedRevision],
          ),
          record(db, input, "retire", input.domainId, null),
        ],
        result: () => ({ response: null as unknown }),
      };
    },
  });
}

/** Stores the provider's answer on the receipt once; the first stored answer wins and is returned. */
export async function completeSharedMailCommand(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      z.strictObject({
        organizationId: ulid,
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
        response: z.custom<unknown>((value) => value !== undefined && value !== null),
        now: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.shared.completeCommand",
    keys = [input.organizationId, input.idempotencyKey];
  return runCommand(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(
          "SELECT response FROM workspace_mail_commands WHERE organization_id=?1 AND idempotency_key=?2",
        )
        .bind(...keys)
        .first<{ response: string | null }>(),
    decide: (row) => {
      if (row === null) return { reject: new Error("mail_operation_pending") };
      if (row.response !== null) return { replay: parsed(row.response) };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM workspace_mail_commands WHERE organization_id=?1 AND idempotency_key=?2 AND response IS NOT NULL)",
            keys,
          ),
          db
            .prepare(
              "UPDATE workspace_mail_commands SET response=?3,completed_at=?4 WHERE organization_id=?1 AND idempotency_key=?2 AND response IS NULL",
            )
            .bind(...keys, JSON.stringify(input.response), input.now),
        ],
        result: () => input.response,
      };
    },
  });
}

const BINDING_SQL = `SELECT b.mail_domain_id,b.organization_id,b.project_id,b.environment_id,CAST(b.revision AS TEXT) revision,
 b.sending,b.legacy,b.sender_addresses,b.default_from,b.default_reply_to,b.state,b.application_identity_revision,
 i.hostname,i.registrable_domain,CAST(i.revision AS TEXT) identity_revision,i.state identity_state,i.expires_at,w.status domain_status
 FROM project_mail_domain_bindings b
 JOIN projects p ON p.organization_id=b.organization_id AND p.project_id=b.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 JOIN workspace_mail_domains w ON w.domain_id=b.mail_domain_id AND w.organization_id=b.organization_id
 LEFT JOIN project_application_domain_identities i ON i.project_id=b.project_id AND i.organization_id=b.organization_id
 WHERE b.organization_id=?1 AND b.project_id=?2 AND b.environment_id=?3`;
type BindingRow = Record<string, unknown>;
/** The original binding view; an active binding whose proof or sender domain lapsed reads as suspended. */
function bindingView(row: BindingRow, now: string) {
  const at = Date.parse(now),
    legacy = Number(row["legacy"]) === 1,
    identityState = row["identity_state"] as string | null,
    expiresAt = row["expires_at"] === null ? null : Date.parse(String(row["expires_at"])),
    proofCurrent =
      legacy ||
      (identityState === "verified" &&
        Number(row["identity_revision"]) === Number(row["application_identity_revision"]) &&
        expiresAt !== null &&
        expiresAt > at),
    state = String(row["state"]);
  return {
    mail_domain_id: String(row["mail_domain_id"]),
    organization_id: String(row["organization_id"]),
    project_id: String(row["project_id"]),
    environment_id: String(row["environment_id"]),
    revision: Number(row["revision"]),
    sending: Number(row["sending"]) === 1,
    legacy,
    sender_addresses: JSON.parse(String(row["sender_addresses"])) as string[],
    default_from: row["default_from"] as string | null,
    default_reply_to: row["default_reply_to"] as string | null,
    status:
      state === "active" && (!proofCurrent || row["domain_status"] !== "active")
        ? "suspended"
        : state,
    application_domain_identity:
      row["hostname"] === null
        ? null
        : {
            hostname: String(row["hostname"]),
            registrable_domain: String(row["registrable_domain"]),
            revision: Number(row["identity_revision"]),
            status:
              identityState !== "revoked" && expiresAt !== null && expiresAt <= at
                ? "expired"
                : identityState,
          },
  };
}
/** The project's shared sender binding, or null when it has none in this scope. */
export async function readSharedMailBinding(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      z.strictObject({
        organizationId: ulid,
        ...projectScope.shape,
        now: z.string().refine((value) => Number.isFinite(Date.parse(value))),
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(BINDING_SQL)
      .bind(input.organizationId, input.projectId, input.environmentId)
      .first<BindingRow>();
  return row === null ? null : bindingView(row, input.now);
}

const SENDING_READY = `CASE WHEN COALESCE(d.sending_status,w.sending_status)='ready' AND COALESCE(d.sending_key_id,w.sending_key_id) IS NULL THEN 'pending' ELSE COALESCE(d.sending_status,w.sending_status) END`;
const PROJECT_ACTIVE =
  "SELECT 1 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3 AND e.name='prod' AND p.owner_state='active' AND p.lifecycle_state='active'";
/** Binds the project to a ready workspace sender behind a verified same-domain application proof. */
export async function bindSharedMailProject(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      command
        .extend(projectScope.shape)
        .extend(settings.shape)
        .extend({ domainId: ulid, expectedRevision: bindingRevision.optional() }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.shared.bindProject",
    first = earlier(await readPrior(db, input), input, "bind");
  if (first) return parsed(first.response);
  await requireMailOrganizationPaid(context, {
    organizationId: input.organizationId,
    now: publicTimestamp(input.now),
  });
  const scope = [input.organizationId, input.projectId, input.environmentId] as const;
  return runCommand(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["workspace_mail_commands"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(PRIOR).bind(input.organizationId, input.idempotencyKey),
        reader.prepare(PROJECT_ACTIVE).bind(...scope),
        reader.prepare(
          "SELECT 1 ok FROM shared_mail_capabilities WHERE capability='same-domain-sharing-v1' AND enabled",
        ),
        reader
          .prepare(
            `SELECT w.domain,w.registrable_domain,w.status,${SENDING_READY} sending FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id WHERE w.organization_id=?1 AND w.domain_id=?2`,
          )
          .bind(input.organizationId, input.domainId),
        reader
          .prepare(
            "SELECT hostname,registrable_domain,CAST(revision AS TEXT) revision,state,expires_at FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(input.organizationId, input.projectId),
        reader
          .prepare(
            "SELECT organization_id,CAST(revision AS TEXT) revision FROM project_mail_domain_bindings WHERE project_id=?1",
          )
          .bind(input.projectId),
      ]);
      return {
        prior: (rows[0]?.results[0] as Prior | undefined) ?? null,
        active: (rows[1]?.results.length ?? 0) === 1,
        sharing: (rows[2]?.results.length ?? 0) === 1,
        domain: rows[3]?.results[0] as Record<string, string> | undefined,
        proof: rows[4]?.results[0] as Record<string, string> | undefined,
        binding: rows[5]?.results[0] as Record<string, string> | undefined,
      };
    },
    decide: (snapshot) => {
      const prior = earlier(snapshot.prior, input, "bind");
      if (prior) return { replay: parsed(prior.response) };
      if (!snapshot.sharing) return { reject: new Error("mail_sharing_unavailable") };
      const domain = snapshot.domain;
      if (!domain || !snapshot.active) return { reject: new MailScopeError() };
      let registrable: string;
      try {
        registrable = classifyCustomerMailDomain(domain["domain"] ?? "").registrableDomain;
        if (snapshot.proof) classifyApplicationMailIdentity(snapshot.proof["hostname"] ?? "");
      } catch {
        return { reject: new MailScopeError() };
      }
      const sender = validateMailSenderSettings({
          domain: domain["domain"] ?? "",
          senderAddresses: input.senderAddresses,
          defaultFrom: input.defaultFrom,
          defaultReplyTo: input.defaultReplyTo,
        }),
        proof = snapshot.proof;
      if (
        domain["sending"] !== "ready" ||
        !proof ||
        proof["state"] !== "verified" ||
        Date.parse(String(proof["expires_at"])) <= Date.parse(input.now) ||
        proof["registrable_domain"] !== registrable ||
        domain["status"] !== "active"
      )
        return { reject: new Error("mail_domain_mismatch") };
      const current =
        snapshot.binding?.["organization_id"] === input.organizationId
          ? Number(snapshot.binding["revision"])
          : 0;
      if (input.expectedRevision !== undefined && current !== input.expectedRevision)
        return { reject: new Error("mail_binding_revision_conflict") };
      const identityRevision = Number(proof["revision"]),
        view = bindingView(
          {
            mail_domain_id: input.domainId,
            organization_id: input.organizationId,
            project_id: input.projectId,
            environment_id: input.environmentId,
            revision: String(current + 1),
            sending: input.sending ? 1 : 0,
            legacy: 0,
            sender_addresses: JSON.stringify(sender.senderAddresses),
            default_from: sender.defaultFrom,
            default_reply_to: sender.defaultReplyTo,
            state: "active",
            application_identity_revision: identityRevision,
            hostname: proof["hostname"],
            registrable_domain: proof["registrable_domain"],
            identity_revision: proof["revision"],
            identity_state: "verified",
            expires_at: proof["expires_at"],
            domain_status: "active",
          },
          input.now,
        );
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "COALESCE((SELECT CASE WHEN organization_id=?1 THEN revision ELSE 0 END FROM project_mail_domain_bindings WHERE project_id=?2),0)<>?3",
            [input.organizationId, input.projectId, current],
          ),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?2 AND revision=?3 AND state='verified')",
            [input.organizationId, input.projectId, identityRevision],
          ),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM workspace_mail_domains w LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id WHERE w.organization_id=?1 AND w.domain_id=?2 AND w.status='active' AND ${SENDING_READY}='ready')`,
            [input.organizationId, input.domainId],
          ),
          db
            .prepare(
              "UPDATE workspace_mail_domains SET registrable_domain=?3 WHERE organization_id=?1 AND domain_id=?2 AND registrable_domain IS NULL",
            )
            .bind(input.organizationId, input.domainId, registrable),
          db
            .prepare(
              `INSERT INTO project_mail_domain_bindings(organization_id,project_id,environment_id,mail_domain_id,revision,state,sending,legacy,sender_addresses,default_from,default_reply_to,application_identity_revision,configured_at,updated_at)
 VALUES(?1,?2,?3,?4,1,'active',?5,0,?6,?7,?8,?9,?10,?10) ON CONFLICT(project_id) DO UPDATE SET organization_id=excluded.organization_id,environment_id=excluded.environment_id,mail_domain_id=excluded.mail_domain_id,revision=project_mail_domain_bindings.revision+1,state='active',sending=excluded.sending,legacy=0,sender_addresses=excluded.sender_addresses,default_from=excluded.default_from,default_reply_to=excluded.default_reply_to,application_identity_revision=excluded.application_identity_revision,updated_at=excluded.updated_at`,
            )
            .bind(
              ...scope,
              input.domainId,
              input.sending ? 1 : 0,
              JSON.stringify(sender.senderAddresses),
              sender.defaultFrom,
              sender.defaultReplyTo,
              identityRevision,
              input.now,
            ),
          record(db, input, "bind", input.domainId, view),
        ],
        result: () => view as unknown,
      };
    },
  });
}

/** Detaches the project's sender binding at its expected revision; sending stops, the sender stays. */
export async function detachSharedMailProject(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      command.extend(projectScope.shape).extend({ expectedRevision: bindingRevision.optional() }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.shared.detachProject",
    scope = [input.organizationId, input.projectId, input.environmentId] as const;
  return runCommand(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["workspace_mail_commands"],
    read: async (reader) => {
      const rows = await reader.batch([
        reader.prepare(PRIOR).bind(input.organizationId, input.idempotencyKey),
        reader.prepare(BINDING_SQL).bind(...scope),
      ]);
      return {
        prior: (rows[0]?.results[0] as Prior | undefined) ?? null,
        binding: rows[1]?.results[0] as BindingRow | undefined,
      };
    },
    decide: (snapshot) => {
      const prior = earlier(snapshot.prior, input, "detach");
      if (prior) return { replay: parsed(prior.response) };
      const binding = snapshot.binding;
      if (
        !binding ||
        (input.expectedRevision !== undefined &&
          Number(binding["revision"]) !== input.expectedRevision)
      )
        return { reject: new Error("mail_binding_revision_conflict") };
      const view = bindingView(
        {
          ...binding,
          state: "detached",
          sending: 0,
          revision: String(Number(binding["revision"]) + 1),
        },
        input.now,
      );
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_mail_domain_bindings WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND revision=?4)",
            [...scope, Number(binding["revision"])],
          ),
          db
            .prepare(
              "UPDATE project_mail_domain_bindings SET state='detached',sending=0,revision=revision+1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
            )
            .bind(...scope, input.now),
          record(db, input, "detach", String(binding["mail_domain_id"]), view),
        ],
        result: () => view as unknown,
      };
    },
  });
}

const expiredInput = z.strictObject({ cutoff: mailTime, limit: z.number().int().min(1).max(50) });
/**
 * Workspace senders that are not verified for sending, were created here (no legacy project domain behind them) and
 * were configured before the cutoff. The caller retires each one through the provider path, which frees its name.
 */
export async function listExpiredUnverifiedSharedMailDomains(
  context: CatalogContext,
  raw: unknown,
) {
  const input = mailInput(expiredInput, raw),
    { db } = await context.router.routeShard(0),
    rows = await db
      .prepare(
        `SELECT organization_id,domain_id,CAST(revision AS TEXT) revision FROM workspace_mail_domains
         WHERE legacy_domain_id IS NULL AND sending_status<>'ready' AND status IN('active','retiring') AND configured_at<=?1
         ORDER BY configured_at,domain_id LIMIT ?2`,
      )
      .bind(input.cutoff, input.limit)
      .all<{ organization_id: string; domain_id: string; revision: string }>();
  return rows.results.map((row) => ({
    organizationId: row.organization_id,
    domainId: row.domain_id,
    expectedRevision: Number(row.revision),
  }));
}
