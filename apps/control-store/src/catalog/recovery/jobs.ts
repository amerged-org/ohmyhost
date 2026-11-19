import { workflowExecutionGuards } from "../provisioning/authority.js";
import {
  assertOperationDelegationCurrent,
  operationAction,
  restrictionAllows,
} from "../identity/operation-delegations.js";
import { isUserRevoked } from "../identity/mcp-sql.js";
import {
  authorizeOrganizationAction,
  canonicalAuthorizationGuard,
} from "../projects/customer-projects-access.js";
import { z } from "zod";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import {
  addMilliseconds,
  conflict,
  instant,
  notFencedOrganization,
  ringDoorbell,
  routeOrganization,
  rowsOf,
  ulid,
  type CatalogContext,
} from "../common.js";
import { acceptApiOperationInput, acceptStatements } from "../operations/accept-api-operation.js";
import {
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import { isoOf } from "../platform-support.js";
import {
  ProjectRecoveryConflictError,
  ProjectRecoveryDailyLimitError,
  RecoveryFenceLostError,
} from "./errors.js";
import {
  ARCHIVE_RETENTION_MILLISECONDS,
  EXPORT_WINDOW_MILLISECONDS,
  INPUT_RETENTION_MILLISECONDS,
  archiveInput,
  DB_NOW,
  atExecution,
  blobOf,
  executionClock,
  effectiveNowSql,
  failureCode as failureCodeSchema,
  fenceCurrentGuard,
  fenceHeldByOtherSql,
  isCurrentHolder,
  isExecutionClock,
  liveFence,
  jobScope,
  mutationFields,
  readRecoverySnapshot,
  sameArchive,
  transitionStatements,
  uuid,
  recoveryEnvironmentAllowedSql,
  RECOVERY_JOB_DATA_ALLOWED_SQL,
  type ArchiveInput,
  type JobRow,
  type RecoverySnapshot,
} from "./shared.js";

export type RecoveryJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Nothing here can name a statement: every field is a typed value of one recovery job. */
const STALE: (
  | "claim_lost"
  | "operation_conflict"
  | "precondition_changed"
  | "row_version_conflict"
)[] = ["claim_lost", "operation_conflict", "precondition_changed", "row_version_conflict"];

// ---------------------------------------------------------------------------------------------------------------
// accept: one authoritative transaction, one D1 batch (idempotency receipt + operation + audit + outbox + job)
// ---------------------------------------------------------------------------------------------------------------

export const acceptRecoveryJobInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  billingEpochId: ulid,
  operationId: ulid,
  operationEventId: ulid,
  auditEventId: ulid,
  outboxEventId: ulid,
  principalId: z.string().trim().min(1),
  actorType: z.enum(["principal", "service"]).default("principal"),
  requestId: z.string().trim().min(1),
  httpMethod: z.enum(["POST", "PUT", "DELETE"]),
  routeTemplate: z.string().startsWith("/v1/"),
  idempotencyKey: z.string().trim().min(1).max(255),
  canonicalRequestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  occurredAt: instant,
  clock: executionClock,
  projectAnchor: z.literal(true).optional(),
  developmentAnchor: z.literal(true).optional(),
  availableAt: instant.optional(),
  delegation: acceptApiOperationInput.shape.delegation,
  archiveBucket: z.enum(["ohmyho-development-backups", "ohmyho-production-backups"]),
  /** The sealed password envelope: the ciphertext is opaque to the store and kept byte for byte. */
  sealedInput: z.strictObject({
    ciphertext: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength >= 17 && value.byteLength <= 8208),
    nonce: z.instanceof(Uint8Array).refine((value) => value.byteLength === 12),
    keyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
});
export type AcceptRecoveryJobInput = z.input<typeof acceptRecoveryJobInput>;

export interface AcceptRecoveryJobResult {
  readonly outcome: "created" | "replayed";
  readonly operationId: string;
}

interface AcceptSnapshot {
  readonly record: ReturnType<typeof storedIdempotencyRecord>;
  readonly storedJob: boolean;
  readonly scopeActive: boolean;
  readonly latestRequestedAt: string | null;
  readonly dbNow: string;
}

/** The failure of an export whose database could not be woken or read: it failed before any dump was taken. */
const UNAVAILABLE_DATABASE_FAILURE = "RECOVERY_DATABASE_UNAVAILABLE";
/** A job counts against the rolling export window unless its database was unavailable; `table` names its alias. */
const countedInWindow = (table: string) =>
  `(${table}.failure_code IS NULL OR ${table}.failure_code <> '${UNAVAILABLE_DATABASE_FAILURE}')`;
const QUOTA_SQL = `SELECT max(requested_at) AS latest FROM project_recovery_jobs WHERE project_id = ?1 AND ${countedInWindow("project_recovery_jobs")}`;

/**
 * `acceptProjectRecoveryJob` as ONE batch: the complete idempotency receipt, scope/owner guards, the queued
 * operation with its first event, audit event and outbox event (the shared `acceptStatements`), the rolling
 * 24-hour guard and the job row with its sealed input. The daily limit is read for a typed refusal AND guarded in
 * the batch, so two concurrent exports of one project cannot both commit; a lost response replays through the
 * idempotency receipt and never creates a second job.
 */
export async function acceptRecoveryJob(
  context: CatalogContext,
  rawInput: unknown,
): Promise<AcceptRecoveryJobResult> {
  const input = acceptRecoveryJobInput.parse(rawInput);
  if (
    input.delegation !== undefined &&
    (input.delegation.action !== operationAction("ProjectRecoveryRequestedV1") ||
      !restrictionAllows(input.delegation.authorizationRestriction, {
        action: input.delegation.action,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }) ||
      (await isUserRevoked(
        context.directory,
        input.principalId.startsWith("user:") ? input.principalId.slice(5) : "",
      )) ||
      (await authorizeOrganizationAction(context, {
        organizationId: input.organizationId,
        principalId: input.principalId,
        projectId: input.projectId,
        action: input.delegation.action,
      })) !== "allow")
  )
    throw conflict("operation_authorization_changed", "Queued operation authorization changed");
  const { archiveBucket, sealedInput, ...rest } = input;
  delete rest.clock;
  delete rest.projectAnchor;
  delete rest.developmentAnchor;
  const shard = await routeOrganization(context, input.organizationId);
  const command: Command<AcceptSnapshot, AcceptRecoveryJobResult> = {
    name: "recovery.acceptRecoveryJob",
    input,
    retryOn: STALE,
    naturalKeyTables: ["api_idempotency_records", "operations", "project_recovery_jobs"],
    read: async (reader) => {
      const [record, stored, scope, quota, clock] = await reader.batch([
        readIdempotencyRecordStatement(reader, input),
        reader
          .prepare(
            `SELECT 1 AS present FROM api_idempotency_records receipt
             JOIN project_recovery_jobs job ON job.organization_id = receipt.organization_id AND job.operation_id = receipt.operation_id AND job.project_id = ?6
             WHERE receipt.organization_id = ?1 AND receipt.principal_id = ?2 AND receipt.http_method = ?3
               AND receipt.route_template = ?4 AND receipt.idempotency_key = ?5`,
          )
          .bind(
            input.organizationId,
            input.principalId,
            input.httpMethod,
            input.routeTemplate,
            input.idempotencyKey,
            input.projectId,
          ),
        reader
          .prepare(
            `SELECT 1 AS active FROM projects p JOIN environments e ON e.organization_id = p.organization_id AND e.project_id = p.project_id
             WHERE p.organization_id = ?1 AND p.project_id = ?2 AND p.owner_state = 'active' AND p.lifecycle_state = 'active' AND e.environment_id = ?3 AND ${recoveryEnvironmentAllowedSql("e")}
              AND (?4 = 0 OR (EXISTS(SELECT 1 FROM environments prod WHERE prod.organization_id=?1 AND prod.project_id=?2 AND prod.name='prod')
                AND e.environment_id=(SELECT environment_id FROM environments current WHERE current.organization_id=?1 AND current.project_id=?2 AND ${recoveryEnvironmentAllowedSql("current")} ORDER BY current.name LIMIT 1)))`,
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.projectAnchor === true || input.developmentAnchor === true ? 1 : 0,
          ),
        reader.prepare(QUOTA_SQL).bind(input.projectId),
        reader.prepare(`SELECT ${DB_NOW} AS db_now`),
      ]);
      return {
        record: storedIdempotencyRecord(rowsOf(record)[0]),
        storedJob: rowsOf(stored).length === 1,
        scopeActive: rowsOf(scope).length === 1,
        dbNow: rowsOf<{ db_now: string }>(clock)[0]?.db_now ?? "",
        latestRequestedAt: (
          rowsOf<{ latest: string | null }>(quota)[0] as { latest: string | null }
        ).latest,
      };
    },
    decide: ({
      record,
      storedJob,
      scopeActive,
      latestRequestedAt,
      dbNow,
    }): Plan<AcceptRecoveryJobResult> => {
      const current = atExecution(input, "occurredAt", dbNow);
      const accepted = acceptApiOperationInput.parse({
        ...rest,
        occurredAt: current.occurredAt,
        eventType: "ProjectRecoveryRequestedV1",
      });
      const windowStart = addMilliseconds(current.occurredAt, -EXPORT_WINDOW_MILLISECONDS);
      if (record !== null) {
        if (record.digestHex !== input.canonicalRequestDigest || record.operationId === null) {
          return {
            reject: conflict(
              "idempotency_conflict",
              "Idempotency key conflicts or the first request is incomplete",
            ),
          };
        }
        if (!storedJob) return { reject: new ProjectRecoveryConflictError() };
        return { replay: { outcome: "replayed", operationId: record.operationId } };
      }
      if (!scopeActive) {
        return {
          reject: conflict(
            "scope_inactive",
            "API operation requires one active tenant-scoped project environment",
          ),
        };
      }
      if (latestRequestedAt !== null && latestRequestedAt > windowStart) {
        return {
          reject: new ProjectRecoveryDailyLimitError(
            isoOf(addMilliseconds(latestRequestedAt, EXPORT_WINDOW_MILLISECONDS)),
          ),
        };
      }
      return {
        statements: [
          guard(
            shard.db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM environments recovery_environment WHERE recovery_environment.organization_id=?1
              AND recovery_environment.project_id=?2 AND recovery_environment.environment_id=?3 AND ${recoveryEnvironmentAllowedSql("recovery_environment")})`,
            [input.organizationId, input.projectId, input.environmentId],
          ),
          ...(input.projectAnchor === true || input.developmentAnchor === true
            ? [
                guard(
                  shard.db,
                  "precondition_changed",
                  `NOT EXISTS(SELECT 1 FROM environments WHERE organization_id=?1 AND project_id=?2 AND name='prod')
                    OR ?3 IS NOT (SELECT environment_id FROM environments current WHERE organization_id=?1 AND project_id=?2 AND ${recoveryEnvironmentAllowedSql("current")} ORDER BY name LIMIT 1)`,
                  [input.organizationId, input.projectId, input.environmentId],
                ),
              ]
            : []),
          ...acceptStatements(shard.db, accepted, false, input.delegation !== undefined),
          guard(
            shard.db,
            "precondition_changed",
            `EXISTS (SELECT 1 FROM project_recovery_jobs WHERE project_id = ?1 AND requested_at > ?2 AND ${countedInWindow("project_recovery_jobs")})`,
            [input.projectId, windowStart],
          ),
          shard.db
            .prepare(
              "INSERT INTO project_recovery_jobs(organization_id, operation_id, project_id, environment_id, input_ciphertext, input_nonce, input_key_version, input_expires_at, requested_at, archive_bucket) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .bind(
              input.organizationId,
              input.operationId,
              input.projectId,
              input.environmentId,
              sealedInput.ciphertext,
              sealedInput.nonce,
              sealedInput.keyVersion,
              addMilliseconds(current.occurredAt, INPUT_RETENTION_MILLISECONDS),
              current.occurredAt,
              archiveBucket,
            ),
        ],
        result: () => ({ outcome: "created", operationId: input.operationId }),
      };
    },
  };
  const result = await runCommand(shard.db, command);
  if (result.outcome === "replayed")
    await assertOperationDelegationCurrent(context, {
      organizationId: input.organizationId,
      operationId: result.operationId,
    });
  const due =
    input.clock === "execution"
      ? await shard.db
          .prepare(
            `SELECT COALESCE((SELECT min(available_at) FROM outbox_events
    WHERE organization_id=?1 AND operation_id=?2 AND event_type='ProjectRecoveryRequestedV1'), ${DB_NOW}) AS due`,
          )
          .bind(input.organizationId, result.operationId)
          .first<{ due: string }>()
      : null;
  await ringDoorbell(
    context.directory,
    "outbox",
    shard.shardId,
    due?.due ?? input.availableAt ?? input.occurredAt,
  );
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------------------------------------------

export const claimRecoveryJobInput = z
  .strictObject({
    ...mutationFields,
    /** The fence holder of this invocation, when it already holds the capture fence. Others wait while it is held. */
    holderId: uuid.optional(),
    /**
     * A holder that claims inside its fence may name the terminal step of a denied claim (input expired, scope gone):
     * the denial, the operation failure and the release of that holder's fence then commit in ONE batch, exactly like
     * the original claim-then-fail transaction and the dispatch command.
     */
    denial: z
      .strictObject({
        /** The epoch of the holder's fence, released with the failure; absent for a claim made before any fence. */
        epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
        operationEventId: ulid,
        auditEventId: ulid,
      })
      .optional(),
  })
  .refine((value) => value.denial?.epoch === undefined || value.holderId !== undefined);
type ClaimInput = z.output<typeof claimRecoveryJobInput>;

export interface RecoveryArchive {
  readonly sqlFiles: readonly string[];
  readonly bytes: number;
  readonly sha256: Uint8Array;
  readonly capturedAt: string;
  readonly nativeManifest?: string;
  readonly nativeManifestSha256?: Uint8Array;
}

export interface ClaimedRecoveryJob {
  readonly status: "claimed";
  readonly preparedArchive: RecoveryArchive | null;
  readonly expired: boolean;
  readonly denialCode: "RECOVERY_SCOPE_UNAVAILABLE" | "RECOVERY_INPUT_EXPIRED" | null;
  readonly replayed: boolean;
  readonly archiveBucket: string;
  readonly archiveKey: string;
  readonly sealedInput: {
    readonly ciphertext: Uint8Array;
    readonly nonce: Uint8Array;
    readonly keyVersion: number;
  } | null;
}

/** `absent`: no such job in the exact scope. Any other status: not claimable now (terminal, or a capture holds it). */
export type ClaimRecoveryJobResult =
  | { readonly status: RecoveryJobStatus | "absent" }
  | ClaimedRecoveryJob;

type ClaimPlan =
  | { readonly kind: "done"; readonly result: ClaimRecoveryJobResult }
  | { readonly kind: "reject"; readonly error: Error }
  | {
      readonly kind: "write";
      readonly statements: D1PreparedStatement[];
      readonly result: ClaimedRecoveryJob;
      readonly job: JobRow;
      /** Operation events after the statements: a composing terminal step continues from here. */
      readonly eventCount: number;
    };

function archiveOf(job: JobRow): RecoveryArchive | null {
  if (job.archive_bytes === null) return null;
  if (job.archive_sha256 === null || job.captured_at === null || job.sql_files === null) {
    return null;
  }
  return {
    sqlFiles: JSON.parse(job.sql_files) as string[],
    bytes: job.archive_bytes,
    sha256: blobOf(job.archive_sha256),
    capturedAt: isoOf(job.captured_at),
    ...(job.native_manifest === null || job.native_manifest_sha256 === null
      ? {}
      : {
          nativeManifest: job.native_manifest,
          nativeManifestSha256: blobOf(job.native_manifest_sha256),
        }),
  };
}

/**
 * The sealed input may be handed out only while it is still stored, unexpired and its project still active at the
 * moment the batch EXECUTES (`max(?4, SQL clock)`): the decision may have been taken before an expiry that the queued
 * batch then crosses. A violation aborts the whole claim batch and the claim is decided again at the database time it
 * re-reads, which withdraws the envelope together with the denial. Binds ?1 org ?2 operation ?3 project ?4 instant.
 */
const SEALED_INPUT_DELIVERABLE_SQL = `NOT EXISTS (SELECT 1 FROM project_recovery_jobs job
  JOIN projects project ON project.organization_id = job.organization_id AND project.project_id = job.project_id
  WHERE job.organization_id = ?1 AND job.operation_id = ?2 AND job.project_id = ?3 AND job.finished_at IS NULL
    AND job.input_ciphertext IS NOT NULL AND job.input_expires_at > ${effectiveNowSql("?4", true)}
    AND project.owner_state = 'active' AND project.lifecycle_state = 'active' AND ${RECOVERY_JOB_DATA_ALLOWED_SQL})`;

/**
 * `claimProjectRecoveryJob` as a pure plan, so the dispatch command can compose it with its terminal step into one
 * batch. A live fence of another holder is a wait (PG: the advisory lock was not available), never a failure.
 * `input.occurredAt` is already the decision instant (the snapshot's SQL clock under `clock: "execution"`).
 */
function planClaim(
  db: D1Database,
  snapshot: RecoverySnapshot,
  input: ClaimInput,
  holderId: string | undefined,
): ClaimPlan {
  const execution = isExecutionClock(input);
  const { job, fence } = snapshot;
  if (job === null) return { kind: "done", result: { status: "absent" } };
  const live = liveFence(fence, input.occurredAt);
  if (live !== null && live.holder_id !== holderId) {
    return { kind: "done", result: { status: job.state } };
  }
  const replayed = job.state === "running" && job.claim_id === input.claimId;
  if (job.state !== "queued" && !replayed) return { kind: "done", result: { status: job.state } };
  if (!replayed && job.claim_id !== null) {
    return { kind: "reject", error: new ProjectRecoveryConflictError() };
  }
  const expired = job.input_expires_at <= input.occurredAt;
  const denialCode =
    job.active_scope !== 1
      ? ("RECOVERY_SCOPE_UNAVAILABLE" as const)
      : expired && job.archive_bytes === null
        ? ("RECOVERY_INPUT_EXPIRED" as const)
        : null;
  let sealedInput: ClaimedRecoveryJob["sealedInput"] = null;
  if (denialCode === null && !expired) {
    if (
      job.input_ciphertext === null ||
      job.input_nonce === null ||
      job.input_key_version === null
    ) {
      return { kind: "reject", error: new ProjectRecoveryConflictError() };
    }
    sealedInput = {
      ciphertext: blobOf(job.input_ciphertext),
      nonce: blobOf(job.input_nonce),
      keyVersion: job.input_key_version,
    };
  }
  const preparedArchive = archiveOf(job);
  if (job.archive_bytes !== null && preparedArchive === null) {
    return { kind: "reject", error: new ProjectRecoveryConflictError() };
  }
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    operationId: input.operationId,
  };
  const statements = [
    ...workflowExecutionGuards(db, scope, snapshot.delegation),
    guard(db, "precondition_changed", fenceHeldByOtherSql(execution), [
      input.organizationId,
      input.projectId,
      input.occurredAt,
      holderId ?? "",
    ]),
    ...(execution && sealedInput !== null
      ? [
          guard(db, "precondition_changed", SEALED_INPUT_DELIVERABLE_SQL, [
            input.organizationId,
            input.operationId,
            input.projectId,
            input.occurredAt,
          ]),
        ]
      : []),
    ...(replayed
      ? []
      : transitionStatements(
          db,
          scope,
          { billingEpochId: job.billing_epoch_id, eventCount: job.event_count },
          {
            action: "start",
            operationEventId: input.operationEventId,
            auditEventId: input.auditEventId,
            occurredAt: input.occurredAt,
          },
        )),
    db
      .prepare(
        `UPDATE project_recovery_jobs SET claim_id = ?4, started_at = COALESCE(started_at, ?5),
           input_ciphertext = CASE WHEN ?6 = 1 THEN NULL ELSE input_ciphertext END,
           input_nonce = CASE WHEN ?6 = 1 THEN NULL ELSE input_nonce END,
           input_key_version = CASE WHEN ?6 = 1 THEN NULL ELSE input_key_version END
         WHERE organization_id = ?1 AND operation_id = ?2 AND project_id = ?3 AND finished_at IS NULL
           AND (claim_id IS NULL OR claim_id = ?4)`,
      )
      .bind(
        input.organizationId,
        input.operationId,
        input.projectId,
        input.claimId,
        input.occurredAt,
        denialCode !== null || expired ? 1 : 0,
      ),
    guard(db, "claim_lost", "changes() = 0"),
  ];
  return {
    kind: "write",
    statements,
    job,
    eventCount: job.event_count + (replayed ? 0 : 1),
    result: {
      status: "claimed",
      preparedArchive,
      expired,
      denialCode,
      replayed,
      archiveBucket: job.archive_bucket,
      archiveKey: job.archive_key,
      sealedInput,
    },
  };
}

/** `claimProjectRecoveryJob`: start the operation, record the claim and withdraw an expired or denied input, in one batch. */
export async function claimRecoveryJob(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ClaimRecoveryJobResult> {
  const request = claimRecoveryJobInput.parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<RecoverySnapshot, ClaimRecoveryJobResult> = {
    name: "recovery.claimRecoveryJob",
    input: request,
    retryOn: STALE,
    read: (reader) => readRecoverySnapshot(reader, request),
    decide: (snapshot) => {
      // The input-expiry and fence decisions use the SQL clock this attempt just read (`clock: "execution"`); the
      // write batch re-checks the sealed input, the scope and the fences against the SQL clock when it executes.
      const input = atExecution(request, "occurredAt", snapshot.dbNow);
      const plan = planClaim(shard.db, snapshot, input, input.holderId);
      if (plan.kind === "done") return { replay: plan.result };
      if (plan.kind === "reject") return { reject: plan.error };
      const denial = plan.result.denialCode;
      if (input.denial !== undefined && denial !== null) {
        const holder =
          input.denial.epoch !== undefined && input.holderId !== undefined
            ? { epoch: input.denial.epoch, holderId: input.holderId }
            : undefined;
        return {
          statements: [
            ...plan.statements,
            ...failureStatements(
              shard.db,
              input,
              { billingEpochId: plan.job.billing_epoch_id, eventCount: plan.eventCount },
              {
                claimId: input.claimId,
                occurredAt: input.occurredAt,
                operationEventId: input.denial.operationEventId,
                auditEventId: input.denial.auditEventId,
                failureCode: denial,
                fence: holder,
              },
            ),
          ],
          result: () => ({ status: "failed" }),
        };
      }
      return { statements: plan.statements, result: () => plan.result };
    },
  };
  return runCommand(shard.db, command);
}

// ---------------------------------------------------------------------------------------------------------------
// prepare archive
// ---------------------------------------------------------------------------------------------------------------

const holderFields = {
  epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  holderId: uuid,
};

export const prepareRecoveryArchiveInput = z.strictObject({
  ...mutationFields,
  archive: archiveInput,
  fence: z.strictObject(holderFields),
});

const nativeManifestSchema = z.strictObject({
  schemaVersion: z.literal("ohmyhost.native-auth-inventory/v1"),
  organizationId: ulid,
  projectId: ulid,
  databaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  migrationVersion: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_VERSION),
  migrationDigest: z.literal(NATIVE_AUTH_SCHEMA_MIGRATION_SHA256),
  realms: z
    .array(
      z.strictObject({
        environmentId: ulid,
        schemaName: z.string(),
        revocationEpoch: z.number().int().min(1).max(2147483647),
        configurationRevision: z.number().int().min(1).max(2147483647),
        dumpOffset: z
          .number()
          .int()
          .min(0)
          .max(2 ** 40),
        dumpBytes: z
          .number()
          .int()
          .min(1)
          .max(2 ** 40),
        dumpSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .min(1)
    .max(2),
});
async function validateNativeManifest(
  archive: ArchiveInput,
  scope: { organizationId: string; projectId: string },
): Promise<string | null> {
  if (archive.nativeManifest === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(archive.nativeManifest);
  } catch {
    throw new ProjectRecoveryConflictError();
  }
  const parsed = nativeManifestSchema.safeParse(decoded);
  if (
    !parsed.success ||
    JSON.stringify(parsed.data) !== archive.nativeManifest ||
    parsed.data.organizationId !== scope.organizationId ||
    parsed.data.projectId !== scope.projectId ||
    parsed.data.realms.some((r, index, all) => {
      const previous = all[index - 1];
      return (
        r.schemaName !== `omh_auth_${r.environmentId.toLowerCase()}` ||
        (index === 0
          ? r.dumpOffset !== 0
          : previous === undefined ||
            r.environmentId <= previous.environmentId ||
            r.dumpOffset !== previous.dumpOffset + previous.dumpBytes) ||
        r.dumpOffset + r.dumpBytes > 2 ** 40
      );
    })
  )
    throw new ProjectRecoveryConflictError();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(archive.nativeManifest)),
  );
  if (
    !archive.nativeManifestSha256 ||
    digest.some((value, index) => value !== archive.nativeManifestSha256?.[index])
  )
    throw new ProjectRecoveryConflictError();
  return archive.nativeManifest;
}
function nativeManifestGuard(
  db: D1Database,
  scope: { organizationId: string; projectId: string },
  manifest: string | null,
  archive: ArchiveInput,
): D1PreparedStatement[] {
  const dataGuards = archive.sqlFiles.includes("dev.sql")
    ? [
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM environments WHERE organization_id=?1 AND project_id=?2 AND name='dev')",
          [scope.organizationId, scope.projectId],
        ),
      ]
    : [];
  const visibleRealm = `SELECT 1 FROM native_auth_realms r JOIN environments current ON current.organization_id=r.organization_id AND current.project_id=r.project_id AND current.environment_id=r.environment_id
    WHERE r.organization_id=?1 AND r.project_id=?2 AND ${recoveryEnvironmentAllowedSql("current")}`;
  const unresolved = `SELECT 1 FROM native_auth_database_operations operation JOIN environments current ON current.organization_id=operation.organization_id AND current.project_id=operation.project_id AND current.environment_id=operation.environment_id
    WHERE operation.organization_id=?1 AND operation.project_id=?2 AND operation.state='dispatched' AND operation.database_id IS NULL AND ${recoveryEnvironmentAllowedSql("current")}`;
  if (manifest === null)
    return [
      ...dataGuards,
      guard(
        db,
        "precondition_changed",
        `EXISTS(SELECT 1 FROM native_auth_database_targets WHERE project_id=?2 AND ended_at IS NULL AND (NOT EXISTS(SELECT 1 FROM native_auth_realms any_realm WHERE any_realm.organization_id=?1 AND any_realm.project_id=?2) OR EXISTS(${visibleRealm}))) OR EXISTS(${unresolved})`,
        [scope.organizationId, scope.projectId],
      ),
    ];
  return [
    ...dataGuards,
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM native_auth_database_targets t WHERE t.project_id=?2 AND t.ended_at IS NULL AND t.database_id=json_extract(?3,'$.databaseId')) OR EXISTS(${unresolved}) OR EXISTS(SELECT 1 FROM native_auth_policy_syncs policy JOIN environments current ON current.organization_id=policy.organization_id AND current.project_id=policy.project_id AND current.environment_id=policy.environment_id AND ${recoveryEnvironmentAllowedSql("current")} WHERE policy.organization_id=?1 AND policy.project_id=?2 AND policy.state IN('pending','refresh_pending_cleanup')) OR EXISTS(SELECT 1 FROM native_auth_restores WHERE organization_id=?1 AND project_id=?2 AND state='restoring') OR EXISTS(SELECT 1 FROM json_each(?3,'$.realms') item WHERE NOT EXISTS(SELECT 1 FROM native_auth_realms r JOIN environments current ON current.organization_id=r.organization_id AND current.project_id=r.project_id AND current.environment_id=r.environment_id AND ${recoveryEnvironmentAllowedSql("current")} JOIN native_auth_preparation_receipts p ON p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.environment_id=r.environment_id JOIN native_auth_database_targets t ON t.project_id=p.project_id AND t.database_id=p.database_id AND t.target_version=p.target_version AND t.ended_at IS NULL WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=json_extract(item.value,'$.environmentId') AND r.configuration_revision=json_extract(item.value,'$.configurationRevision') AND r.revocation_epoch=json_extract(item.value,'$.revocationEpoch') AND p.schema_name=json_extract(item.value,'$.schemaName') AND p.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND p.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}')) OR (SELECT count(DISTINCT p.environment_id) FROM native_auth_preparation_receipts p JOIN native_auth_realms r ON r.organization_id=p.organization_id AND r.project_id=p.project_id AND r.environment_id=p.environment_id JOIN environments current ON current.organization_id=r.organization_id AND current.project_id=r.project_id AND current.environment_id=r.environment_id AND ${recoveryEnvironmentAllowedSql("current")} JOIN native_auth_database_targets t ON t.project_id=p.project_id AND t.database_id=p.database_id AND t.target_version=p.target_version AND t.ended_at IS NULL WHERE p.organization_id=?1 AND p.project_id=?2 AND p.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND p.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}')<>json_array_length(?3,'$.realms')`,
      [scope.organizationId, scope.projectId, manifest],
    ),
  ];
}

type NativeActorSnapshot = RecoverySnapshot & { nativeActor: string | null };
async function readNativeActorSnapshot(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string },
): Promise<NativeActorSnapshot> {
  const snapshot = await readRecoverySnapshot(db, scope);
  const result = await db
    .prepare(
      `SELECT a.actor_id FROM audit_events a WHERE a.organization_id=?1 AND a.project_id=?2 AND a.operation_id=?3 AND a.event_type='ProjectRecoveryRequestedV1' AND a.actor_type='principal' AND (SELECT count(*) FROM api_idempotency_records r WHERE r.organization_id=a.organization_id AND r.operation_id=a.operation_id AND r.principal_id=a.actor_id)=1`,
    )
    .bind(scope.organizationId, scope.projectId, scope.operationId)
    .all<{ actor_id: string }>();
  return {
    ...snapshot,
    nativeActor: result.results.length === 1 ? (result.results[0]?.actor_id ?? null) : null,
  };
}
function nativeActorGuards(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string },
  actor: string | null,
): D1PreparedStatement[] {
  if (!actor?.startsWith("user:") || actor.length <= 5) return [guard(db, "consent_changed", "1")];
  return [
    guard(
      db,
      "consent_changed",
      `(SELECT count(*) FROM audit_events a WHERE a.organization_id=?1 AND a.project_id=?2 AND a.operation_id=?3 AND a.event_type='ProjectRecoveryRequestedV1' AND a.actor_type='principal' AND a.actor_id=?4 AND (SELECT count(*) FROM api_idempotency_records r WHERE r.organization_id=a.organization_id AND r.operation_id=a.operation_id AND r.principal_id=a.actor_id)=1)<>1 OR (SELECT count(*) FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectRecoveryRequestedV1')<>1 OR (SELECT count(*) FROM api_idempotency_records WHERE organization_id=?1 AND operation_id=?3)<>1`,
      [scope.organizationId, scope.projectId, scope.operationId, actor],
    ),
    canonicalAuthorizationGuard(db, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      principalId: actor,
      action: "projects:write",
    }),
    guard(
      db,
      "consent_changed",
      "EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1)",
      [actor.slice(5)],
    ),
  ];
}

function nativeExportBillingGuard(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string },
): D1PreparedStatement {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM operations o JOIN projects p ON p.organization_id=o.organization_id AND p.project_id=o.project_id AND p.active_billing_epoch_id=o.billing_epoch_id JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL WHERE o.organization_id=?1 AND o.project_id=?2 AND o.operation_id=?3)`,
    [scope.organizationId, scope.projectId, scope.operationId],
  );
}

/** Before disclosing the Native backup reference, recheck the original actor and the live capture lease. */
export async function authorizeNativeRecoveryCapture(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ authorized: true }> {
  const request = z
    .strictObject({ ...mutationFields, fence: z.strictObject(holderFields) })
    .parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<NativeActorSnapshot, { authorized: true }> = {
    name: "recovery.authorizeNativeRecoveryCapture",
    input: request,
    retryOn: STALE,
    read: (db) => readNativeActorSnapshot(db, request),
    decide: ({ job, fence, project, dbNow, delegation, nativeActor }) => {
      const input = atExecution(request, "occurredAt", dbNow);
      if (
        job === null ||
        job.active_scope !== 1 ||
        job.state !== "running" ||
        job.claim_id !== input.claimId
      )
        return { reject: new ProjectRecoveryConflictError() };
      if (
        !isCurrentHolder(
          fence,
          project,
          { ...input.fence, operationId: input.operationId },
          input.occurredAt,
        )
      )
        return { reject: new RecoveryFenceLostError() };
      return {
        statements: [
          ...workflowExecutionGuards(shard.db, input, delegation),
          nativeExportBillingGuard(shard.db, input),
          ...nativeActorGuards(shard.db, input, nativeActor),
          fenceCurrentGuard(
            shard.db,
            input,
            input.fence,
            input.occurredAt,
            isExecutionClock(request),
          ),
        ],
        result: () => ({ authorized: true }),
      };
    },
  };
  return runCommand(shard.db, command);
}

/**
 * `prepareProjectRecoveryArchive`: records the captured archive metadata (the digest the later storage readback is
 * compared with). The metadata is accepted only while the caller still holds the capture fence at its epoch, the
 * lease is live and the project still has the ownership and lifecycle version the capture started from; a stale
 * holder is refused before anything is written. A repeat with the identical archive is a replay.
 */
export async function prepareRecoveryArchive(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly outcome: "prepared" | "replayed" }> {
  const request = prepareRecoveryArchiveInput.parse(rawInput);
  const nativeManifest = await validateNativeManifest(request.archive, request);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<NativeActorSnapshot, { readonly outcome: "prepared" | "replayed" }> = {
    name: "recovery.prepareRecoveryArchive",
    input: request,
    retryOn: STALE,
    read: (reader) => readNativeActorSnapshot(reader, request),
    decide: ({ job, fence, project, dbNow, delegation, nativeActor }) => {
      const input = atExecution(request, "occurredAt", dbNow);
      if (
        job === null ||
        job.active_scope !== 1 ||
        job.state !== "running" ||
        job.claim_id !== input.claimId
      ) {
        return { reject: new ProjectRecoveryConflictError() };
      }
      if (job.archive_bytes !== null) {
        return sameArchive(job, input.archive)
          ? {
              statements: workflowExecutionGuards(shard.db, input, delegation),
              result: () => ({ outcome: "replayed" as const }),
            }
          : { reject: new ProjectRecoveryConflictError() };
      }
      if (
        !isCurrentHolder(
          fence,
          project,
          { ...input.fence, operationId: input.operationId },
          input.occurredAt,
        )
      ) {
        return { reject: new RecoveryFenceLostError() };
      }
      return {
        statements: [
          ...workflowExecutionGuards(shard.db, input, delegation),
          ...nativeManifestGuard(shard.db, input, nativeManifest, input.archive),
          ...(nativeManifest === null
            ? []
            : [
                nativeExportBillingGuard(shard.db, input),
                ...nativeActorGuards(shard.db, input, nativeActor),
              ]),
          fenceCurrentGuard(
            shard.db,
            input,
            input.fence,
            input.occurredAt,
            isExecutionClock(request),
          ),
          shard.db
            .prepare(
              `UPDATE project_recovery_jobs SET archive_bytes = ?5, archive_sha256 = ?6, captured_at = ?7, sql_files = ?8, archive_expires_at = ?9, native_manifest=?10, native_manifest_sha256=?11
               WHERE organization_id = ?1 AND operation_id = ?2 AND project_id = ?3 AND claim_id = ?4
                 AND archive_bytes IS NULL AND finished_at IS NULL`,
            )
            .bind(
              input.organizationId,
              input.operationId,
              input.projectId,
              input.claimId,
              input.archive.bytes,
              input.archive.sha256,
              input.archive.capturedAt,
              JSON.stringify(input.archive.sqlFiles),
              addMilliseconds(input.archive.capturedAt, ARCHIVE_RETENTION_MILLISECONDS),
              input.archive.nativeManifest ?? null,
              input.archive.nativeManifestSha256 ?? null,
            ),
          guard(shard.db, "claim_lost", "changes() = 0"),
          ...(nativeManifest === null
            ? []
            : [
                shard.db
                  .prepare(
                    `INSERT INTO native_export_effects(organization_id,project_id,operation_id,bucket,object_key,archive_bytes,archive_sha256,native_manifest,native_manifest_sha256,expires_at,state)
            SELECT organization_id,project_id,operation_id,archive_bucket,'native-exports/'||organization_id||'/'||project_id||'/'||operation_id||'.zip',archive_bytes,archive_sha256,native_manifest,native_manifest_sha256,archive_expires_at,'reserved'
            FROM project_recovery_jobs WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`,
                  )
                  .bind(input.organizationId, input.projectId, input.operationId),
              ]),
        ],
        result: () => ({ outcome: "prepared" }),
      };
    },
  };
  return runCommand(shard.db, command);
}

/** Grant exactly one high-level Native upload. A replay never grants a second PUT. */
export async function dispatchRecoveryArchive(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly granted: boolean }> {
  const request = prepareRecoveryArchiveInput.parse(rawInput);
  if (request.archive.nativeManifest === undefined) throw new ProjectRecoveryConflictError();
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<
    NativeActorSnapshot & { effectState: string | null },
    { readonly granted: boolean }
  > = {
    name: "recovery.dispatchRecoveryArchive",
    input: request,
    retryOn: STALE,
    read: async (reader) => {
      const snapshot = await readNativeActorSnapshot(reader, request);
      const effect = await reader
        .prepare(
          "SELECT state FROM native_export_effects WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
        )
        .bind(request.organizationId, request.projectId, request.operationId)
        .first<{ state: string }>();
      return { ...snapshot, effectState: effect?.state ?? null };
    },
    decide: ({ job, fence, project, dbNow, delegation, effectState, nativeActor }) => {
      const input = atExecution(request, "occurredAt", dbNow);
      if (
        job === null ||
        job.active_scope !== 1 ||
        job.state !== "running" ||
        job.claim_id !== input.claimId ||
        !sameArchive(job, input.archive)
      )
        return { reject: new ProjectRecoveryConflictError() };
      if (
        !isCurrentHolder(
          fence,
          project,
          { ...input.fence, operationId: input.operationId },
          input.occurredAt,
        )
      )
        return { reject: new RecoveryFenceLostError() };
      if (effectState === null) return { reject: new ProjectRecoveryConflictError() };
      const guards = [
        ...workflowExecutionGuards(shard.db, input, delegation),
        nativeExportBillingGuard(shard.db, input),
        ...nativeActorGuards(shard.db, input, nativeActor),
        fenceCurrentGuard(
          shard.db,
          input,
          input.fence,
          input.occurredAt,
          isExecutionClock(request),
        ),
      ];
      if (effectState !== "reserved")
        return { statements: guards, result: () => ({ granted: false }) };
      return {
        statements: [
          ...guards,
          shard.db
            .prepare(
              "UPDATE native_export_effects SET state='dispatched' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='reserved'",
            )
            .bind(input.organizationId, input.projectId, input.operationId),
          guard(shard.db, "precondition_changed", "changes() = 0"),
        ],
        result: () => ({ granted: true }),
      };
    },
  };
  return runCommand(shard.db, command);
}

export const discardRecoveryArchiveInput = prepareRecoveryArchiveInput;

/**
 * `discardProjectRecoveryArchive`: clears the recorded archive of a running job whose upload never landed, so the job
 * can capture and prepare a fresh one. Only the exact receipt the worker verified absent is cleared, only for the
 * current claim and the current fence holder, and only while the sealed input is still held to capture it again. A
 * job with no recorded archive answers `replayed` (the lost-response retry of the same holder). Finished jobs and every
 * other archive stay untouched.
 */
export async function discardRecoveryArchive(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly outcome: "discarded" | "replayed" }> {
  const request = discardRecoveryArchiveInput.parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<RecoverySnapshot, { readonly outcome: "discarded" | "replayed" }> = {
    name: "recovery.discardRecoveryArchive",
    input: request,
    retryOn: STALE,
    read: (reader) => readRecoverySnapshot(reader, request),
    decide: ({ job, fence, project, dbNow }) => {
      const input = atExecution(request, "occurredAt", dbNow);
      if (
        job === null ||
        job.active_scope !== 1 ||
        job.state !== "running" ||
        job.claim_id !== input.claimId
      ) {
        return { reject: new ProjectRecoveryConflictError() };
      }
      if (
        !isCurrentHolder(
          fence,
          project,
          { ...input.fence, operationId: input.operationId },
          input.occurredAt,
        )
      ) {
        return { reject: new RecoveryFenceLostError() };
      }
      if (job.archive_bytes === null) return { replay: { outcome: "replayed" } };
      if (!sameArchive(job, input.archive)) return { reject: new ProjectRecoveryConflictError() };
      // Native archive identity is retained even when the provider outcome is unknown.
      if (job.native_manifest !== null) return { reject: new ProjectRecoveryConflictError() };
      // Never clear the last recorded archive when no fresh capture can follow it.
      if (job.input_ciphertext === null || job.input_expires_at <= input.occurredAt) {
        return { reject: new ProjectRecoveryConflictError() };
      }
      return {
        statements: [
          fenceCurrentGuard(
            shard.db,
            input,
            input.fence,
            input.occurredAt,
            isExecutionClock(request),
          ),
          shard.db
            .prepare(
              `UPDATE project_recovery_jobs SET archive_bytes = NULL, archive_sha256 = NULL, sql_files = NULL, captured_at = NULL, archive_expires_at = NULL, native_manifest=NULL, native_manifest_sha256=NULL
               WHERE organization_id = ?1 AND operation_id = ?2 AND project_id = ?3 AND claim_id = ?4 AND finished_at IS NULL
                 AND archive_sha256 = ?5 AND archive_bytes = ?6 AND sql_files = ?7 AND captured_at = ?8
                 AND native_manifest IS ?10 AND native_manifest_sha256 IS ?11
                 AND input_ciphertext IS NOT NULL AND input_expires_at > ${effectiveNowSql("?9", isExecutionClock(request))}
                 AND EXISTS (SELECT 1 FROM operations o WHERE o.organization_id = ?1 AND o.operation_id = ?2 AND o.state = 'running')`,
            )
            .bind(
              input.organizationId,
              input.operationId,
              input.projectId,
              input.claimId,
              input.archive.sha256,
              input.archive.bytes,
              JSON.stringify(input.archive.sqlFiles),
              input.archive.capturedAt,
              input.occurredAt,
              input.archive.nativeManifest ?? null,
              input.archive.nativeManifestSha256 ?? null,
            ),
          guard(shard.db, "claim_lost", "changes() = 0"),
        ],
        result: () => ({ outcome: "discarded" }),
      };
    },
  };
  return runCommand(shard.db, command);
}

// ---------------------------------------------------------------------------------------------------------------
// finish (success or failure)
// ---------------------------------------------------------------------------------------------------------------

export const finishRecoveryJobInput = z.union([
  z.strictObject({
    ...mutationFields,
    archive: archiveInput,
    /** Success is recorded only by the current fence holder; the fence is released in the same batch. */
    fence: z.strictObject(holderFields),
  }),
  z.strictObject({
    ...mutationFields,
    failureCode: failureCodeSchema,
    /** A holder that fails its own capture releases its fence in the same batch. */
    fence: z.strictObject(holderFields).optional(),
  }),
]);

export interface FinishRecoveryJobResult {
  /** `waiting`: another capture holds the fence; nothing changed and the caller retries later. */
  readonly outcome: "finished" | "replayed" | "waiting";
  readonly status: RecoveryJobStatus;
}

interface FailureBase {
  readonly billingEpochId: string;
  readonly eventCount: number;
}

/** The terminal failure step: operation transition, job update and, for a holder, the fence release. */
function failureStatements(
  db: D1Database,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
  base: FailureBase,
  step: {
    readonly claimId: string;
    readonly occurredAt: string;
    readonly operationEventId: string;
    readonly auditEventId: string;
    readonly failureCode: string;
    readonly fence?: { readonly epoch: number; readonly holderId: string } | undefined;
  },
): D1PreparedStatement[] {
  return [
    ...transitionStatements(db, scope, base, {
      action: "fail",
      operationEventId: step.operationEventId,
      auditEventId: step.auditEventId,
      occurredAt: step.occurredAt,
      failureCode: step.failureCode,
    }),
    db
      .prepare(
        `UPDATE project_recovery_jobs SET finished_at = ?4, verified_at = NULL, failure_code = ?5,
           input_ciphertext = NULL, input_nonce = NULL, input_key_version = NULL
         WHERE organization_id = ?1 AND operation_id = ?2 AND project_id = ?3 AND claim_id = ?6 AND finished_at IS NULL`,
      )
      .bind(
        scope.organizationId,
        scope.operationId,
        scope.projectId,
        step.occurredAt,
        step.failureCode,
        step.claimId,
      ),
    guard(db, "claim_lost", "changes() = 0"),
    ...(step.fence === undefined ? [] : [releaseStatement(db, scope, step.fence, step.occurredAt)]),
  ];
}

function releaseStatement(
  db: D1Database,
  scope: { readonly organizationId: string; readonly projectId: string },
  holder: { readonly epoch: number; readonly holderId: string },
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE project_recovery_fences SET released_at = ?5 WHERE organization_id = ?1 AND project_id = ?2 AND epoch = ?3 AND holder_id = ?4 AND released_at IS NULL",
    )
    .bind(scope.organizationId, scope.projectId, holder.epoch, holder.holderId, now);
}

/**
 * `finishProjectRecoveryJob`: success requires the independently verified archive of the prepared metadata AND the
 * current fence; failure carries a closed uppercase code. Both end the operation, finalize the job and drop the
 * sealed input in one batch. A repeat of the recorded outcome is a replay; a different outcome is a conflict.
 */
export async function finishRecoveryJob(
  context: CatalogContext,
  rawInput: unknown,
): Promise<FinishRecoveryJobResult> {
  const request = finishRecoveryJobInput.parse(rawInput);
  const nativeManifest =
    "archive" in request ? await validateNativeManifest(request.archive, request) : null;
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<NativeActorSnapshot, FinishRecoveryJobResult> = {
    name: "recovery.finishRecoveryJob",
    input: request,
    retryOn: STALE,
    read: (reader) => readNativeActorSnapshot(reader, request),
    decide: ({ job, fence, project, dbNow, delegation, nativeActor }) => {
      // The final fence guard, the terminal events and the release all use this attempt's SQL clock instant, and
      // the guards of the batch compare with the SQL clock again when it executes.
      const input = atExecution(request, "occurredAt", dbNow);
      const execution = isExecutionClock(request);
      if (job === null || job.claim_id !== input.claimId) {
        return { reject: new ProjectRecoveryConflictError() };
      }
      const scope = input;
      const base = { billingEpochId: job.billing_epoch_id, eventCount: job.event_count };
      if ("archive" in input) {
        const archive: ArchiveInput = input.archive;
        if (job.state === "succeeded" && sameArchive(job, archive)) {
          return { replay: { outcome: "replayed", status: "succeeded" } };
        }
        if (job.active_scope !== 1 || !sameArchive(job, archive)) {
          return { reject: new ProjectRecoveryConflictError() };
        }
        if (job.state !== "running") return { reject: new ProjectRecoveryConflictError() };
        if (
          !isCurrentHolder(
            fence,
            project,
            { ...input.fence, operationId: input.operationId },
            input.occurredAt,
          )
        ) {
          return { reject: new RecoveryFenceLostError() };
        }
        return {
          statements: [
            ...workflowExecutionGuards(shard.db, scope, delegation),
            ...nativeManifestGuard(shard.db, scope, nativeManifest, archive),
            ...(nativeManifest === null
              ? []
              : [
                  nativeExportBillingGuard(shard.db, scope),
                  ...nativeActorGuards(shard.db, scope, nativeActor),
                ]),
            fenceCurrentGuard(shard.db, scope, input.fence, input.occurredAt, execution),
            ...transitionStatements(shard.db, scope, base, {
              action: "succeed",
              operationEventId: input.operationEventId,
              auditEventId: input.auditEventId,
              occurredAt: input.occurredAt,
            }),
            shard.db
              .prepare(
                `UPDATE project_recovery_jobs SET finished_at = ?4, verified_at = ?4, failure_code = NULL,
                   input_ciphertext = NULL, input_nonce = NULL, input_key_version = NULL
                 WHERE organization_id = ?1 AND operation_id = ?2 AND project_id = ?3 AND claim_id = ?5 AND finished_at IS NULL
                   AND archive_sha256 = ?6 AND archive_bytes = ?7 AND native_manifest IS ?8 AND native_manifest_sha256 IS ?9`,
              )
              .bind(
                input.organizationId,
                input.operationId,
                input.projectId,
                input.occurredAt,
                input.claimId,
                archive.sha256,
                archive.bytes,
                archive.nativeManifest ?? null,
                archive.nativeManifestSha256 ?? null,
              ),
            guard(shard.db, "claim_lost", "changes() = 0"),
            ...(nativeManifest === null
              ? []
              : [
                  shard.db
                    .prepare(
                      "UPDATE native_export_effects SET state='verified' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='dispatched'",
                    )
                    .bind(input.organizationId, input.projectId, input.operationId),
                  guard(shard.db, "precondition_changed", "changes() = 0"),
                ]),
            releaseStatement(shard.db, scope, input.fence, input.occurredAt),
          ],
          result: () => ({ outcome: "finished", status: "succeeded" }),
        };
      }
      if (job.state === "failed") {
        return job.failure_code === input.failureCode
          ? { replay: { outcome: "replayed", status: "failed" } }
          : { reject: new ProjectRecoveryConflictError() };
      }
      if (job.state !== "running") return { reject: new ProjectRecoveryConflictError() };
      const live = liveFence(fence, input.occurredAt);
      if (live !== null && live.holder_id !== input.fence?.holderId) {
        return { replay: { outcome: "waiting", status: job.state } };
      }
      return {
        statements: [
          guard(shard.db, "precondition_changed", fenceHeldByOtherSql(execution), [
            input.organizationId,
            input.projectId,
            input.occurredAt,
            input.fence?.holderId ?? "",
          ]),
          ...failureStatements(shard.db, scope, base, { ...input, failureCode: input.failureCode }),
        ],
        result: () => ({ outcome: "finished", status: "failed" }),
      };
    },
  };
  return runCommand(shard.db, command);
}

// ---------------------------------------------------------------------------------------------------------------
// dispatch: claim and, when the input is denied or the dispatch is exhausted, the terminal failure, in ONE batch
// ---------------------------------------------------------------------------------------------------------------

export const prepareRecoveryDispatchInput = z.strictObject({
  ...mutationFields,
  terminalOperationEventId: ulid,
  terminalAuditEventId: ulid,
  failureCode: failureCodeSchema.optional(),
});

export interface RecoveryRunCommand {
  readonly action: "run";
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly claimId: string;
}

export interface RecoveryDispatchResult {
  readonly status: RecoveryJobStatus | "absent";
  readonly command: RecoveryRunCommand | null;
}

/**
 * `prepareProjectRecoveryDispatch`: a scope-only dispatch under the fence. A held fence, an absent or terminal job
 * only report their status. Otherwise the job is claimed (keeping an earlier claim id) and, when the claim denies the
 * work or the caller names a failure, the terminal failure follows in the same batch.
 */
/** Pure planner for composition with an exhausted outbox failure in ONE authoritative batch. */
export function prepareRecoveryDispatchCommand(
  db: D1Database,
  request: z.output<typeof prepareRecoveryDispatchInput>,
): Command<RecoverySnapshot, RecoveryDispatchResult> {
  return {
    name: "recovery.prepareRecoveryDispatch",
    input: request,
    retryOn: STALE,
    read: (reader) => readRecoverySnapshot(reader, request),
    decide: (snapshot) => {
      // The dispatch decides and guards at the SQL clock exactly like the claim (`clock: "execution"`).
      const input = atExecution(request, "occurredAt", snapshot.dbNow);
      const claimInput = {
        ...input,
        claimId: snapshot.job?.claim_id ?? input.claimId,
      };
      const plan = planClaim(db, snapshot, claimInput, undefined);
      if (plan.kind === "reject") return { reject: plan.error };
      if (plan.kind === "done") {
        return {
          replay: { status: plan.result.status as RecoveryJobStatus | "absent", command: null },
        };
      }
      const failure = plan.result.denialCode ?? input.failureCode;
      if (failure !== undefined) {
        return {
          statements: [
            ...plan.statements,
            ...failureStatements(
              db,
              input,
              { billingEpochId: plan.job.billing_epoch_id, eventCount: plan.eventCount },
              {
                claimId: claimInput.claimId,
                occurredAt: input.occurredAt,
                operationEventId: input.terminalOperationEventId,
                auditEventId: input.terminalAuditEventId,
                failureCode: failure,
              },
            ),
          ],
          result: () => ({ status: "failed", command: null }),
        };
      }
      return {
        statements: plan.statements,
        result: () => ({
          status: "running",
          command: {
            action: "run",
            organizationId: input.organizationId,
            projectId: input.projectId,
            operationId: input.operationId,
            claimId: claimInput.claimId,
          },
        }),
      };
    },
  };
}

export async function prepareRecoveryDispatch(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveryDispatchResult> {
  const request = prepareRecoveryDispatchInput.parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  return runCommand(shard.db, prepareRecoveryDispatchCommand(shard.db, request));
}

// ---------------------------------------------------------------------------------------------------------------
// exact-scope reads
// ---------------------------------------------------------------------------------------------------------------

export const readRecoveryJobStateInput = z.strictObject(jobScope);

/** `readProjectRecoveryJobState`: the operation state of exactly this job, or null. */
export async function readRecoveryJobState(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly status: RecoveryJobStatus } | null> {
  const input = readRecoveryJobStateInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const row = await shard.db
    .prepare(
      `SELECT operation.state FROM project_recovery_jobs job
       JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id AND operation.project_id = job.project_id
       WHERE job.organization_id = ?1 AND job.project_id = ?2 AND job.operation_id = ?3`,
    )
    .bind(input.organizationId, input.projectId, input.operationId)
    .first<{ state: RecoveryJobStatus }>();
  return row === null ? null : { status: row.state };
}

export const readRecoveryArchiveInput = z.strictObject({
  ...jobScope,
  now: instant,
  clock: executionClock,
});

export interface RecoveryArchiveLocator extends RecoveryArchive {
  readonly operationId: string;
  readonly bucket: string;
  readonly key: string;
  readonly expiresAt: string;
}

/** `readProjectRecoveryArchive`: the private locator for an owner download; incomplete, foreign and expired archives are unavailable. */
export async function readRecoveryArchive(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveryArchiveLocator | null> {
  const input = readRecoveryArchiveInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  // One statement: under `clock: "execution"` the expiry is judged at the SQL clock of this very read.
  const row = await shard.db
    .prepare(
      `SELECT job.archive_bucket, CASE WHEN job.native_manifest IS NULL THEN job.archive_key ELSE 'native-exports/'||job.organization_id||'/'||job.project_id||'/'||job.operation_id||'.zip' END AS archive_key, job.archive_bytes, job.archive_sha256, job.sql_files, job.native_manifest, job.native_manifest_sha256, job.captured_at, job.archive_expires_at
       FROM project_recovery_jobs job
       JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id AND operation.project_id = job.project_id
       JOIN projects project ON project.organization_id = job.organization_id AND project.project_id = job.project_id
       WHERE job.organization_id = ?1 AND job.project_id = ?2 AND job.operation_id = ?3
         AND project.owner_state = 'active' AND project.lifecycle_state = 'active'
         AND operation.state = 'succeeded' AND job.verified_at IS NOT NULL AND job.archive_expires_at > ${isExecutionClock(input) ? DB_NOW : "?4"}`,
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.operationId,
      ...(isExecutionClock(input) ? [] : [input.now]),
    )
    .first<
      Pick<
        JobRow,
        | "archive_bucket"
        | "archive_key"
        | "archive_bytes"
        | "archive_sha256"
        | "sql_files"
        | "native_manifest"
        | "native_manifest_sha256"
        | "captured_at"
        | "archive_expires_at"
      >
    >();
  if (row === null) return null;
  if (
    row.archive_bytes === null ||
    row.archive_sha256 === null ||
    row.sql_files === null ||
    row.captured_at === null ||
    row.archive_expires_at === null
  ) {
    throw new ProjectRecoveryConflictError();
  }
  return {
    operationId: input.operationId,
    bucket: row.archive_bucket,
    key: row.archive_key,
    sqlFiles: JSON.parse(row.sql_files) as string[],
    bytes: row.archive_bytes,
    sha256: blobOf(row.archive_sha256),
    ...(row.native_manifest === null || row.native_manifest_sha256 === null
      ? {}
      : {
          nativeManifest: row.native_manifest,
          nativeManifestSha256: blobOf(row.native_manifest_sha256),
        }),
    capturedAt: isoOf(row.captured_at),
    expiresAt: isoOf(row.archive_expires_at),
  };
}

export const readProjectExportStatusInput = z.strictObject(jobScope);

export interface ProjectExportStatus {
  readonly state: RecoveryJobStatus;
  readonly requestedAt: string;
  readonly nextRequestAt: string;
  readonly failureCode: string | null;
  readonly archive: {
    readonly bytes: number;
    readonly sha256: string;
    readonly sqlFiles: readonly string[];
    readonly capturedAt: string;
    readonly expiresAt: string;
  } | null;
}

/** `readProjectExportStatus`: the owner projection without queued ciphertext, provider credentials or storage locators. */
export async function readProjectExportStatus(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ProjectExportStatus | null> {
  const input = readProjectExportStatusInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const row = await shard.db
    .prepare(
      `SELECT operation.state, job.requested_at, job.failure_code, job.archive_bytes, lower(hex(job.archive_sha256)) AS sha256, job.sql_files,
              job.captured_at, job.archive_expires_at, job.verified_at,
              (SELECT max(latest.requested_at) FROM project_recovery_jobs latest WHERE latest.project_id = job.project_id AND ${countedInWindow("latest")}) AS latest_requested_at
       FROM project_recovery_jobs job
       JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id AND operation.project_id = job.project_id
       JOIN projects project ON project.organization_id = job.organization_id AND project.project_id = job.project_id
       WHERE job.organization_id = ?1 AND job.project_id = ?2 AND job.operation_id = ?3
         AND project.owner_state = 'active' AND project.lifecycle_state = 'active'`,
    )
    .bind(input.organizationId, input.projectId, input.operationId)
    .first<{
      state: RecoveryJobStatus;
      requested_at: string;
      failure_code: string | null;
      archive_bytes: number | null;
      sha256: string | null;
      sql_files: string | null;
      captured_at: string | null;
      archive_expires_at: string | null;
      verified_at: string | null;
      latest_requested_at: string | null;
    }>();
  if (row === null) return null;
  const complete =
    row.state === "succeeded" &&
    row.verified_at !== null &&
    row.archive_bytes !== null &&
    row.sha256 !== null &&
    row.sql_files !== null &&
    row.captured_at !== null &&
    row.archive_expires_at !== null;
  return {
    state: row.state,
    requestedAt: isoOf(row.requested_at),
    // With no counted export in the window, a new export is allowed at once: the job's own request instant has passed.
    nextRequestAt: isoOf(
      row.latest_requested_at === null
        ? row.requested_at
        : addMilliseconds(row.latest_requested_at, EXPORT_WINDOW_MILLISECONDS),
    ),
    failureCode: row.failure_code,
    archive: complete
      ? {
          bytes: row.archive_bytes as number,
          sha256: `sha256:${row.sha256 as string}`,
          sqlFiles: JSON.parse(row.sql_files as string) as string[],
          capturedAt: isoOf(row.captured_at as string),
          expiresAt: isoOf(row.archive_expires_at as string),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// shard sweeps (maintenance authority only)
// ---------------------------------------------------------------------------------------------------------------

export const discardRecoveryInputsInput = z.strictObject({
  shardId: z.number().int().min(0).max(1023),
  now: instant,
  clock: executionClock,
  limit: z.number().int().min(1).max(1000).optional(),
});

/**
 * `discardProjectRecoveryInputs`: expired or terminal password envelopes are dropped without any executor. A shard
 * drain, so it skips every organization whose bucket is being moved. Returns the number of envelopes cleared.
 */
export async function discardRecoveryInputs(
  context: CatalogContext,
  rawInput: unknown,
): Promise<number> {
  const input = discardRecoveryInputsInput.parse(rawInput);
  const shard = await context.router.routeShard(input.shardId);
  const params: unknown[] = input.clock === "execution" ? [] : [input.now];
  const nowSql = input.clock === "execution" ? DB_NOW : "?1";
  const limitSql = input.limit === undefined ? "" : `LIMIT ?${params.length + 1}`;
  if (input.limit !== undefined) params.push(input.limit);
  const cleared = await shard.db
    .prepare(
      `UPDATE project_recovery_jobs SET input_ciphertext = NULL, input_nonce = NULL, input_key_version = NULL
       WHERE (organization_id, operation_id) IN (
         SELECT job.organization_id, job.operation_id FROM project_recovery_jobs job
         JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id
         WHERE job.input_ciphertext IS NOT NULL
           AND (job.input_expires_at <= ${nowSql} OR operation.state IN ('succeeded','failed','cancelled'))
           AND ${notFencedOrganization("job.organization_id")}
         ORDER BY job.requested_at, job.operation_id ${limitSql})`,
    )
    .bind(...params)
    .run();
  return cleared.meta.changes;
}

export const readUnfinishedExpiredRecoveriesInput = z.strictObject({
  shardId: z.number().int().min(0).max(1023),
  now: instant,
  clock: executionClock,
});

export interface UnfinishedRecovery {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly dispatchFailed: boolean;
}

/** `readUnfinishedExpiredRecoveries`: up to ten jobs of a shard whose input expired, whose dispatch failed or whose project left the active scope. */
export async function readUnfinishedExpiredRecoveries(
  context: CatalogContext,
  rawInput: unknown,
): Promise<UnfinishedRecovery[]> {
  const input = readUnfinishedExpiredRecoveriesInput.parse(rawInput);
  const shard = await context.router.routeShard(input.shardId);
  const nowSql = input.clock === "execution" ? DB_NOW : "?1";
  const rows = await shard.db
    .prepare(
      `SELECT job.organization_id, job.project_id, job.operation_id, (outbox.reconciliation_required_at IS NOT NULL) AS dispatch_failed
       FROM project_recovery_jobs job
       JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id
       JOIN outbox_events outbox ON outbox.organization_id = job.organization_id AND outbox.project_id = job.project_id
         AND outbox.operation_id = job.operation_id AND outbox.event_type = 'ProjectRecoveryRequestedV1'
       WHERE operation.state IN ('queued','running')
         AND ((job.input_expires_at <= ${nowSql} AND job.archive_bytes IS NULL) OR outbox.reconciliation_required_at IS NOT NULL
              OR NOT EXISTS (SELECT 1 FROM projects project WHERE project.organization_id = job.organization_id AND project.project_id = job.project_id
                               AND project.owner_state = 'active' AND project.lifecycle_state = 'active'))
         AND ${notFencedOrganization("job.organization_id")}
       ORDER BY job.requested_at, job.operation_id LIMIT 10`,
    )
    .bind(...(input.clock === "execution" ? [] : [input.now]))
    .all<{
      organization_id: string;
      project_id: string;
      operation_id: string;
      dispatch_failed: number;
    }>();
  return rows.results.map((row) => ({
    organizationId: row.organization_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    dispatchFailed: row.dispatch_failed === 1,
  }));
}
