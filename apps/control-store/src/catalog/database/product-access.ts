import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import type { Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import {
  addMilliseconds,
  auditStatement,
  instant,
  newUlid,
  publicTimestamp,
  ulid,
  type CatalogContext,
} from "../common.js";
import { readSnapshot } from "../platform-support.js";
import { OrganizationCreditError } from "../billing/errors.js";
import {
  paidDenial,
  readAccount,
  readRuntimeDecision,
  type RuntimeDecision,
} from "../credit/index.js";
import {
  admissionRefusal,
  DATA_CHANGE_PENDING,
  ProductDatabaseError,
  SQL_TARGET,
  targetGuard,
  targetParams,
  type SqlTargetRow,
} from "./product-common.js";
import { readOnOrganization, runOnOrganization } from "./run.js";

const scope = { organizationId: ulid, projectId: ulid };
const reason = z.enum(["principal", "expired", "budget", "creation_failed", "data_change"]);
const readInput = z.strictObject({ ...scope, accessId: ulid, now: instant });
const revokeInput = z.strictObject({
  ...scope,
  accessId: ulid,
  revokedAt: instant,
  revokedBy: z.string().min(1).max(256),
  reason,
  roleDropped: z.boolean(),
  auditEventId: ulid,
});
const issueInput = z.strictObject({
  ...scope,
  environment: z.enum(["dev", "prod"]),
  mode: z.enum(["read", "write"]),
  ttlSeconds: z.number().int().min(300).max(86400),
  label: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => v.trim() === v && !/\p{Cc}/u.test(v))
    .nullable(),
  principalId: z.string().min(1).max(256),
  now: instant,
  roleSuffix: z.string().regex(/^[0-9a-z]{8}$/u),
  accessId: ulid,
  auditEventId: ulid,
});
interface AccessRow {
  access_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  environment: "dev" | "prod";
  data_environment_id: string;
  provider_project_id: string;
  role_name: string;
  mode: "read" | "write";
  label: string | null;
  principal_id: string;
  origin_host: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: z.output<typeof reason> | null;
  role_dropped_at: string | null;
  database_id: string;
  provider_create_operation_id: string | null;
  provider_delete_operation_id: string | null;
}
function record(row: AccessRow, now: string) {
  return {
    provider: "pgcf" as const,
    accessId: row.access_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    environment: row.environment,
    dataEnvironmentId: row.data_environment_id,
    providerProjectId: row.provider_project_id,
    databaseId: row.database_id,
    providerCreateOperationId: row.provider_create_operation_id,
    providerDeleteOperationId: row.provider_delete_operation_id,
    roleName: row.role_name,
    mode: row.mode,
    label: row.label,
    principalId: row.principal_id,
    originHost: row.origin_host,
    issuedAt: publicTimestamp(row.issued_at),
    expiresAt: publicTimestamp(row.expires_at),
    revokedAt: row.revoked_at === null ? null : publicTimestamp(row.revoked_at),
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
    roleDroppedAt: row.role_dropped_at === null ? null : publicTimestamp(row.role_dropped_at),
    state:
      row.revoked_at !== null
        ? ("revoked" as const)
        : Date.parse(row.expires_at) <= Date.parse(now)
          ? ("expired" as const)
          : ("active" as const),
  };
}
export type ProductAccessRecord = ReturnType<typeof record>;
// Stored Neon-era rows are inert history: every read path selects PGCF rows only.
const ACCESS =
  "SELECT * FROM project_database_access WHERE provider='pgcf' AND organization_id=?1 AND project_id=?2 AND access_id=?3";
const params = (i: z.output<typeof readInput>) => [i.organizationId, i.projectId, i.accessId];
const RETRY = ["precondition_changed", "owner_changed", "scope_inactive"] as const;

/**
 * The entitlement suspension of one database, as SQL over the four columns that name it: its policy says suspended, or a
 * suspend action is still reserved, dispatched or pending. The reconciler records the policy only once the suspension
 * succeeded, so the open action covers the time in which the database is being suspended.
 */
function suspendedByEntitlement(key: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly databaseId: string;
}): string {
  return `EXISTS(SELECT 1 FROM pgcf_database_entitlement_policies policy WHERE policy.organization_id=${key.organizationId} AND policy.project_id=${key.projectId} AND policy.physical_environment_id=${key.physicalEnvironmentId} AND policy.database_id=${key.databaseId} AND(policy.suspended_by_entitlement=1 OR EXISTS(SELECT 1 FROM pgcf_database_entitlement_actions suspension WHERE suspension.organization_id=policy.organization_id AND suspension.project_id=policy.project_id AND suspension.physical_environment_id=policy.physical_environment_id AND suspension.database_id=policy.database_id AND suspension.action='suspend' AND suspension.state IN('reserved','dispatched','pending'))))`;
}

/**
 * Whether the target database is suspended by the entitlement reconciler while its organization has no Paid coverage. A
 * suspension that Paid coverage is about to lift (a Paid organization) does not refuse: the access then waits for the
 * reconciler, as it did before.
 */
export async function suspendedWithoutPaid(
  db: D1Database,
  input: { readonly organizationId: string; readonly projectId: string; readonly now: string },
  target: SqlTargetRow,
): Promise<boolean> {
  const suspended = await db
    .prepare(
      `SELECT ${suspendedByEntitlement({ organizationId: "?1", projectId: "?2", physicalEnvironmentId: "?3", databaseId: "?4" })} suspended`,
    )
    .bind(input.organizationId, input.projectId, target.physical_environment_id, target.database_id)
    .first<{ suspended: number }>();
  return (
    suspended?.suspended === 1 &&
    paidDenial(await readAccount(db, input.organizationId, input.now)) === "paid_plan_required"
  );
}

/** Original122 admission with the credit decision, live-credential limit and audit in one guarded Core batch. */
export async function issueProductDatabaseAccess(context: CatalogContext, raw: unknown) {
  const input = issueInput.parse(raw);
  try {
    const accepted = await runOnOrganization(
      context,
      input.organizationId,
      (db) => {
        const command: Command<
          {
            target: SqlTargetRow | null;
            financial: RuntimeDecision | null;
            count: number;
            existing: AccessRow | null;
            suspendedWithoutPaid: boolean;
          },
          unknown
        > = {
          name: "database.issueProductAccess",
          input,
          commandId: `database-access:${input.accessId}`,
          retryOn: RETRY,
          naturalKeyTables: ["project_database_access"],
          read: async (reader) => {
            const [targets, counts, existing] = await readSnapshot(reader, [
              [SQL_TARGET, ...targetParams(input)],
              [
                `SELECT count(*) active FROM project_database_access a JOIN environments e ON e.organization_id=a.organization_id AND e.project_id=a.project_id AND e.environment_id=a.environment_id WHERE a.organization_id=?1 AND a.project_id=?2 AND e.name=?3 AND a.revoked_at IS NULL AND a.expires_at>?4`,
                ...targetParams(input),
                input.now,
              ],
              [ACCESS, input.organizationId, input.projectId, input.accessId],
            ]);
            const target = targets?.[0] as unknown as SqlTargetRow | undefined;
            return {
              target: target ?? null,
              count: Number(counts?.[0]?.["active"] ?? 0),
              existing: (existing?.[0] as unknown as AccessRow) ?? null,
              financial: target
                ? await readRuntimeDecision(reader, {
                    organizationId: input.organizationId,
                    projectId: input.projectId,
                    environmentId: target.environment_id,
                    now: input.now,
                  })
                : null,
              suspendedWithoutPaid: target
                ? await suspendedWithoutPaid(reader, input, target)
                : false,
            };
          },
          decide: ({ target, financial, count, suspendedWithoutPaid }) => {
            if (!target || !financial) return { reject: new ProductDatabaseError("scope") };
            if (count >= 3) return { reject: new ProductDatabaseError("limit") };
            const refusal = admissionRefusal(financial);
            if (refusal !== null) return { reject: refusal };
            // The reconciler suspended this database for lack of Paid coverage, so its role could not be created or
            // altered. Refused before the insert: a retry cannot succeed until Paid coverage returns.
            if (suspendedWithoutPaid)
              return { reject: new ProductDatabaseError("paid_plan_required") };
            const expiresAt = addMilliseconds(input.now, input.ttlSeconds * 1000),
              roleName = `ohmyho_da_${target.physical_environment_id.toLowerCase()}_${input.roleSuffix}`;
            const access = {
              accessId: input.accessId,
              provider: "pgcf" as const,
              databaseId: target.database_id,
              roleName,
              memberRole: `ohmyho_${input.mode === "read" ? "ro" : "rw"}_${target.physical_environment_id.toLowerCase()}`,
              mode: input.mode,
              environment: input.environment,
              environmentId: target.environment_id,
              dataEnvironmentId: target.physical_environment_id,
              providerProjectId: target.provider_project_id,
              originHost: target.origin_host,
              issuedAt: publicTimestamp(input.now),
              expiresAt: publicTimestamp(expiresAt),
              label: input.label,
            };
            return {
              statements: [
                targetGuard(db, input, target),
                guard(
                  db,
                  "precondition_changed",
                  `(SELECT count(*) FROM project_database_access WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND revoked_at IS NULL AND expires_at>?4)>=3`,
                  [input.organizationId, input.projectId, target.environment_id, input.now],
                ),
                db
                  .prepare(
                    `INSERT INTO project_database_access(access_id,organization_id,project_id,environment_id,environment,data_environment_id,provider_project_id,default_branch_id,role_name,mode,label,principal_id,origin_host,issued_at,expires_at,provider,database_id) VALUES(?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,?10,?11,?12,?13,?14,'pgcf',?15)`,
                  )
                  .bind(
                    input.accessId,
                    input.organizationId,
                    input.projectId,
                    target.environment_id,
                    input.environment,
                    target.physical_environment_id,
                    target.provider_project_id,
                    roleName,
                    input.mode,
                    input.label,
                    input.principalId,
                    target.origin_host,
                    input.now,
                    expiresAt,
                    target.database_id,
                  ),
                auditStatement(db, input.organizationId, {
                  auditEventId: input.auditEventId,
                  projectId: input.projectId,
                  operationId: null,
                  billingEpochId: target.active_billing_epoch_id,
                  eventType: "DatabaseAccessIssued",
                  actorType: "principal",
                  actorId: input.principalId,
                  payload: {
                    mode: input.mode,
                    environment: input.environment,
                    expires_at: access.expiresAt,
                  },
                  occurredAt: input.now,
                }),
              ],
              result: () => access,
              logResult: access,
            };
          },
          fromLog: (value) => value,
        };
        return command;
      },
      {},
    );
    return { status: "accepted" as const, access: accepted };
  } catch (error) {
    if (error instanceof ProductDatabaseError || error instanceof OrganizationCreditError)
      return { status: "rejected" as const, code: error.code };
    throw error;
  }
}

/** Historical exact-scope reads retain inactive/expired/revoked facts. Issuance adds a fresh current-target proof. */
export async function readProductDatabaseAccess(
  context: CatalogContext,
  raw: unknown,
  issuance = false,
): Promise<ProductAccessRecord | null> {
  const input = readInput.parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const row = await db
    .prepare(ACCESS)
    .bind(...params(input))
    .first<AccessRow>();
  if (!row) return null;
  let found = record(row, input.now);
  if (!issuance) return found;
  if (found.state !== "active") return null;
  // The role identity is immutable. Re-read its revocation state and the current target in ONE snapshot.
  const [current, targets] = await readSnapshot(db, [
    [ACCESS, ...params(input)],
    [SQL_TARGET, ...targetParams({ ...input, environment: found.environment })],
  ]);
  const currentRow = current?.[0] as unknown as AccessRow | undefined;
  const target = targets?.[0] as unknown as SqlTargetRow | undefined;
  if (!currentRow) return null;
  found = record(currentRow, input.now);
  if (found.state !== "active") return null;
  if (
    !target ||
    target.environment_id !== found.environmentId ||
    target.physical_environment_id !== found.dataEnvironmentId ||
    target.database_id !== found.databaseId ||
    target.provider_project_id !== found.providerProjectId ||
    target.origin_host !== found.originHost
  )
    return null;
  return found;
}

export function revokeStatements(
  db: D1Database,
  input: z.output<typeof revokeInput>,
  row: AccessRow,
): D1PreparedStatement[] {
  const body = [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(${ACCESS} AND revoked_at IS ?4 AND revoked_by IS ?5 AND revocation_reason IS ?6 AND role_dropped_at IS ?7)`,
      [
        input.organizationId,
        input.projectId,
        input.accessId,
        row.revoked_at,
        row.revoked_by,
        row.revocation_reason,
        row.role_dropped_at,
      ],
    ),
    db
      .prepare(
        `UPDATE project_database_access SET revoked_at=COALESCE(revoked_at,?4),revoked_by=COALESCE(revoked_by,?5),revocation_reason=COALESCE(revocation_reason,?6),role_dropped_at=CASE WHEN ?7 THEN COALESCE(role_dropped_at,?4) ELSE role_dropped_at END WHERE organization_id=?1 AND project_id=?2 AND access_id=?3`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.accessId,
        input.revokedAt,
        input.revokedBy,
        input.reason,
        input.roleDropped ? 1 : 0,
      ),
  ];
  if (row.revoked_at === null)
    body.push(
      db
        .prepare(
          `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) SELECT ?1,?2,?3,NULL,'DatabaseAccessRevoked',?4,?5,?6,?7,p.active_billing_epoch_id FROM projects p WHERE p.organization_id=?1 AND p.project_id=?3`,
        )
        .bind(
          input.organizationId,
          input.auditEventId,
          input.projectId,
          input.reason === "principal" ? "principal" : "platform",
          input.revokedBy,
          JSON.stringify({
            mode: row.mode,
            environment: row.environment,
            expires_at: publicTimestamp(row.expires_at),
            revocation_reason: input.reason,
          }),
          input.revokedAt,
        ),
    );
  return body;
}
const providerOperationId = z.string().regex(/^op_[a-z0-9]{20}$/u);

/**
 * Provider delete evidence and first revocation are one original transaction, never two RPC commits. A failed delete
 * operation id is replaced only by compare-and-set on the id the caller saw fail, while the access is revoking.
 */
export async function mutateProductDatabaseAccess(
  context: CatalogContext,
  raw: unknown,
  operation = false,
) {
  const input = operation
    ? z
        .strictObject({
          ...scope,
          accessId: ulid,
          kind: z.enum(["create", "delete"]),
          operationId: providerOperationId,
          previousOperationId: providerOperationId.optional(),
          revocation: revokeInput
            .omit({ organizationId: true, projectId: true, accessId: true })
            .optional(),
        })
        .refine((value) => value.previousOperationId === undefined || value.kind === "delete")
        .parse(raw)
    : revokeInput.parse(raw);
  await runOnOrganization(
    context,
    input.organizationId,
    (db) => {
      const command: Command<AccessRow | null, boolean> = {
        name: operation ? "database.recordAccessOperation" : "database.revokeProductAccess",
        input,
        retryOn: RETRY,
        naturalKeyTables: ["audit_events"],
        read: (reader) =>
          reader
            .prepare(ACCESS)
            .bind(input.organizationId, input.projectId, input.accessId)
            .first<AccessRow>(),
        decide: (row) => {
          if (!row) return { reject: new ProductDatabaseError("scope") };
          const statements: D1PreparedStatement[] = [];
          if ("kind" in input) {
            const column =
              input.kind === "create"
                ? "provider_create_operation_id"
                : "provider_delete_operation_id";
            const stored = row[column];
            const replaces = input.previousOperationId ?? null;
            // Set once, or replaced only by compare-and-set on the stored id the caller saw fail.
            if (stored !== input.operationId && replaces !== stored)
              return { reject: new ProductDatabaseError("scope") };
            // A replacement is possible only while the access is revoking: revoked, and its role not yet dropped.
            if (
              stored !== null &&
              stored !== input.operationId &&
              (row.revoked_at === null || row.role_dropped_at !== null)
            )
              return { reject: new ProductDatabaseError("scope") };
            if (
              stored === input.operationId &&
              (!input.revocation ||
                (row.revoked_at !== null &&
                  (!input.revocation.roleDropped || row.role_dropped_at !== null)))
            )
              return { replay: true };
            statements.push(
              guard(
                db,
                "precondition_changed",
                `NOT EXISTS(${ACCESS} AND (${column} IS NULL OR ${column}=?4 OR (${column}=?5 AND revoked_at IS NOT NULL AND role_dropped_at IS NULL)))`,
                [
                  input.organizationId,
                  input.projectId,
                  input.accessId,
                  input.operationId,
                  replaces,
                ],
              ),
              db
                .prepare(
                  `UPDATE project_database_access SET ${column}=?4 WHERE organization_id=?1 AND project_id=?2 AND access_id=?3`,
                )
                .bind(input.organizationId, input.projectId, input.accessId, input.operationId),
            );
            if (input.revocation)
              statements.push(...revokeStatements(db, { ...input, ...input.revocation }, row));
          } else {
            if (row.revoked_at !== null && (!input.roleDropped || row.role_dropped_at !== null))
              return { replay: true };
            statements.push(...revokeStatements(db, input, row));
          }
          return { statements, result: () => true };
        },
      };
      return command;
    },
    {},
  );
  const now =
    "revokedAt" in input
      ? input.revokedAt
      : "revocation" in input && input.revocation
        ? input.revocation.revokedAt
        : publicTimestamp(new Date().toISOString());
  return readProductDatabaseAccess(context, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    accessId: input.accessId,
    now,
  });
}

/**
 * Each tenant's rows in one pass, so one tenant's undropped or expired roles cannot fill the whole list of every other
 * tenant. A tenant's rows rank by the same order the category uses, and the pass takes at most this many per tenant.
 */
const SWEEP_TENANT_SHARE = 5;

/**
 * Bounded original maintenance categories over PGCF accesses; stored Neon-era history is never swept. Each category
 * lists its rows never tried first, then the least recently tried, then by expiry or revocation, so a row the sweep
 * cannot finish does not hold the head of a 50-row list across all tenants. A tenant contributes at most
 * `SWEEP_TENANT_SHARE` rows to a pass, so one tenant's stuck rows cannot starve another tenant's. This is a pure read:
 * the sweep stamps the rows it tried through `markProductDatabaseAccessSweepAttempts`.
 */
export async function readProductDatabaseAccessSweep(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ now: instant, limit: z.number().int().min(1).max(50) }).parse(raw),
    db = (await context.router.routeShard(0)).db;
  // A database the entitlement reconciler suspended, or is suspending, keeps its roles: a role drop there raises the
  // database generation, which ends the automatic resume. Its roles wait for the resume, after which the sweep takes them.
  const SWEEP_SUSPENDED_DATABASE = `NOT ${suspendedByEntitlement({ organizationId: "a.organization_id", projectId: "a.project_id", physicalEnvironmentId: "a.data_environment_id", databaseId: "a.database_id" })}`;
  // A stamp counts as a try of the category only when it is later than the instant the category waits for: a credential
  // stamped while it was still active by the budget pass was not tried as an expired or undropped row.
  const list = (
    where: string,
    age: "expires_at" | "revoked_at",
    tried: string,
    bindsNow: boolean,
  ) =>
    [
      `SELECT * FROM (SELECT a.*,${tried} AS tried_at,ROW_NUMBER() OVER (PARTITION BY a.organization_id ORDER BY COALESCE(${tried},''),a.${age},a.access_id) AS tenant_rank FROM project_database_access a WHERE a.provider='pgcf' AND ${where} AND ${SWEEP_SUSPENDED_DATABASE}) WHERE tenant_rank<=${SWEEP_TENANT_SHARE} ORDER BY tenant_rank,COALESCE(tried_at,''),${age},access_id LIMIT ?${bindsNow ? 2 : 1}`,
      ...(bindsNow ? [input.now] : []),
      input.limit,
    ] as const;
  const [expired, undropped, active] = await readSnapshot(db, [
    list(
      "revoked_at IS NULL AND expires_at<=?1",
      "expires_at",
      "CASE WHEN a.sweep_attempted_at>a.expires_at THEN a.sweep_attempted_at END",
      true,
    ),
    list(
      "revoked_at IS NOT NULL AND role_dropped_at IS NULL",
      "revoked_at",
      "CASE WHEN a.sweep_attempted_at>a.revoked_at THEN a.sweep_attempted_at END",
      false,
    ),
    list("revoked_at IS NULL AND expires_at>?1", "expires_at", "a.sweep_attempted_at", true),
  ]);
  return {
    expired: (expired ?? []).map((row) => record(row as unknown as AccessRow, input.now)),
    undropped: (undropped ?? []).map((row) => record(row as unknown as AccessRow, input.now)),
    active: (active ?? []).map((row) => record(row as unknown as AccessRow, input.now)),
  };
}

/**
 * Stamps the accesses the sweep tried: a failed revocation, or a credential the budget check kept. The caller supplies
 * the pass time. A row the pass never reached is not stamped. The stamp is not part of the access identity and never
 * decides revocation.
 */
export async function markProductDatabaseAccessSweepAttempts(
  context: CatalogContext,
  raw: unknown,
): Promise<number> {
  const input = z
      .strictObject({ now: instant, accessIds: z.array(ulid).min(1).max(150) })
      .parse(raw),
    db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(
      "UPDATE project_database_access SET sweep_attempted_at=?1 WHERE provider='pgcf' AND access_id IN(SELECT value FROM json_each(?2))",
    )
    .bind(input.now, JSON.stringify(input.accessIds))
    .run();
  return result.meta.changes;
}

/** The budget sweep asks the serving decision of the gateway: credit exhausted past its grace, a budget stop or a gone scope. */
export async function readProductAccessCreditAdmission(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ ...scope, environmentId: ulid, now: instant }).parse(raw);
  return readOnOrganization(context, input.organizationId, (db) => readRuntimeDecision(db, input));
}

/** Original161 losing logical environment: the accepted parent claim and intent authorize this exact access inventory. */
export async function readDataChangeProductAccess(context: CatalogContext, raw: unknown) {
  const input = z
      .strictObject({
        ...scope,
        environmentId: ulid,
        operationId: ulid,
        claimId: ulid,
        losingEnvironmentId: ulid,
      })
      .parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const rows = await db
    .prepare(
      `SELECT a.access_id FROM product_provider_mutation_claims claim
 JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id AND intent.operation_id=claim.operation_id
 JOIN projects p ON p.organization_id=claim.organization_id AND p.project_id=claim.project_id
 JOIN operations op ON op.organization_id=claim.organization_id AND op.project_id=claim.project_id AND op.operation_id=claim.operation_id
 JOIN environments losing ON losing.organization_id=claim.organization_id AND losing.project_id=claim.project_id AND losing.name=CASE WHEN intent.data_change='isolate_dev_keeps_data' THEN 'prod' ELSE 'dev' END
 LEFT JOIN project_database_access a ON a.organization_id=claim.organization_id AND a.project_id=claim.project_id AND a.environment_id=losing.environment_id AND a.provider='pgcf' AND a.revoked_at IS NULL
 WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.claim_id=?5 AND losing.environment_id=?6
 AND claim.event_type='ProjectDataChangeRequestedV1' AND intent.event_type=claim.event_type AND p.owner_state='active' AND p.lifecycle_state='active' AND p.lifecycle_version=claim.accepted_lifecycle_version AND op.state IN('queued','running') ORDER BY a.issued_at,a.access_id`,
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.operationId,
      input.claimId,
      input.losingEnvironmentId,
    )
    .all<{ access_id: string | null }>();
  if (rows.results.length === 0) throw new ProductDatabaseError("scope");
  return rows.results.flatMap((row) => (row.access_id === null ? [] : [row.access_id]));
}

/**
 * The admission of a database command for one environment, read by name: the same serving decision the commands
 * apply (`admissionRefusal`), so a caller refused here is refused by the command too. A scope that is not this
 * organization's environment answers `organization_credit_scope_missing`, the same as an inactive one.
 */
export async function readProductDatabaseAdmission(context: CatalogContext, raw: unknown) {
  const input = z
    .strictObject({ ...scope, environment: z.enum(["dev", "prod"]), now: instant })
    .parse(raw);
  return readOnOrganization(context, input.organizationId, async (db) => {
    const row = await db
      .prepare(
        "SELECT environment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND name=?3",
      )
      .bind(input.organizationId, input.projectId, input.environment)
      .first<{ environment_id: string }>();
    if (row === null)
      return { status: "rejected" as const, code: "organization_credit_scope_missing" };
    const refusal = admissionRefusal(
      await readRuntimeDecision(db, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: row.environment_id,
        now: input.now,
      }),
    );
    return refusal === null
      ? { status: "admitted" as const }
      : { status: "rejected" as const, code: refusal.code };
  });
}

/** Original readonly diagnostic target. A query uses current registration authority without adding write/data-change admission. */
export async function readProductDiagnosticTarget(context: CatalogContext, raw: unknown) {
  const input = z.strictObject({ ...scope, environment: z.enum(["dev", "prod"]) }).parse(raw),
    db = (await context.router.routeOrganization(input.organizationId)).db;
  const row = await db
    .prepare(SQL_TARGET.replace(` AND NOT ${DATA_CHANGE_PENDING}`, ""))
    .bind(...targetParams(input))
    .first<SqlTargetRow>();
  if (!row) return null;
  return {
    provider: "pgcf" as const,
    providerProjectId: row.provider_project_id,
    databaseId: row.database_id,
    dataEnvironmentId: row.physical_environment_id,
    originHost: row.origin_host,
    roleName: `ohmyho_ro_${row.physical_environment_id.toLowerCase()}`,
  };
}

const databaseEventAudit = z.strictObject({
  ...scope,
  // An export covers every environment of the project, so its link names none.
  environment: z.enum(["dev", "prod"]).nullable(),
  principalId: z.string().trim().min(1).max(256),
  eventType: z.enum(["ProjectDatabaseEventChangedV1", "ProjectExportDownloadLinkIssuedV1"]),
  payload: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  occurredAt: instant,
});
/** Download links one organization may be issued in any minute; a refused link is not signed and not audited. */
const EXPORT_LINKS_PER_MINUTE = 6;

/**
 * Records one audit event under the principal that caused it: a change of database events (webhook, schedule, watch,
 * table, replay) or an export download link. A link is the reservation of one signature: the Core answers false,
 * and writes nothing, when the organization already has EXPORT_LINKS_PER_MINUTE links in the last minute. A project
 * the Core does not know is refused. The audit id is minted here.
 */
export async function recordProductDatabaseEventAudit(context: CatalogContext, raw: unknown) {
  const input = databaseEventAudit.parse(raw);
  const auditEventId = newUlid();
  return runOnOrganization(context, input.organizationId, (db) => ({
    name: "productDatabase.recordEventAudit",
    input,
    read: async (reader: D1Database) => ({
      present:
        (await reader
          .prepare("SELECT 1 AS present FROM projects WHERE organization_id=?1 AND project_id=?2")
          .bind(input.organizationId, input.projectId)
          .first()) !== null,
      recent:
        input.eventType === "ProjectExportDownloadLinkIssuedV1"
          ? Number(
              (
                await reader
                  .prepare(
                    "SELECT count(*) AS n FROM audit_events WHERE organization_id=?1 AND event_type=?2 AND occurred_at>=?3",
                  )
                  .bind(
                    input.organizationId,
                    input.eventType,
                    addMilliseconds(input.occurredAt, -60000),
                  )
                  .first<{ n: number }>()
              )?.n ?? 0,
            )
          : 0,
    }),
    decide: ({ present, recent }: { present: boolean; recent: number }) =>
      present &&
      recent >= EXPORT_LINKS_PER_MINUTE &&
      input.eventType === "ProjectExportDownloadLinkIssuedV1"
        ? { statements: [], result: () => ({ recorded: false }) }
        : present
          ? {
              statements: [
                db
                  .prepare(
                    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) SELECT ?1,?2,?3,NULL,?4,'principal',?5,?6,?7,p.active_billing_epoch_id FROM projects p WHERE p.organization_id=?1 AND p.project_id=?3",
                  )
                  .bind(
                    input.organizationId,
                    auditEventId,
                    input.projectId,
                    input.eventType,
                    input.principalId,
                    JSON.stringify(input.payload),
                    input.occurredAt,
                  ),
              ],
              result: () => ({ recorded: true }),
            }
          : { reject: new ProductDatabaseError("scope") },
  }));
}
