import { handoffAuthorityInput, handoffEffectGuards } from "../identity/handoff-effect.js";
import { z } from "zod";
import { INSTALLED_PLATFORM_KEY_NAMES } from "@ohmyhost/contracts/secret-names";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import {
  ACTIVE_SCOPE_SQL,
  PROVIDER_CLAIM_SQL,
  activeScopeParams,
  bytesOf,
  instant,
  isoOf,
  providerClaimParams,
  readSnapshot,
  reject,
  sameBytes,
  sha256,
  shardOfOrganization,
  ulid,
  type PlatformContext,
} from "../platform-support.js";

// The Postgres contract of environment_secrets.ciphertext (octet_length 17..65552) stays importable. The public limit is
// 5120 UTF-8 bytes (not characters), so the current cipher emits at most 5136 bytes, but historical rows may be larger.
export const MAXIMUM_CIPHERTEXT_BYTES = 65_552;
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const scope = {
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
};
const sealed = {
  name: secretName,
  ciphertext: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength >= 17 && value.byteLength <= MAXIMUM_CIPHERTEXT_BYTES),
  nonce: z.instanceof(Uint8Array).refine((value) => value.byteLength === 12),
  valueSha256: sha256,
  keyVersion: z.number().int().min(1),
  writtenAt: instant,
};
const providerClaim = z.strictObject({ operationId: ulid, claimId: ulid });
/** The installed platform keys an owner may rotate. Their values are generated and sealed by the control API. */
const ROTATABLE_PLATFORM_KEYS = INSTALLED_PLATFORM_KEY_NAMES;

export const putEnvironmentSecretInput = z.strictObject({
  ...scope,
  ...sealed,
  claim: providerClaim.optional(),
});
export const ensureEnvironmentSecretInput = putEnvironmentSecretInput;
export const listEnvironmentSecretsInput = z.strictObject(scope);
export const authorizeProviderEnvironmentSecretInput = z.strictObject({
  ...scope,
  ...providerClaim.shape,
});
export const mutateEnvironmentSecretInput = z.discriminatedUnion("action", [
  z.strictObject({
    ...scope,
    action: z.literal("set"),
    ...sealed,
    idempotencyKey: z.string().min(1).max(128),
    requestSha256: sha256,
    requestedAt: instant,
    principalId: z.string().optional(),
    handoffDelegation: handoffAuthorityInput.optional(),
  }),
  z.strictObject({
    ...scope,
    action: z.literal("delete"),
    name: secretName,
    idempotencyKey: z.string().min(1).max(128),
    requestSha256: sha256,
    requestedAt: instant,
    principalId: z.string().optional(),
    handoffDelegation: handoffAuthorityInput.optional(),
  }),
  z.strictObject({
    ...scope,
    action: z.literal("rotate"),
    ...sealed,
    name: z.enum(ROTATABLE_PLATFORM_KEYS),
    idempotencyKey: z.string().min(1).max(128),
    requestSha256: sha256,
    requestedAt: instant,
    principalId: z.string().optional(),
    handoffDelegation: handoffAuthorityInput.optional(),
  }),
]);

export interface EnvironmentSecretMetadata {
  readonly name: string;
  readonly revision: number;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnvironmentSecretMutationResponse =
  | { readonly status: "stored"; readonly secret: EnvironmentSecretMetadata }
  | { readonly status: "deleted" | "absent"; readonly name: string };

const storedResponse = z.union([
  z.strictObject({
    status: z.literal("stored"),
    secret: z.strictObject({
      name: secretName,
      revision: z.number().int().min(1),
      keyVersion: z.number().int().min(1),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  }),
  z.strictObject({ status: z.enum(["deleted", "absent"]), name: secretName }),
]);

const SCOPE_INACTIVE = reject(
  "environment_secret_scope_inactive",
  "Environment secret scope is not active",
);

interface SecretRow {
  readonly revision: number;
  readonly key_version: number;
  readonly value_sha256: unknown;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SecretSnapshot {
  readonly scopeActive: boolean;
  readonly claimCurrent: boolean;
  readonly deliveryState: boolean;
  readonly secret: SecretRow | null;
}

function metadata(
  name: string,
  row: { revision: number; keyVersion: number; createdAt: string; updatedAt: string },
): EnvironmentSecretMetadata {
  return {
    name,
    revision: row.revision,
    keyVersion: row.keyVersion,
    createdAt: isoOf(row.createdAt),
    updatedAt: isoOf(row.updatedAt),
  };
}

type SecretScope = { organizationId: string; projectId: string; environmentId: string };

const DELIVERY_STATE_SQL = `SELECT 1 FROM runtime_secret_delivery_states WHERE organization_id = ? AND project_id = ? AND environment_id = ?`;

type SecretSnapshotInput = SecretScope & {
  name: string;
  claim?: { operationId: string; claimId: string } | undefined;
};
/** Internal composition: the actual runtime compounds append authority/key reads to this SAME native snapshot batch. */
export function secretSnapshotQueries(
  input: SecretSnapshotInput,
): readonly (readonly [string, ...unknown[]])[] {
  const parameters = activeScopeParams(input.organizationId, input.projectId, input.environmentId);
  return [
    [ACTIVE_SCOPE_SQL, ...parameters],
    input.claim === undefined
      ? ["SELECT 1 WHERE 0"]
      : [PROVIDER_CLAIM_SQL, ...providerClaimParams({ ...input, ...input.claim })],
    [DELIVERY_STATE_SQL, input.organizationId, input.projectId, input.environmentId],
    [
      "SELECT revision,key_version,value_sha256,created_at,updated_at FROM environment_secrets WHERE organization_id=? AND project_id=? AND environment_id=? AND name=?",
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.name,
    ],
  ];
}
export function secretSnapshotOf(
  rows: Record<string, unknown>[][],
  hasClaim: boolean,
): SecretSnapshot {
  const [active, claim, delivery, secret] = rows;
  return {
    scopeActive: (active?.length ?? 0) === 1,
    claimCurrent: !hasClaim || (claim?.length ?? 0) === 1,
    deliveryState: (delivery?.length ?? 0) === 1,
    secret: (secret?.[0] as SecretRow | undefined) ?? null,
  };
}
export async function readSecretSnapshot(
  db: D1Database,
  input: SecretSnapshotInput,
): Promise<SecretSnapshot> {
  return secretSnapshotOf(
    await readSnapshot(db, secretSnapshotQueries(input)),
    input.claim !== undefined,
  );
}

/** Guards that keep a secret write valid at commit time: the scope, the optional provider claim and the delivery state. */
function scopeGuards(
  db: D1Database,
  input: SecretScope & { claim?: { operationId: string; claimId: string } | undefined },
  needsDeliveryState: boolean,
): D1PreparedStatement[] {
  const parameters = activeScopeParams(input.organizationId, input.projectId, input.environmentId);
  return [
    guard(db, "scope_inactive", `NOT EXISTS (${ACTIVE_SCOPE_SQL})`, parameters),
    ...(input.claim === undefined
      ? []
      : [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS (${PROVIDER_CLAIM_SQL})`,
            providerClaimParams({ ...input, ...input.claim }),
          ),
        ]),
    ...(needsDeliveryState
      ? [
          guard(db, "precondition_changed", `NOT EXISTS (${DELIVERY_STATE_SQL})`, [
            input.organizationId,
            input.projectId,
            input.environmentId,
          ]),
        ]
      : []),
  ];
}

/** Earlier accepted writes may arrive after later ones: advance generation without moving observation time backwards. */
function advanceDelivery(db: D1Database, input: SecretScope, at: string): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE runtime_secret_delivery_states SET desired_generation = desired_generation + 1, updated_at = MAX(updated_at, ?) WHERE organization_id = ? AND project_id = ? AND environment_id = ?",
    )
    .bind(at, input.organizationId, input.projectId, input.environmentId);
}

type PutInput = z.output<typeof putEnvironmentSecretInput>;
type PutResult = {
  readonly outcome: "created" | "existing" | "updated";
  readonly metadata: EnvironmentSecretMetadata;
};

/**
 * Plans the write of one sealed secret. `overwrite` distinguishes put (a different value replaces the
 * envelope under a revision bump) from ensure (an existing secret is never touched).
 */
export function planPut(
  db: D1Database,
  input: PutInput,
  snapshot: SecretSnapshot,
  overwrite: boolean,
): Plan<PutResult> {
  if (!snapshot.scopeActive || !snapshot.claimCurrent) return SCOPE_INACTIVE;
  const row = snapshot.secret;
  if (
    row !== null &&
    (!overwrite ||
      (sameBytes(bytesOf(row.value_sha256), input.valueSha256) &&
        row.key_version === input.keyVersion))
  ) {
    return {
      replay: {
        outcome: "existing",
        metadata: metadata(input.name, {
          revision: row.revision,
          keyVersion: row.key_version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      },
    };
  }
  const write =
    row === null
      ? db
          .prepare(
            "INSERT INTO environment_secrets(organization_id, project_id, environment_id, name, ciphertext, nonce, value_sha256, key_version, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.name,
            input.ciphertext,
            input.nonce,
            input.valueSha256,
            input.keyVersion,
            input.writtenAt,
          )
      : db
          .prepare(
            "UPDATE environment_secrets SET ciphertext = ?5, nonce = ?6, value_sha256 = ?7, key_version = ?8, revision = revision + 1, updated_at = ?9 WHERE organization_id = ?1 AND project_id = ?2 AND environment_id = ?3 AND name = ?4 AND revision = ?10",
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.name,
            input.ciphertext,
            input.nonce,
            input.valueSha256,
            input.keyVersion,
            input.writtenAt,
            row.revision,
          );
  const result: PutResult = {
    outcome: row === null ? "created" : "updated",
    metadata: metadata(input.name, {
      revision: row === null ? 1 : row.revision + 1,
      keyVersion: input.keyVersion,
      createdAt: row === null ? input.writtenAt : row.created_at,
      updatedAt: input.writtenAt,
    }),
  };
  return {
    statements: [
      // A new environment has no delivery state until its first deployment or secret write. Initialize it in this
      // same guarded transaction, so concurrent first writes preserve every generation and a later failure rolls it back.
      ...(snapshot.deliveryState
        ? []
        : [
            db
              .prepare(
                "INSERT INTO runtime_secret_delivery_states(organization_id,project_id,environment_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(organization_id,project_id,environment_id) DO NOTHING",
              )
              .bind(input.organizationId, input.projectId, input.environmentId, input.writtenAt),
          ]),
      ...scopeGuards(db, input, true),
      write,
      ...(row === null ? [] : [guard(db, "row_version_conflict", "changes() = 0")]),
      advanceDelivery(db, input, input.writtenAt),
    ],
    result: () => result,
  };
}

function putCommand(
  db: D1Database,
  name: string,
  input: PutInput,
  overwrite: boolean,
): Command<SecretSnapshot, PutResult> {
  return {
    name,
    input,
    retryOn: ["row_version_conflict", "scope_inactive", "precondition_changed"],
    naturalKeyTables: ["environment_secrets"],
    read: (shard) => readSecretSnapshot(shard, input),
    decide: (snapshot) => planPut(db, input, snapshot, overwrite),
  };
}

/** `putEnvironmentSecret` plus the optional provider-claim authorization the runtime secret delivery Worker runs in the same transaction. */
export async function putEnvironmentSecret(
  context: PlatformContext,
  raw: unknown,
): Promise<PutResult> {
  const input = putEnvironmentSecretInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  return runCommand(db, putCommand(db, "secrets.putEnvironmentSecret", input, true));
}

/** Creates the secret when it does not exist; an existing secret is returned untouched. */
export async function ensureEnvironmentSecret(
  context: PlatformContext,
  raw: unknown,
): Promise<PutResult> {
  const input = ensureEnvironmentSecretInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  return runCommand(db, putCommand(db, "secrets.ensureEnvironmentSecret", input, false));
}

/** The provider mutation claim authorizes platform secret writes for exactly this scope. */
export async function authorizeProviderEnvironmentSecret(
  context: PlatformContext,
  raw: unknown,
): Promise<{ readonly authorized: true }> {
  const input = authorizeProviderEnvironmentSecretInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  const [claim] = await readSnapshot(db, [[PROVIDER_CLAIM_SQL, ...providerClaimParams(input)]]);
  if ((claim?.length ?? 0) !== 1) throw SCOPE_INACTIVE.reject;
  return { authorized: true };
}

export async function listEnvironmentSecrets(
  context: PlatformContext,
  raw: unknown,
): Promise<readonly EnvironmentSecretMetadata[]> {
  const input = listEnvironmentSecretsInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  const rows = await db
    .prepare(
      `SELECT es.name, es.revision, es.key_version, es.created_at, es.updated_at
         FROM environment_secrets es
         JOIN projects p ON p.organization_id = es.organization_id AND p.project_id = es.project_id AND p.owner_state = 'active'
         JOIN billing_epochs be ON be.organization_id = p.organization_id AND be.billing_epoch_id = p.active_billing_epoch_id AND be.project_id = p.project_id AND be.ended_at IS NULL
        WHERE es.organization_id = ? AND es.project_id = ? AND es.environment_id = ?
        ORDER BY es.name`,
    )
    .bind(input.organizationId, input.projectId, input.environmentId)
    .all<{
      name: string;
      revision: number;
      key_version: number;
      created_at: string;
      updated_at: string;
    }>();
  return rows.results.map((row) =>
    metadata(row.name, {
      revision: row.revision,
      keyVersion: row.key_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
}

type MutateInput = z.output<typeof mutateEnvironmentSecretInput>;

interface MutateSnapshot extends SecretSnapshot {
  readonly receipt: {
    readonly name: string;
    readonly request_sha256: unknown;
    readonly response: string;
  } | null;
  readonly mutable: boolean;
  readonly blockedByClaim: boolean;
  readonly apiDelivery: ApiSecretDeliveryState | undefined;
}

async function readMutateSnapshot(
  db: D1Database,
  input: MutateInput,
  includeApiDelivery = false,
): Promise<MutateSnapshot> {
  const base = await readSecretSnapshot(db, input);
  const [receipt, mutable, blocked, apiDelivery] = await readSnapshot(db, [
    [
      "SELECT name, request_sha256, response FROM environment_secret_requests WHERE organization_id = ? AND project_id = ? AND environment_id = ? AND action = ? AND idempotency_key = ?",
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.action,
      input.idempotencyKey,
    ],
    [
      "SELECT 1 FROM projects p JOIN environments e ON e.organization_id = p.organization_id AND e.project_id = p.project_id AND e.environment_id = ? WHERE p.organization_id = ? AND p.project_id = ? AND p.lifecycle_state = 'active' AND p.owner_state = 'active'",
      input.environmentId,
      input.organizationId,
      input.projectId,
    ],
    [
      "SELECT 1 FROM product_provider_mutation_claims WHERE organization_id = ? AND project_id = ?",
      input.organizationId,
      input.projectId,
    ],
    ...(includeApiDelivery
      ? [[API_DELIVERY_SQL, input.organizationId, input.projectId, input.environmentId] as const]
      : []),
  ]);
  return {
    ...base,
    receipt: (receipt?.[0] as MutateSnapshot["receipt"] | undefined) ?? null,
    mutable: (mutable?.length ?? 0) === 1,
    blockedByClaim: (blocked?.length ?? 0) > 0,
    apiDelivery: apiDeliveryOf(apiDelivery?.[0]),
  };
}

/**
 * The control API's secret mutation as one command: idempotency receipt, project authorization, the
 * put or delete, the delivery-generation advance and the stored response commit in one batch.
 */
export async function mutateEnvironmentSecret(
  context: PlatformContext,
  raw: unknown,
): Promise<EnvironmentSecretMutationResponse> {
  const input = mutateEnvironmentSecretInput.parse(raw);
  const db = await shardOfOrganization(context, input.organizationId);
  return runCommand(db, mutationCommand(db, input));
}

const SECRET_ROW = `SELECT * FROM environment_secrets WHERE organization_id = ?1 AND project_id = ?2 AND environment_id = ?3 AND name = ?4`;
const SECRET_UPDATED_MS = "(substr(secret.updated_at,1,23)||'000Z')";
/**
 * The next key version of a Storage gateway key, appended from the rotated secret in the same batch. The guard after it
 * holds the batch back unless the newest version is exactly the rotated digest, created at the rotation instant. A Mail
 * key has no version history: the Mail gateway authorizes from the environment secret itself.
 */
function platformKeyVersion(db: D1Database, input: MutateInput): D1PreparedStatement[] {
  if (input.name !== "OHMYHOST_STORAGE_KEY") return [];
  const bind = [input.organizationId, input.projectId, input.environmentId, input.name];
  const newest = `SELECT MAX(latest.key_version) FROM storage_gateway_keys latest WHERE latest.organization_id=key.organization_id AND latest.project_id=key.project_id AND latest.environment_id=key.environment_id`;
  return [
    db
      .prepare(
        `INSERT INTO storage_gateway_keys(organization_id,project_id,environment_id,key_version,key_sha256,created_at)
 SELECT secret.organization_id,secret.project_id,secret.environment_id,(SELECT MAX(k.key_version)+1 FROM storage_gateway_keys k WHERE k.organization_id=secret.organization_id AND k.project_id=secret.project_id AND k.environment_id=secret.environment_id),secret.value_sha256,${SECRET_UPDATED_MS}
 FROM (${SECRET_ROW}) secret WHERE EXISTS(SELECT 1 FROM storage_gateway_keys k WHERE k.organization_id=secret.organization_id AND k.project_id=secret.project_id AND k.environment_id=secret.environment_id)`,
      )
      .bind(...bind),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM storage_gateway_keys key JOIN (${SECRET_ROW}) secret ON key.organization_id=secret.organization_id AND key.project_id=secret.project_id AND key.environment_id=secret.environment_id WHERE key.key_version=(${newest}) AND key.key_sha256=secret.value_sha256 AND substr(key.created_at,1,23)=substr(secret.updated_at,1,23))`,
      bind,
    ),
  ];
}

function mutationCommand(
  db: D1Database,
  input: MutateInput,
): Command<MutateSnapshot, EnvironmentSecretMutationResponse> {
  return {
    name: "secrets.mutateEnvironmentSecret",
    input,
    retryOn: ["row_version_conflict", "scope_inactive", "precondition_changed"],
    naturalKeyTables: ["environment_secrets", "environment_secret_requests"],
    read: (shard) => readMutateSnapshot(shard, input),
    decide: (snapshot) => {
      if (snapshot.receipt !== null) {
        if (
          snapshot.receipt.name !== input.name ||
          !sameBytes(bytesOf(snapshot.receipt.request_sha256), input.requestSha256)
        ) {
          return reject(
            "environment_secret_idempotency_conflict",
            "Environment secret idempotency key was reused with different input",
          );
        }
        return { replay: storedResponse.parse(JSON.parse(snapshot.receipt.response)) };
      }
      if (!snapshot.scopeActive || !snapshot.mutable) return SCOPE_INACTIVE;
      if (snapshot.blockedByClaim) {
        return reject(
          "environment_secret_mutation_blocked",
          "Environment secret mutation is blocked by an active deployment",
        );
      }
      const receipt = (response: EnvironmentSecretMutationResponse): D1PreparedStatement =>
        db
          .prepare(
            "INSERT INTO environment_secret_requests(organization_id, project_id, environment_id, action, name, idempotency_key, request_sha256, response, requested_at, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.action,
            input.name,
            input.idempotencyKey,
            input.requestSha256,
            JSON.stringify(response),
            input.requestedAt,
          );
      const authorityGuards =
        input.handoffDelegation === undefined
          ? []
          : handoffEffectGuards(db, {
              organizationId: input.organizationId,
              principalId: input.principalId ?? "",
              projectId: input.projectId,
              environmentId: input.environmentId,
              ...(input.action === "set" ? { secretName: input.name } : {}),
              action: "secrets:write",
              authority: input.handoffDelegation,
            });
      const noClaim = guard(
        db,
        "precondition_changed",
        "EXISTS (SELECT 1 FROM product_provider_mutation_claims WHERE organization_id = ? AND project_id = ?)",
        [input.organizationId, input.projectId],
      );
      if (input.action === "set") {
        const plan = planPut(db, { ...input, claim: undefined }, snapshot, true);
        if ("reject" in plan) return plan;
        const stored: EnvironmentSecretMutationResponse = {
          status: "stored",
          secret: ("replay" in plan ? plan.replay : plan.result([])).metadata,
        };
        const writes =
          "replay" in plan
            ? scopeGuards(db, { ...input, claim: undefined }, false)
            : plan.statements;
        return {
          statements: [...authorityGuards, noClaim, ...writes, receipt(stored)],
          result: () => stored,
        };
      }
      if (input.action === "rotate") {
        // An installed key is replaced in place; the generation advances with the envelope, and a Storage or Mail
        // key also gets its next version, which is the one the gateway authorizes from then on.
        if (snapshot.secret === null)
          return reject("environment_secret_absent", "Environment secret is not installed");
        const plan = planPut(db, { ...input, claim: undefined }, snapshot, true);
        if ("reject" in plan) return plan;
        const stored: EnvironmentSecretMutationResponse = {
          status: "stored",
          secret: ("replay" in plan ? plan.replay : plan.result([])).metadata,
        };
        const writes =
          "replay" in plan
            ? scopeGuards(db, { ...input, claim: undefined }, false)
            : [...plan.statements, ...platformKeyVersion(db, input)];
        return {
          statements: [...authorityGuards, noClaim, ...writes, receipt(stored)],
          result: () => stored,
        };
      }
      const deleted = snapshot.secret !== null;
      if (deleted && !snapshot.deliveryState) return SCOPE_INACTIVE;
      const response: EnvironmentSecretMutationResponse = {
        status: deleted ? "deleted" : "absent",
        name: input.name,
      };
      return {
        statements: [
          ...authorityGuards,
          noClaim,
          guard(
            db,
            "scope_inactive",
            `NOT EXISTS (${ACTIVE_SCOPE_SQL})`,
            activeScopeParams(input.organizationId, input.projectId, input.environmentId),
          ),
          ...(deleted
            ? [
                db
                  .prepare(
                    "DELETE FROM environment_secrets WHERE organization_id = ? AND project_id = ? AND environment_id = ? AND name = ?",
                  )
                  .bind(input.organizationId, input.projectId, input.environmentId, input.name),
                // A racing delete already removed it: re-read and answer "absent" instead of advancing the generation twice.
                guard(db, "row_version_conflict", "changes() = 0"),
                advanceDelivery(db, input, input.requestedAt),
              ]
            : []),
          receipt(response),
        ],
        result: () => response,
      };
    },
  };
}

/** The public API's delivery metadata contains no key, provider tag or ciphertext. */
export interface ApiSecretDeliveryState {
  desiredGeneration: number;
  appliedGeneration: number;
  runtimeProvider?: "wfp";
  lastFailureCode?: string;
  manifestSecretCount: number;
}
const API_DELIVERY_SQL = `SELECT CAST(state.desired_generation AS TEXT) desired_generation,
 CAST(state.applied_generation AS TEXT) applied_generation,state.provider_tag,state.last_failure_code,state.applied_secret_count
 FROM runtime_secret_delivery_states state JOIN projects project ON project.organization_id=state.organization_id
 AND project.project_id=state.project_id AND project.owner_state='active'
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id
 AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3`;
function apiDeliveryOf(
  row: Record<string, unknown> | undefined,
): ApiSecretDeliveryState | undefined {
  if (row === undefined) return undefined;
  const desiredGeneration = Number(row["desired_generation"]),
    appliedGeneration = Number(row["applied_generation"]);
  if (
    !Number.isSafeInteger(desiredGeneration) ||
    desiredGeneration < 0 ||
    !Number.isSafeInteger(appliedGeneration) ||
    appliedGeneration < 0
  )
    throw new TypeError("Secret delivery generation is outside the public contract");
  const manifestSecretCount = Number(row["applied_secret_count"]);
  if (!Number.isSafeInteger(manifestSecretCount) || manifestSecretCount < 0)
    throw new TypeError("Secret count is outside the public contract");
  return {
    desiredGeneration,
    appliedGeneration,
    ...(row["provider_tag"] === null ? {} : { runtimeProvider: "wfp" as const }),
    ...(row["last_failure_code"] === null
      ? {}
      : { lastFailureCode: String(row["last_failure_code"]) }),
    manifestSecretCount,
  };
}
/** Original API list and delivery read share one consistent native batch. */
export async function readApiEnvironmentSecrets(context: PlatformContext, raw: unknown) {
  const input = listEnvironmentSecretsInput.parse(raw),
    db = await shardOfOrganization(context, input.organizationId);
  const rows = await readSnapshot(db, [
    [
      `SELECT es.name,es.revision,es.key_version,es.created_at,es.updated_at
 FROM environment_secrets es JOIN projects project ON project.organization_id=es.organization_id AND project.project_id=es.project_id AND project.owner_state='active'
 JOIN billing_epochs epoch ON epoch.organization_id=project.organization_id AND epoch.project_id=project.project_id AND epoch.billing_epoch_id=project.active_billing_epoch_id AND epoch.ended_at IS NULL
 WHERE es.organization_id=?1 AND es.project_id=?2 AND es.environment_id=?3 ORDER BY es.name`,
      input.organizationId,
      input.projectId,
      input.environmentId,
    ],
    [API_DELIVERY_SQL, input.organizationId, input.projectId, input.environmentId],
  ]);
  return {
    items: (rows[0] ?? []).map((row) =>
      metadata(String(row["name"]), {
        revision: Number(row["revision"]),
        keyVersion: Number(row["key_version"]),
        createdAt: String(row["created_at"]),
        updatedAt: String(row["updated_at"]),
      }),
    ),
    delivery: apiDeliveryOf(rows[1]?.[0]),
  };
}
/** Same original mutation batch, with delivery observation appended before commit. */
export async function mutateApiEnvironmentSecret(context: PlatformContext, raw: unknown) {
  const input = mutateEnvironmentSecretInput.parse(raw),
    db = await shardOfOrganization(context, input.organizationId),
    base = mutationCommand(db, input);
  return runCommand<
    MutateSnapshot,
    { response: EnvironmentSecretMutationResponse; delivery: ApiSecretDeliveryState | undefined }
  >(db, {
    name: "secrets.mutateApiEnvironmentSecret",
    input,
    read: (reader) => readMutateSnapshot(reader, input, true),
    retryOn: ["row_version_conflict", "scope_inactive", "precondition_changed"],
    naturalKeyTables: ["environment_secrets", "environment_secret_requests"],
    decide(snapshot) {
      const plan = base.decide(snapshot);
      if ("reject" in plan) return plan;
      if ("replay" in plan)
        return { replay: { response: plan.replay, delivery: snapshot.apiDelivery } };
      return {
        statements: [
          ...plan.statements,
          db
            .prepare(API_DELIVERY_SQL)
            .bind(input.organizationId, input.projectId, input.environmentId),
        ],
        result: (results) => ({
          response: plan.result(results.slice(0, -1)),
          delivery: apiDeliveryOf(results.at(-1)?.results[0]),
        }),
      };
    },
  });
}
