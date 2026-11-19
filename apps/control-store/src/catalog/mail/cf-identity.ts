import { z } from "zod";
import { classifyApplicationMailIdentity, classifyCustomerMailDomain } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { publicTimestamp, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { mailInput, mailHash, mailTime, MailScopeError } from "./auth.js";
import {
  cfActor,
  cfDelegation,
  cfAuthorityCondition,
  cfAuthorityGuard,
  type CfAuthority,
} from "./cf-authority.js";
import { mailMetadataJsonb } from "./metadata-jsonb.js";
import { shiftStored } from "../../timestamps.js";
import { unknownOutcome } from "../unknown-outcome.js";

const requestScope = z.strictObject({ organizationId: ulid, projectId: ulid, actorId: cfActor }),
  mutation = requestScope.extend({
    idempotencyKeySha256: mailHash,
    requestSha256: mailHash,
    delegation: cfDelegation.nullable(),
  }),
  OWNED =
    "SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'",
  ROW =
    "SELECT *,CAST(revision AS TEXT) revision,lower(hex(idempotency_key_sha256)) key_hash,lower(hex(request_sha256)) request_hash FROM project_application_domain_identities WHERE project_id=?2",
  WEBSITE =
    "SELECT hostname FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state IN('awaiting_deployment','pending','active') ORDER BY hostname";
type IdentityRow = Record<string, unknown> & {
  project_id: string;
  organization_id: string;
  hostname: string;
  registrable_domain: string;
  revision: string;
  state: string;
  challenge_name: string;
  challenge_value: string;
  declared_at: string;
  verified_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  key_hash: string;
  request_hash: string;
};
const authority = (input: z.output<typeof mutation>): CfAuthority => ({
  organizationId: input.organizationId,
  purpose: "application_identity",
  resourceId: input.projectId,
  principalId: input.actorId,
  delegation: input.delegation,
});
function identity(row: IdentityRow) {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    hostname: row.hostname,
    registrableDomain: row.registrable_domain,
    revision: Number(row.revision),
    state: row.state,
    challengeName: row.challenge_name,
    challengeValue: row.challenge_value,
    declaredAt: publicTimestamp(row.declared_at),
    verifiedAt: row.verified_at === null ? null : publicTimestamp(row.verified_at),
    expiresAt: publicTimestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : publicTimestamp(row.revoked_at),
  };
}
function view(row: IdentityRow, now: string) {
  return {
    organization_id: row.organization_id,
    project_id: row.project_id,
    hostname: row.hostname,
    registrable_domain: row.registrable_domain,
    status:
      row.state !== "revoked" && Date.parse(row.expires_at) <= Date.parse(now)
        ? "expired"
        : row.state,
    revision: Number(row.revision),
    challenge: { type: "TXT" as const, name: row.challenge_name, value: row.challenge_value },
    verified_at: row.verified_at === null ? null : publicTimestamp(row.verified_at),
    expires_at: publicTimestamp(row.expires_at),
  };
}
export async function readCfApplicationIdentity(context: CatalogContext, raw: unknown) {
  const input = mailInput(requestScope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(`${ROW} AND organization_id=?1 AND EXISTS(${OWNED})`)
      .bind(input.organizationId, input.projectId)
      .first<IdentityRow>();
  return row === null ? null : identity(row);
}
/** Original declaration with authority/website/current scope, immutable receipt replay and sender suspension in one batch. */
export async function declareCfApplicationIdentity(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      mutation.extend({
        hostname: z.string(),
        registrableDomain: z.string(),
        challengeValue: z.string().regex(/^omh-domain-v1=[A-Za-z0-9_-]{43}$/u),
        declaredAt: mailTime,
        expiresAt: mailTime,
      }),
      raw,
    ),
    classified = classifyApplicationMailIdentity(input.hostname),
    { db } = await routeOrganization(context, input.organizationId),
    auth = authority(input),
    condition = cfAuthorityCondition(auth),
    values = [input.organizationId, input.projectId],
    receipt =
      "SELECT lower(hex(request_sha256)) request_hash,response FROM project_application_identity_commands WHERE organization_id=?1 AND project_id=?2 AND idempotency_key_sha256=unhex(?3)";
  if (
    classified.hostname.length > 240 ||
    classified.registrableDomain !== input.registrableDomain ||
    Date.parse(input.expiresAt) <= Date.parse(input.declaredAt) ||
    Date.parse(input.expiresAt) - Date.parse(input.declaredAt) > 86400000
  )
    throw new TypeError("Invalid application identity proof");
  return runCommand(db, {
    name: "cf.declareApplicationIdentity",
    input,
    lookup: unknownOutcome("cf.declareApplicationIdentity"),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_application_identity_commands"],
    read: async (r) => {
      const rows = await r.batch([
        r.prepare(`SELECT 1 WHERE ${condition.sql}`).bind(...condition.params),
        r.prepare(receipt).bind(...values, input.idempotencyKeySha256),
        r.prepare(ROW).bind(...values),
        r.prepare(WEBSITE).bind(...values),
        r.prepare(OWNED).bind(...values),
      ]);
      return {
        allowed: rows[0]?.results.length === 1,
        receipt: rows[1]?.results[0] as { request_hash: string; response: string } | undefined,
        old: rows[2]?.results[0] as IdentityRow | undefined,
        websites: rows[3]?.results ?? [],
        owned: rows[4]?.results.length === 1,
      };
    },
    decide: (snapshot) => {
      if (!snapshot.allowed) throw new Error("dns_authority_revoked");
      if (!snapshot.owned) throw new MailScopeError();
      if (snapshot.receipt) {
        if (snapshot.receipt.request_hash !== input.requestSha256)
          throw new Error("idempotency_conflict");
        return { replay: JSON.parse(snapshot.receipt.response) as Record<string, unknown> };
      }
      const old = snapshot.old;
      if (
        old?.organization_id === input.organizationId &&
        old.key_hash === input.idempotencyKeySha256
      ) {
        if (old.request_hash !== input.requestSha256) throw new Error("idempotency_conflict");
        return { replay: identity(old) };
      }
      const revision = old === undefined ? "1" : (BigInt(old.revision) + 1n).toString(),
        result = {
          organizationId: input.organizationId,
          projectId: input.projectId,
          hostname: classified.hostname,
          registrableDomain: classified.registrableDomain,
          revision: Number(revision),
          state: "pending",
          challengeName: `_omh-project.${classified.hostname}`,
          challengeValue: input.challengeValue,
          declaredAt: publicTimestamp(input.declaredAt),
          verifiedAt: null,
          expiresAt: publicTimestamp(input.expiresAt),
          revokedAt: null,
        };
      return {
        statements: [
          cfAuthorityGuard(db, auth),
          guard(db, "precondition_changed", `NOT EXISTS(${OWNED})`, values),
          guard(
            db,
            "precondition_changed",
            `(SELECT json_group_array(hostname) FROM(${WEBSITE})) IS NOT ?3`,
            [...values, JSON.stringify(snapshot.websites.map((row) => String(row["hostname"])))],
          ),
          guard(
            db,
            "precondition_changed",
            "(SELECT revision FROM project_application_domain_identities WHERE project_id=?2) IS NOT CAST(?3 AS INTEGER)",
            [...values, old?.revision ?? null],
          ),
          db
            .prepare(
              "INSERT INTO project_application_domain_identities(organization_id,project_id,hostname,registrable_domain,revision,state,challenge_name,challenge_value,declared_at,expires_at,idempotency_key_sha256,request_sha256,actor_id)VALUES(?1,?2,?3,?4,CAST(?5 AS INTEGER),'pending',?6,?7,?8,?9,unhex(?10),unhex(?11),?12) ON CONFLICT(project_id) DO UPDATE SET organization_id=excluded.organization_id,hostname=excluded.hostname,registrable_domain=excluded.registrable_domain,revision=project_application_domain_identities.revision+1,state='pending',challenge_name=excluded.challenge_name,challenge_value=excluded.challenge_value,declared_at=excluded.declared_at,verified_at=NULL,expires_at=excluded.expires_at,revoked_at=NULL,idempotency_key_sha256=excluded.idempotency_key_sha256,request_sha256=excluded.request_sha256,actor_id=excluded.actor_id",
            )
            .bind(
              ...values,
              classified.hostname,
              classified.registrableDomain,
              revision,
              result.challengeName,
              input.challengeValue,
              input.declaredAt,
              input.expiresAt,
              input.idempotencyKeySha256,
              input.requestSha256,
              input.actorId,
            ),
          db
            .prepare(
              "UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=?2 WHERE project_id=?1 AND NOT legacy AND state='active'",
            )
            .bind(input.projectId, input.declaredAt),
          db
            .prepare(
              "INSERT INTO project_application_identity_commands(organization_id,project_id,idempotency_key_sha256,request_sha256,response)VALUES(?1,?2,unhex(?3),unhex(?4),?5)",
            )
            .bind(
              ...values,
              input.idempotencyKeySha256,
              input.requestSha256,
              mailMetadataJsonb(result),
            ),
        ],
        result: () => result,
      };
    },
  });
}
const ACTION_ROW =
  "SELECT lower(hex(request_sha256)) request_hash,response FROM project_application_identity_action_commands WHERE organization_id=?1 AND project_id=?2 AND actor_id=?3 AND action=?4 AND idempotency_key_sha256=unhex(?5)";
export async function replayCfApplicationIdentityAction(context: CatalogContext, raw: unknown) {
  const input = mailInput(mutation.extend({ action: z.enum(["verify", "revoke"]) }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    condition = cfAuthorityCondition(authority(input)),
    rows = await db.batch([
      db.prepare(`SELECT 1 WHERE ${condition.sql}`).bind(...condition.params),
      db.prepare(OWNED).bind(input.organizationId, input.projectId),
      db
        .prepare(ACTION_ROW)
        .bind(
          input.organizationId,
          input.projectId,
          input.actorId,
          input.action,
          input.idempotencyKeySha256,
        ),
    ]);
  if (rows[0]?.results.length !== 1) throw new Error("dns_authority_revoked");
  if (rows[1]?.results.length !== 1) throw new MailScopeError();
  const receipt = rows[2]?.results[0];
  if (!receipt) return null;
  if (receipt["request_hash"] !== input.requestSha256) throw new Error("idempotency_conflict");
  return JSON.parse(String(receipt["response"])) as Record<string, unknown>;
}
export async function readCfApplicationIdentityForVerification(
  context: CatalogContext,
  raw: unknown,
) {
  const input = mailInput(requestScope, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(`${ROW} AND organization_id=?1 AND EXISTS(${OWNED})`)
      .bind(input.organizationId, input.projectId)
      .first<IdentityRow>();
  if (!row) return null;
  classifyApplicationMailIdentity(row.hostname);
  return identity(row);
}
/** The observed TXT challenge is local to CF; only its exact current version may complete an authorized proof+receipt. */
export async function completeCfApplicationIdentityAction(context: CatalogContext, raw: unknown) {
  const input = mailInput(
      mutation.extend({
        action: z.enum(["verify", "revoke"]),
        revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        challengeValue: z.string().optional(),
        now: mailTime,
        expiresAt: mailTime.optional(),
        viewAt: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    auth = authority(input),
    condition = cfAuthorityCondition(auth),
    values = [input.organizationId, input.projectId],
    actionValues = [...values, input.actorId, input.action, input.idempotencyKeySha256];
  if (
    input.action === "verify" &&
    (input.challengeValue === undefined ||
      input.expiresAt === undefined ||
      Date.parse(input.expiresAt) <= Date.parse(input.now) ||
      Date.parse(input.expiresAt) - Date.parse(input.now) > 30 * 86400000)
  )
    throw new TypeError("Invalid application identity proof validity");
  return runCommand(db, {
    name: `cf.${input.action}ApplicationIdentity`,
    input,
    lookup: unknownOutcome(`cf.${input.action}ApplicationIdentity`),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_application_identity_action_commands"],
    read: async (r) => {
      const rows = await r.batch([
        r.prepare(`SELECT 1 WHERE ${condition.sql}`).bind(...condition.params),
        r.prepare(OWNED).bind(...values),
        r.prepare(ACTION_ROW).bind(...actionValues),
        r.prepare(ROW).bind(...values),
      ]);
      return {
        allowed: rows[0]?.results.length === 1,
        owned: rows[1]?.results.length === 1,
        receipt: rows[2]?.results[0],
        row: rows[3]?.results[0] as IdentityRow | undefined,
      };
    },
    decide: (snapshot) => {
      if (!snapshot.allowed) throw new Error("dns_authority_revoked");
      if (!snapshot.owned) throw new MailScopeError();
      if (snapshot.receipt) {
        if (snapshot.receipt["request_hash"] !== input.requestSha256)
          throw new Error("idempotency_conflict");
        return {
          replay: JSON.parse(String(snapshot.receipt["response"])) as Record<string, unknown>,
        };
      }
      const row = snapshot.row;
      if (row && input.action === "verify") classifyApplicationMailIdentity(row.hostname);
      if (
        !row ||
        row.organization_id !== input.organizationId ||
        Number(row.revision) !== input.revision ||
        (input.action === "verify" &&
          (row.state === "revoked" ||
            row.challenge_value !== input.challengeValue ||
            (row.state !== "verified" && row.expires_at <= input.now)))
      )
        return { replay: null };
      const next = {
          ...row,
          state: input.action === "verify" ? "verified" : "revoked",
          verified_at: input.action === "verify" ? input.now : row.verified_at,
          expires_at:
            input.action === "verify" ? (input.expiresAt ?? row.expires_at) : row.expires_at,
          revoked_at: input.action === "revoke" ? input.now : row.revoked_at,
        },
        response = view(next, input.viewAt),
        statements = [
          cfAuthorityGuard(db, auth),
          guard(db, "precondition_changed", `NOT EXISTS(${OWNED})`, values),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?2 AND revision=CAST(?3 AS INTEGER) AND state=?4 AND challenge_value=?5 AND expires_at=?6)",
            [...values, row.revision, row.state, row.challenge_value, row.expires_at],
          ),
          db
            .prepare(
              "UPDATE project_application_domain_identities SET state=?3,verified_at=?4,expires_at=?5,revoked_at=?6 WHERE organization_id=?1 AND project_id=?2",
            )
            .bind(...values, next.state, next.verified_at, next.expires_at, next.revoked_at),
        ];
      if (input.action === "revoke")
        statements.push(
          db
            .prepare(
              "UPDATE project_mail_domain_bindings SET state='suspended',sending=0,revision=revision+1,updated_at=?3 WHERE organization_id=?1 AND project_id=?2 AND NOT legacy AND state='active'",
            )
            .bind(...values, input.now),
          // The identity's scoped DNS consent ends with it, in the same batch. The Cloudflare token itself is revoked
          // upstream by the domain-management sweep; these rows only stop the grant being usable or inspectable.
          db
            .prepare(
              "UPDATE scoped_customer_dns_authorizations SET revoked_at=?3 WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2 AND revoked_at IS NULL",
            )
            .bind(...values, input.now),
          db
            .prepare(
              "UPDATE scoped_customer_dns_grants SET revoked_at=?3 WHERE organization_id=?1 AND purpose='application_identity' AND resource_id=?2 AND revoked_at IS NULL",
            )
            .bind(...values, input.now),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO project_application_identity_action_commands(organization_id,project_id,actor_id,action,idempotency_key_sha256,request_sha256,response)VALUES(?1,?2,?3,?4,unhex(?5),unhex(?6),?7)",
          )
          .bind(...actionValues, input.requestSha256, mailMetadataJsonb(response)),
      );
      return { statements, result: () => response };
    },
  });
}

const AUTOMATIC_SCOPE = z.strictObject({
    organizationId: ulid,
    projectId: ulid,
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    now: mailTime,
  }),
  AUTOMATIC = `SELECT i.hostname,i.registrable_domain,CAST(i.revision AS TEXT) revision,i.challenge_name,i.challenge_value,i.verified_at,i.expires_at,
 p.ownership_version,p.active_billing_epoch_id,p.lifecycle_version,CAST(b.revision AS TEXT) binding_revision,b.mail_domain_id,b.environment_id,
 CAST(w.revision AS TEXT) resource_revision,w.domain resource_domain,
 json_array(i.hostname,i.registrable_domain,CAST(i.revision AS TEXT),i.challenge_name,i.challenge_value,i.verified_at,i.expires_at,p.ownership_version,p.active_billing_epoch_id,p.lifecycle_version,CAST(b.revision AS TEXT),b.mail_domain_id,b.environment_id,CAST(w.revision AS TEXT),w.domain) fingerprint
 FROM project_application_domain_identities i
 JOIN projects p ON p.organization_id=i.organization_id AND p.project_id=i.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 JOIN billing_epochs epoch ON epoch.organization_id=i.organization_id AND epoch.project_id=i.project_id AND epoch.billing_epoch_id=p.active_billing_epoch_id AND epoch.ended_at IS NULL
 JOIN project_mail_domain_bindings b ON b.organization_id=i.organization_id AND b.project_id=i.project_id AND b.application_identity_revision=i.revision AND b.state='active' AND NOT b.legacy
 JOIN environments environment ON environment.organization_id=i.organization_id AND environment.project_id=i.project_id AND environment.environment_id=b.environment_id AND environment.name='prod'
 JOIN workspace_mail_domains w ON w.organization_id=i.organization_id AND w.domain_id=b.mail_domain_id AND w.status='active'
 WHERE i.organization_id=?1 AND i.project_id=?2 AND i.revision=?3 AND i.state='verified' AND i.expires_at>?4 AND i.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`;
const automaticWitness = z.strictObject({
  hostname: z.string(),
  registrableDomain: z.string(),
  revision: z.number(),
  challengeName: z.string(),
  challengeValue: z.string(),
  verifiedAt: z.string(),
  expiresAt: z.string(),
  expiresAtCas: z.string(),
  ownershipVersion: z.number(),
  billingEpochId: ulid,
  lifecycleVersion: z.number(),
  bindingRevision: z.number(),
  mailDomainId: ulid,
  environmentId: ulid,
  resourceRevision: z.number(),
  resourceDomain: z.string(),
  customHostnames: z.array(z.string()),
});
function automaticProof(
  row: Record<string, unknown> | undefined,
  websites: readonly Record<string, unknown>[],
) {
  if (!row) return null;
  const hostname = String(row["hostname"]),
    registrableDomain = String(row["registrable_domain"]),
    resourceDomain = String(row["resource_domain"]);
  try {
    if (
      classifyApplicationMailIdentity(hostname).registrableDomain !== registrableDomain ||
      classifyCustomerMailDomain(resourceDomain).registrableDomain !== registrableDomain
    )
      return null;
  } catch {
    return null;
  }
  return {
    hostname,
    registrableDomain,
    revision: Number(row["revision"]),
    challengeName: String(row["challenge_name"]),
    challengeValue: String(row["challenge_value"]),
    verifiedAt: publicTimestamp(String(row["verified_at"])),
    expiresAt: publicTimestamp(String(row["expires_at"])),
    expiresAtCas: String(row["expires_at"]),
    ownershipVersion: Number(row["ownership_version"]),
    billingEpochId: String(row["active_billing_epoch_id"]),
    lifecycleVersion: Number(row["lifecycle_version"]),
    bindingRevision: Number(row["binding_revision"]),
    mailDomainId: String(row["mail_domain_id"]),
    environmentId: String(row["environment_id"]),
    resourceRevision: Number(row["resource_revision"]),
    resourceDomain,
    customHostnames: websites.map((value) => String(value["hostname"])),
  };
}
/** Installed current desired state may renew a still-valid proof independently of its original human creator. */
export async function readAutomaticCfApplicationIdentity(context: CatalogContext, raw: unknown) {
  const input = mailInput(AUTOMATIC_SCOPE, raw),
    { db } = await routeOrganization(context, input.organizationId),
    rows = await db.batch([
      db
        .prepare(AUTOMATIC)
        .bind(input.organizationId, input.projectId, input.expectedRevision, input.now),
      db.prepare(WEBSITE).bind(input.organizationId, input.projectId),
    ]);
  return automaticProof(rows[0]?.results[0], rows[1]?.results ?? []);
}
export async function completeAutomaticCfApplicationIdentity(
  context: CatalogContext,
  raw: unknown,
) {
  const input = mailInput(AUTOMATIC_SCOPE.extend({ witness: automaticWitness }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    values = [input.organizationId, input.projectId, input.expectedRevision, input.now];
  return runCommand<
    { row: Record<string, unknown> | undefined; websites: Record<string, unknown>[] },
    { status: "stale" | "not_due" | "revalidated"; revision: number; expiresAt: string | null }
  >(db, {
    name: "cf.completeAutomaticApplicationIdentity",
    input,
    lookup: unknownOutcome("cf.completeAutomaticApplicationIdentity"),
    retryOn: ["precondition_changed"],
    read: async (r) => {
      const rows = await r.batch([
        r.prepare(AUTOMATIC).bind(...values),
        r.prepare(WEBSITE).bind(input.organizationId, input.projectId),
      ]);
      return { row: rows[0]?.results[0], websites: rows[1]?.results ?? [] };
    },
    decide: (snapshot) => {
      const latest = automaticProof(snapshot.row, snapshot.websites);
      if (!latest || !snapshot.row)
        return { replay: { status: "stale", revision: input.expectedRevision, expiresAt: null } };
      if (Date.parse(latest.expiresAt) - Date.parse(input.now) > 7 * 86400000)
        return {
          replay: { status: "not_due", revision: latest.revision, expiresAt: latest.expiresAt },
        };
      if (JSON.stringify(latest) !== JSON.stringify(input.witness))
        return {
          replay: { status: "stale", revision: latest.revision, expiresAt: latest.expiresAt },
        };
      const expiresAt = shiftStored(input.now, 30 * 86400000);
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${AUTOMATIC}) current WHERE current.fingerprint=?5)`,
            [...values, snapshot.row["fingerprint"]],
          ),
          guard(
            db,
            "precondition_changed",
            `(SELECT json_group_array(hostname) FROM(${WEBSITE})) IS NOT ?3`,
            [input.organizationId, input.projectId, JSON.stringify(latest.customHostnames)],
          ),
          db
            .prepare(
              "UPDATE project_application_domain_identities SET verified_at=?5,expires_at=?6 WHERE organization_id=?1 AND project_id=?2 AND revision=?3 AND challenge_value=?4 AND state='verified' AND expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND expires_at=?7",
            )
            .bind(
              input.organizationId,
              input.projectId,
              input.expectedRevision,
              latest.challengeValue,
              input.now,
              expiresAt,
              latest.expiresAtCas,
            ),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        result: () => ({
          status: "revalidated",
          revision: latest.revision,
          expiresAt: publicTimestamp(expiresAt),
        }),
      };
    },
  });
}
