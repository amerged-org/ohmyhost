import { z } from "zod";
import {
  assertDatabaseSizeChange,
  databaseSizeForClass,
  databaseSizeForMemory,
} from "@ohmyhost/contracts/database-sizes";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import type { Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import {
  addMilliseconds,
  instant,
  publicTimestamp,
  ringDoorbell,
  ulid,
  type CatalogContext,
} from "../common.js";
import { paidDenial, readAccount, type AccountView } from "../credit/index.js";
import { acceptApiOperationInput, acceptStatements } from "../operations/accept-api-operation.js";
import {
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import { currentDataEnvironment } from "./authority.js";
import { DATA_CHANGE_PENDING, ProductDatabaseError, productTransition } from "./product-common.js";
import { runOnOrganization } from "./run.js";
import { claimOutboxEvent, acknowledgeOutboxEvent } from "../operations/outbox.js";
import { recordOperationInput } from "./provider-contracts.js";
import { authorizeOrganizationAction } from "../projects/customer-projects-access.js";
import { isUserRevoked } from "../identity/mcp-sql.js";
import {
  assertOperationDelegationCurrent,
  operationAction,
  restrictionAllows,
} from "../identity/operation-delegations.js";
import { conflict } from "../common.js";
import { planRecordDatabaseProviderOperation } from "./provider-targets.js";

const scope = { organizationId: ulid, projectId: ulid };
const identity = z.strictObject({
  ...scope,
  principalId: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).max(255),
  canonicalRequestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
const jobInput = z.strictObject({ ...scope, operationId: ulid });
const mutation = {
  ...scope,
  operationId: ulid,
  claimId: ulid,
  occurredAt: instant,
  operationEventId: ulid,
  auditEventId: ulid,
};
const claimInput = z.strictObject(mutation);
const completeInput = z.strictObject({
  ...mutation,
  physicalEnvironmentId: ulid,
  success: z.boolean(),
  failureCode: z.enum(["DATABASE_COMPUTE_FAILED", "DATABASE_COMPUTE_PLAN_CHANGED"]).optional(),
});
const acceptInput = acceptApiOperationInput.safeExtend({
  eventType: z.literal("ProjectDatabaseComputeChangeRequestedV1"),
  actorType: z.literal("principal").default("principal"),
  httpMethod: z.literal("POST"),
  routeTemplate: z.literal("/v1/projects/{project_id}/database/compute"),
  confirmation: z.never().optional(),
  memoryMiB: z.number().int(),
  currentStorageMiB: z.number().int().min(0),
  expectedDatabaseId: z.string().regex(/^[a-z][a-z0-9]{19}$/u),
  expectedTargetVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const COMPUTE_SCOPE_SQL = `SELECT e.environment_id,e.name environment,p.active_billing_epoch_id,p.lifecycle_version,p.ownership_version,p.data_mode,p.lifecycle_state,
 ${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")} physical_environment_id,
 CAST(h.target_version AS TEXT) target_version,t.provider,t.provider_project_id,t.database_id,t.branch_id,t.region_id,t.size_class_id,t.runtime_role,t.credential_reference,h.activated_at
 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
 LEFT JOIN database_provider_target_heads h ON h.organization_id=e.organization_id AND h.project_id=e.project_id AND h.physical_environment_id=${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")} AND h.state='active'
 LEFT JOIN database_provider_target_revisions t ON t.organization_id=h.organization_id AND t.project_id=h.project_id AND t.physical_environment_id=h.physical_environment_id AND t.target_version=h.target_version
 WHERE e.organization_id=?1 AND e.project_id=?2 AND e.name=?3 AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')`;
interface ComputeScope {
  environment_id: string;
  environment: "dev" | "prod";
  active_billing_epoch_id: string;
  lifecycle_version: number;
  ownership_version: number;
  data_mode: "shared" | "isolated";
  lifecycle_state: string;
  physical_environment_id: string | null;
  target_version: string | null;
  provider: "neon" | "pgcf" | null;
  provider_project_id: string;
  database_id: string;
  region_id: string;
  size_class_id: string;
  runtime_role: string;
  credential_reference: string;
  activated_at: string | null;
}
const JOB = `SELECT j.*,op.state,(SELECT count(*) FROM operation_events ev WHERE ev.organization_id=j.organization_id AND ev.operation_id=j.operation_id) event_count FROM pgcf_database_compute_changes j JOIN operations op ON op.organization_id=j.organization_id AND op.project_id=j.project_id AND op.operation_id=j.operation_id JOIN projects p ON p.organization_id=j.organization_id AND p.project_id=j.project_id WHERE j.organization_id=?1 AND j.project_id=?2 AND j.operation_id=?3 AND p.owner_state='active' AND p.active_billing_epoch_id=j.billing_epoch_id AND p.lifecycle_state='active' AND p.lifecycle_version=j.accepted_lifecycle_version`;
interface JobRow {
  operation_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  data_environment_id: string;
  billing_epoch_id: string;
  provider_project_id: string;
  database_id: string;
  target_version: number;
  memory_mib: number;
  size_class_id: string;
  accepted_lifecycle_version: number;
  requested_at: string;
  claim_id: string | null;
  claim_expires_at: string | null;
  last_attempted_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  event_count: number;
}
function job(row: JobRow) {
  if (!Number.isSafeInteger(row.target_version))
    throw new ProductDatabaseError("compute_change_scope_unavailable");
  return {
    operationId: row.operation_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    physicalEnvironmentId: row.data_environment_id,
    billingEpochId: row.billing_epoch_id,
    providerProjectId: row.provider_project_id,
    databaseId: row.database_id,
    targetVersion: row.target_version,
    memoryMiB: row.memory_mib,
    sizeClassId: row.size_class_id,
    completedAt: row.completed_at === null ? null : publicTimestamp(row.completed_at),
    claimId: row.claim_id,
    claimExpiresAt: row.claim_expires_at === null ? null : publicTimestamp(row.claim_expires_at),
    state: row.state,
  };
}
const RETRY = [
  "precondition_changed",
  "operation_conflict",
  "row_version_conflict",
  "scope_inactive",
  "owner_changed",
] as const;
const scopeArgs = (input: {
  organizationId: string;
  projectId: string;
  environment: "dev" | "prod";
}) => [input.organizationId, input.projectId, input.environment];
const jobArgs = (input: z.output<typeof jobInput>) => [
  input.organizationId,
  input.projectId,
  input.operationId,
];
/**
 * A compute change or entitlement action of the project is unfinished, or a database is suspended by its entitlement. A resize
 * of a suspended database moves PGCF's generation past the one its automatic resume matches, so it is refused until the resume.
 */
const pending = `EXISTS(SELECT 1 FROM project_database_compute_changes WHERE project_id=?1 AND completed_at IS NULL) OR EXISTS(SELECT 1 FROM pgcf_database_compute_changes WHERE project_id=?1 AND completed_at IS NULL) OR EXISTS(SELECT 1 FROM pgcf_database_entitlement_actions WHERE project_id=?1 AND state IN('reserved','dispatched','pending')) OR EXISTS(SELECT 1 FROM pgcf_database_entitlement_policies WHERE project_id=?1 AND suspended_by_entitlement=1)`;
/** The account the command decided over, with the rows of the reads it was read with. */
interface ComputeFacts {
  readonly account: AccountView;
  readonly extra: readonly (readonly Record<string, unknown>[])[];
}
/** One snapshot batch of the command's own reads plus the credit account of the organization. */
async function readFacts(
  reader: D1Database,
  organizationId: string,
  now: string,
  reads: readonly D1PreparedStatement[],
): Promise<ComputeFacts> {
  const results = await reader.batch([...reads]);
  return {
    account: await readAccount(reader, organizationId, now),
    extra: results.map((result) => result.results),
  };
}
function target(scope: ComputeScope, input: { organizationId: string; projectId: string }) {
  if (
    scope.provider !== "pgcf" ||
    scope.physical_environment_id === null ||
    scope.target_version === null
  )
    return null;
  const version = Number(scope.target_version);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new ProductDatabaseError("compute_change_scope_unavailable");
  return {
    ...input,
    physicalEnvironmentId: scope.physical_environment_id,
    targetVersion: version,
    provider: "pgcf" as const,
    providerProjectId: scope.provider_project_id,
    databaseId: scope.database_id,
    regionId: scope.region_id,
    sizeClassId: scope.size_class_id,
    runtimeRole: scope.runtime_role,
    credentialReference: scope.credential_reference,
    activatedAt: scope.activated_at === null ? null : publicTimestamp(scope.activated_at),
  };
}
/** The original pre-provider transaction; historical Neon receipts can never select a provider in D1 mode. */
export async function readProductComputeScope(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ ...scope, environment: z.enum(["dev", "prod"]) }).parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const row = await db
    .prepare(COMPUTE_SCOPE_SQL)
    .bind(...scopeArgs(input))
    .first<ComputeScope>();
  if (!row || !row.physical_environment_id)
    throw new ProductDatabaseError("compute_change_scope_unavailable");
  return {
    ...input,
    environmentId: row.environment_id,
    billingEpochId: row.active_billing_epoch_id,
    physicalEnvironmentId: row.physical_environment_id,
    dataMode: row.data_mode,
    target: target(row, input),
  };
}
/** Replay remains before provider access and must still belong to the current original owner/epoch/lifecycle. */
export async function replayProductCompute(
  context: CatalogContext,
  raw: unknown,
): Promise<string | null> {
  const input = identity.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const records = await readIdempotencyRecordStatement(db, {
    ...input,
    httpMethod: "POST",
    routeTemplate: "/v1/projects/{project_id}/database/compute",
  }).all();
  const record = storedIdempotencyRecord(records.results[0]);
  if (!record) return null;
  if (!record.operationId || record.digestHex !== input.canonicalRequestDigest)
    throw new ProductDatabaseError("idempotency_key_reused");
  const row = await db
    .prepare(JOB)
    .bind(input.organizationId, input.projectId, record.operationId)
    .first<JobRow>();
  if (!row) throw new ProductDatabaseError("compute_change_scope_unavailable");
  await assertOperationDelegationCurrent(context, {
    organizationId: input.organizationId,
    operationId: row.operation_id,
  });
  return row.operation_id;
}
export async function acceptProductCompute(context: CatalogContext, raw: unknown) {
  const input = acceptInput.parse(raw);
  if (
    input.delegation !== undefined &&
    (operationAction(input.eventType) !== input.delegation.action ||
      !restrictionAllows(input.delegation.authorizationRestriction, {
        action: input.delegation.action,
        organizationId: input.organizationId,
        projectId: input.projectId,
      }) ||
      !input.principalId.startsWith("user:") ||
      (await isUserRevoked(context.directory, input.principalId.slice(5))) ||
      (await authorizeOrganizationAction(context, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        principalId: input.principalId,
        action: input.delegation.action,
      })) !== "allow")
  )
    throw conflict("operation_authorization_changed", "Queued operation authorization changed");
  const result = await runOnOrganization(
    context,
    input.organizationId,
    (db) => {
      const command: Command<
        ComputeFacts,
        { outcome: "created" | "replayed"; operationId: string }
      > = {
        name: "database.acceptProductCompute",
        input,
        retryOn: RETRY,
        naturalKeyTables: [
          "api_idempotency_records",
          "operations",
          "pgcf_database_compute_changes",
        ],
        read: (reader) =>
          readFacts(reader, input.organizationId, input.occurredAt, [
            readIdempotencyRecordStatement(reader, input),
            reader
              .prepare(
                `${COMPUTE_SCOPE_SQL.replace("e.name=?3", "e.environment_id=?3")} AND NOT ${DATA_CHANGE_PENDING}`,
              )
              .bind(input.organizationId, input.projectId, input.environmentId),
            reader.prepare(`SELECT ${pending} pending`).bind(input.projectId),
            reader
              .prepare(
                JOB.replace(
                  "j.operation_id=?3",
                  "j.operation_id=(SELECT receipt.operation_id FROM api_idempotency_records receipt WHERE receipt.organization_id=?1 AND receipt.principal_id=?3 AND receipt.http_method='POST' AND receipt.route_template='/v1/projects/{project_id}/database/compute' AND receipt.idempotency_key=?4)",
                ),
              )
              .bind(input.organizationId, input.projectId, input.principalId, input.idempotencyKey),
          ]),
        decide: (snapshot) => {
          const record = storedIdempotencyRecord(snapshot.extra[0]?.[0]),
            current = snapshot.extra[1]?.[0] as unknown as ComputeScope | undefined;
          if (record) {
            if (record.digestHex !== input.canonicalRequestDigest || !record.operationId)
              return { reject: new ProductDatabaseError("idempotency_key_reused") };
            const replay = snapshot.extra[3]?.[0];
            if (!replay || replay["operation_id"] !== record.operationId)
              return { reject: new ProductDatabaseError("compute_change_scope_unavailable") };
            return { replay: { outcome: "replayed", operationId: record.operationId } };
          }
          if (
            !current ||
            current.lifecycle_state !== "active" ||
            current.active_billing_epoch_id !== input.billingEpochId ||
            current.database_id !== input.expectedDatabaseId ||
            current.target_version !== String(input.expectedTargetVersion)
          )
            return { reject: new ProductDatabaseError("compute_change_scope_unavailable") };
          const size = databaseSizeForMemory(input.memoryMiB),
            { paid } = snapshot.account;
          if (size.paidRequired && paidDenial(snapshot.account) !== null)
            return { reject: new ProductDatabaseError("compute_paid_required") };
          try {
            assertDatabaseSizeChange({
              memoryMiB: input.memoryMiB,
              paid,
              currentStorageMiB: input.currentStorageMiB,
            });
          } catch {
            return {
              reject: new ProductDatabaseError("compute_storage_shrink_requires_migration"),
            };
          }
          if (Number(snapshot.extra[2]?.[0]?.["pending"]) === 1)
            return { reject: new ProductDatabaseError("compute_change_pending") };
          const params = [
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.expectedDatabaseId,
            String(input.expectedTargetVersion),
            current.lifecycle_version,
            input.billingEpochId,
          ];
          return {
            statements: [
              guard(
                db,
                "precondition_changed",
                `NOT EXISTS(SELECT 1 FROM(${COMPUTE_SCOPE_SQL.replace("e.name=?3", "e.environment_id=?3")} AND NOT ${DATA_CHANGE_PENDING}) current WHERE current.provider='pgcf' AND current.database_id=?4 AND current.target_version=CAST(?5 AS TEXT) AND current.lifecycle_version=?6 AND current.active_billing_epoch_id=?7)`,
                params,
              ),
              guard(db, "precondition_changed", pending, [input.projectId]),
              ...acceptStatements(db, input, false, input.delegation !== undefined),
              db
                .prepare(
                  `INSERT INTO pgcf_database_compute_changes(operation_id,organization_id,project_id,environment_id,data_environment_id,billing_epoch_id,provider_project_id,database_id,target_version,memory_mib,size_class_id,accepted_lifecycle_version,requested_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
                )
                .bind(
                  input.operationId,
                  input.organizationId,
                  input.projectId,
                  input.environmentId,
                  current.physical_environment_id,
                  input.billingEpochId,
                  current.provider_project_id,
                  current.database_id,
                  input.expectedTargetVersion,
                  size.memoryMiB,
                  size.sizeClassId,
                  current.lifecycle_version,
                  input.occurredAt,
                ),
            ],
            result: () => ({ outcome: "created", operationId: input.operationId }),
          };
        },
      };
      return command;
    },
    {},
  );
  if (result.outcome === "replayed")
    await assertOperationDelegationCurrent(context, {
      organizationId: input.organizationId,
      operationId: result.operationId,
    });
  const routed = await context.router.routeOrganization(input.organizationId);
  await ringDoorbell(context.directory, "outbox", routed.shardId, input.occurredAt);
  return result;
}
export async function readProductComputeJob(context: CatalogContext, raw: unknown) {
  const input = jobInput.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db,
    row = await db
      .prepare(JOB)
      .bind(...jobArgs(input))
      .first<JobRow>();
  return row ? job(row) : null;
}
export async function claimProductCompute(context: CatalogContext, raw: unknown) {
  const input = claimInput.parse(raw);
  return runOnOrganization(
    context,
    input.organizationId,
    (db) => ({
      name: "database.claimProductCompute",
      input,
      retryOn: RETRY,
      naturalKeyTables: ["operation_events", "audit_events"],
      read: (reader) =>
        readFacts(reader, input.organizationId, input.occurredAt, [
          reader.prepare(JOB).bind(...jobArgs(input)),
          reader
            .prepare(
              `SELECT h.target_version,t.database_id FROM database_provider_target_heads h JOIN database_provider_target_revisions t USING(organization_id,project_id,physical_environment_id,target_version) JOIN pgcf_database_compute_changes j ON j.organization_id=h.organization_id AND j.project_id=h.project_id AND j.data_environment_id=h.physical_environment_id WHERE j.organization_id=?1 AND j.project_id=?2 AND j.operation_id=?3 AND h.state='active' AND t.provider='pgcf'`,
            )
            .bind(...jobArgs(input)),
          reader
            .prepare(
              "SELECT 1 FROM database_provider_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND step='database.resize' AND state<>'reserved'",
            )
            .bind(...jobArgs(input)),
          // The job's own database is suspended by its entitlement: no dispatch until the automatic resume clears it.
          reader
            .prepare(
              "SELECT 1 FROM pgcf_database_compute_changes j JOIN pgcf_database_entitlement_policies policy ON policy.organization_id=j.organization_id AND policy.project_id=j.project_id AND policy.physical_environment_id=j.data_environment_id AND policy.database_id=j.database_id WHERE j.organization_id=?1 AND j.project_id=?2 AND j.operation_id=?3 AND policy.suspended_by_entitlement=1",
            )
            .bind(...jobArgs(input)),
        ]),
      decide: (snapshot) => {
        const row = snapshot.extra[0]?.[0] as unknown as JobRow | undefined,
          current = snapshot.extra[1]?.[0],
          suspended = (snapshot.extra[3]?.length ?? 0) > 0;
        if (!row) return { replay: null };
        const result = job(row);
        if (row.completed_at !== null)
          return { replay: { ...result, mutationPermitted: false, providerDispatchStarted: true } };
        if (
          row.claim_id !== null &&
          row.claim_id !== input.claimId &&
          row.claim_expires_at !== null &&
          row.claim_expires_at > input.occurredAt
        )
          return { replay: null };
        if (
          !current ||
          current["database_id"] !== row.database_id ||
          Number(current["target_version"]) !== row.target_version
        )
          return { reject: new ProductDatabaseError("compute_change_scope_unavailable") };
        const mutationPermitted =
          (!databaseSizeForMemory(row.memory_mib).paidRequired || snapshot.account.paid) &&
          !suspended;
        const transition =
          row.state === "queued"
            ? productTransition(
                db,
                { ...input, billingEpochId: row.billing_epoch_id },
                {
                  action: "start",
                  kind: "compute",
                  eventCount: row.event_count,
                  operationEventId: input.operationEventId,
                  auditEventId: input.auditEventId,
                  now: input.occurredAt,
                },
              )
            : [];
        const expiresAt = addMilliseconds(input.occurredAt, 60000);
        return {
          statements: [
            guard(
              db,
              "precondition_changed",
              `NOT EXISTS(${JOB} AND j.claim_id IS ?4 AND j.claim_expires_at IS ?5 AND j.completed_at IS NULL)`,
              [...jobArgs(input), row.claim_id, row.claim_expires_at],
            ),
            guard(
              db,
              "precondition_changed",
              `NOT EXISTS(SELECT 1 FROM database_provider_target_heads h JOIN database_provider_target_revisions t USING(organization_id,project_id,physical_environment_id,target_version) WHERE h.organization_id=?1 AND h.project_id=?2 AND h.physical_environment_id=?3 AND h.target_version=?4 AND h.state='active' AND t.provider='pgcf' AND t.database_id=?5)`,
              [
                input.organizationId,
                input.projectId,
                row.data_environment_id,
                row.target_version,
                row.database_id,
              ],
            ),
            ...transition,
            db
              .prepare(
                "UPDATE pgcf_database_compute_changes SET claim_id=?4,claim_expires_at=?5,last_attempted_at=?6 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
              )
              .bind(...jobArgs(input), input.claimId, expiresAt, input.occurredAt),
          ],
          result: () => ({
            ...result,
            mutationPermitted,
            providerDispatchStarted: snapshot.extra[2]?.length === 1,
            state: "running" as const,
            claimId: input.claimId,
            claimExpiresAt: publicTimestamp(expiresAt),
          }),
        };
      },
    }),
    {},
  );
}
function completeStatements(
  db: D1Database,
  input: z.output<typeof completeInput>,
  row: JobRow,
): D1PreparedStatement[] {
  if (
    row.claim_id !== input.claimId ||
    row.claim_expires_at === null ||
    row.claim_expires_at <= input.occurredAt ||
    row.completed_at !== null
  )
    throw new ProductDatabaseError("compute_change_conflict");
  const proof = [
      input.organizationId,
      input.projectId,
      row.data_environment_id,
      input.operationId,
      row.database_id,
    ],
    statements: D1PreparedStatement[] = [
      guard(
        db,
        "precondition_changed",
        `NOT EXISTS(${JOB} AND j.claim_id=?4 AND j.claim_expires_at>?5 AND j.completed_at IS NULL)`,
        [...jobArgs(input), input.claimId, input.occurredAt],
      ),
    ];
  if (input.success)
    statements.push(
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM database_provider_operations WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND operation_id=?4 AND step='database.resize' AND state='succeeded' AND database_id=?5)",
        proof,
      ),
      db
        .prepare(
          `INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) SELECT organization_id,project_id,physical_environment_id,target_version+1,provider,provider_project_id,database_id,region_id,?5,runtime_role,credential_reference,?4,?7 FROM database_provider_target_revisions WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND target_version=?6`,
        )
        .bind(
          input.organizationId,
          input.projectId,
          row.data_environment_id,
          input.operationId,
          row.size_class_id,
          row.target_version,
          input.occurredAt,
        ),
      db
        .prepare(
          "UPDATE database_provider_target_heads SET target_version=target_version+1,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND target_version=?4 AND state='active'",
        )
        .bind(
          input.organizationId,
          input.projectId,
          row.data_environment_id,
          row.target_version,
          input.occurredAt,
        ),
      guard(db, "precondition_changed", "changes()<>1"),
    );
  statements.push(
    ...productTransition(
      db,
      { ...input, billingEpochId: row.billing_epoch_id },
      {
        action: input.success ? "succeed" : "fail",
        eventCount: row.event_count,
        operationEventId: input.operationEventId,
        auditEventId: input.auditEventId,
        now: input.occurredAt,
        kind: "compute",
        failureCode: input.failureCode ?? "DATABASE_COMPUTE_FAILED",
      },
    ),
    db
      .prepare(
        "UPDATE pgcf_database_compute_changes SET completed_at=?4,failure_code=?5,claim_id=NULL,claim_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      )
      .bind(
        ...jobArgs(input),
        input.occurredAt,
        input.success ? null : (input.failureCode ?? "DATABASE_COMPUTE_FAILED"),
      ),
  );
  return statements;
}
export async function completeProductCompute(context: CatalogContext, raw: unknown) {
  const input = completeInput.parse(raw);
  return runOnOrganization(
    context,
    input.organizationId,
    (db) => ({
      name: "database.completeProductCompute",
      input,
      commandId: `compute-complete:${input.operationId}:${input.claimId}`,
      fromLog: () => undefined,
      retryOn: RETRY,
      read: (reader) =>
        reader
          .prepare(JOB)
          .bind(...jobArgs(input))
          .first<JobRow>(),
      decide: (row) => {
        if (!row) return { reject: new ProductDatabaseError("compute_change_scope_unavailable") };
        if (row.completed_at !== null)
          return { reject: new ProductDatabaseError("compute_change_conflict") };
        return {
          statements: completeStatements(db, input, row),
          result: () => undefined,
          logResult: null,
        };
      },
    }),
    {},
  );
}
/** Original provider observation AND terminal job/head transition commit atomically; no callback SQL crosses RPC. */
export async function recordProductCompute(context: CatalogContext, raw: unknown) {
  const input = z
    .strictObject({ record: recordOperationInput, completion: completeInput.optional() })
    .refine(
      (value) =>
        value.record.operation.step === "database.resize" &&
        (value.completion === undefined ||
          (value.completion.organizationId === value.record.operation.organizationId &&
            value.completion.projectId === value.record.operation.projectId &&
            value.completion.physicalEnvironmentId ===
              value.record.operation.physicalEnvironmentId &&
            value.completion.operationId === value.record.operation.operationId &&
            value.completion.claimId === value.record.operation.claimId)),
    )
    .parse(raw);
  return runOnOrganization(
    context,
    input.record.operation.organizationId,
    (db) => {
      const provider = planRecordDatabaseProviderOperation(db, input.record);
      return {
        name: "database.recordProductCompute",
        input,
        retryOn: RETRY,
        read: async (reader) => ({
          provider: await provider.read(reader),
          job: input.completion
            ? await reader
                .prepare(JOB)
                .bind(...jobArgs(input.completion))
                .first<JobRow>()
            : null,
        }),
        decide: (snapshot) => {
          const plan = provider.decide(snapshot.provider);
          if ("reject" in plan) return plan;
          const statements = "statements" in plan ? [...plan.statements] : [];
          if (input.completion) {
            if (!snapshot.job)
              return { reject: new ProductDatabaseError("compute_change_scope_unavailable") };
            if (snapshot.job.completed_at === null)
              statements.push(...completeStatements(db, input.completion, snapshot.job));
          }
          return statements.length
            ? { statements, result: () => undefined }
            : { replay: undefined };
        },
      };
    },
    {},
  );
}
/** Original selected and pending history under the current physical target and owner epoch. */
export async function readProductComputeContext(context: CatalogContext, raw: unknown) {
  const input = z
      .strictObject({ ...scope, environment: z.enum(["dev", "prod"]), now: instant })
      .parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const row = await db
    .prepare(COMPUTE_SCOPE_SQL)
    .bind(...scopeArgs(input))
    .first<ComputeScope>();
  if (!row || row.provider !== "pgcf" || !row.physical_environment_id) return null;
  const rows = await db
    .prepare(
      `WITH eligible AS(SELECT j.operation_id,j.memory_mib,j.size_class_id,op.state,j.requested_at,j.completed_at FROM pgcf_database_compute_changes j JOIN operations op ON op.organization_id=j.organization_id AND op.project_id=j.project_id AND op.operation_id=j.operation_id WHERE j.organization_id=?1 AND j.project_id=?2 AND j.data_environment_id=?3 AND j.database_id=?4 AND j.billing_epoch_id=?5 AND j.requested_at<=?6)
 SELECT * FROM(SELECT * FROM eligible WHERE state='succeeded' ORDER BY completed_at DESC,operation_id DESC LIMIT 1)
 UNION ALL SELECT * FROM(SELECT * FROM eligible WHERE completed_at IS NULL ORDER BY requested_at DESC,operation_id DESC LIMIT 1)`,
    )
    .bind(
      input.organizationId,
      input.projectId,
      row.physical_environment_id,
      row.database_id,
      row.active_billing_epoch_id,
      input.now,
    )
    .all<JobRow>();
  const selected = rows.results.find((j) => j.state === "succeeded"),
    pending = rows.results.find((j) => j.completed_at === null);
  return {
    provider: "pgcf" as const,
    dataMode: row.data_mode,
    dataEnvironmentId: row.physical_environment_id,
    effective: {
      memoryMiB: databaseSizeForClass(row.size_class_id).memoryMiB,
      sizeClassId: row.size_class_id,
    },
    selected: selected
      ? {
          memoryMiB: selected.memory_mib,
          sizeClassId: selected.size_class_id,
          operationId: selected.operation_id,
          selectedAt:
            selected.completed_at === null ? null : publicTimestamp(selected.completed_at),
        }
      : null,
    pendingChange: pending
      ? {
          operationId: pending.operation_id,
          memoryMiB: pending.memory_mib,
          state: pending.state,
          requestedAt: publicTimestamp(pending.requested_at),
        }
      : null,
  };
}
export async function readDueProductCompute(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ now: instant }).parse(raw);
  const db = (await context.router.routeShard(0)).db;
  return (
    await db
      .prepare(
        "SELECT organization_id,project_id,operation_id FROM pgcf_database_compute_changes WHERE completed_at IS NULL AND(claim_expires_at IS NULL OR claim_expires_at<=?) ORDER BY COALESCE(last_attempted_at,requested_at),operation_id LIMIT 5",
      )
      .bind(input.now)
      .all<{ organization_id: string; project_id: string; operation_id: string }>()
  ).results.map((row) => ({
    organizationId: row.organization_id,
    projectId: row.project_id,
    operationId: row.operation_id,
  }));
}

/** One fixed family is delivered into its already durable job; it never acknowledges an absent/foreign job. */
export async function acknowledgeProductComputeOutbox(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ now: instant, attemptId: ulid }).parse(raw);
  const event = await claimOutboxEvent(context, {
    ...input,
    shardId: 0,
    leaseMilliseconds: 60000,
    supportedEventTypes: ["ProjectDatabaseComputeChangeRequestedV1"],
  });
  if (!event) return false;
  const db = (await context.router.routeOrganization(event.organizationId)).db;
  const row = await db
    .prepare(
      "SELECT 1 FROM project_database_compute_changes WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 UNION ALL SELECT 1 FROM pgcf_database_compute_changes WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
    )
    .bind(event.organizationId, event.projectId, event.operationId)
    .all();
  if (row.results.length !== 1) throw new ProductDatabaseError("compute_change_scope_unavailable");
  return acknowledgeOutboxEvent(context, {
    organizationId: event.organizationId,
    eventId: event.eventId,
    attemptId: event.attemptId,
    now: input.now,
  });
}

/** Release only the exact admitted provider call after its local request has settled. */
export async function releaseProductComputeUse(context: CatalogContext, raw: unknown) {
  const input = jobInput.extend({ claimId: ulid }).parse(raw);
  const db = (await context.router.routeOrganization(input.organizationId)).db;
  const result = await db
    .prepare(
      "DELETE FROM compute_connection_provider_uses WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND claim_id=?4",
    )
    .bind(input.organizationId, input.projectId, input.operationId, input.claimId)
    .run();
  return result.meta.changes === 1;
}
