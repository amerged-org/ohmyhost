import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import { hexBytes, type CatalogContext } from "../common.js";
import { buildSettlement } from "./settlement.js";
import {
  authorizeInput,
  BuildCapacityReachedError,
  BuildInputConflictError,
  claimInput,
  completionInput,
  usageInput,
  type BuildClaimResult,
  type BuildScope,
  type ClaimInput,
  type CompletionInput,
  type UsageInput,
} from "./contracts.js";

const DB_NOW = `(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')`;
/** Open build reservations one organization may hold, so no tenant can occupy every build sandbox. */
const MAXIMUM_OPEN_BUILDS_PER_ORGANIZATION = 4;
/** The longest a started build is counted: the sandbox sleeps after 15 idle minutes, and a crashed build must not hold capacity. */
const STARTED_BUILD_WINDOW = `(strftime('%Y-%m-%dT%H:%M:%f','now','-60 minutes') || '000Z')`;
/**
 * A reservation that still holds or may take build capacity (alias `r`): its operation has not
 * ended, and either its build started within the window, or it is unstarted inside its start window.
 */
const OPEN_RESERVATION = `EXISTS (SELECT 1 FROM operations o WHERE o.organization_id=r.organization_id
  AND o.project_id=r.project_id AND o.operation_id=r.operation_id AND o.state IN ('queued','running'))
  AND (EXISTS (SELECT 1 FROM build_receipts b WHERE b.organization_id=r.organization_id AND b.project_id=r.project_id
      AND b.environment_id=r.environment_id AND b.operation_id=r.operation_id AND b.created_at > ${STARTED_BUILD_WINDOW})
    OR (NOT EXISTS (SELECT 1 FROM build_receipts b WHERE b.organization_id=r.organization_id AND b.project_id=r.project_id
      AND b.environment_id=r.environment_id AND b.operation_id=r.operation_id)
      AND ${DB_NOW} < r.start_allowed_until))`;
const AFTER_LEASE = `(strftime('%Y-%m-%dT%H:%M:%f','now', printf('+%.3f seconds', ?7 / 1000.0)) || '000Z')`;
const AFTER_WINDOW = `(strftime('%Y-%m-%dT%H:%M:%f','now','+4 minutes') || '000Z')`;
const CURRENT_SCOPE = `SELECT 1 FROM operations o JOIN environments e ON e.organization_id=o.organization_id
  AND e.project_id=o.project_id AND e.environment_id=?3 JOIN projects p ON p.organization_id=o.organization_id
  AND p.project_id=o.project_id WHERE o.organization_id=?1 AND o.project_id=?2 AND o.operation_id=?4 AND p.owner_state='active'`;
type Row = Readonly<Record<string, unknown>>;
const scopeParams = (org: string, scope: BuildScope) => [
  org,
  scope.projectId,
  scope.environmentId,
  scope.operationId,
];
const fail = (): never => {
  throw new BuildInputConflictError();
};
const str = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fail();
};

/** Resolve an immutable accepted operation (or receipt for late usage), then apply its organization's authoritative bucket fence. */
async function databaseFor(context: CatalogContext, scope: BuildScope, usage = false) {
  const row = await context.directory
    .prepare(
      usage
        ? `SELECT organization_id FROM build_receipts WHERE project_id=?1 AND environment_id=?2 AND operation_id=?3`
        : `SELECT o.organization_id FROM operations o JOIN environments e ON e.organization_id=o.organization_id
       AND e.project_id=o.project_id AND e.environment_id=?2 JOIN projects p ON p.organization_id=o.organization_id
       AND p.project_id=o.project_id WHERE o.project_id=?1 AND o.operation_id=?3 AND p.owner_state='active'`,
    )
    .bind(scope.projectId, scope.environmentId, scope.operationId)
    .first<{ organization_id: string }>();
  if (row === null) return fail();
  return {
    org: row.organization_id,
    db: (await context.router.routeOrganization(row.organization_id)).db,
  };
}

interface BuildSnapshot {
  readonly current: boolean;
  readonly reservation: Row | undefined;
  readonly receipt: Row | undefined;
  readonly foreign: boolean;
  readonly openReservations: number;
  readonly now: string;
}

async function readBuild(
  db: D1Database,
  org: string,
  scope: BuildScope,
  proposedClaim: string,
  provider?: CompletionInput["receipt"],
): Promise<BuildSnapshot> {
  const values = scopeParams(org, scope);
  const rows = await db.batch([
    db.prepare(`SELECT EXISTS (${CURRENT_SCOPE}) AS current, ${DB_NOW} AS db_now`).bind(...values),
    db
      .prepare(
        `SELECT lower(hex(input_fingerprint)) AS fingerprint,claim_id,claim_mode,attempt_number,created_at,start_allowed_until,lease_expires_at
      FROM build_input_reservations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4`,
      )
      .bind(...values),
    db
      .prepare(
        `SELECT provider_build_id,build_project_name,lower(hex(input_fingerprint)) AS fingerprint,build_claim_id
      FROM build_receipts WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4`,
      )
      .bind(...values),
    db
      .prepare(
        `SELECT 1 FROM build_input_reservations WHERE claim_id=?1 AND NOT (organization_id=?2 AND project_id=?3 AND environment_id=?4 AND operation_id=?5)
      UNION ALL SELECT 1 FROM build_receipts WHERE build_project_name=?6 AND provider_build_id=?7
      AND NOT (organization_id=?2 AND project_id=?3 AND environment_id=?4 AND operation_id=?5)`,
      )
      .bind(proposedClaim, ...values, provider?.projectName ?? "", provider?.buildId ?? ""),
    db
      .prepare(
        `SELECT COUNT(*) AS open_reservations FROM build_input_reservations r WHERE r.organization_id=?1 AND ${OPEN_RESERVATION}`,
      )
      .bind(org),
  ]);
  const first = rows[0]?.results[0] ?? {};
  return {
    current: first["current"] === 1,
    now: str(first, "db_now"),
    reservation: rows[1]?.results[0],
    receipt: rows[2]?.results[0],
    foreign: (rows[3]?.results.length ?? 0) > 0,
    openReservations: Number(rows[4]?.results[0]?.["open_reservations"] ?? 0),
  };
}

function claimed(row: Row): Extract<BuildClaimResult, { status: "claimed" }> {
  const mode = str(row, "claim_mode");
  if (mode !== "start" && mode !== "observe") return fail();
  return {
    status: "claimed",
    mode,
    attemptNumber: Number(row["attempt_number"]),
    reservationCreatedAt: new Date(str(row, "created_at")),
    startAllowedUntil: new Date(str(row, "start_allowed_until")),
    leaseExpiresAt: new Date(str(row, "lease_expires_at")),
  };
}

function completed(snapshot: BuildSnapshot, input: ClaimInput): BuildClaimResult | undefined {
  const r = snapshot.receipt,
    reservation = snapshot.reservation;
  if (r === undefined) return undefined;
  if (
    reservation === undefined ||
    str(r, "fingerprint") !== input.inputFingerprint.slice(7) ||
    str(reservation, "fingerprint") !== input.inputFingerprint.slice(7) ||
    str(r, "build_claim_id") !== str(reservation, "claim_id")
  )
    return fail();
  return {
    status: "completed",
    envelope: {
      receipt: {
        scope: input.scope,
        buildId: str(r, "provider_build_id"),
        projectName: str(r, "build_project_name"),
      },
      inputFingerprint: input.inputFingerprint,
      claimId: str(r, "build_claim_id"),
    },
  };
}

/** Database-clock lease acquisition; one current fingerprint and one provider receipt per accepted operation. */
export async function claimBuildInput(
  context: CatalogContext,
  raw: unknown,
): Promise<BuildClaimResult> {
  const input = claimInput.parse(raw),
    { db, org } = await databaseFor(context, input.scope);
  const values = scopeParams(org, input.scope);
  const command: Command<BuildSnapshot, BuildClaimResult> = {
    name: "build.claimInput",
    input,
    read: (database) => readBuild(database, org, input.scope, input.claimId),
    decide: (snapshot) => {
      if (!snapshot.current || snapshot.foreign) return { reject: new BuildInputConflictError() };
      const r = snapshot.reservation;
      if (r !== undefined && str(r, "fingerprint") !== input.inputFingerprint.slice(7))
        return { reject: new BuildInputConflictError() };
      const ready = completed(snapshot, input);
      if (ready !== undefined) return { replay: ready };
      if (r !== undefined && str(r, "lease_expires_at") > snapshot.now)
        return {
          replay: {
            status: "pending",
            leaseExpiresAt: new Date(str(r, "lease_expires_at")),
            startAllowedUntil: new Date(str(r, "start_allowed_until")),
          },
        };
      if (r === undefined && snapshot.openReservations >= MAXIMUM_OPEN_BUILDS_PER_ORGANIZATION)
        return { reject: new BuildCapacityReachedError() };
      // A new reservation re-checks the bound in the same batch, so a concurrent claim retries the decision.
      const capacity =
        r === undefined
          ? guard(
              db,
              "precondition_changed",
              `(SELECT COUNT(*) FROM build_input_reservations r WHERE r.organization_id=?1 AND ${OPEN_RESERVATION}) >= ${MAXIMUM_OPEN_BUILDS_PER_ORGANIZATION}`,
              [org],
            )
          : guard(db, "precondition_changed", "0 = 1");
      const statement =
        r === undefined
          ? db
              .prepare(
                `INSERT INTO build_input_reservations(organization_id,project_id,environment_id,operation_id,input_fingerprint,claim_id,
            claim_mode,claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until)
          VALUES (?1,?2,?3,?4,?5,?6,'start',${DB_NOW},${AFTER_LEASE},1,${DB_NOW},${AFTER_WINDOW})
          RETURNING claim_mode,attempt_number,created_at,start_allowed_until,lease_expires_at`,
              )
              .bind(
                ...values,
                hexBytes(input.inputFingerprint.slice(7)),
                input.claimId,
                input.leaseMilliseconds,
              )
          : db
              .prepare(
                `UPDATE build_input_reservations SET claim_id=?6,claim_mode=CASE WHEN claim_mode='observe' OR ${DB_NOW}>=start_allowed_until THEN 'observe' ELSE 'start' END,
            claimed_at=${DB_NOW},lease_expires_at=${AFTER_LEASE},attempt_number=attempt_number+1
          WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND input_fingerprint=?5
            AND claim_id=?8 AND attempt_number=?9 AND lease_expires_at<=${DB_NOW}
          RETURNING claim_mode,attempt_number,created_at,start_allowed_until,lease_expires_at`,
              )
              .bind(
                ...values,
                hexBytes(input.inputFingerprint.slice(7)),
                input.claimId,
                input.leaseMilliseconds,
                str(r, "claim_id"),
                r["attempt_number"],
              );
      return {
        statements: [
          guard(db, "precondition_changed", `NOT EXISTS (${CURRENT_SCOPE})`, values),
          capacity,
          statement,
          guard(db, "precondition_changed", "changes() <> 1"),
        ],
        result: (results) => claimed(results[2]?.results[0] ?? {}),
      };
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["build_input_reservations"],
    lookup: async (database) => {
      const snapshot = await readBuild(database, org, input.scope, input.claimId);
      if (!snapshot.current) return undefined;
      const ready = completed(snapshot, input);
      if (ready !== undefined) return ready;
      const r = snapshot.reservation;
      return r !== undefined &&
        r["claim_id"] === input.claimId &&
        r["fingerprint"] === input.inputFingerprint.slice(7)
        ? claimed(r)
        : undefined;
    },
  };
  return runCommand(db, command);
}

/** Start authority is read on the primary at SQL time; a receipt, expired lease/window or resolved reservation denies launch. */
export async function authorizeBuildStart(context: CatalogContext, raw: unknown): Promise<boolean> {
  const input = authorizeInput.parse(raw);
  let scopeDatabase: Awaited<ReturnType<typeof databaseFor>>;
  try {
    scopeDatabase = await databaseFor(context, input.scope);
  } catch (error) {
    if (error instanceof BuildInputConflictError) return false;
    throw error;
  }
  const { db, org } = scopeDatabase;
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM build_input_reservations r WHERE r.organization_id=?1 AND r.project_id=?2
    AND r.environment_id=?3 AND r.operation_id=?4 AND r.claim_id=?5 AND r.claim_mode='start'
    AND ${DB_NOW}<r.lease_expires_at AND ${DB_NOW}<r.start_allowed_until AND EXISTS (${CURRENT_SCOPE})
    AND EXISTS (SELECT 1 FROM credit_reservation c WHERE c.organization_id=r.organization_id AND c.project_id=r.project_id
      AND c.reservation_id=r.operation_id)
    AND NOT EXISTS (SELECT 1 FROM build_receipts b WHERE b.organization_id=r.organization_id AND b.project_id=r.project_id
      AND b.environment_id=r.environment_id AND b.operation_id=r.operation_id)) AS allowed`,
    )
    .bind(...scopeParams(org, input.scope), input.claimId)
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

function receiptMatches(row: Row, input: CompletionInput): boolean {
  return (
    row["provider_build_id"] === input.receipt.buildId &&
    row["build_project_name"] === input.receipt.projectName &&
    row["fingerprint"] === input.inputFingerprint.slice(7) &&
    row["build_claim_id"] === input.claimId
  );
}

/** Provider evidence is accepted only by the exact current reservation; receipt identity is immutable. */
export async function putBuildReceipt(context: CatalogContext, raw: unknown): Promise<void> {
  const input = completionInput.parse(raw),
    scope = input.receipt.scope,
    { db, org } = await databaseFor(context, scope);
  const values = scopeParams(org, scope);
  const decide = (snapshot: BuildSnapshot): Plan<true> => {
    if (
      !snapshot.current ||
      snapshot.foreign ||
      snapshot.reservation?.["fingerprint"] !== input.inputFingerprint.slice(7) ||
      snapshot.reservation["claim_id"] !== input.claimId
    )
      return { reject: new BuildInputConflictError() };
    if (snapshot.receipt !== undefined)
      return receiptMatches(snapshot.receipt, input)
        ? { replay: true }
        : { reject: new BuildInputConflictError() };
    return {
      statements: [
        guard(db, "precondition_changed", `NOT EXISTS (${CURRENT_SCOPE})`, values),
        guard(
          db,
          "precondition_changed",
          `NOT EXISTS (SELECT 1 FROM build_input_reservations WHERE organization_id=?1 AND project_id=?2
        AND environment_id=?3 AND operation_id=?4 AND input_fingerprint=?5 AND claim_id=?6)`,
          [...values, hexBytes(input.inputFingerprint.slice(7)), input.claimId],
        ),
        db
          .prepare(
            `INSERT INTO build_receipts(organization_id,project_id,environment_id,operation_id,provider_build_id,build_project_name,input_fingerprint,build_claim_id,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,${DB_NOW})`,
          )
          .bind(
            ...values,
            input.receipt.buildId,
            input.receipt.projectName,
            hexBytes(input.inputFingerprint.slice(7)),
            input.claimId,
          ),
      ],
      result: () => true,
    };
  };
  const read = (database: D1Database) =>
    readBuild(database, org, scope, input.claimId, input.receipt);
  await runCommand(db, {
    name: "build.putReceipt",
    input,
    read,
    decide,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["build_receipts"],
    lookup: async (database) => {
      const plan = decide(await read(database));
      return "replay" in plan ? plan.replay : undefined;
    },
  });
}

function usageMatches(row: Row, input: UsageInput): boolean {
  return (
    row["provider_build_id"] === input.receipt.buildId &&
    row["build_project_name"] === input.receipt.projectName &&
    row["runner"] === input.usage.runner &&
    row["instance_type"] === input.usage.instanceType &&
    row["status"] === input.usage.status &&
    row["started_at"] === input.usage.startedAt &&
    row["provisioning_started_at"] === input.usage.provisioningStartedAt &&
    row["completed_at"] === input.usage.completedAt
  );
}

/** Immutable measured usage AND the original accepted build settlement commit in ONE guarded batch. */
export async function putBuildUsage(context: CatalogContext, raw: unknown): Promise<void> {
  const input = usageInput.parse(raw),
    scope = input.receipt.scope,
    { db, org } = await databaseFor(context, scope, true);
  const values = scopeParams(org, scope);
  const read = async (database: D1Database) => {
    const [accepted, existing, clock, reservation] = await database.batch([
      database
        .prepare(
          `SELECT o.billing_epoch_id,p.created_at AS plan_created_at,p.cost_estimate FROM build_receipts r
      JOIN operations o ON o.organization_id=r.organization_id AND o.project_id=r.project_id AND o.operation_id=r.operation_id
      LEFT JOIN product_command_intents i ON i.organization_id=o.organization_id AND i.operation_id=o.operation_id
      AND i.project_id=o.project_id AND i.environment_id=r.environment_id AND i.billing_epoch_id=o.billing_epoch_id AND i.event_type='DeploymentRequestedV1'
      LEFT JOIN deployment_plans p ON p.organization_id=i.organization_id AND p.project_id=i.project_id AND p.plan_id=i.plan_id
      WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.operation_id=?4 AND r.provider_build_id=?5 AND r.build_project_name=?6`,
        )
        .bind(...values, input.receipt.buildId, input.receipt.projectName),
      database
        .prepare(
          "SELECT * FROM build_usage WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4",
        )
        .bind(...values),
      database.prepare(`SELECT ${DB_NOW} AS db_now`),
      database
        .prepare("SELECT 1 FROM credit_reservation WHERE reservation_id=?1 AND organization_id=?2")
        .bind(scope.operationId, org),
    ]);
    return {
      accepted: accepted?.results[0],
      existing: existing?.results[0],
      dbNow: str(clock?.results[0] ?? {}, "db_now"),
      reserved: (reservation?.results.length ?? 0) > 0,
    };
  };
  const decide = (snapshot: Awaited<ReturnType<typeof read>>): Plan<true> => {
    const { accepted, existing } = snapshot;
    if (accepted === undefined || (existing !== undefined && !usageMatches(existing, input)))
      return { reject: new BuildInputConflictError() };
    const now = existing === undefined ? snapshot.dbNow : str(existing, "observed_at");
    const settlement = buildSettlement(
      db,
      snapshot.reserved,
      input,
      {
        organizationId: org,
        planCreatedAt:
          typeof accepted["plan_created_at"] === "string" ? accepted["plan_created_at"] : null,
        costEstimate:
          typeof accepted["cost_estimate"] === "string" ? accepted["cost_estimate"] : null,
      },
      now,
    );
    if (existing !== undefined && settlement.length === 0) return { replay: true };
    const statements: D1PreparedStatement[] =
      existing !== undefined
        ? []
        : [
            db
              .prepare(
                `INSERT INTO build_usage(organization_id,project_id,environment_id,operation_id,billing_epoch_id,provider_build_id,build_project_name,
        runner,instance_type,status,started_at,provisioning_started_at,completed_at,observed_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
              )
              .bind(
                ...values,
                accepted["billing_epoch_id"],
                input.receipt.buildId,
                input.receipt.projectName,
                input.usage.runner,
                input.usage.instanceType,
                input.usage.status,
                input.usage.startedAt,
                input.usage.provisioningStartedAt,
                input.usage.completedAt,
                now,
              ),
          ];
    return { statements: [...statements, ...settlement], result: () => true };
  };
  await runCommand(db, {
    name: "build.putUsage",
    input,
    read,
    decide,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["build_usage", "credit_log"],
    lookup: async (database) => {
      const plan = decide(await read(database));
      return "replay" in plan ? plan.replay : undefined;
    },
  });
}
