import { BARRIER_FREE_MEMBERSHIP_SQL } from "./membership-barrier-sql.js";
import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "./authorization-restriction.js";
import {
  canonicalAuthorizationCondition,
  canonicalAuthorizationGuard,
} from "../projects/customer-projects-access.js";
import { restrictionAllows } from "./operation-delegations.js";
import { activeGrantGuard, activeGrantSelect } from "./mcp-sql.js";
import { isUserSecretName } from "@ohmyhost/contracts/secret-names";
import { z } from "zod";

import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import {
  conflict,
  addMilliseconds,
  instant,
  publicTimestamp,
  routeOrganization,
  runMapped,
  ulid,
  type CatalogContext,
} from "../common.js";
import type { D1Database } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";

import { derivedUuid } from "./shared.js";

const requestHash = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.strictObject({
  organizationId: ulid,
  userId: z.string().regex(/^user_[A-Za-z0-9_]{1,123}$/u),
  clientId: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/[\s\p{Cc}]/u.test(value)),
  consentHash: requestHash,
});
const projectIds = z
  .array(ulid)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
export type McpIdentity = z.output<typeof identity>;

const handoffAuthority = z.strictObject({
  grantId: z.string().uuid(),
  clientId: identity.shape.clientId,
  consentHash: requestHash,
  action: delegationActionInput,
  authorizationRestriction: authorizationRestrictionInput.optional(),
});

export interface McpPortalHandoff extends McpIdentity {
  readonly requestHash: string;
  readonly authority?: z.output<typeof handoffAuthority>;
  readonly kind: "secret" | "github";
  readonly projectIds: readonly string[];
  readonly allowCreate: boolean;
  readonly allowPublish: boolean;
  readonly secretTarget: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly environment: "dev" | "prod";
    readonly name: string;
    readonly names?: readonly string[];
    readonly submissionId?: string;
    readonly results?: readonly z.output<typeof secretResult>[];
    readonly nativeProvider?: {
      readonly provider: "google" | "github";
      readonly configurationRevision: number;
      readonly enabled: boolean;
      readonly clientId?: string;
    };
  } | null;
  readonly githubTarget?: { readonly idempotencyKey: string } | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly outcome:
    | "approved"
    | "declined"
    | "secret_submitted"
    | "secret_failed"
    | "github_started"
    | "github_failed"
    | null;
}

export interface McpDelegationGrant extends McpIdentity {
  readonly grantId: string;
  readonly projectId: string | null;
  readonly allowPublish: boolean;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

const secretResult = z.enum(["saved", "failed", "unconfirmed"]);
const secretTarget = z
  .strictObject({
    projectId: ulid,
    environmentId: ulid,
    environment: z.enum(["dev", "prod"]),
    name: z.string().min(1).max(256),
    names: z.array(z.string().refine(isUserSecretName)).min(1).max(10).optional(),
    submissionId: ulid.optional(),
    results: z.array(secretResult).min(1).max(10).optional(),
    nativeProvider: z
      .strictObject({
        provider: z.enum(["google", "github"]),
        configurationRevision: z.number().int().positive().max(2_147_483_646),
        enabled: z.boolean(),
        clientId: z.string().max(1024).optional(),
      })
      .optional(),
  })
  .refine((value) =>
    value.nativeProvider === undefined
      ? value.names === undefined ||
        (value.names[0] === value.name && new Set(value.names).size === value.names.length)
      : value.names === undefined &&
        value.submissionId === undefined &&
        value.results === undefined &&
        value.name === `NATIVE_AUTH_${value.nativeProvider.provider.toUpperCase()}_CLIENT_SECRET`,
  );

export const insertMcpHandoffInput = z
  .strictObject({
    ...identity.shape,
    requestHash,
    authority: handoffAuthority,
    kind: z.enum(["secret", "github"]),
    projectIds,
    allowCreate: z.boolean(),
    allowPublish: z.boolean(),
    secretTarget: secretTarget.nullable(),
    githubTarget: z
      .strictObject({ idempotencyKey: z.string().min(1) })
      .nullable()
      .optional(),
    createdAt: instant,
    expiresAt: instant,
  })
  .refine(
    (value) =>
      value.expiresAt > value.createdAt &&
      value.secretTarget?.submissionId === undefined &&
      value.secretTarget?.results === undefined &&
      value.expiresAt <=
        new Date(
          Date.parse(value.createdAt.slice(0, 19) + "Z") +
            (value.kind === "secret" &&
            value.secretTarget !== null &&
            value.secretTarget.nativeProvider === undefined
              ? 3_600_000
              : 600_000),
        )
          .toISOString()
          .slice(0, 19) +
          value.createdAt.slice(19),
    "Invalid handoff lifetime",
  );

interface HandoffRow {
  readonly organization_id: string;
  readonly request_hash: string;
  readonly authority: string | null;
  readonly user_id: string;
  readonly client_id: string;
  readonly consent_hash: string;
  readonly kind: "grant" | "secret" | "github";
  readonly project_ids: string;
  readonly allow_create: number;
  readonly allow_publish: number;
  readonly secret_target: string | null;
  readonly github_target: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly outcome: McpPortalHandoff["outcome"];
}

const HANDOFF_COLUMNS =
  "authority, organization_id, request_hash, user_id, client_id, consent_hash, kind, project_ids, allow_create, allow_publish, secret_target, github_target, created_at, expires_at, consumed_at, outcome";

function handoffOf(row: HandoffRow): McpPortalHandoff {
  if (row.kind === "grant") throw new TypeError("Retired handoff kind");
  return {
    requestHash: row.request_hash,
    ...(row.authority === null
      ? {}
      : { authority: handoffAuthority.parse(JSON.parse(row.authority)) }),
    userId: row.user_id,
    clientId: row.client_id,
    consentHash: row.consent_hash,
    organizationId: row.organization_id,
    kind: row.kind,
    projectIds: JSON.parse(row.project_ids) as string[],
    allowCreate: row.allow_create === 1,
    allowPublish: row.allow_publish === 1,
    secretTarget:
      row.secret_target === null
        ? null
        : (JSON.parse(row.secret_target) as McpPortalHandoff["secretTarget"]),
    ...(row.github_target === null
      ? {}
      : { githubTarget: JSON.parse(row.github_target) as { idempotencyKey: string } }),
    createdAt: publicTimestamp(row.created_at),
    expiresAt: publicTimestamp(row.expires_at),
    consumedAt: row.consumed_at === null ? null : publicTimestamp(row.consumed_at),
    outcome: row.outcome,
  };
}

/**
 * `insertHandoff`: the directory learns which organization owns the request hash (it is looked up by the
 * hash alone), then the handoff row lands in the organization's shard. Both steps are idempotent for the same
 * hash and organization, so a command interrupted between them is simply sent again; a hash owned by another
 * organization, or already stored, is a conflict.
 */
export async function insertMcpHandoff(context: CatalogContext, rawInput: unknown): Promise<void> {
  const input = insertMcpHandoffInput.parse(rawInput);
  await context.directory
    .prepare(
      "INSERT INTO mcp_handoff_routes(request_hash, organization_id, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT (request_hash) DO NOTHING",
    )
    .bind(input.requestHash, input.organizationId, input.expiresAt)
    .run();
  const route = await context.directory
    .prepare("SELECT organization_id FROM mcp_handoff_routes WHERE request_hash = ?")
    .bind(input.requestHash)
    .first<{ organization_id: string }>();
  if (route?.organization_id !== input.organizationId) {
    throw conflict("mcp_handoff_exists", "MCP request identity is already used");
  }
  const shard = await routeOrganization(context, input.organizationId);
  const command: Command<HandoffRow | null, void> = {
    name: "identity.insertMcpHandoff",
    input,
    naturalKeyTables: ["mcp_portal_handoffs"],
    read: (db) =>
      db
        .prepare(`SELECT ${HANDOFF_COLUMNS} FROM mcp_portal_handoffs WHERE request_hash = ?`)
        .bind(input.requestHash)
        .first<HandoffRow>(),
    decide: (existing): Plan<void> => {
      if (existing !== null) {
        const same =
          existing.organization_id === input.organizationId &&
          existing.user_id === input.userId &&
          existing.client_id === input.clientId &&
          existing.consent_hash === input.consentHash &&
          existing.kind === input.kind &&
          existing.created_at === input.createdAt;
        return same
          ? { replay: undefined }
          : { reject: conflict("mcp_handoff_exists", "MCP request identity is already used") };
      }
      return {
        statements: [
          shard.db
            .prepare(
              `INSERT INTO mcp_portal_handoffs(organization_id, request_hash, user_id, client_id, consent_hash, kind, project_ids, allow_create, allow_publish, secret_target, github_target, mail_domain_scopes, allow_mail_domain_create, created_at, expires_at, authority)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
            )
            .bind(
              input.organizationId,
              input.requestHash,
              input.userId,
              input.clientId,
              input.consentHash,
              input.kind,
              JSON.stringify(input.projectIds),
              input.allowCreate ? 1 : 0,
              input.allowPublish ? 1 : 0,
              input.secretTarget === null ? null : JSON.stringify(input.secretTarget),
              input.githubTarget ? JSON.stringify(input.githubTarget) : null,
              "[]",
              0,
              input.createdAt,
              input.expiresAt,
              input.authority === undefined ? null : JSON.stringify(input.authority),
            ),
        ],
        result: () => undefined,
      };
    },
  };
  await runCommand(shard.db, command);
}

async function routeHandoff(context: CatalogContext, hash: string): Promise<string | null> {
  const route = await context.directory
    .prepare("SELECT organization_id FROM mcp_handoff_routes WHERE request_hash = ?")
    .bind(hash)
    .first<{ organization_id: string }>();
  return route?.organization_id ?? null;
}

const findHandoffInput = z.strictObject({ requestHash });

/** `findHandoff`. */
export async function findMcpHandoff(
  context: CatalogContext,
  rawInput: unknown,
): Promise<McpPortalHandoff | null> {
  const input = findHandoffInput.parse(rawInput);
  const organizationId = await routeHandoff(context, input.requestHash);
  if (organizationId === null) return null;
  const shard = await routeOrganization(context, organizationId);
  const row = await shard.db
    .prepare(`SELECT ${HANDOFF_COLUMNS} FROM mcp_portal_handoffs WHERE request_hash = ?`)
    .bind(input.requestHash)
    .first<HandoffRow>();
  return row === null || row.kind === "grant" ? null : handoffOf(row);
}

// ------------------------------------------------------------------ consume

export const consumeMcpHandoffInput = z.strictObject({
  requestHash,
  userId: identity.shape.userId,
  organizationId: ulid,
  now: instant,
  approve: z.boolean(),
  publish: z.boolean(),
  selectedProjectIds: projectIds.optional(),
  submissionId: ulid.optional(),
});

const REVOKED_SQL = `(EXISTS (SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id = ?1 AND r.user_id = ?2 AND r.client_id = ?3 AND r.consent_hash = ?4)
  OR EXISTS (SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id = ?2 AND r.client_id = ?3 AND r.consent_hash = ?4)
  OR EXISTS (SELECT 1 FROM revocations r WHERE r.kind = 'user' AND r.resource_id = ?2))`;
/** Consume a secret or GitHub handoff once under its original connection proof. */
export async function consumeMcpHandoff(
  context: CatalogContext,
  rawInput: unknown,
): Promise<McpPortalHandoff | null> {
  const input = consumeMcpHandoffInput.parse(rawInput);
  if ((await routeHandoff(context, input.requestHash)) !== input.organizationId) return null;
  const { db } = await routeOrganization(context, input.organizationId);
  const command: Command<HandoffRow | null, McpPortalHandoff | null> = {
    name: "identity.consumeMcpHandoff",
    input,
    retryOn: ["precondition_changed", "consent_changed"],
    lookup: async (reader) => {
      const row = await reader
        .prepare(
          `SELECT ${HANDOFF_COLUMNS} FROM mcp_portal_handoffs WHERE request_hash=?1 AND user_id=?2 AND organization_id=?3 AND consumed_at=?4
           AND json_extract(secret_target,'$.submissionId') IS ?5`,
        )
        .bind(
          input.requestHash,
          input.userId,
          input.organizationId,
          input.now,
          input.submissionId ?? null,
        )
        .first<HandoffRow>();
      if (row === null || row.kind === "grant") return undefined;
      if (
        input.approve &&
        row.secret_target !== null &&
        secretTarget.parse(JSON.parse(row.secret_target)).nativeProvider
      )
        return undefined;
      const outcome = consumedOutcome(row.kind, input.approve, input.submissionId);
      return row.outcome === outcome || row.outcome === `${row.kind}_failed`
        ? { ...handoffOf(row), outcome }
        : undefined;
    },
    read: async (reader) => {
      const row = await reader
        .prepare(
          `SELECT ${HANDOFF_COLUMNS} FROM mcp_portal_handoffs h WHERE request_hash=?1 AND user_id=?2 AND organization_id=?3 AND expires_at>?4
           AND (consumed_at IS NULL OR (?5=0 AND json_type(secret_target,'$.nativeProvider')='object' AND outcome IN('secret_submitted','secret_failed')))
           AND (json_type(secret_target,'$.nativeProvider') IS NULL OR NOT EXISTS(SELECT 1 FROM native_auth_handoff_attempts a WHERE a.organization_id=h.organization_id AND a.request_hash=h.request_hash AND (a.state='succeeded' OR (a.state='active' AND a.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')))))
           AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=h.user_id AND r.client_id=h.client_id AND r.consent_hash=h.consent_hash)
           AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=h.organization_id AND r.user_id=h.user_id AND r.client_id=h.client_id AND r.consent_hash=h.consent_hash)
           AND NOT EXISTS(SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=h.user_id)`,
        )
        .bind(
          input.requestHash,
          input.userId,
          input.organizationId,
          input.now,
          input.approve ? 1 : 0,
        )
        .first<HandoffRow>();
      if (row === null || row.kind === "grant" || row.authority === null) return null;
      const authority = handoffAuthority.parse(JSON.parse(row.authority));
      const target =
        row.secret_target === null ? null : secretTarget.parse(JSON.parse(row.secret_target));
      if (target?.nativeProvider && input.approve) return null;
      if (Boolean(target?.names) !== (input.submissionId !== undefined)) return null;
      const action = target?.nativeProvider
        ? "auth:manage"
        : row.kind === "secret"
          ? "secrets:write"
          : "sources:link";
      const who = {
        organizationId: input.organizationId,
        userId: input.userId,
        clientId: row.client_id,
        consentHash: row.consent_hash,
      };
      const current = canonicalAuthorizationCondition({
        organizationId: who.organizationId,
        principalId: `user:${who.userId}`,
        action,
        ...(target === null
          ? {}
          : { projectId: target.projectId, environmentId: target.environmentId }),
      });
      const [proof, allowed] = await reader.batch([
        activeGrantSelect(reader, who, target?.projectId ?? null, false),
        reader.prepare(`SELECT (${current.sql}) AS allowed`).bind(...current.params),
      ]);
      if (
        proof?.results[0]?.["grant_id"] !== authority.grantId ||
        allowed?.results[0]?.["allowed"] !== 1
      )
        return null;
      return row;
    },
    decide: (row) => {
      if (row === null || row.kind === "grant" || row.authority === null) return { replay: null };
      const authority = handoffAuthority.parse(JSON.parse(row.authority));
      const target =
        row.secret_target === null ? null : secretTarget.parse(JSON.parse(row.secret_target));
      if (target?.nativeProvider && input.approve) return { replay: null };
      const nativeDecline = target?.nativeProvider !== undefined;
      const action = nativeDecline
        ? "auth:manage"
        : row.kind === "secret"
          ? "secrets:write"
          : "sources:link";
      const who = {
        organizationId: input.organizationId,
        userId: input.userId,
        clientId: row.client_id,
        consentHash: row.consent_hash,
      };
      if (
        authority.action !== action ||
        authority.clientId !== who.clientId ||
        authority.consentHash !== who.consentHash ||
        (row.kind === "secret" && target === null) ||
        !restrictionAllows(authority.authorizationRestriction, {
          action,
          organizationId: who.organizationId,
          ...(target === null ? {} : { projectId: target.projectId }),
        })
      )
        return { replay: null };
      const outcome = consumedOutcome(row.kind, input.approve, input.submissionId);
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT (NOT ${REVOKED_SQL} AND EXISTS(SELECT 1 FROM mcp_portal_handoffs h WHERE request_hash=?5 AND expires_at>?6
              AND (consumed_at IS NULL OR (?7=1 AND outcome IN('secret_submitted','secret_failed')))
              AND (?7=0 OR NOT EXISTS(SELECT 1 FROM native_auth_handoff_attempts a WHERE a.organization_id=h.organization_id AND a.request_hash=h.request_hash AND (a.state='succeeded' OR (a.state='active' AND a.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')))))))`,
            [
              who.organizationId,
              who.userId,
              who.clientId,
              who.consentHash,
              row.request_hash,
              input.now,
              nativeDecline ? 1 : 0,
            ],
          ),
          canonicalAuthorizationGuard(db, {
            organizationId: who.organizationId,
            principalId: `user:${who.userId}`,
            action,
            ...(target === null
              ? {}
              : { projectId: target.projectId, environmentId: target.environmentId }),
          }),
          activeGrantGuard(db, who, target?.projectId ?? null, false, authority.grantId),
          db
            .prepare(
              `UPDATE mcp_portal_handoffs SET consumed_at=COALESCE(consumed_at,?2), outcome=?3,
               secret_target=CASE WHEN ?5 IS NULL THEN secret_target ELSE json_set(secret_target,'$.submissionId',?5) END
               WHERE request_hash=?1 AND (consumed_at IS NULL OR ?4=1)`,
            )
            .bind(
              row.request_hash,
              input.now,
              outcome,
              nativeDecline ? 1 : 0,
              input.submissionId ?? null,
            ),
        ],
        result: () => {
          const handoff = handoffOf(row);
          return {
            ...handoff,
            consumedAt: publicTimestamp(row.consumed_at ?? input.now),
            outcome,
            ...(handoff.secretTarget && input.submissionId
              ? { secretTarget: { ...handoff.secretTarget, submissionId: input.submissionId } }
              : {}),
          };
        },
      };
    },
  };
  const committed = await command.lookup?.(db);
  return committed === undefined ? runMapped(db, command, {}) : committed;
}

/**
 * A single secret remains failed until its write is confirmed. A grouped submission reserves its own
 * result slot; its public status stays pending until the per-name outcomes arrive or the link expires.
 */
function consumedOutcome(
  kind: "secret" | "github",
  approve: boolean,
  submissionId: string | undefined,
): NonNullable<McpPortalHandoff["outcome"]> {
  if (!approve) return "declined";
  if (kind === "github") return "github_started";
  return submissionId === undefined ? "secret_failed" : "secret_submitted";
}

const completeInput = z.strictObject({ requestHash, succeeded: z.boolean() });
const completeBatchInput = z.strictObject({
  requestHash,
  submissionId: ulid,
  results: z.array(secretResult).min(1).max(10),
});

async function completeHandoff(
  context: CatalogContext,
  rawInput: unknown,
  kind: "secret" | "github",
): Promise<void> {
  const input = completeInput.parse(rawInput);
  // A consumed plain secret is already recorded as failed, so its only completion record is success.
  if (kind === "secret" ? !input.succeeded : input.succeeded) return;
  const organizationId = await routeHandoff(context, input.requestHash);
  if (organizationId === null) return;
  const shard = await routeOrganization(context, organizationId);
  await shard.db
    .prepare(
      kind === "secret"
        ? "UPDATE mcp_portal_handoffs SET outcome = 'secret_submitted' WHERE organization_id = ?1 AND request_hash = ?2 AND kind = 'secret' AND outcome = 'secret_failed' AND consumed_at IS NOT NULL AND json_type(secret_target,'$.nativeProvider') IS NULL AND json_type(secret_target,'$.names') IS NULL"
        : "UPDATE mcp_portal_handoffs SET outcome = 'github_failed' WHERE organization_id = ?1 AND request_hash = ?2 AND kind = 'github' AND outcome = 'github_started'",
    )
    .bind(organizationId, input.requestHash)
    .run();
}

/** `completeSecret`: a consumed batch records its ordered statuses once, together with the outcome. */
export async function completeMcpSecret(context: CatalogContext, rawInput: unknown): Promise<void> {
  const input = z.union([completeInput, completeBatchInput]).parse(rawInput);
  if ("succeeded" in input) return completeHandoff(context, input, "secret");
  const organizationId = await routeHandoff(context, input.requestHash);
  if (organizationId === null) return;
  const { db } = await routeOrganization(context, organizationId);
  const outcome = input.results.every((result) => result === "saved")
    ? "secret_submitted"
    : "secret_failed";
  await db
    .prepare(
      `UPDATE mcp_portal_handoffs SET outcome=?1, secret_target=json_set(secret_target,'$.results',json(?2))
       WHERE organization_id=?3 AND request_hash=?4 AND kind='secret' AND outcome='secret_submitted'
       AND consumed_at IS NOT NULL AND json_extract(secret_target,'$.submissionId')=?5
       AND json_type(secret_target,'$.names')='array' AND json_array_length(secret_target,'$.names')=?6
       AND json_type(secret_target,'$.results') IS NULL`,
    )
    .bind(
      outcome,
      JSON.stringify(input.results),
      organizationId,
      input.requestHash,
      input.submissionId,
      input.results.length,
    )
    .run();
}

const nativeHandoffScope = z.strictObject({
  organizationId: ulid,
  userId: identity.shape.userId,
  requestHash,
});
const nativeHandoffClaim = nativeHandoffScope.extend({ attemptId: ulid, valueSha256: requestHash });
interface NativeAttempt {
  attempt_id: string;
  state: "active" | "failed" | "succeeded";
  lease_until: string;
  value_sha256: string;
}
interface NativeHandoffSnapshot {
  row: HandoffRow;
  target: z.output<typeof secretTarget>;
  authority: z.output<typeof handoffAuthority>;
  attempt: NativeAttempt | null;
}

async function nativeHandoffSnapshot(
  db: D1Database,
  i: z.output<typeof nativeHandoffScope>,
): Promise<NativeHandoffSnapshot | null> {
  const [handoffs, attempts] = await db.batch([
    db
      .prepare(
        `SELECT ${HANDOFF_COLUMNS} FROM mcp_portal_handoffs h WHERE h.organization_id=?1 AND h.user_id=?2 AND h.request_hash=?3 AND h.kind='secret'
      AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=h.user_id AND r.client_id=h.client_id AND r.consent_hash=h.consent_hash)
      AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=h.organization_id AND r.user_id=h.user_id AND r.client_id=h.client_id AND r.consent_hash=h.consent_hash)
      AND NOT EXISTS(SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=h.user_id)`,
      )
      .bind(i.organizationId, i.userId, i.requestHash),
    db
      .prepare(
        "SELECT attempt_id,state,lease_until,value_sha256 FROM native_auth_handoff_attempts WHERE organization_id=?1 AND request_hash=?2",
      )
      .bind(i.organizationId, i.requestHash),
  ]);
  const row = handoffs?.results[0] as HandoffRow | undefined;
  if (!row || !row.secret_target || !row.authority) return null;
  const target = secretTarget.parse(JSON.parse(row.secret_target)),
    authority = handoffAuthority.parse(JSON.parse(row.authority));
  if (
    !target.nativeProvider ||
    authority.action !== "auth:manage" ||
    authority.clientId !== row.client_id ||
    authority.consentHash !== row.consent_hash ||
    !restrictionAllows(authority.authorizationRestriction, {
      action: "auth:manage",
      organizationId: i.organizationId,
      projectId: target.projectId,
    })
  )
    return null;
  const who = {
    organizationId: i.organizationId,
    userId: i.userId,
    clientId: row.client_id,
    consentHash: row.consent_hash,
  };
  const condition = canonicalAuthorizationCondition({
    organizationId: i.organizationId,
    principalId: `user:${i.userId}`,
    projectId: target.projectId,
    environmentId: target.environmentId,
    action: "auth:manage",
  });
  const [proof, allowed] = await db.batch([
    activeGrantSelect(db, who, target.projectId, false),
    db.prepare(`SELECT (${condition.sql}) AS allowed`).bind(...condition.params),
  ]);
  if (
    proof?.results[0]?.["grant_id"] !== authority.grantId ||
    allowed?.results[0]?.["allowed"] !== 1
  )
    return null;
  return {
    row,
    target,
    authority,
    attempt: (attempts?.results[0] as unknown as NativeAttempt | undefined) ?? null,
  };
}

/** Status contains no value or digest and always rechecks current Owner and original delegation. */
export async function readNativeProviderHandoffState(context: CatalogContext, raw: unknown) {
  const i = nativeHandoffScope.parse(raw);
  if ((await routeHandoff(context, i.requestHash)) !== i.organizationId) return null;
  const { db } = await routeOrganization(context, i.organizationId),
    state = await nativeHandoffSnapshot(db, i);
  if (state === null) return null;
  if (state.row.outcome === "declined") return "declined" as const;
  const now = storedTimestamp(new Date().toISOString());
  if (state.attempt?.state === "succeeded") return "succeeded" as const;
  if (state.row.expires_at <= now) return "expired" as const;
  if (state.attempt?.state === "active" && state.attempt.lease_until > now)
    return "pending" as const;
  return "retryable" as const;
}

/** One lease per human submission; the original handoff and target remain immutable across retries. */
export async function claimNativeProviderHandoff(
  context: CatalogContext,
  raw: unknown,
): Promise<McpPortalHandoff | null> {
  const i = nativeHandoffClaim.parse(raw);
  if ((await routeHandoff(context, i.requestHash)) !== i.organizationId) return null;
  const { db } = await routeOrganization(context, i.organizationId);
  const now = storedTimestamp(new Date().toISOString()),
    until = addMilliseconds(now, 60_000);
  const read = (reader: D1Database) => nativeHandoffSnapshot(reader, i);
  const command: Command<NativeHandoffSnapshot | null, McpPortalHandoff | null> = {
    name: "identity.claimNativeProviderHandoff",
    input: i,
    read,
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["native_auth_handoff_attempts"],
    async lookup(reader) {
      const s = await read(reader);
      const liveNow = storedTimestamp(new Date().toISOString());
      return s?.attempt?.state === "active" &&
        s.attempt.attempt_id === i.attemptId &&
        s.attempt.value_sha256 === i.valueSha256 &&
        s.attempt.lease_until > liveNow &&
        s.row.expires_at > liveNow
        ? handoffOf(s.row)
        : undefined;
    },
    decide(s) {
      const liveNow = storedTimestamp(new Date().toISOString());
      if (
        !s ||
        s.row.expires_at <= liveNow ||
        (s.row.outcome !== null &&
          s.row.outcome !== "secret_submitted" &&
          s.row.outcome !== "secret_failed")
      )
        return { replay: null };
      if (s.attempt !== null && s.attempt.value_sha256 !== i.valueSha256) return { replay: null };
      if (
        s.attempt?.state === "succeeded" ||
        (s.attempt?.state === "active" && s.attempt.lease_until > liveNow)
      )
        return {
          replay:
            s.attempt?.attempt_id === i.attemptId && s.attempt.state === "active"
              ? handoffOf(s.row)
              : null,
        };
      const who = {
        organizationId: i.organizationId,
        userId: i.userId,
        clientId: s.row.client_id,
        consentHash: s.row.consent_hash,
      };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT (NOT ${REVOKED_SQL} AND EXISTS(SELECT 1 FROM mcp_portal_handoffs WHERE organization_id=?1 AND request_hash=?5 AND user_id=?2 AND expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND authority IS ?6 AND secret_target IS ?7 AND kind='secret' AND (outcome IS NULL OR outcome IN('secret_submitted','secret_failed'))))`,
            [
              i.organizationId,
              i.userId,
              s.row.client_id,
              s.row.consent_hash,
              i.requestHash,
              s.row.authority,
              s.row.secret_target,
            ],
          ),
          canonicalAuthorizationGuard(db, {
            organizationId: i.organizationId,
            principalId: `user:${i.userId}`,
            projectId: s.target.projectId,
            environmentId: s.target.environmentId,
            action: "auth:manage",
          }),
          activeGrantGuard(db, who, s.target.projectId, false, s.authority.grantId),
          db
            .prepare(
              `INSERT INTO native_auth_handoff_attempts(organization_id,request_hash,attempt_id,first_attempt_id,state,lease_until,value_sha256) VALUES(?1,?2,?3,?3,'active',?4,?5)
          ON CONFLICT(organization_id,request_hash) DO UPDATE SET attempt_id=excluded.attempt_id,state='active',lease_until=excluded.lease_until
          WHERE native_auth_handoff_attempts.value_sha256=excluded.value_sha256 AND (native_auth_handoff_attempts.state='failed' OR (native_auth_handoff_attempts.state='active' AND native_auth_handoff_attempts.lease_until<=(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')))`,
            )
            .bind(i.organizationId, i.requestHash, i.attemptId, until, i.valueSha256),
          guard(db, "precondition_changed", "changes()=0"),
          db
            .prepare(
              "INSERT INTO native_auth_handoff_attempt_events(organization_id,request_hash,attempt_id,event,occurred_at) VALUES(?1,?2,?3,'started',?4)",
            )
            .bind(i.organizationId, i.requestHash, i.attemptId, now),
          db
            .prepare(
              "UPDATE mcp_portal_handoffs SET outcome=CASE WHEN consumed_at IS NULL THEN 'secret_submitted' ELSE outcome END,consumed_at=COALESCE(consumed_at,?3) WHERE organization_id=?1 AND request_hash=?2",
            )
            .bind(i.organizationId, i.requestHash, now),
        ],
        result: () => ({
          ...handoffOf(s.row),
          consumedAt:
            s.row.consumed_at === null ? publicTimestamp(now) : publicTimestamp(s.row.consumed_at),
          outcome: s.row.outcome ?? "secret_submitted",
        }),
      };
    },
  };
  return runCommand(db, command);
}

/** A late response may settle only the exact current attempt, never its successor. */
export async function completeNativeProviderHandoff(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = z
    .strictObject({ organizationId: ulid, requestHash, attemptId: ulid, succeeded: z.boolean() })
    .parse(raw);
  if ((await routeHandoff(context, i.requestHash)) !== i.organizationId) return false;
  const { db } = await routeOrganization(context, i.organizationId),
    outcome = i.succeeded ? "succeeded" : "failed";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO native_auth_handoff_attempt_events(organization_id,request_hash,attempt_id,event,occurred_at)
      SELECT ?1,?2,?3,?4,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') WHERE EXISTS(SELECT 1 FROM native_auth_handoff_attempt_events WHERE organization_id=?1 AND request_hash=?2 AND attempt_id=?3 AND event='started')
      ON CONFLICT DO NOTHING`,
      )
      .bind(i.organizationId, i.requestHash, i.attemptId, outcome),
    db
      .prepare(
        "UPDATE native_auth_handoff_attempts SET state=?4 WHERE organization_id=?1 AND request_hash=?2 AND attempt_id=?3 AND state='active'",
      )
      .bind(i.organizationId, i.requestHash, i.attemptId, outcome),
    db
      .prepare(
        "UPDATE mcp_portal_handoffs SET outcome=?4 WHERE organization_id=?1 AND request_hash=?2 AND kind='secret' AND outcome='secret_submitted' AND EXISTS(SELECT 1 FROM native_auth_handoff_attempts WHERE organization_id=?1 AND request_hash=?2 AND first_attempt_id=?3) AND EXISTS(SELECT 1 FROM native_auth_handoff_attempt_events WHERE organization_id=?1 AND request_hash=?2 AND attempt_id=?3 AND event=?5)",
      )
      .bind(
        i.organizationId,
        i.requestHash,
        i.attemptId,
        i.succeeded ? "secret_submitted" : "secret_failed",
        outcome,
      ),
    db
      .prepare(
        "SELECT state FROM native_auth_handoff_attempts WHERE organization_id=?1 AND request_hash=?2 AND attempt_id=?3",
      )
      .bind(i.organizationId, i.requestHash, i.attemptId),
  ]);
  return results[3]?.results[0]?.["state"] === outcome;
}

/** `completeGithub`: a failed GitHub start is recorded on its consumed handoff (idempotent). */
export async function completeMcpGithub(context: CatalogContext, rawInput: unknown): Promise<void> {
  await completeHandoff(context, rawInput, "github");
}

/** Creates durable identity evidence after the API has authorized the concrete action. */
export async function ensureMcpConnectionProof(
  context: CatalogContext,
  rawInput: unknown,
): Promise<McpDelegationGrant | null> {
  const input = z
    .strictObject({ ...identity.shape, projectId: ulid.nullable(), now: instant })
    .parse(rawInput);
  const { projectId, now, ...who } = input;
  const db = (await routeOrganization(context, who.organizationId)).db;
  const grantId = await derivedUuid(
    `mcp-proof|${who.organizationId}|${who.userId}|${who.clientId}|${who.consentHash}|${projectId ?? ""}|${crypto.randomUUID()}`,
  );
  await db
    .prepare(
      `INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at)
    SELECT ?1,?6,?2,?3,?4,?5,p.ownership_version,p.active_billing_epoch_id,1,1,?7
    FROM organizations o LEFT JOIN projects p ON p.organization_id=o.organization_id AND p.project_id=?5
    WHERE o.organization_id=?1 AND o.state='active' AND o.beta_admitted_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM organization_memberships m WHERE m.organization_id=?1 AND m.workos_user_id=?2 AND m.state='active' AND ${BARRIER_FREE_MEMBERSHIP_SQL})
      AND NOT EXISTS(SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=?2)
      AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=?1 AND r.user_id=?2 AND r.client_id=?3 AND r.consent_hash=?4)
      AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=?2 AND r.client_id=?3 AND r.consent_hash=?4)
      AND (?5 IS NULL OR (p.owner_state='active' AND p.lifecycle_state='active'))
    ON CONFLICT (organization_id,user_id,client_id,consent_hash,COALESCE(project_id,''),COALESCE(ownership_version,-1),COALESCE(billing_epoch_id,''))
    DO UPDATE SET revoked_at=NULL
    WHERE mcp_client_grants.ownership_version IS excluded.ownership_version
      AND mcp_client_grants.billing_epoch_id IS excluded.billing_epoch_id
      AND mcp_client_grants.revoked_at IS NOT NULL`,
    )
    .bind(who.organizationId, who.userId, who.clientId, who.consentHash, projectId, grantId, now)
    .run();
  const row = await db
    .prepare(
      `SELECT g.grant_id,g.project_id,g.allow_publish,g.created_at,g.revoked_at FROM mcp_client_grants g
    WHERE g.organization_id=?1 AND g.user_id=?2 AND g.client_id=?3 AND g.consent_hash=?4 AND g.project_id IS ?5 AND g.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM organization_memberships m JOIN organizations o ON o.organization_id=m.organization_id WHERE m.organization_id=?1 AND m.workos_user_id=?2 AND m.state='active' AND o.state='active' AND o.beta_admitted_at IS NOT NULL AND ${BARRIER_FREE_MEMBERSHIP_SQL})
    AND (?5 IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?5 AND p.owner_state='active' AND p.lifecycle_state='active' AND p.ownership_version=g.ownership_version AND p.active_billing_epoch_id=g.billing_epoch_id))
    AND NOT EXISTS(SELECT 1 FROM revocations r WHERE r.kind='user' AND r.resource_id=?2)
    AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=?1 AND r.user_id=?2 AND r.client_id=?3 AND r.consent_hash=?4)
    AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=?2 AND r.client_id=?3 AND r.consent_hash=?4)`,
    )
    .bind(who.organizationId, who.userId, who.clientId, who.consentHash, projectId)
    .first<{
      grant_id: string;
      project_id: string | null;
      allow_publish: number;
      created_at: string;
      revoked_at: string | null;
    }>();
  return row === null ? null : grantOf(who, row);
}

function grantOf(
  who: McpIdentity,
  row: {
    grant_id: string;
    project_id: string | null;
    allow_publish: number;
    created_at: string;
    revoked_at: string | null;
  },
): McpDelegationGrant {
  return {
    ...who,
    grantId: row.grant_id,
    projectId: row.project_id,
    allowPublish: row.allow_publish === 1,
    createdAt: publicTimestamp(row.created_at),
    revokedAt: row.revoked_at === null ? null : publicTimestamp(row.revoked_at),
  };
}

const revokeInput = z.strictObject({
  userId: identity.shape.userId,
  clientId: identity.shape.clientId,
  consentHash: identity.shape.consentHash,
  now: instant,
});

/** A verified user disconnects this client/consent across every present and future workspace. */
export async function revokeMcpConsent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ state: "pending" | "revoked" }> {
  const input = revokeInput.parse(rawInput);
  const { db } = await context.router.routeShard(0);
  await db
    .prepare(
      "INSERT INTO mcp_connection_revocations(user_id,client_id,consent_hash,revoked_at) VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
    )
    .bind(input.userId, input.clientId, input.consentHash, input.now)
    .run();
  // Persist terminal intent before checking leases: new claims are fenced immediately.
  // A successful response is delayed until every previously admitted provider use drains.
  return { state: (await consentUseActive(db, input)) === null ? "revoked" : "pending" };
}

/** A provider use of this consent still holds a lease or recovery fence; null once everything has drained. */
export async function consentUseActive(
  db: D1Database,
  input: { readonly userId: string; readonly clientId: string; readonly consentHash: string },
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(
      `SELECT 1 FROM scoped_dns_provider_uses lease JOIN mcp_client_grants proof ON proof.organization_id=lease.organization_id AND proof.grant_id=lease.delegation_grant_id
    WHERE proof.user_id=?1 AND proof.client_id=?2 AND proof.consent_hash=?3 AND lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    UNION ALL SELECT 1 FROM project_recovery_fences fence JOIN operation_mcp_delegations proof ON proof.organization_id=fence.organization_id AND proof.operation_id=fence.operation_id
    WHERE proof.principal_id='user:'||?1 AND proof.client_id=?2 AND proof.consent_hash=?3 AND fence.released_at IS NULL AND fence.lease_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    UNION ALL SELECT 1 FROM github_connection_provider_uses lease WHERE lease.user_id=?1 AND lease.client_id=?2 AND lease.consent_hash=?3 AND lease.expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    UNION ALL SELECT 1 FROM compute_connection_provider_uses lease JOIN operation_mcp_delegations proof USING(organization_id,project_id,operation_id)
    WHERE proof.principal_id='user:'||?1 AND proof.client_id=?2 AND proof.consent_hash=?3 AND lease.lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') LIMIT 1`,
    )
    .bind(input.userId, input.clientId, input.consentHash)
    .first<Record<string, unknown>>();
}
