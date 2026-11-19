import {
  readWorkflowDelegation,
  workflowExecutionGuards,
  type WorkflowDelegationProof,
} from "../provisioning/authority.js";
import { assertOperationDelegationCurrent } from "../identity/operation-delegations.js";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { providerRequestJsonb, sameProviderRequestJsonb } from "./provider-request-jsonb.js";
import type { Command, Plan } from "../../run-command.js";
import { organizationLiveGuard } from "../common.js";
import { isoOrNull, readSnapshot, type PlatformContext } from "../platform-support.js";
import { ACTIVE_TARGET_SQL, claimParams, currentDataEnvironment } from "./authority.js";
import { DatabaseProviderConflictError, runtimeRoleOf } from "./contracts.js";
import {
  PgcfDatabaseClaimClosedError,
  PgcfDatabaseTakenError,
  activePgcfClaimStatements,
  type PgcfClaim,
} from "./pgcf-claims.js";
import {
  authorityGuard,
  DATABASE_OPERATION_OBSERVATION,
  readAuthority,
  type AuthorityGrant,
  type AuthoritySnapshot,
} from "./provider-authority.js";
import {
  DatabaseProviderOperationUnknownError,
  activateTargetInput,
  authorizeInput,
  beginOperationInput,
  migrationReceiptInput,
  nextVersionInput,
  readTargetInput,
  recordOperationInput,
  reserveOperationInput,
  resolveScopeInput,
  retireLegacyInput,
  type DatabaseProviderOperation,
  type DatabaseProviderOperationState,
  type DatabaseProviderScope,
  type DatabaseProviderTarget,
} from "./provider-contracts.js";
import { ENVIRONMENTS_JSON, RECEIPTS_OF, RESERVATIONS_OF } from "./registration.js";
import { DATABASE_CONFLICTS, runOnOrganization, stale } from "./run.js";

type Row = Record<string, unknown>;

const scopeParams = (scope: DatabaseProviderScope): string[] => [
  scope.organizationId,
  scope.projectId,
  scope.physicalEnvironmentId,
];

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** `omh-` plus the SHA-256 of `[org, project, physical, operation, step]`: stable for every retry of one step. */
export async function providerIdempotencyKey(
  scope: DatabaseProviderScope,
  operationId: string,
  step: string,
): Promise<string> {
  return `omh-${hex(await sha256(JSON.stringify([...scopeParams(scope), operationId, step])))}`;
}

const FORBIDDEN_KEY = /password|secret|token|credential|uri/u;
/**
 * The one stored form of a provider request body (the original `canonicalProviderRequest`): bounded, secret-free and
 * key-sorted, so text equality is request equality. Throws the typed conflict for anything that is not.
 */
export function canonicalProviderRequest(value: Readonly<Record<string, unknown>>): string {
  const encode = (item: unknown): unknown => {
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return item;
    if (typeof item === "string" && item.length <= 256 && !item.includes("://")) return item;
    if (Array.isArray(item) && item.length <= 16) return item.map(encode);
    if (typeof item === "object" && item !== null)
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => {
            if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key) || FORBIDDEN_KEY.test(key))
              throw new DatabaseProviderConflictError();
            return [key, encode(child)];
          }),
      );
    throw new DatabaseProviderConflictError();
  };
  const result = JSON.stringify(encode(value));
  if (result.length > 4096) throw new DatabaseProviderConflictError();
  return result;
}

function targetOf(scope: DatabaseProviderScope, row: Row): DatabaseProviderTarget {
  const base = {
    ...scope,
    targetVersion: Number(row["target_version"]),
    providerProjectId: String(row["provider_project_id"]),
    regionId: String(row["region_id"]),
    runtimeRole: String(row["runtime_role"]),
    credentialReference: String(row["credential_reference"]),
    activatedAt: isoOrNull(row["activated_at"]),
  };
  if (!Number.isSafeInteger(base.targetVersion) || base.targetVersion < 1)
    throw new DatabaseProviderConflictError();
  if (row["provider"] === "neon" && typeof row["branch_id"] === "string")
    return { ...base, provider: "neon", branchId: row["branch_id"] };
  if (
    row["provider"] === "pgcf" &&
    typeof row["database_id"] === "string" &&
    typeof row["size_class_id"] === "string"
  )
    return {
      ...base,
      provider: "pgcf",
      databaseId: row["database_id"],
      sizeClassId: row["size_class_id"],
    };
  throw new DatabaseProviderConflictError();
}

const refuse = { reject: new DatabaseProviderConflictError() };

// ---------------------------------------------------------------------------------------------------------------
// Scope and target reads.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The physical data environment a logical environment points at now, for an active owner and a project that is active
 * or deleting. Shared Dev/Prod authority stays logical; placement is physical.
 */
export async function resolveDatabaseProviderScope(
  context: PlatformContext,
  input: unknown,
): Promise<DatabaseProviderScope> {
  const parsed = resolveScopeInput.parse(input);
  const [rows] = await readSnapshot(
    await (
      await context.router.routeOrganization(parsed.organizationId)
    ).db,
    [
      [
        `SELECT ${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")} AS physical_environment_id
           FROM environments e JOIN projects p ON p.organization_id = e.organization_id AND p.project_id = e.project_id
          WHERE e.organization_id = ?1 AND e.project_id = ?2 AND e.environment_id = ?3
            AND e.name IN('dev','prod') AND p.owner_state = 'active' AND p.lifecycle_state IN ('active', 'deleting')`,
        parsed.organizationId,
        parsed.projectId,
        parsed.environmentId,
      ],
    ],
  );
  const physical = rows?.[0]?.["physical_environment_id"];
  if (typeof physical !== "string") throw new DatabaseProviderConflictError();
  return {
    organizationId: parsed.organizationId,
    projectId: parsed.projectId,
    physicalEnvironmentId: physical,
  };
}

/** The ACTIVE target of a physical environment under an active owner; a Neon history row is never selected. */
export async function readDatabaseProviderTarget(
  context: PlatformContext,
  input: unknown,
): Promise<DatabaseProviderTarget | null> {
  const scope = readTargetInput.parse(input);
  const db = (await context.router.routeOrganization(scope.organizationId)).db;
  const [rows] = await readSnapshot(db, [[ACTIVE_TARGET_SQL, ...scopeParams(scope)]]);
  const row = rows?.[0];
  return row === undefined ? null : targetOf(scope, row);
}

/**
 * Read-only proof that the claim (or the step's second authority) holds now. Writers never rely on this call: they
 * carry the same predicate as a guard of their own batch.
 */
export async function authorizeDatabaseProviderClaim(
  context: PlatformContext,
  input: unknown,
): Promise<void> {
  const parsed = authorizeInput.parse(input);
  const db = (await context.router.routeOrganization(parsed.organizationId)).db;
  const { step, ...claim } = parsed;
  if ((await readAuthority(db, claim, step)).grant === null)
    throw new DatabaseProviderConflictError();
}

// ---------------------------------------------------------------------------------------------------------------
// Provider operation: RESERVE (commit the identity) -> DISPATCH decision -> external I/O (caller) -> OBSERVE.
// ---------------------------------------------------------------------------------------------------------------

const OPERATION_OF = `SELECT claim_id, idempotency_key, provider_project_id, request_body, lower(hex(request_digest)) AS request_digest, provider_operation_id, database_id, state
  FROM database_provider_operations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND step = ?5`;

interface OperationSnapshot {
  readonly authority: AuthoritySnapshot;
  readonly row: Row | null;
  readonly delegation: WorkflowDelegationProof | null;
}

async function readOperation(
  db: D1Database,
  claim: {
    organizationId: string;
    projectId: string;
    physicalEnvironmentId: string;
    operationId: string;
    claimId: string;
  },
  step: string,
): Promise<OperationSnapshot> {
  const authority = await readAuthority(db, claim, step);
  const [rows] = await readSnapshot(db, [[OPERATION_OF, ...claimParams(claim).slice(0, 4), step]]);
  const delegation = step === "database.resize" ? await readWorkflowDelegation(db, claim) : null;
  return { authority, row: rows?.[0] ?? null, delegation };
}

function operationOf(
  scope: DatabaseProviderScope & { operationId: string; claimId: string; step: string },
  row: Row,
): DatabaseProviderOperation {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    physicalEnvironmentId: scope.physicalEnvironmentId,
    operationId: scope.operationId,
    claimId: scope.claimId,
    step: scope.step,
    idempotencyKey: String(row["idempotency_key"]),
    providerProjectId: String(row["provider_project_id"]),
    requestBody: JSON.parse(String(row["request_body"])) as Record<string, unknown>,
    providerOperationId:
      typeof row["provider_operation_id"] === "string" ? row["provider_operation_id"] : null,
    databaseId: typeof row["database_id"] === "string" ? row["database_id"] : null,
    state: String(row["state"]) as DatabaseProviderOperationState,
  };
}

/** The stored identity of a step equals the one the caller holds: claim, key, target and body. */
const sameIdentity = (
  row: Row,
  op: { claimId: string; idempotencyKey: string; providerProjectId: string; step?: string },
  body: string,
  digest?: Uint8Array,
) =>
  (row["claim_id"] === op.claimId || op.step === "database.resize") &&
  row["idempotency_key"] === op.idempotencyKey &&
  row["provider_project_id"] === op.providerProjectId &&
  typeof row["request_body"] === "string" &&
  sameProviderRequestJsonb(row["request_body"], body) &&
  (digest === undefined || row["request_digest"] === hex(digest));

function reserveCommand(
  db: D1Database,
  input: ReturnType<typeof reserveOperationInput.parse>,
  idempotencyKey: string,
  body: string,
  digest: Uint8Array,
): Command<OperationSnapshot, DatabaseProviderOperation> {
  const { step } = input;
  const storedBody = providerRequestJsonb(body);
  const identity = {
    claimId: input.claimId,
    step: input.step,
    idempotencyKey,
    providerProjectId: input.providerProjectId,
  };
  return {
    name: "database.reserveProviderOperation",
    input,
    retryOn: ["precondition_changed"],
    read: () => readOperation(db, input, step),
    decide(snapshot): Plan<DatabaseProviderOperation> {
      const grant = snapshot.authority.grant;
      if (grant === null) return refuse;
      if (snapshot.row !== null)
        return sameIdentity(snapshot.row, identity, body, digest)
          ? { replay: operationOf({ ...input, step }, snapshot.row) }
          : refuse;
      const key = [
        ...scopeParams(input),
        input.operationId,
        input.claimId,
        step,
        idempotencyKey,
        input.providerProjectId,
      ];
      return {
        statements: [
          organizationLiveGuard(db, input.organizationId),
          authorityGuard(db, input, grant),
          ...(step === "database.resize"
            ? workflowExecutionGuards(db, input, snapshot.delegation)
            : []),
          db
            .prepare(
              `INSERT INTO database_provider_operations(organization_id, project_id, physical_environment_id, operation_id, claim_id, step, idempotency_key, provider_project_id, request_digest, request_body)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT DO NOTHING`,
            )
            .bind(...key, digest, storedBody),
          // The exact identity must exist: a different row under this step or key is a stale decision.
          stale(
            db,
            `NOT EXISTS (SELECT 1 FROM database_provider_operations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND (claim_id = ?5 OR step='database.resize') AND step = ?6 AND idempotency_key = ?7 AND provider_project_id = ?8 AND request_body = ?9 AND request_digest = ?10)`,
            [...key, storedBody, digest],
          ),
          db.prepare(OPERATION_OF).bind(...claimParams(input).slice(0, 4), step),
        ],
        result: (results) => {
          const row = results.at(-1)?.results[0] as Row | undefined;
          if (row === undefined) throw new DatabaseProviderConflictError();
          return operationOf({ ...input, step }, row);
        },
      };
    },
  };
}

/**
 * Commits the identity (key, target, canonical body) of a provider mutation BEFORE any dispatch. A replay returns the
 * stored operation whatever state it advanced to; a different body or target under the same step is a conflict.
 */
export async function reserveDatabaseProviderOperation(
  context: PlatformContext,
  raw: unknown,
): Promise<DatabaseProviderOperation> {
  const input = reserveOperationInput.parse(raw);
  const body = canonicalProviderRequest(input.requestBody);
  const idempotencyKey = await providerIdempotencyKey(input, input.operationId, input.step);
  const digest = await sha256(body);
  return runOnOrganization(context, input.organizationId, (db) =>
    reserveCommand(db, input, idempotencyKey, body, digest),
  );
}

/** The original identity of a step without inventing a second mutation for an existing role. Null: never reserved. */
export async function readDatabaseProviderOperation(
  context: PlatformContext,
  raw: unknown,
): Promise<DatabaseProviderOperation | null> {
  const { step, ...claim } = authorizeInput.required({ step: true }).parse(raw);
  const db = (await context.router.routeOrganization(claim.organizationId)).db;
  const snapshot = await readOperation(db, claim, step);
  if (
    snapshot.authority.grant === null &&
    (snapshot.row === null ||
      snapshot.row["state"] === "reserved" ||
      (await db
        .prepare(DATABASE_OPERATION_OBSERVATION)
        .bind(...claimParams(claim))
        .first()) === null)
  )
    throw new DatabaseProviderConflictError();
  return snapshot.row === null ? null : operationOf({ ...claim, step }, snapshot.row);
}

function providerSnapshotGuard(
  db: D1Database,
  scope: DatabaseProviderScope & { operationId: string; step: string },
  row: Row,
): D1PreparedStatement {
  const digest = row["request_digest"];
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))
    throw new DatabaseProviderConflictError();
  const bytes = new Uint8Array(
    digest.match(/../gu)?.map((part) => Number.parseInt(part, 16)) ?? [],
  );
  return stale(
    db,
    `NOT EXISTS(SELECT 1 FROM database_provider_operations WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND operation_id=?4 AND step=?5 AND claim_id IS ?6 AND idempotency_key IS ?7 AND provider_project_id IS ?8 AND request_body IS ?9 AND request_digest IS ?10 AND provider_operation_id IS ?11 AND database_id IS ?12 AND state IS ?13)`,
    [
      ...scopeParams(scope),
      scope.operationId,
      scope.step,
      row["claim_id"],
      row["idempotency_key"],
      row["provider_project_id"],
      row["request_body"],
      bytes,
      row["provider_operation_id"] ?? null,
      row["database_id"] ?? null,
      row["state"],
    ],
  );
}

function beginCommand(
  db: D1Database,
  op: ReturnType<typeof beginOperationInput.parse>["operation"],
  now: string,
): Command<OperationSnapshot, "dispatch" | "observe"> {
  const body = canonicalProviderRequest(op.requestBody);
  return {
    name: "database.beginProviderOperation",
    input: { operation: op },
    retryOn: ["precondition_changed"],
    read: () => readOperation(db, op, op.step),
    decide(snapshot): Plan<"dispatch" | "observe"> {
      const grant = snapshot.authority.grant;
      // An operation that was never reserved (or whose identity differs) is never dispatched.
      if (grant === null || snapshot.row === null || !sameIdentity(snapshot.row, op, body))
        return snapshot.row === null && grant !== null
          ? { reject: new DatabaseProviderOperationUnknownError() }
          : refuse;
      const resize = op.step === "database.resize";
      if (snapshot.row["state"] !== "reserved" && !resize) return { replay: "observe" };
      const dispatch = snapshot.row["state"] === "reserved";
      const key = [...scopeParams(op), op.operationId, op.step, op.idempotencyKey];
      return {
        statements: [
          organizationLiveGuard(db, op.organizationId),
          authorityGuard(db, op, grant),
          ...(op.step === "database.resize"
            ? workflowExecutionGuards(db, op, snapshot.delegation)
            : []),
          providerSnapshotGuard(db, op, snapshot.row),
          ...(resize
            ? [
                db
                  .prepare(
                    `INSERT INTO compute_connection_provider_uses(organization_id,project_id,operation_id,claim_id,lease_until) VALUES(?1,?2,?3,?4,strftime('%Y-%m-%dT%H:%M:%f','now','+60 seconds')||'000Z') ON CONFLICT(organization_id,project_id,operation_id) DO UPDATE SET claim_id=excluded.claim_id,lease_until=excluded.lease_until WHERE compute_connection_provider_uses.lease_until <= (strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`,
                  )
                  .bind(op.organizationId, op.projectId, op.operationId, op.claimId),
                stale(db, "changes() = 0", []),
              ]
            : []),
          ...(dispatch
            ? [
                db
                  .prepare(
                    "UPDATE database_provider_operations SET state = 'dispatched' , dispatched_at = ?6 WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND step = ?5 AND idempotency_key = ?7 AND state = 'reserved'",
                  )
                  .bind(...key.slice(0, 5), now, op.idempotencyKey),
                // Only the batch that really moved `reserved` to `dispatched` may dispatch; a concurrent twin changed nothing.
                stale(db, "changes() = 0", []),
              ]
            : []),
        ],
        result: () => (dispatch ? "dispatch" : "observe"),
      };
    },
  };
}

/**
 * The dispatch DECISION, committed before the external call. Exactly one caller observes `dispatch` (the one whose
 * batch moved `reserved` to `dispatched`); every later or concurrent caller, and a retry after a lost response, gets
 * `observe` and must look up the ORIGINAL provider operation by its key instead of creating a second resource.
 */
export async function beginDatabaseProviderOperation(
  context: PlatformContext,
  raw: unknown,
): Promise<"dispatch" | "observe"> {
  const { operation, now } = beginOperationInput.parse(raw);
  if (operation.step === "database.resize")
    await assertOperationDelegationCurrent(context, {
      organizationId: operation.organizationId,
      operationId: operation.operationId,
    });
  return runOnOrganization(context, operation.organizationId, (db) =>
    beginCommand(db, operation, now),
  );
}

export function planRecordDatabaseProviderOperation(
  db: D1Database,
  parsed: ReturnType<typeof recordOperationInput.parse>,
): Command<OperationSnapshot, void> {
  const { operation: op, observation, now } = parsed;
  const body = canonicalProviderRequest(op.requestBody);
  return {
    name: "database.recordProviderOperation",
    input: { operation: op, observation },
    retryOn: ["precondition_changed"],
    read: async () => {
      const snapshot = await readOperation(db, op, op.step);
      if (
        snapshot.authority.grant === null &&
        snapshot.row !== null &&
        snapshot.row["state"] !== "reserved" &&
        (await db
          .prepare(DATABASE_OPERATION_OBSERVATION)
          .bind(...claimParams(op))
          .first()) !== null
      )
        return {
          ...snapshot,
          authority: { ...snapshot.authority, grant: { kind: "operation_observation" as const } },
        };
      return snapshot;
    },
    decide(snapshot): Plan<void> {
      const grant = snapshot.authority.grant;
      const row = snapshot.row;
      if (grant === null || row === null || !sameIdentity(row, op, body)) return refuse;
      const sameProviderOperation =
        (row["provider_operation_id"] ?? null) === observation.providerOperationId;
      if (
        row["database_id"] === observation.databaseId &&
        sameProviderOperation &&
        row["state"] === observation.state
      )
        return { replay: undefined };
      if (
        (row["state"] !== "dispatched" && row["state"] !== "pending") ||
        (row["database_id"] !== null && row["database_id"] !== observation.databaseId) ||
        (row["provider_operation_id"] !== null && !sameProviderOperation)
      )
        return refuse;
      const key = [...scopeParams(op), op.operationId, op.step, op.idempotencyKey];
      return {
        statements: [
          organizationLiveGuard(db, op.organizationId),
          authorityGuard(db, op, grant),
          ...(op.step === "database.resize"
            ? workflowExecutionGuards(db, op, snapshot.delegation)
            : []),
          providerSnapshotGuard(db, op, row),
          db
            .prepare(
              "UPDATE database_provider_operations SET database_id = ?7, provider_operation_id = ?8, state = ?9, observed_at = ?10 WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND step = ?5 AND idempotency_key = ?6 AND state IN ('dispatched', 'pending') AND (database_id IS NULL OR database_id = ?7) AND (provider_operation_id IS NULL OR provider_operation_id IS ?8)",
            )
            .bind(
              ...key,
              observation.databaseId,
              observation.providerOperationId,
              observation.state,
              now,
            ),
          stale(
            db,
            "NOT EXISTS (SELECT 1 FROM database_provider_operations WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND step = ?5 AND idempotency_key = ?6 AND database_id = ?7 AND provider_operation_id IS ?8 AND state = ?9 AND observed_at = ?10)",
            [
              ...key,
              observation.databaseId,
              observation.providerOperationId,
              observation.state,
              now,
            ],
          ),
        ],
        result: () => undefined,
      };
    },
  };
}

/** OBSERVE: records what the provider answered for the original operation; identical replays are no-ops. */
export async function recordDatabaseProviderOperation(
  context: PlatformContext,
  raw: unknown,
): Promise<void> {
  const parsed = recordOperationInput.parse(raw);
  return runOnOrganization(context, parsed.operation.organizationId, (db) =>
    planRecordDatabaseProviderOperation(db, parsed),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Target version and activation.
// ---------------------------------------------------------------------------------------------------------------

interface VersionSnapshot {
  readonly authority: AuthoritySnapshot;
  readonly projectActive: boolean;
  readonly head: Row | null;
  readonly maximum: number;
  readonly latestReceipt: Row | null;
  readonly environments: readonly string[];
  readonly unfinished: boolean;
}

const HEAD_OF = `SELECT h.target_version, h.state, r.provider, r.provider_project_id, r.branch_id,
       r.provider = 'neon' AND EXISTS (SELECT 1 FROM database_provider_legacy_retirements retired
         WHERE retired.organization_id = h.organization_id AND retired.project_id = h.project_id AND retired.physical_environment_id = h.physical_environment_id
           AND retired.target_version = h.target_version AND retired.provider_project_id = r.provider_project_id AND retired.branch_id = r.branch_id) AS absent
  FROM database_provider_target_heads h JOIN database_provider_target_revisions r
    ON r.organization_id = h.organization_id AND r.project_id = h.project_id AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
 WHERE h.organization_id = ?1 AND h.project_id = ?2 AND h.physical_environment_id = ?3`;
const MAXIMUM_OF = `SELECT COALESCE(max(target_version), 0) AS version FROM database_provider_target_revisions WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3`;
const UNFINISHED = `EXISTS (SELECT 1 ${RESERVATIONS_OF} AND registration_version > (SELECT COALESCE(max(registration_version), 0) ${RECEIPTS_OF}))`;
/**
 * The latest registration receipt blocks a successor when it is already PGCF, names another Neon project or branch,
 * or does not authorize exactly the environments now on this physical environment. Parameters ?1..?3 scope, ?4
 * provider project, ?5 branch.
 */
const REGISTRATION_BLOCKS = `SELECT 1 FROM project_database_registration_receipts receipt
 WHERE receipt.organization_id = ?1 AND receipt.project_id = ?2 AND receipt.physical_environment_id = ?3
   AND NOT EXISTS (SELECT 1 FROM project_database_registration_receipts newer WHERE newer.organization_id = receipt.organization_id AND newer.project_id = receipt.project_id
        AND newer.physical_environment_id = receipt.physical_environment_id AND newer.registration_version > receipt.registration_version)
   AND (json_extract(receipt.metadata, '$.provider') = 'pgcf' OR json_extract(receipt.metadata, '$.providerProjectId') IS NOT ?4
     OR json_extract(receipt.metadata, '$.branchId') IS NOT ?5 OR ${ENVIRONMENTS_JSON} = '[]'
     OR json_extract(receipt.metadata, '$.authorizedEnvironmentIds') IS NOT ${ENVIRONMENTS_JSON})`;

async function readVersion(
  db: D1Database,
  claim: Parameters<typeof readOperation>[1],
): Promise<VersionSnapshot> {
  const authority = await readAuthority(db, claim);
  const scope = claimParams(claim).slice(0, 3);
  const [project, head, maximum, receipt, environments, unfinished] = await readSnapshot(db, [
    [
      "SELECT 1 FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND lifecycle_state = 'active'",
      claim.organizationId,
      claim.projectId,
    ],
    [HEAD_OF, ...scope],
    [MAXIMUM_OF, ...scope],
    [`SELECT metadata ${RECEIPTS_OF} ORDER BY registration_version DESC LIMIT 1`, ...scope],
    [`SELECT ${ENVIRONMENTS_JSON} AS ids`, ...scope],
    [`SELECT ${UNFINISHED} AS pending`, ...scope],
  ]);
  return {
    authority,
    projectActive: (project?.length ?? 0) === 1,
    head: head?.[0] ?? null,
    maximum: Number(maximum?.[0]?.["version"] ?? 0),
    latestReceipt: receipt?.[0] ?? null,
    environments: JSON.parse(String(environments?.[0]?.["ids"] ?? "[]")) as string[],
    unfinished: Number(unfinished?.[0]?.["pending"] ?? 0) === 1,
  };
}

/** The successor version the snapshot allows, or null. Mirrors `nextPgcfDatabaseTargetVersion` of the original. */
export function nextVersionOf(snapshot: VersionSnapshot): number | null {
  if (snapshot.authority.grant === null || !snapshot.projectActive) return null;
  const { head, maximum } = snapshot;
  if (!Number.isSafeInteger(maximum + 1)) return null;
  if (head === null) return maximum === 0 ? 1 : null;
  if (
    head["state"] !== "retired" ||
    Number(head["absent"]) !== 1 ||
    Number(head["target_version"]) !== maximum
  )
    return null;
  if (snapshot.latestReceipt !== null) {
    const metadata = JSON.parse(String(snapshot.latestReceipt["metadata"])) as Record<
      string,
      unknown
    >;
    if (
      metadata["provider"] === "pgcf" ||
      metadata["providerProjectId"] !== head["provider_project_id"] ||
      metadata["branchId"] !== head["branch_id"] ||
      snapshot.environments.length === 0 ||
      JSON.stringify(metadata["authorizedEnvironmentIds"]) !== JSON.stringify(snapshot.environments)
    )
      return null;
  }
  return snapshot.unfinished ? null : maximum + 1;
}

/**
 * Selects the successor target version BEFORE provider I/O (read-only). The activation batch re-proves the same
 * facts as guards, so an arbitrary retired head, a concurrent activation or a registration change aborts it.
 */
export async function nextPgcfDatabaseTargetVersion(
  context: PlatformContext,
  raw: unknown,
): Promise<number> {
  const { claim } = nextVersionInput.parse({ claim: raw });
  const db = (await context.router.routeOrganization(claim.organizationId)).db;
  const version = nextVersionOf(await readVersion(db, claim));
  if (version === null) throw new DatabaseProviderConflictError();
  return version;
}

/** The guards that keep `version` the only legal successor at commit time. */
function versionGuards(
  db: D1Database,
  claim: DatabaseProviderScope,
  prior: Row | null,
  version: number,
): D1PreparedStatement[] {
  const scope = scopeParams(claim);
  const guards = [
    stale(db, `(${MAXIMUM_OF}) <> ?4`, [...scope, version - 1]),
    stale(
      db,
      `(SELECT count(*) FROM database_provider_target_heads WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3) <> ?4`,
      [...scope, prior === null ? 0 : 1],
    ),
  ];
  if (prior !== null)
    guards.push(
      stale(
        db,
        `NOT EXISTS (${HEAD_OF} AND h.state = 'retired' AND h.target_version = ?4 AND r.provider = 'neon' AND EXISTS (SELECT 1 FROM database_provider_legacy_retirements retired
            WHERE retired.organization_id = h.organization_id AND retired.project_id = h.project_id AND retired.physical_environment_id = h.physical_environment_id
              AND retired.target_version = h.target_version AND retired.provider_project_id = r.provider_project_id AND retired.branch_id = r.branch_id))`,
        [...scope, version - 1],
      ),
      stale(db, `EXISTS (${REGISTRATION_BLOCKS})`, [
        ...scope,
        String(prior["provider_project_id"]),
        String(prior["branch_id"]),
      ]),
      stale(db, UNFINISHED, scope),
    );
  return guards;
}

/** `database.create` succeeded for exactly this database, version and region, in a project of that region. ?1..?3 scope, ?4 operation, ?5 provider project, ?6 database, ?7 version, ?8 region. */
const CREATE_PROOF = `SELECT 1 FROM database_provider_operations op
 WHERE op.organization_id = ?1 AND op.project_id = ?2 AND op.physical_environment_id = ?3 AND op.operation_id = ?4
   AND op.provider_project_id = ?5 AND op.database_id = ?6 AND op.step = 'database.create' AND op.state = 'succeeded'
   AND (CAST(json_extract(op.request_body, '$.target_version') AS INTEGER) = ?7 OR (json_type(op.request_body, '$.target_version') IS NULL AND ?7 = 1))
   AND json_extract(op.request_body, '$.region_id') = ?8
   AND EXISTS (SELECT 1 FROM projects p WHERE p.organization_id = op.organization_id AND p.project_id = op.project_id AND p.lifecycle_state = 'active'
        AND CASE p.region WHEN 'us' THEN 'us-dev' WHEN 'eu' THEN 'eu-dev' END = ?8)`;

interface ActivateSnapshot extends VersionSnapshot {
  readonly proven: boolean;
  readonly active: Row | null;
  readonly closed: boolean;
  readonly databaseClaim: Row | null;
}

type ActivateInput = ReturnType<typeof activateTargetInput.parse>;

function activateCommand(
  db: D1Database,
  input: ActivateInput,
  claimId: string,
): Command<ActivateSnapshot, void> {
  const { claim, target, now } = input;
  const scope = scopeParams(claim);
  const proofParams = [
    ...scope,
    claim.operationId,
    target.providerProjectId,
    target.databaseId,
    target.targetVersion,
    target.regionId,
  ];
  const tombstone = [target.providerProjectId, target.databaseId, claimId];
  return {
    name: "database.activateNewPgcfTarget",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["database_provider_target_revisions", "database_provider_target_heads"],
    async read() {
      const version = await readVersion(db, claim);
      const [proof, active, closed, databaseClaim] = await readSnapshot(db, [
        [CREATE_PROOF, ...proofParams],
        [ACTIVE_TARGET_SQL, ...scope],
        [
          "SELECT 1 FROM pgcf_database_claim_aborts WHERE provider_project_id = ?1 AND database_id = ?2 AND claim_id = ?3",
          ...tombstone,
        ],
        [
          "SELECT * FROM pgcf_database_claims WHERE provider_project_id=?1 AND database_id=?2",
          target.providerProjectId,
          target.databaseId,
        ],
      ]);
      const observedOperation =
        version.authority.grant === null &&
        (proof?.length ?? 0) === 1 &&
        (await db
          .prepare(DATABASE_OPERATION_OBSERVATION)
          .bind(...claimParams(claim))
          .first()) !== null;
      return {
        ...version,
        ...(observedOperation
          ? {
              authority: {
                ...version.authority,
                grant: { kind: "operation_observation" as const },
              },
            }
          : {}),
        proven: (proof?.length ?? 0) === 1,
        active: active?.[0] ?? null,
        closed: (closed?.length ?? 0) === 1,
        databaseClaim: databaseClaim?.[0] ?? null,
      };
    },
    decide(snapshot): Plan<void> {
      const grant: AuthorityGrant | null = snapshot.authority.grant;
      if (grant === null || !snapshot.proven) return refuse;
      const current = snapshot.active;
      const sameTarget = (row: Row) =>
        row["provider"] === "pgcf" &&
        row["database_id"] === target.databaseId &&
        row["provider_project_id"] === target.providerProjectId &&
        Number(row["target_version"]) === target.targetVersion &&
        row["region_id"] === target.regionId &&
        row["size_class_id"] === target.sizeClassId &&
        row["runtime_role"] === target.runtimeRole &&
        row["credential_reference"] === target.credentialReference;
      const global = snapshot.databaseClaim;
      if (
        global !== null &&
        !(
          global["organization_id"] === claim.organizationId &&
          global["project_id"] === claim.projectId &&
          global["physical_environment_id"] === claim.physicalEnvironmentId &&
          Number(global["target_version"]) === target.targetVersion &&
          global["claim_id"] === claimId
        )
      )
        return { reject: new PgcfDatabaseTakenError() };
      if (snapshot.closed) return { reject: new PgcfDatabaseClaimClosedError() };
      const identity: PgcfClaim = {
        providerProjectId: target.providerProjectId,
        databaseId: target.databaseId,
        organizationId: claim.organizationId,
        projectId: claim.projectId,
        physicalEnvironmentId: claim.physicalEnvironmentId,
        targetVersion: target.targetVersion,
        claimId,
        now,
      };
      if (current !== null) {
        if (!sameTarget(current)) return refuse;
        if (global?.["state"] === "active") return { replay: undefined };
        return {
          statements: [
            organizationLiveGuard(db, claim.organizationId),
            authorityGuard(db, claim, grant),
            stale(
              db,
              "EXISTS(SELECT 1 FROM pgcf_database_claim_aborts WHERE provider_project_id=?1 AND database_id=?2 AND claim_id=?3)",
              tombstone,
            ),
            stale(
              db,
              `NOT EXISTS(${ACTIVE_TARGET_SQL} AND r.target_version=?4 AND r.database_id=?5 AND r.provider_project_id=?6)`,
              [...scope, target.targetVersion, target.databaseId, target.providerProjectId],
            ),
            ...activePgcfClaimStatements(db, identity),
          ],
          result: () => undefined,
        };
      }
      if (nextVersionOf(snapshot) !== target.targetVersion) return refuse;
      const prior = snapshot.head;
      const key = [...scope, target.targetVersion];
      return {
        statements: [
          organizationLiveGuard(db, claim.organizationId),
          authorityGuard(db, claim, grant),
          stale(
            db,
            "EXISTS (SELECT 1 FROM pgcf_database_claim_aborts WHERE provider_project_id = ?1 AND database_id = ?2 AND claim_id = ?3)",
            tombstone,
          ),
          stale(db, `NOT EXISTS (${CREATE_PROOF})`, proofParams),
          stale(
            db,
            "NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND lifecycle_state = 'active' AND owner_state = 'active')",
            [claim.organizationId, claim.projectId],
          ),
          ...versionGuards(db, claim, prior, target.targetVersion),
          ...activePgcfClaimStatements(db, identity),
          db
            .prepare(
              `INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, region_id, size_class_id, runtime_role, credential_reference, operation_id, created_at)
               VALUES (?1, ?2, ?3, ?4, 'pgcf', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
            )
            .bind(
              ...key,
              target.providerProjectId,
              target.databaseId,
              target.regionId,
              target.sizeClassId,
              target.runtimeRole,
              target.credentialReference,
              claim.operationId,
              now,
            ),
          prior === null
            ? db
                .prepare(
                  "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', NULL, ?5)",
                )
                .bind(...key, now)
            : db
                .prepare(
                  "UPDATE database_provider_target_heads SET target_version = ?4, state = 'active', activated_at = NULL, updated_at = ?5 WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND state = 'retired' AND target_version = ?6",
                )
                .bind(...key, now, target.targetVersion - 1),
          stale(
            db,
            "NOT EXISTS (SELECT 1 FROM database_provider_target_heads WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND target_version = ?4 AND state = 'active' AND activated_at IS NULL)",
            key,
          ),
        ],
        result: () => undefined,
      };
    },
  };
}

/**
 * New data only (including owner-proven absent Neon sources; live cutovers use their own fence). The global physical
 * identity, target revision and head commit in ONE Core batch with accepted authority, succeeded creation, successor
 * version, registration, absence and abort guards. No reserved claim survives a failed target/head batch.
 */
export async function activateNewPgcfDatabaseTarget(
  context: PlatformContext,
  raw: unknown,
): Promise<void> {
  const input = activateTargetInput.parse(raw);
  const { claim, target } = input;
  if (
    claim.organizationId !== target.organizationId ||
    claim.projectId !== target.projectId ||
    claim.physicalEnvironmentId !== target.physicalEnvironmentId ||
    target.runtimeRole !== runtimeRoleOf(claim.physicalEnvironmentId)
  )
    throw new DatabaseProviderConflictError();
  return runOnOrganization(context, claim.organizationId, (db) =>
    activateCommand(db, input, `${claim.operationId}:${target.targetVersion}`),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Owner-only legacy absence.
// ---------------------------------------------------------------------------------------------------------------

type RetireInput = ReturnType<typeof retireLegacyInput.parse>;

/**
 * OWNER-ONLY. The operator supplies the complete inventory proof that the legacy Neon branch is gone; this permits
 * the first PGCF successor target. The PostgreSQL original was reachable only by the table owner role; here the
 * integrator must bind it ONLY in `createDatabaseProviderOperatorCommands`, never in the runtime or public surface.
 */
export async function retireAbsentLegacyDatabaseTarget(
  context: PlatformContext,
  raw: unknown,
): Promise<void> {
  const input = retireLegacyInput.parse(raw);
  const scope = scopeParams(input);
  const row = [
    ...scope,
    input.expectedTargetVersion,
    input.providerProjectId,
    input.branchId,
    hexToBytes(input.manifestSha256),
    hexToBytes(input.inventorySha256),
  ];
  return runOnOrganization(
    context,
    input.organizationId,
    (db): Command<{ existing: Row | null; source: boolean }, void> => ({
      name: "database.retireAbsentLegacyTarget",
      input,
      retryOn: ["precondition_changed"],
      naturalKeyTables: ["database_provider_legacy_retirements"],
      async read() {
        const [existing, source] = await readSnapshot(db, [
          [
            "SELECT provider_project_id, branch_id, manifest_sha256, inventory_sha256 FROM database_provider_legacy_retirements WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND target_version = ?4",
            ...row.slice(0, 4),
          ],
          [SOURCE_OF, ...row.slice(0, 6)],
        ]);
        return { existing: existing?.[0] ?? null, source: (source?.length ?? 0) === 1 };
      },
      decide(snapshot): Plan<void> {
        if (snapshot.existing !== null)
          return exactRetirement(snapshot.existing, input) ? { replay: undefined } : refuse;
        if (!snapshot.source) return refuse;
        return {
          statements: [
            organizationLiveGuard(db, input.organizationId),
            stale(db, `NOT EXISTS (${SOURCE_OF})`, row.slice(0, 6)),
            db
              .prepare(
                `INSERT INTO database_provider_legacy_retirements(organization_id, project_id, physical_environment_id, target_version, provider_project_id, branch_id, manifest_sha256, inventory_sha256, retired_at, retired_by)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
              )
              .bind(...row, input.retiredAt, input.retiredBy),
            stale(
              db,
              "NOT EXISTS (SELECT 1 FROM database_provider_legacy_retirements WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND target_version = ?4 AND provider_project_id = ?5 AND branch_id = ?6 AND manifest_sha256 = ?7 AND inventory_sha256 = ?8)",
              row,
            ),
          ],
          result: () => undefined,
        };
      },
    }),
  );
}

/** The Neon source revision (history, state retired by the 0070 trigger) the proof names. ?1..?3 scope, ?4 version, ?5 provider project, ?6 branch. */
const SOURCE_OF = `SELECT 1 FROM database_provider_target_heads h JOIN database_provider_target_revisions r
    ON r.organization_id = h.organization_id AND r.project_id = h.project_id AND r.physical_environment_id = h.physical_environment_id AND r.target_version = h.target_version
 WHERE h.organization_id = ?1 AND h.project_id = ?2 AND h.physical_environment_id = ?3 AND h.target_version = ?4
   AND r.provider = 'neon' AND r.provider_project_id = ?5 AND r.branch_id = ?6`;

function hexToBytes(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}
const bytesEqual = (value: unknown, expected: string): boolean =>
  value instanceof ArrayBuffer
    ? hex(new Uint8Array(value)) === expected
    : Array.isArray(value) && hex(Uint8Array.from(value as number[])) === expected;
function exactRetirement(row: Row, input: RetireInput): boolean {
  return (
    row["provider_project_id"] === input.providerProjectId &&
    row["branch_id"] === input.branchId &&
    bytesEqual(row["manifest_sha256"], input.manifestSha256) &&
    bytesEqual(row["inventory_sha256"], input.inventorySha256)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Migration receipt (missing writer of the original pgcf-runtime step).
// ---------------------------------------------------------------------------------------------------------------

/**
 * Records that the expand-only migration bundle ran against this database (PostgreSQL stays the executor: this
 * stores the receipt only). One batch: the current claim, the exact bundle/path receipt, and the replay identity.
 */
export async function recordPgcfDatabaseMigrationReceipt(
  context: PlatformContext,
  raw: unknown,
): Promise<void> {
  const input = migrationReceiptInput.parse(raw);
  const { claim } = input;
  const identity = [
    ...scopeParams(claim),
    claim.operationId,
    claim.claimId,
    input.providerProjectId,
    input.databaseId,
    hexToBytes(input.bundleSha256),
  ];
  const EXACT =
    "organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4 AND claim_id = ?5 AND provider_project_id = ?6 AND database_id = ?7 AND bundle_sha256 = ?8";
  return runOnOrganization(
    context,
    claim.organizationId,
    (db): Command<{ authority: AuthoritySnapshot; exact: boolean; other: boolean }, void> => ({
      name: "database.recordPgcfMigrationReceipt",
      input,
      retryOn: ["precondition_changed"],
      naturalKeyTables: ["pgcf_database_migration_receipts"],
      async read() {
        const authority = await readAuthority(db, claim);
        const [exact, any] = await readSnapshot(db, [
          [`SELECT 1 FROM pgcf_database_migration_receipts WHERE ${EXACT}`, ...identity],
          [
            "SELECT 1 FROM pgcf_database_migration_receipts WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND operation_id = ?4",
            ...identity.slice(0, 4),
          ],
        ]);
        return { authority, exact: (exact?.length ?? 0) === 1, other: (any?.length ?? 0) === 1 };
      },
      decide(snapshot): Plan<void> {
        const grant = snapshot.authority.grant;
        if (grant === null) return refuse;
        if (snapshot.exact) return { replay: undefined };
        if (snapshot.other) return refuse;
        return {
          statements: [
            organizationLiveGuard(db, claim.organizationId),
            authorityGuard(db, claim, grant),
            db
              .prepare(
                `INSERT INTO pgcf_database_migration_receipts(organization_id, project_id, physical_environment_id, operation_id, claim_id, provider_project_id, database_id, bundle_sha256, applied_paths, replayed_paths, completed_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT DO NOTHING`,
              )
              .bind(
                ...identity,
                JSON.stringify(input.appliedPaths),
                JSON.stringify(input.replayedPaths),
                input.completedAt,
              ),
            stale(
              db,
              `NOT EXISTS (SELECT 1 FROM pgcf_database_migration_receipts WHERE ${EXACT})`,
              identity,
            ),
          ],
          result: () => undefined,
        };
      },
    }),
  );
}

export { DATABASE_CONFLICTS };
