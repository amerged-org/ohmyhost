import { z } from "zod";
import type { D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, StoreBusyError, type Command } from "../../run-command.js";
import { BucketFencedError } from "../../fence.js";
import { storedTimestamp } from "../../timestamps.js";
import { bucketOf } from "../../router.js";
import { ensureAccount, grantCredit, MICROS_PER_CREDIT } from "../credit/index.js";
import { persistOrganizationGrantsStatement } from "./local-grants.js";

import {
  ulid,
  newUlid,
  auditStatement,
  addMilliseconds,
  runMapped,
  instant,
  hexBytes,
  rowsOf,
  conflict,
  routeOrganization,
  type CatalogContext,
} from "../common.js";
import { exactInstant, workosUserId, workosOrganizationId } from "./shared.js";

const warningScopeInput = z.strictObject({ organizationId: ulid, exhaustedAt: exactInstant });
const warningOwnerInput = z.strictObject({ organizationId: ulid, userId: workosUserId });

/** The exact active/beta/exhaustion scope used by the credit-warning recipient resolver. */
export async function readCreditWarningScope(
  context: CatalogContext,
  raw: unknown,
): Promise<string | null> {
  const input = warningScopeInput.parse(raw);
  const shard = await routeOrganization(context, input.organizationId);
  const row = await shard.db
    .prepare(
      `SELECT o.workos_organization_id FROM organizations o
    JOIN credit_account account ON account.organization_id = o.organization_id
    WHERE o.organization_id = ?1 AND o.state = 'active' AND o.beta_admitted_at IS NOT NULL AND account.exhausted_at = ?2`,
    )
    .bind(input.organizationId, input.exhaustedAt)
    .first<{ workos_organization_id: string }>();
  return row?.workos_organization_id ?? null;
}

/** The original credits:read organization authorization for a candidate fresh WorkOS owner. */
export async function isCreditWarningOwner(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = warningOwnerInput.parse(raw);
  const shard = await routeOrganization(context, input.organizationId);
  const row = await shard.db
    .prepare(
      `SELECT EXISTS (
    SELECT 1 FROM organizations o JOIN organization_memberships m ON m.organization_id = o.organization_id
    JOIN local_authorization_grants g ON g.organization_id = o.organization_id AND g.principal_kind = 'user'
      AND g.principal_id = 'user:' || m.workos_user_id AND g.project_id IS NULL AND g.environment_id IS NULL
      AND g.revoked_at IS NULL AND g.ownership_version IS NULL AND g.billing_epoch_id IS NULL
    WHERE o.organization_id = ?1 AND m.workos_user_id = ?2 AND o.state = 'active' AND o.beta_admitted_at IS NOT NULL
      AND m.state = 'active' AND m.role IN ('admin','owner') AND g.role = 'owner') AS allowed`,
    )
    .bind(input.organizationId, input.userId)
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

export type BindWorkosAuxiliaryCommand = <Result>(
  command: (context: CatalogContext, raw: unknown) => Promise<Result>,
) => (raw: unknown) => Promise<Result>;
export function createWorkosAuxiliaryCommands(bind: BindWorkosAuxiliaryCommand) {
  return Object.freeze({
    readCreditWarningScope: bind(readCreditWarningScope),
    isCreditWarningOwner: bind(isCreditWarningOwner),
    prepareWorkosOnboarding: bind(prepareWorkosOnboarding),
    claimWorkosOnboardingOrganization: bind(claimWorkosOnboardingOrganization),
    recordWorkosOnboardingOrganization: bind(recordWorkosOnboardingOrganization),
    claimWorkosOnboardingMembership: bind(claimWorkosOnboardingMembership),
    completeWorkosOnboarding: bind(completeWorkosOnboarding),
  });
}

// Closed metadata operations of the original WorkOS onboarding transactions.
const onboardingRequestInput = z.strictObject({
  initial: z.boolean().optional(),
  userId: workosUserId,
  sessionId: z.string().regex(/^session_[A-Za-z0-9_]{1,120}$/u),
  name: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => {
      if (value !== value.trim()) return false;
      for (const character of value) {
        const point = character.codePointAt(0) ?? 0;
        if (point <= 31 || point === 127) return false;
      }
      return true;
    }),
  signupSource: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
});
const prepareInput = z.strictObject({
  request: onboardingRequestInput,
  proposedRequestId: ulid.optional(),
  now: instant,
});
const requestScopeInput = z.strictObject({ requestId: ulid, userId: workosUserId });
const recordOrganizationInput = requestScopeInput.extend({ workosOrganizationId });
interface RequestRow {
  readonly request_id: string;
  readonly workos_user_id: string;
  readonly request_digest: string;
  readonly name: string;
  readonly signup_source: string | null;
  readonly organization_attempted: number;
  readonly membership_attempted: number;
  readonly workos_organization_id: string | null;
  readonly organization_id: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
}
interface SignupRow {
  readonly origin_source: string | null;
  readonly origin_present: number;
  readonly recorded_at: string;
  readonly attributed_source: string | null;
  readonly first_request_id: string | null;
  readonly bonus_micros: string | null;
  readonly credit_grant_id: string | null;
  readonly attributed_at: string | null;
}
interface SourceRow {
  readonly active: number;
  readonly admits_beta: number;
  readonly bonus_micros: string;
}
const REQUEST_COLUMNS = `request_id, workos_user_id, lower(hex(request_sha256)) AS request_digest, name, signup_source,
  organization_attempted, membership_attempted, workos_organization_id, organization_id, completed_at, created_at`;
// Bounded relevant facts only, not all the user's workspaces: the original selected one key and its first attribution.
const PREPARE_FP = `json_array(
 (SELECT json_array(origin_source, origin_present, recorded_at, attributed_source, first_request_id, bonus_micros, credit_grant_id, attributed_at) FROM user_signup WHERE workos_user_id = ?1),
 (SELECT json_array(request_id, lower(hex(request_sha256)), name, signup_source, organization_attempted, membership_attempted, workos_organization_id, organization_id, completed_at, created_at)
   FROM onboarding_requests WHERE workos_user_id = ?1 AND idempotency_sha256 = ?2),
 (SELECT json_array(r.request_id, lower(hex(r.request_sha256)), r.name, r.signup_source, r.organization_attempted, r.membership_attempted, r.workos_organization_id, r.organization_id, r.completed_at, r.created_at)
   FROM onboarding_requests r JOIN user_signup u ON u.first_request_id = r.request_id WHERE u.workos_user_id = ?1),
 (SELECT json_array(active, admits_beta, CAST(bonus_micros AS TEXT)) FROM signup_sources WHERE source_id = ?3))`;
/**
 * One user can start at most this many new workspace requests per rolling window. Every workspace costs the shared
 * WorkOS membership sync queue at least two events, so an unbounded loop of creations is a flood that delays every
 * tenant's membership removals. A replay of an accepted idempotency key is an observation and never counts.
 */
export const ONBOARDING_REQUESTS_PER_WINDOW = 5;
export const ONBOARDING_REQUEST_WINDOW_MS = 3_600_000;
const RECENT_REQUESTS = `SELECT count(*) AS n FROM onboarding_requests WHERE workos_user_id = ?1 AND created_at > ?2`;
const USER_SESSION_REVOKED = `EXISTS (SELECT 1 FROM revocations WHERE effective_at <= ?3 AND ((kind = 'user' AND resource_id = ?1) OR (kind = 'session' AND resource_id = ?2 AND workos_user_id = ?1)))`;
const failOnboarding = (code: string) => conflict(code);
async function digestText(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function wireRequest(row: RequestRow) {
  if (row.signup_source === null) throw failOnboarding("service_unavailable");
  return {
    request_id: row.request_id,
    request_digest: row.request_digest,
    name: row.name,
    signup_source: row.signup_source,
    workos_organization_id: row.workos_organization_id,
    organization_id: row.organization_id,
  };
}
interface PrepareState {
  readonly origin: SignupRow | null;
  readonly prior: RequestRow | null;
  readonly first: RequestRow | null;
  readonly source: SourceRow | null;
  readonly fingerprint: string;
  readonly revoked: number;
  readonly recent: number;
}

/** Freeze origin, first attribution and the stable provider request identity as ONE original transaction. */
export async function prepareWorkosOnboarding(context: CatalogContext, raw: unknown) {
  const input = prepareInput.parse(raw);
  const proposedRequestId = input.proposedRequestId ?? newUlid();
  const [requestDigest, keyDigest] = await Promise.all([
    digestText(JSON.stringify([input.request.name, input.request.signupSource])),
    digestText(input.request.idempotencyKey),
  ]);
  const db = (await context.router.routeShard(0)).db;
  const key = hexBytes(keyDigest),
    request = input.request;
  const windowStart = addMilliseconds(input.now, -ONBOARDING_REQUEST_WINDOW_MS);
  return runCommand(db, {
    name: "identity.prepareWorkosOnboarding",
    input,
    retryOn: ["precondition_changed", "scope_inactive"],
    naturalKeyTables: ["user_signup", "onboarding_requests", "signup_sources"],
    read: async (reader) => {
      const results = await reader.batch([
        reader.prepare("SELECT * FROM user_signup WHERE workos_user_id = ?").bind(request.userId),
        reader
          .prepare(
            `SELECT ${REQUEST_COLUMNS} FROM onboarding_requests WHERE workos_user_id = ?1 AND idempotency_sha256 = ?2`,
          )
          .bind(request.userId, key),
        reader
          .prepare(
            `SELECT ${REQUEST_COLUMNS} FROM onboarding_requests WHERE request_id = (SELECT first_request_id FROM user_signup WHERE workos_user_id = ?1)`,
          )
          .bind(request.userId),
        reader
          .prepare(
            "SELECT active, admits_beta, CAST(bonus_micros AS TEXT) AS bonus_micros FROM signup_sources WHERE source_id = ?",
          )
          .bind(request.signupSource),
        reader
          .prepare(
            `SELECT ${PREPARE_FP} AS fingerprint, ${USER_SESSION_REVOKED.replace(/\?[123]/gu, (parameter) => ({ "?1": "?1", "?2": "?4", "?3": "?5" })[parameter] as string)} AS revoked`,
          )
          .bind(request.userId, key, request.signupSource, request.sessionId, input.now),
        reader.prepare(RECENT_REQUESTS).bind(request.userId, windowStart),
      ]);
      return {
        origin: rowsOf<SignupRow>(results[0])[0] ?? null,
        prior: rowsOf<RequestRow>(results[1])[0] ?? null,
        first: rowsOf<RequestRow>(results[2])[0] ?? null,
        source: rowsOf<SourceRow>(results[3])[0] ?? null,
        ...(rowsOf<{ fingerprint: string; revoked: number }>(results[4])[0] as {
          fingerprint: string;
          revoked: number;
        }),
        recent: (rowsOf<{ n: number }>(results[5])[0] as { n: number }).n,
      } satisfies PrepareState;
    },
    decide: (state: PrepareState) => {
      if (state.revoked === 1) return { reject: failOnboarding("forbidden") };
      if (state.prior !== null && state.prior.request_digest !== requestDigest)
        return { reject: failOnboarding("idempotency_key_reused") };
      const origin = state.origin;
      const frozen = origin?.origin_present === 1 ? origin.origin_source : null;
      if (frozen !== null && frozen !== request.signupSource)
        return { reject: failOnboarding("forbidden") };
      const statements: D1PreparedStatement[] = [
        guard(db, "precondition_changed", `(${PREPARE_FP}) IS NOT ?4`, [
          request.userId,
          key,
          request.signupSource,
          state.fingerprint,
        ]),
        guard(db, "scope_inactive", USER_SESSION_REVOKED, [
          request.userId,
          request.sessionId,
          input.now,
        ]),
      ];
      if (origin === null)
        statements.push(
          db
            .prepare(
              "INSERT INTO user_signup(workos_user_id,origin_source,recorded_at,origin_present) VALUES (?1,?2,?3,1)",
            )
            .bind(request.userId, request.signupSource, input.now),
        );
      else if (origin.origin_present === 0)
        statements.push(
          db
            .prepare(
              "UPDATE user_signup SET origin_present=1,origin_source=?2,recorded_at=?3 WHERE workos_user_id=?1 AND origin_present=0",
            )
            .bind(request.userId, request.signupSource, input.now),
        );
      const selected = request.initial && state.first !== null ? state.first : state.prior;
      if (selected !== null) {
        const effective =
          request.initial && state.first !== null
            ? { ...request, name: selected.name, signupSource: wireRequest(selected).signup_source }
            : request;
        return { statements, result: () => ({ request: effective, row: wireRequest(selected) }) };
      }
      if (state.recent >= ONBOARDING_REQUESTS_PER_WINDOW)
        return { reject: failOnboarding("forbidden") };
      // A request that started between the read and this batch changes the count: read again before inserting.
      statements.push(
        guard(db, "precondition_changed", `(${RECENT_REQUESTS}) <> ?3`, [
          request.userId,
          windowStart,
          state.recent,
        ]),
      );
      const attribution =
        origin?.attributed_source === null || origin?.attributed_source === undefined
          ? null
          : origin;
      if (state.source?.active === 0) return { reject: failOnboarding("forbidden") };
      if (attribution !== null && attribution.attributed_source !== request.signupSource)
        return { reject: failOnboarding("forbidden") };
      if (attribution !== null && state.source === null)
        return { reject: failOnboarding("service_unavailable") };
      if (state.source === null)
        statements.push(
          db
            .prepare(
              "INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros) VALUES (?1,1,1,0)",
            )
            .bind(request.signupSource),
        );
      statements.push(
        db
          .prepare(
            `INSERT INTO onboarding_requests(request_id,workos_user_id,idempotency_sha256,request_sha256,name,organization_attempted,membership_attempted,signup_source,created_at)
        VALUES (?1,?2,?3,?4,?5,0,0,?6,?7)`,
          )
          .bind(
            proposedRequestId,
            request.userId,
            key,
            hexBytes(requestDigest),
            request.name,
            request.signupSource,
            input.now,
          ),
      );
      if (attribution === null) {
        const bonus =
          origin?.origin_present === 1 && origin.origin_source === null
            ? "0"
            : (state.source?.bonus_micros ?? "0");
        statements.push(
          db
            .prepare(
              "UPDATE user_signup SET attributed_source=?2,first_request_id=?3,bonus_micros=?4,attributed_at=?5 WHERE workos_user_id=?1 AND attributed_source IS NULL",
            )
            .bind(request.userId, request.signupSource, proposedRequestId, bonus, input.now),
        );
      }
      return {
        statements,
        result: () => ({
          request,
          row: {
            request_id: proposedRequestId,
            request_digest: requestDigest,
            name: request.name,
            signup_source: request.signupSource,
            workos_organization_id: null,
            organization_id: null,
          },
        }),
      };
    },
  });
}

/** Save the at-most-once provider attempt before creating the external organization. */
export async function claimWorkosOnboardingOrganization(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = requestScopeInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(
      "UPDATE onboarding_requests SET organization_attempted=1 WHERE request_id=?1 AND workos_user_id=?2 AND organization_attempted=0",
    )
    .bind(input.requestId, input.userId)
    .run();
  return result.meta.changes === 1;
}
/** A known provider identity is never rebound after an uncertain response. */
export async function recordWorkosOnboardingOrganization(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = recordOrganizationInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  await db.batch([
    db
      .prepare(
        "UPDATE onboarding_requests SET workos_organization_id=?3 WHERE request_id=?1 AND workos_user_id=?2 AND workos_organization_id IS NULL",
      )
      .bind(input.requestId, input.userId, input.workosOrganizationId),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS (SELECT 1 FROM onboarding_requests WHERE request_id=?1 AND workos_user_id=?2 AND workos_organization_id=?3)",
      [input.requestId, input.userId, input.workosOrganizationId],
    ),
  ]);
}
/** The membership attempt is likewise durable before its provider POST. */
export async function claimWorkosOnboardingMembership(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = requestScopeInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(
      "UPDATE onboarding_requests SET membership_attempted=1 WHERE request_id=?1 AND workos_user_id=?2 AND membership_attempted=0 AND organization_id IS NULL",
    )
    .bind(input.requestId, input.userId)
    .run();
  return result.meta.changes === 1;
}

/** A referred user's first organization starts with 1000 credits and 30 days of Paid access. */
const REFERRAL_CREDIT_MICROS = 1_000 * MICROS_PER_CREDIT;
const REFERRAL_PAID_MS = 30 * 86_400_000;
/**
 * The referral credit and Paid access are granted to the users whose rank among the users recorded through one referrer's
 * link is at most this many (rank by recording time, then user id, so a late completion keeps its place); the users
 * after that rank get the workspace without them.
 */
const REFERRAL_SIGNUPS_PER_SOURCE = 20;

const completeInput = z.strictObject({
  request: onboardingRequestInput,
  requestId: ulid,
  workosOrganizationId,
  membershipUpdatedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), "provider membership time is invalid"),
  now: instant,
});
interface MemberState {
  readonly role: string;
  readonly state: string;
  readonly mapping_revision: number;
}
interface GrantState {
  readonly total: number;
  readonly owner: number;
}
interface ReferrerState {
  readonly organization_id: string;
  readonly proof: string;
}
interface CompleteState {
  readonly organizationId: string;
  readonly organizationWorkosId: string | null;
  readonly bucket: number;
  /** The organization's state; null while it does not exist yet. */
  readonly organization: string | null;
  readonly bonusGranted: boolean;
  readonly referralGranted: boolean;
  readonly row: RequestRow | null;
  readonly signup: SignupRow | null;
  readonly member: MemberState | null;
  readonly grants: GrantState;
  readonly referrer: ReferrerState | null;
  /** Users recorded through the referrer's link no later than this user (the user itself included): its rank. */
  readonly referralSignups: number;
  readonly fingerprint: string;
  readonly revoked: number;
}
const OWNER_AT_ONBOARDING = `EXISTS (SELECT 1 FROM organizations o JOIN organization_memberships m ON m.organization_id=o.organization_id
 JOIN local_authorization_grants g ON g.organization_id=o.organization_id AND g.principal_kind='user' AND g.principal_id='user:' || m.workos_user_id
 WHERE o.organization_id=?1 AND m.workos_user_id=?2 AND o.state='active' AND m.state='active' AND m.role IN ('admin','owner')
   AND g.role='owner' AND g.project_id IS NULL AND g.environment_id IS NULL AND g.revoked_at IS NULL AND g.ownership_version IS NULL AND g.billing_epoch_id IS NULL)`;
const REFERRER_OF = `SELECT organization_id, proof FROM (
 SELECT o.organization_id, json_array('ref',o.organization_id,o.state) AS proof FROM organizations o WHERE ?5='ref' AND o.organization_id=?6 AND o.state='active'
 UNION ALL
 SELECT p.organization_id, json_array('flag',p.project_id,p.organization_id,p.owner_state,p.ownership_version,p.lifecycle_state,p.lifecycle_version,f.period_id,f.enabled_at,f.disabled_at)
   FROM projects p JOIN project_powered_by_flag_periods f ON f.project_id=p.project_id AND f.organization_id=p.organization_id
   WHERE ?5='flag' AND p.project_id=?6 AND p.owner_state='active' AND p.lifecycle_state='active' AND f.disabled_at IS NULL
) LIMIT 1`;
const COMPLETE_FP = `json_array(
 (SELECT json_array(workos_organization_id,state,mapping_revision,lower(hex(snapshot_sha256)),snapshot_fetched_at,synchronized_at,beta_admitted_at,signup_source) FROM organizations WHERE organization_id=?1),
 (SELECT json_array(role,state,mapping_revision,lower(hex(snapshot_sha256)),effective_at,revoked_at,trigger_event_id) FROM organization_memberships WHERE organization_id=?1 AND workos_user_id=?2),
 (SELECT json_array(count(*),${OWNER_AT_ONBOARDING}) FROM local_authorization_grants WHERE organization_id=?1 AND principal_id='user:' || ?2 AND project_id IS NULL),
 (SELECT json_array(origin_source,origin_present,recorded_at,attributed_source,first_request_id,bonus_micros,credit_grant_id,attributed_at) FROM user_signup WHERE workos_user_id=?2),
 (SELECT json_array(request_id,workos_user_id,lower(hex(request_sha256)),name,signup_source,organization_attempted,membership_attempted,workos_organization_id,organization_id,completed_at,created_at) FROM onboarding_requests WHERE request_id=?3),
 (SELECT json_array(organization_id,workos_organization_id,state,bucket) FROM org_directory WHERE workos_organization_id=?4),
 (SELECT proof FROM (${REFERRER_OF})),
 (SELECT json_array(EXISTS (SELECT 1 FROM credit_grant WHERE key='signup_bonus:' || ?2), EXISTS (SELECT 1 FROM credit_grant WHERE key='referral_signup:' || ?2))))`;
const COMPLETE_REVOKED = `EXISTS (SELECT 1 FROM revocations WHERE effective_at <= ?8 AND ((kind='user' AND resource_id=?2) OR (kind='session' AND resource_id=?7 AND workos_user_id=?2)))`;
function referralTarget(source: string | null) {
  const match = source === null ? null : /^(flag|ref)-([0-7][0-9a-hjkmnp-tv-z]{25})$/u.exec(source);
  return { kind: match?.[1] ?? null, id: match?.[2]?.toUpperCase() ?? null };
}

/** The entire original final onboarding transaction: authority, attribution, optional two grants and Paid access. */
export async function completeWorkosOnboarding(
  context: CatalogContext,
  raw: unknown,
): Promise<{ id: string; name: string }> {
  const input = completeInput.parse(raw),
    db = (await context.router.routeShard(0)).db;
  const membershipAt = storedTimestamp(input.membershipUpdatedAt);
  const organizationDigest = await digestText(
    JSON.stringify({ id: input.workosOrganizationId, name: input.request.name }),
  );
  const memberDigest = await digestText(
    JSON.stringify({
      organizationId: input.workosOrganizationId,
      userId: input.request.userId,
      role: "admin",
      state: "active",
      updatedAt: input.membershipUpdatedAt,
    }),
  );
  const expectedDigest = await digestText(
    JSON.stringify([input.request.name, input.request.signupSource]),
  );
  let lastBucket = 0;
  const command: Command<CompleteState, { id: string; name: string }> = {
    name: "identity.completeWorkosOnboarding",
    input,
    retryOn: ["precondition_changed", "scope_inactive"],
    naturalKeyTables: [
      "credit_account",
      "credit_grant",
      "credit_log",
      "organizations",
      "org_directory",
      "organization_memberships",
      "local_authorization_grants",
      "onboarding_requests",
      "user_signup",
      "organization_audit_events",
    ],
    read: async (reader) => {
      // Resolve a pre-existing provider mapping, then include it again in the wallet snapshot. An immutable mapping
      // that first appears between those reads is adopted on a new read, never replaced with the proposed request id.
      for (let round = 0; round < 8; round++) {
        const [mapped, origin] = await reader.batch([
          reader
            .prepare("SELECT organization_id FROM org_directory WHERE workos_organization_id=?")
            .bind(input.workosOrganizationId),
          reader
            .prepare("SELECT attributed_source FROM user_signup WHERE workos_user_id=?")
            .bind(input.request.userId),
        ]);
        const organizationId =
          rowsOf<{ organization_id: string }>(mapped)[0]?.organization_id ?? input.requestId;
        const source =
          rowsOf<{ attributed_source: string | null }>(origin)[0]?.attributed_source ?? null;
        const ref = referralTarget(source);
        const args = [
          organizationId,
          input.request.userId,
          input.requestId,
          input.workosOrganizationId,
          ref.kind,
          ref.id,
          input.request.sessionId,
        ];
        const [
          request,
          signupRows,
          memberRows,
          grantRows,
          referrerRows,
          factRows,
          mappedRows,
          workosRows,
          organizationRows,
          grantedRows,
          referralRows,
        ] = await reader.batch([
          reader
            .prepare(`SELECT ${REQUEST_COLUMNS} FROM onboarding_requests WHERE request_id=?`)
            .bind(input.requestId),
          reader
            .prepare("SELECT * FROM user_signup WHERE workos_user_id=?")
            .bind(input.request.userId),
          reader
            .prepare(
              "SELECT role,state,mapping_revision FROM organization_memberships WHERE organization_id=?1 AND workos_user_id=?2",
            )
            .bind(organizationId, input.request.userId),
          reader
            .prepare(
              `SELECT count(*) AS total,${OWNER_AT_ONBOARDING} AS owner FROM local_authorization_grants WHERE organization_id=?1 AND principal_id='user:' || ?2 AND project_id IS NULL`,
            )
            .bind(organizationId, input.request.userId),
          reader.prepare(REFERRER_OF).bind(...args.slice(0, 6)),
          reader
            .prepare(`SELECT ${COMPLETE_FP} AS fingerprint,${COMPLETE_REVOKED} AS revoked`)
            .bind(...args, input.now),
          reader
            .prepare("SELECT organization_id FROM org_directory WHERE workos_organization_id=?")
            .bind(input.workosOrganizationId),
          reader
            .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
            .bind(organizationId),
          reader
            .prepare("SELECT state FROM organizations WHERE organization_id=?")
            .bind(organizationId),
          reader
            .prepare(
              "SELECT EXISTS (SELECT 1 FROM credit_grant WHERE key='signup_bonus:' || ?1) AS bonus, EXISTS (SELECT 1 FROM credit_grant WHERE key='referral_signup:' || ?1) AS referral",
            )
            .bind(input.request.userId),
          reader
            .prepare(
              `SELECT count(*) AS total FROM user_signup WHERE origin_source=?1 AND (recorded_at < (SELECT recorded_at FROM user_signup WHERE workos_user_id=?2)
                 OR (recorded_at = (SELECT recorded_at FROM user_signup WHERE workos_user_id=?2) AND workos_user_id <= ?2))`,
            )
            .bind(source, input.request.userId),
        ]);
        const signup = rowsOf<SignupRow>(signupRows)[0] ?? null;
        const again =
          rowsOf<{ organization_id: string }>(mappedRows)[0]?.organization_id ?? input.requestId;
        if (again !== organizationId || (signup?.attributed_source ?? null) !== source) continue;
        const bucket = await bucketOf(organizationId);
        lastBucket = bucket;
        const fp = rowsOf<{ fingerprint: string; revoked: number }>(factRows)[0] as {
          fingerprint: string;
          revoked: number;
        };
        const granted = rowsOf<{ bonus: number; referral: number }>(grantedRows)[0];
        return {
          organizationId,
          organizationWorkosId:
            rowsOf<{ workos_organization_id: string }>(workosRows)[0]?.workos_organization_id ??
            null,
          bucket,
          organization: rowsOf<{ state: string }>(organizationRows)[0]?.state ?? null,
          bonusGranted: granted?.bonus === 1,
          referralGranted: granted?.referral === 1,
          row: rowsOf<RequestRow>(request)[0] ?? null,
          signup,
          member: rowsOf<MemberState>(memberRows)[0] ?? null,
          grants: rowsOf<GrantState>(grantRows)[0] as GrantState,
          referrer: rowsOf<ReferrerState>(referrerRows)[0] ?? null,
          referralSignups: rowsOf<{ total: number }>(referralRows)[0]?.total ?? 0,
          fingerprint: fp.fingerprint,
          revoked: fp.revoked,
        };
      }
      throw new StoreBusyError("WorkOS organization mapping kept changing");
    },
    decide: (state) => {
      const row = state.row,
        signup = state.signup;
      if (
        state.revoked === 1 ||
        row === null ||
        row.workos_user_id !== input.request.userId ||
        row.workos_organization_id !== input.workosOrganizationId
      )
        return { reject: failOnboarding("forbidden") };
      if (
        row.request_digest !== expectedDigest ||
        row.name !== input.request.name ||
        row.signup_source !== input.request.signupSource
      )
        return { reject: failOnboarding("idempotency_key_reused") };
      if (row.organization_id !== null) {
        if (row.organization_id !== state.organizationId || state.grants.owner !== 1)
          return { reject: failOnboarding("forbidden") };
        return { replay: { id: row.organization_id, name: input.request.name } };
      }
      if (state.organization !== null && state.organizationWorkosId !== input.workosOrganizationId)
        return { reject: failOnboarding("forbidden") };
      if (state.organization !== null && state.organization !== "active")
        return { reject: failOnboarding("forbidden") };
      if (
        state.member !== null &&
        (state.member.state !== "active" || state.member.role !== "admin")
      )
        return { reject: failOnboarding("forbidden") };
      if (state.grants.total !== 0 && state.grants.owner !== 1)
        return { reject: failOnboarding("forbidden") };
      if (
        signup === null ||
        signup.attributed_source === null ||
        signup.first_request_id === null ||
        signup.bonus_micros === null
      )
        return { reject: failOnboarding("forbidden") };
      const ref = referralTarget(signup.attributed_source);
      const args = [
        state.organizationId,
        input.request.userId,
        input.requestId,
        input.workosOrganizationId,
        ref.kind,
        ref.id,
        input.request.sessionId,
      ];
      const statements: D1PreparedStatement[] = [
        guard(db, "precondition_changed", `(${COMPLETE_FP}) IS NOT ?8`, [
          ...args,
          state.fingerprint,
        ]),
        guard(db, "scope_inactive", COMPLETE_REVOKED, [...args, input.now]),
        guard(db, "bucket_fenced", "EXISTS (SELECT 1 FROM bucket_fences WHERE bucket=?1)", [
          state.bucket,
        ]),
        db
          .prepare(
            "INSERT INTO org_directory(organization_id,workos_organization_id,bucket,state,created_at,updated_at) VALUES (?1,?2,?3,'active',?4,?4) ON CONFLICT(organization_id) DO NOTHING",
          )
          .bind(state.organizationId, input.workosOrganizationId, state.bucket, input.now),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS (SELECT 1 FROM org_directory WHERE organization_id=?1 AND workos_organization_id=?2 AND state='active')",
          [state.organizationId, input.workosOrganizationId],
        ),
      ];
      if (state.organization === null)
        statements.push(
          db
            .prepare(
              "INSERT INTO organizations(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,created_at,updated_at,bucket) VALUES (?1,?2,'active',1,?3,?4,?4,?4,?4,?5)",
            )
            .bind(
              state.organizationId,
              input.workosOrganizationId,
              hexBytes(organizationDigest),
              input.now,
              state.bucket,
            ),
        );
      if (state.member === null)
        statements.push(
          db
            .prepare(
              "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,revoked_at,trigger_event_id) VALUES (?1,?2,'admin','active',1,?3,?4,NULL,?5)",
            )
            .bind(
              state.organizationId,
              input.request.userId,
              hexBytes(memberDigest),
              membershipAt,
              `onboarding:${input.requestId}`,
            ),
        );
      if (state.grants.total === 0)
        statements.push(
          persistOrganizationGrantsStatement(
            db,
            state.organizationId,
            [{ grantId: input.requestId, userId: input.request.userId, role: "owner" }],
            input.now,
          ),
          guard(db, "precondition_changed", "changes()<>1"),
        );
      statements.push(
        auditStatement(db, state.organizationId, {
          auditEventId: input.requestId,
          projectId: null,
          operationId: null,
          billingEpochId: null,
          eventType: "organization.created",
          actorType: "principal",
          actorId: `user:${input.request.userId}`,
          payload: { request_id: input.requestId },
          occurredAt: input.now,
        }),
      );
      statements.push(
        db
          .prepare(
            "UPDATE onboarding_requests SET organization_id=?2,completed_at=?3 WHERE request_id=?1 AND organization_id IS NULL",
          )
          .bind(input.requestId, state.organizationId, input.now),
        guard(db, "precondition_changed", "changes()<>1"),
      );
      statements.push(
        db
          .prepare(
            "UPDATE organizations SET beta_admitted_at=COALESCE(beta_admitted_at,?3) WHERE organization_id=?1 AND workos_organization_id=?2 AND state='active'",
          )
          .bind(state.organizationId, input.workosOrganizationId, input.now),
        guard(db, "precondition_changed", "changes()<>1"),
      );
      // The credit account is created with the organization, in the same batch; the grants below land on it.
      statements.push(
        ...ensureAccount(db, { organizationId: state.organizationId, now: input.now }).statements,
      );
      // A user's signup bonus is granted once, to the first organization they create. The grant key is the idempotency; a
      // bonus that the earlier credit lots already paid out is remembered by the attribution pointer.
      const bonus = Number(signup.bonus_micros);
      if (!Number.isSafeInteger(bonus)) throw new RangeError("the signup bonus is out of range");
      if (signup.credit_grant_id === null && !state.bonusGranted && bonus > 0)
        statements.push(
          ...grantCredit(db, {
            organizationId: state.organizationId,
            key: `signup_bonus:${input.request.userId}`,
            kind: "onetime",
            amountMicros: bonus,
            now: input.now,
            detail: { requestId: input.requestId, source: signup.attributed_source },
          }).statements,
        );
      // A referred user's first organization gets 1000 credits and 30 days of Paid access.
      if (
        signup.first_request_id === input.requestId &&
        state.referrer !== null &&
        state.referrer.organization_id !== state.organizationId &&
        !state.referralGranted &&
        state.referralSignups <= REFERRAL_SIGNUPS_PER_SOURCE
      ) {
        statements.push(
          ...grantCredit(db, {
            organizationId: state.organizationId,
            key: `referral_signup:${input.request.userId}`,
            kind: "onetime",
            amountMicros: REFERRAL_CREDIT_MICROS,
            now: input.now,
            detail: { requestId: input.requestId, source: signup.attributed_source },
          }).statements,
          db
            .prepare(
              "UPDATE credit_account SET paid_until = ?2, paid_source = 'granted', updated_at = ?3 WHERE organization_id = ?1 AND (paid_until IS NULL OR paid_until <= ?3 OR paid_source = 'granted')",
            )
            .bind(state.organizationId, addMilliseconds(input.now, REFERRAL_PAID_MS), input.now),
        );
      }
      return { statements, result: () => ({ id: state.organizationId, name: input.request.name }) };
    },
  };
  return runMapped(
    db,
    {
      ...command,
      lookup: async (reader) => {
        const plan = command.decide(await command.read(reader));
        return "replay" in plan ? plan.replay : undefined;
      },
    },
    { bucket_fenced: () => new BucketFencedError(lastBucket) },
  );
}
