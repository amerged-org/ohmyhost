import type { WorkflowDelegationProof } from "../provisioning/authority.js";
import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { OPERATION_LEASE_MILLISECONDS, addMilliseconds, auditStatement, ulid } from "../common.js";
import { bytesOf, readSnapshot } from "../platform-support.js";
import { storedTimestamp } from "../../timestamps.js";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const uuid = z.string().regex(UUID_PATTERN);
/** The original contract: only a millisecond ISO string in canonical form is accepted (`new Date(v).toISOString() === v`). */
export const isoInstant = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .transform(storedTimestamp);

export const SQL_FILE_SETS = [
  ["dev.sql"],
  ["prod.sql"],
  ["dev.sql", "prod.sql"],
  ["shared.sql"],
  ["auth.sql"],
  ["dev.sql", "auth.sql"],
  ["prod.sql", "auth.sql"],
  ["dev.sql", "prod.sql", "auth.sql"],
  ["shared.sql", "auth.sql"],
] as const;
export const MAXIMUM_ARCHIVE_BYTES = 536_870_912;
export const INPUT_RETENTION_MILLISECONDS = 60 * 60 * 1000;
export const ARCHIVE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const EXPORT_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * The SQL clock of the shard database (SQLite/D1) as a stored timestamp: millisecond precision in the microsecond
 * stored form, so it compares as text with every stored instant. `'now'` is fixed per statement, and a statement of
 * a D1 batch runs when the batch executes, not when the Worker prepared it. The same expression the metering lane
 * uses for its database-clock lease fences.
 */
export const DB_NOW = "(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')";

/** Only current canonical logical identities enter recovery; historical retired names remain retained. */
export const recoveryEnvironmentAllowedSql = (alias: string) => `${alias}.name IN('dev','prod')`;

/** A capture keeps its original logical identity; an archived realm is never retargeted to a replacement. */
export const RECOVERY_JOB_DATA_ALLOWED_SQL = `EXISTS(SELECT 1 FROM environments recovery_environment
  WHERE recovery_environment.organization_id=job.organization_id AND recovery_environment.project_id=job.project_id
    AND recovery_environment.environment_id=job.environment_id AND ${recoveryEnvironmentAllowedSql("recovery_environment")})
  AND (job.sql_files IS NULL OR instr(job.sql_files,'"dev.sql"')=0 OR EXISTS(SELECT 1 FROM environments available_dev WHERE available_dev.organization_id=job.organization_id AND available_dev.project_id=job.project_id AND available_dev.name='dev'))
  AND NOT EXISTS(SELECT 1 FROM json_each(job.native_manifest,'$.realms') captured_realm WHERE NOT EXISTS(
    SELECT 1 FROM environments captured_environment WHERE captured_environment.organization_id=job.organization_id
      AND captured_environment.project_id=job.project_id AND captured_environment.environment_id=json_extract(captured_realm.value,'$.environmentId')
      AND ${recoveryEnvironmentAllowedSql("captured_environment")}))`;

/**
 * `clock: "execution"` is the production mode of the trusted entry point. Every time-dependent fence, lease and
 * expiry decision of one command then runs at the SQL clock of the shard database and nothing else: the decision
 * reads that clock inside its snapshot batch (`RecoverySnapshot.dbNow`), and every authority-changing write batch
 * carries a guard that compares against the SQL clock again WHEN THE BATCH EXECUTES. A supplied instant is ignored
 * (a request that waited, or a forged future instant, can neither revive an expired lease or sealed input nor
 * extend a lease), and a batch that queued past an expiry aborts as one unit and is decided again (`retryOn`) at the
 * database time it re-reads. D1 offers no interactive transaction, so the guard inside the one batch is what fences
 * a write that was submitted while the authority was still live. An absent field keeps the supplied instant and the
 * bound-parameter guards (deterministic callers and tests).
 */
export const executionClock = z.literal("execution").optional();

type ClockedInput = { readonly clock?: "execution" | undefined };

export function isExecutionClock(input: ClockedInput): boolean {
  return input.clock === "execution";
}

/** `field` of `input` replaced by the database instant of the snapshot when the execution clock is requested. */
export function atExecution<
  Field extends string,
  Input extends ClockedInput & Record<Field, string>,
>(input: Input, field: Field, dbNow: string): Input {
  return isExecutionClock(input) ? { ...input, [field]: dbNow } : input;
}

/**
 * The instant a write guard compares with, as SQL. Execution mode: the later of the decided instant (`param`) and the
 * SQL clock at execution, so the guard can only be stricter than the decision. Otherwise the bound instant itself.
 */
export function effectiveNowSql(param: string, execution: boolean): string {
  return execution ? `max(${param}, ${DB_NOW})` : param;
}

export const jobScope = {
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
};
export const projectScope = { organizationId: ulid, projectId: ulid };

export const archiveInput = z
  .strictObject({
    sqlFiles: z
      .array(z.string())
      .refine((files) =>
        SQL_FILE_SETS.some((set) => JSON.stringify(set) === JSON.stringify(files)),
      ),
    bytes: z.number().int().min(1).max(MAXIMUM_ARCHIVE_BYTES),
    sha256: z.instanceof(Uint8Array).refine((value) => value.byteLength === 32),
    capturedAt: isoInstant,
    nativeManifest: z.string().min(1).max(16384).optional(),
    nativeManifestSha256: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength === 32)
      .optional(),
  })
  .refine((value) =>
    value.sqlFiles.includes("auth.sql")
      ? value.nativeManifest !== undefined && value.nativeManifestSha256 !== undefined
      : value.nativeManifest === undefined && value.nativeManifestSha256 === undefined,
  );
export type ArchiveInput = z.output<typeof archiveInput>;

/** The identity of one job mutation: its claim and the event ids the operation transition will use. */
export const mutationFields = {
  ...jobScope,
  claimId: uuid,
  occurredAt: isoInstant,
  operationEventId: ulid,
  auditEventId: ulid,
  clock: executionClock,
};

export const failureCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/u);

export interface JobRow {
  readonly environment_id: string;
  readonly input_ciphertext: unknown;
  readonly input_nonce: unknown;
  readonly input_key_version: number | null;
  readonly input_expires_at: string;
  readonly requested_at: string;
  readonly claim_id: string | null;
  readonly archive_bucket: string;
  readonly archive_key: string;
  readonly archive_bytes: number | null;
  readonly sql_files: string | null;
  readonly archive_sha256: unknown;
  readonly native_manifest: string | null;
  readonly native_manifest_sha256: unknown;
  readonly captured_at: string | null;
  readonly archive_expires_at: string | null;
  readonly verified_at: string | null;
  readonly failure_code: string | null;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly billing_epoch_id: string;
  readonly event_count: number;
  readonly active_scope: number;
}

export interface FenceRow {
  readonly epoch: number;
  readonly holder_id: string;
  readonly operation_id: string;
  readonly claim_id: string;
  readonly acquired_at: string;
  readonly lease_expires_at: string;
  readonly released_at: string | null;
  readonly source_ownership_version: number;
  readonly source_lifecycle_version: number;
}

export interface ProjectFacts {
  readonly ownership_version: number;
  readonly lifecycle_version: number;
  readonly active: number;
}

export interface RecoverySnapshot {
  readonly delegation: WorkflowDelegationProof | null;
  readonly job: JobRow | null;
  readonly fence: FenceRow | null;
  readonly project: ProjectFacts | null;
  /** The SQL clock of the shard database inside the snapshot batch: the decision instant of `clock: "execution"`. */
  readonly dbNow: string;
}

const JOB_SQL = `SELECT job.environment_id, job.input_ciphertext, job.input_nonce, job.input_key_version, job.input_expires_at, job.requested_at,
    job.claim_id, job.archive_bucket, CASE WHEN job.native_manifest IS NULL THEN job.archive_key ELSE 'native-exports/'||job.organization_id||'/'||job.project_id||'/'||job.operation_id||'.zip' END AS archive_key, job.archive_bytes, job.sql_files, job.archive_sha256, job.native_manifest, job.native_manifest_sha256, job.captured_at,
    job.archive_expires_at, job.verified_at, job.failure_code, operation.state, operation.billing_epoch_id,
    (SELECT count(*) FROM operation_events event WHERE event.organization_id = job.organization_id AND event.operation_id = job.operation_id) AS event_count,
    EXISTS (SELECT 1 FROM projects project WHERE project.organization_id = job.organization_id AND project.project_id = job.project_id
              AND project.owner_state = 'active' AND project.lifecycle_state = 'active' AND ${RECOVERY_JOB_DATA_ALLOWED_SQL}) AS active_scope
  FROM project_recovery_jobs job
  JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id AND operation.project_id = job.project_id
  WHERE job.organization_id = ?1 AND job.project_id = ?2 AND job.operation_id = ?3`;

const FENCE_SQL = `SELECT epoch, holder_id, operation_id, claim_id, acquired_at, lease_expires_at, released_at, source_ownership_version, source_lifecycle_version
  FROM project_recovery_fences WHERE organization_id = ?1 AND project_id = ?2`;

const PROJECT_SQL = `SELECT ownership_version, lifecycle_version, (owner_state = 'active' AND lifecycle_state = 'active') AS active
  FROM projects WHERE organization_id = ?1 AND project_id = ?2`;

const DB_NOW_SQL = `SELECT ${DB_NOW} AS db_now`;

/** Typed literal reads used together by recovery and its atomic exhausted-delivery composer. */
export function recoverySnapshotQueries(scope: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
}): (readonly [string, ...unknown[]])[] {
  return [
    [JOB_SQL, scope.organizationId, scope.projectId, scope.operationId],
    [FENCE_SQL, scope.organizationId, scope.projectId],
    [PROJECT_SQL, scope.organizationId, scope.projectId],
    [DB_NOW_SQL],
    [
      "SELECT grant_id,client_id,consent_hash,principal_id,project_id,requires_publication,authorization_action,authorization_restriction,event_type FROM operation_mcp_delegations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      scope.organizationId,
      scope.projectId,
      scope.operationId,
    ],
  ];
}

export function recoverySnapshotOf(
  rows: readonly (readonly Record<string, unknown>[])[],
): RecoverySnapshot {
  const [job, fence, project, clock, delegation] = rows;
  return {
    delegation: (delegation?.[0] as unknown as WorkflowDelegationProof | undefined) ?? null,
    job: (job?.[0] as JobRow | undefined) ?? null,
    fence: (fence?.[0] as FenceRow | undefined) ?? null,
    project: (project?.[0] as ProjectFacts | undefined) ?? null,
    dbNow: (clock?.[0] as { db_now: string }).db_now,
  };
}

/** One D1 batch (one transaction) of the job, capture fence, versions and the SQL clock. */
export async function readRecoverySnapshot(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
): Promise<RecoverySnapshot> {
  return recoverySnapshotOf(await readSnapshot(db, recoverySnapshotQueries(scope)));
}

/** The fence of the project is held: not released and its lease has not lapsed at `now`. */
export function liveFence(fence: FenceRow | null, now: string): FenceRow | null {
  return fence !== null && fence.released_at === null && fence.lease_expires_at > now
    ? fence
    : null;
}

/**
 * The shard-side form of `pg_try_advisory_xact_lock_shared`: true when a capture holds the project at `now`.
 * Usable inside EXISTS(...) or a guard violation. Binds `?1` organization, `?2` project, `?3` now.
 */
export const FENCE_HELD_SQL = `EXISTS (SELECT 1 FROM project_recovery_fences held WHERE held.organization_id = ?1 AND held.project_id = ?2
  AND held.released_at IS NULL AND held.lease_expires_at > ?3)`;

/**
 * The caller is the current holder: the epoch, holder and operation match, the lease is live and the project still has
 * the ownership and lifecycle version the capture started from. Binds `?1` organization, `?2` project, `?3` epoch,
 * `?4` holder, `?5` operation, `?6` now. A stale holder, an expired lease or changed source facts make it false.
 * With `execution` the lease must be live at `max(?6, the SQL clock at execution)`, so a batch that waited past the
 * lease commits nothing.
 */
export function fenceCurrentSql(execution: boolean): string {
  return `SELECT 1 FROM project_recovery_fences fence
  JOIN projects project ON project.organization_id = fence.organization_id AND project.project_id = fence.project_id
  WHERE fence.organization_id = ?1 AND fence.project_id = ?2 AND fence.epoch = ?3 AND fence.holder_id = ?4 AND fence.operation_id = ?5
    AND fence.released_at IS NULL AND fence.lease_expires_at > ${effectiveNowSql("?6", execution)}
    AND project.ownership_version = fence.source_ownership_version AND project.lifecycle_version = fence.source_lifecycle_version
    AND project.owner_state = 'active' AND project.lifecycle_state = 'active'
    AND EXISTS(SELECT 1 FROM project_recovery_jobs job WHERE job.organization_id=fence.organization_id
      AND job.project_id=fence.project_id AND job.operation_id=fence.operation_id AND ${RECOVERY_JOB_DATA_ALLOWED_SQL})`;
}

/**
 * Another holder's live lease (a capture of another invocation holds the project) at `max(?3, the SQL clock)` when
 * `execution`. Binds `?1` organization, `?2` project, `?3` now, `?4` holder.
 */
export function fenceHeldByOtherSql(execution: boolean): string {
  return `EXISTS (SELECT 1 FROM project_recovery_fences held WHERE held.organization_id = ?1 AND held.project_id = ?2
  AND held.released_at IS NULL AND held.lease_expires_at > ${effectiveNowSql("?3", execution)} AND held.holder_id <> ?4)`;
}

export function fenceCurrentParams(
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
  holder: { readonly epoch: number; readonly holderId: string },
  now: string,
): unknown[] {
  return [
    scope.organizationId,
    scope.projectId,
    holder.epoch,
    holder.holderId,
    scope.operationId,
    now,
  ];
}

/** Aborts the batch unless the holder is current (`claim_lost`: the caller's ownership of the capture is gone). */
export function fenceCurrentGuard(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
  holder: { readonly epoch: number; readonly holderId: string },
  now: string,
  execution = false,
): D1PreparedStatement {
  return guard(
    db,
    "claim_lost",
    `NOT EXISTS (${fenceCurrentSql(execution)})`,
    fenceCurrentParams(scope, holder, now),
  );
}

export function isCurrentHolder(
  fence: FenceRow | null,
  project: ProjectFacts | null,
  holder: { readonly epoch: number; readonly holderId: string; readonly operationId: string },
  now: string,
): boolean {
  const live = liveFence(fence, now);
  return (
    live !== null &&
    live.epoch === holder.epoch &&
    live.holder_id === holder.holderId &&
    live.operation_id === holder.operationId &&
    project !== null &&
    project.active === 1 &&
    project.ownership_version === live.source_ownership_version &&
    project.lifecycle_version === live.source_lifecycle_version
  );
}

export type OperationStep = "start" | "succeed" | "fail";

const STEP = {
  start: { state: "running", event: "OperationStarted", from: "queued" },
  succeed: { state: "succeeded", event: "OperationSucceeded", from: "running" },
  fail: { state: "failed", event: "OperationFailed", from: "running" },
} as const;

/**
 * The operation transition of one job step: state compare-and-swap (`operation_conflict`), the next revision of
 * the append-only event history and the audit event, exactly what `persistOperationTransition` wrote in PostgreSQL.
 */
export function transitionStatements(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
  base: { readonly billingEpochId: string; readonly eventCount: number },
  step: {
    readonly action: OperationStep;
    readonly operationEventId: string;
    readonly auditEventId: string;
    readonly occurredAt: string;
    readonly failureCode?: string | undefined;
  },
): D1PreparedStatement[] {
  const target = STEP[step.action];
  const failure =
    step.action === "fail"
      ? JSON.stringify({
          code: step.failureCode,
          message: "The recovery job did not complete.",
        })
      : null;
  return [
    db
      .prepare(
        "UPDATE operations SET state = ?3, failure = ?4, updated_at = ?5, lease_expires_at = ?6 WHERE organization_id = ?1 AND operation_id = ?2 AND state = ?7",
      )
      .bind(
        scope.organizationId,
        scope.operationId,
        target.state,
        failure,
        step.occurredAt,
        step.action === "start"
          ? addMilliseconds(step.occurredAt, OPERATION_LEASE_MILLISECONDS)
          : null,
        target.from,
      ),
    guard(db, "operation_conflict", "changes() = 0"),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id, operation_id, revision, event_id, project_id, event_type, idempotency_key, payload, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(
        scope.organizationId,
        scope.operationId,
        base.eventCount,
        step.operationEventId,
        scope.projectId,
        target.event,
        `recovery:${step.action}`,
        failure === null ? "{}" : JSON.stringify({ failure: JSON.parse(failure) }),
        step.occurredAt,
      ),
    auditStatement(db, scope.organizationId, {
      auditEventId: step.auditEventId,
      projectId: scope.projectId,
      operationId: scope.operationId,
      billingEpochId: base.billingEpochId,
      eventType: target.event,
      actorType: "service",
      actorId: "project-recovery",
      payload: {},
      occurredAt: step.occurredAt,
    }),
  ];
}

export function blobOf(value: unknown): Uint8Array {
  return bytesOf(value);
}

export function sameArchive(job: JobRow, archive: ArchiveInput): boolean {
  return (
    job.sql_files === JSON.stringify(archive.sqlFiles) &&
    job.archive_bytes === archive.bytes &&
    job.archive_sha256 !== null &&
    sameBlob(blobOf(job.archive_sha256), archive.sha256) &&
    (archive.nativeManifest === undefined
      ? job.native_manifest === null && job.native_manifest_sha256 === null
      : job.native_manifest === archive.nativeManifest &&
        job.native_manifest_sha256 !== null &&
        archive.nativeManifestSha256 !== undefined &&
        sameBlob(blobOf(job.native_manifest_sha256), archive.nativeManifestSha256)) &&
    job.captured_at === archive.capturedAt
  );
}

function sameBlob(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
