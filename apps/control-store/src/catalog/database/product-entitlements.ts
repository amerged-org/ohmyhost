import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  addMilliseconds,
  instant,
  ulid,
  notFencedOrganization,
  fenceRaceGuard,
  type CatalogContext,
} from "../common.js";
import { paidDenial, readAccount, type AccountView } from "../credit/index.js";
import { currentDataEnvironment } from "./authority.js";

const providerProject = z.string().regex(/^prj_[a-z0-9]{20}$/u),
  database = z.string().regex(/^[a-z][a-z0-9]{19}$/u);
const scopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  physicalEnvironmentId: ulid,
  providerProjectId: providerProject,
  databaseId: database,
});
// The original Paid helper requires the management clock's canonical millisecond ISO form.
const managementClock = z
  .string()
  .refine((value) => {
    const at = new Date(value);
    return Number.isFinite(at.getTime()) && at.toISOString() === value;
  })
  .pipe(instant);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const observationInput = z.strictObject({
  id: database,
  projectId: providerProject,
  sizeClassId: z.string(),
  resources: z.strictObject({
    memoryMiB: z.number().int().min(256).max(Number.MAX_SAFE_INTEGER),
    storageMiB: z.number().int().min(500).max(Number.MAX_SAFE_INTEGER),
  }),
  desiredState: z.enum(["running", "suspended"]),
  suspensionReason: z.enum(["manual", "idle"]).nullable().optional(),
  generation,
  observedGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  observedState: z.string(),
});
const jobInput = scopeInput.extend({
  actionId: ulid,
  claimId: ulid,
  billingEpochId: ulid,
  action: z.enum(["suspend", "resume"]),
  expectedGeneration: generation,
  idempotencyKey: z.string().regex(/^omh-entitlement-[a-f0-9]{64}$/u),
  providerOperationId: z
    .string()
    .regex(/^op_[a-z0-9]{20}$/u)
    .nullable(),
  state: z.enum(["reserved", "dispatched", "pending"]),
});
export type ProductEntitlementScope = z.infer<typeof scopeInput>;
export type ProductEntitlementAction = z.infer<typeof jobInput>;
type Observation = z.infer<typeof observationInput>;
type ClaimResult =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "action"; job: ProductEntitlementAction };
export class ProductEntitlementConflictError extends Error {
  constructor() {
    super("PGCF entitlement scope or action changed");
    this.name = "PgcfEntitlementConflictError";
  }
}
const retryOn = ["precondition_changed", "claim_lost"] as const;
const scopeArgs = (s: ProductEntitlementScope) => [
  s.organizationId,
  s.projectId,
  s.physicalEnvironmentId,
  s.providerProjectId,
  s.databaseId,
];
const policyArgs = (s: ProductEntitlementScope) => [
  s.organizationId,
  s.projectId,
  s.physicalEnvironmentId,
  s.databaseId,
];
const WHERE_POLICY =
  "organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND database_id=?4";
const TARGET = `SELECT h.organization_id,h.project_id,h.physical_environment_id,r.provider_project_id,r.database_id,r.size_class_id,CAST(h.target_version AS TEXT) target_version,p.active_billing_epoch_id,
 json_array(CAST(h.target_version AS TEXT),p.active_billing_epoch_id,p.ownership_version,p.lifecycle_version,r.size_class_id) signature
 FROM database_provider_target_heads h JOIN database_provider_target_revisions r USING(organization_id,project_id,physical_environment_id,target_version)
 JOIN projects p ON p.organization_id=h.organization_id AND p.project_id=h.project_id
 JOIN billing_epochs epoch ON epoch.organization_id=p.organization_id AND epoch.project_id=p.project_id AND epoch.billing_epoch_id=p.active_billing_epoch_id AND epoch.ended_at IS NULL
 WHERE h.state='active' AND h.activated_at IS NOT NULL AND r.provider='pgcf' AND p.owner_state='active' AND p.lifecycle_state='active'
 AND NOT EXISTS(SELECT 1 FROM database_provider_cutover_authorizations a WHERE a.organization_id=h.organization_id AND a.project_id=h.project_id AND NOT EXISTS(SELECT 1 FROM database_provider_cutover_releases released WHERE released.organization_id=a.organization_id AND released.operation_id=a.operation_id))
 AND NOT EXISTS(SELECT 1 FROM product_command_intents i JOIN operations op ON op.organization_id=i.organization_id AND op.project_id=i.project_id AND op.operation_id=i.operation_id WHERE i.organization_id=h.organization_id AND i.project_id=h.project_id AND i.event_type='ProjectDataChangeRequestedV1' AND op.state IN('queued','running'))`;
const CURRENT = `${TARGET} AND h.organization_id=?1 AND h.project_id=?2 AND h.physical_environment_id=?3 AND r.provider_project_id=?4 AND r.database_id=?5`;
/**
 * A queued or running export of the database's environment whose sealed input has not expired. While it can still run,
 * the database stays awake: an owned suspension is resumed for the export and no suspension is chosen. Parameters:
 * ?1 organization, ?2 project, ?3 physical environment, ?4 the stored instant of the decision.
 */
const EXPORT_HOLD = `EXISTS(SELECT 1 FROM project_recovery_jobs job JOIN operations op ON op.organization_id=job.organization_id AND op.operation_id=job.operation_id WHERE job.organization_id=?1 AND job.project_id=?2 AND op.state IN('queued','running') AND job.input_expires_at>?4 AND ${currentDataEnvironment("job.organization_id", "job.project_id", "job.environment_id")}=?3)`;
const POLICY = `SELECT *,CAST(suspension_generation AS TEXT) generation_text,json_array(suspended_by_entitlement,suspension_operation_id,CAST(suspension_generation AS TEXT),last_checked_at) signature FROM pgcf_database_entitlement_policies WHERE ${WHERE_POLICY}`;
const ACTION = `SELECT *,CAST(expected_generation AS TEXT) generation_text,CAST(target_version AS TEXT) target_text,CAST(provider_generation AS TEXT) provider_generation_text,json_array(action_id,organization_id,project_id,physical_environment_id,billing_epoch_id,CAST(target_version AS TEXT),provider_project_id,database_id,action,CAST(expected_generation AS TEXT),idempotency_key,state,provider_operation_id,CAST(provider_generation AS TEXT),claim_id,claim_expires_at,created_at,dispatched_at,observed_at) signature FROM pgcf_database_entitlement_actions`;
interface Target {
  organization_id: string;
  project_id: string;
  physical_environment_id: string;
  provider_project_id: string;
  database_id: string;
  size_class_id: string;
  target_version: string;
  active_billing_epoch_id: string;
  signature: string;
}
interface Policy {
  suspended_by_entitlement: number;
  suspension_operation_id: string | null;
  generation_text: string | null;
  last_checked_at: string;
  signature: string;
}
interface Action {
  action_id: string;
  organization_id: string;
  project_id: string;
  physical_environment_id: string;
  provider_project_id: string;
  database_id: string;
  billing_epoch_id: string;
  generation_text: string;
  target_text: string;
  action: "suspend" | "resume";
  idempotency_key: string;
  state: string;
  provider_operation_id: string | null;
  provider_generation_text: string | null;
  claim_id: string;
  claim_expires_at: string;
  dispatched_at: string | null;
  observed_at: string | null;
  signature: string;
}
interface Facts {
  account: AccountView;
  target: Target | null;
  policyRow: Policy | null;
  pending: Action | null;
  named: Action | null;
  computePending: boolean;
  exportHeld: boolean;
}
async function facts(
  db: D1Database,
  s: ProductEntitlementScope,
  actionId: string | null,
  now: string,
): Promise<Facts> {
  const [target, policyRow, pending, named, compute, held] = await db.batch([
    db.prepare(CURRENT).bind(...scopeArgs(s)),
    db.prepare(POLICY).bind(...policyArgs(s)),
    db
      .prepare(`${ACTION} WHERE ${WHERE_POLICY} AND state IN('reserved','dispatched','pending')`)
      .bind(...policyArgs(s)),
    db.prepare(`${ACTION} WHERE action_id=?1`).bind(actionId),
    db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM pgcf_database_compute_changes WHERE project_id=?1 AND completed_at IS NULL) pending",
      )
      .bind(s.projectId),
    db
      .prepare(`SELECT ${EXPORT_HOLD} held`)
      .bind(s.organizationId, s.projectId, s.physicalEnvironmentId, now),
  ]);
  return {
    account: await readAccount(db, s.organizationId, now),
    target: (target?.results[0] as Target | undefined) ?? null,
    policyRow: (policyRow?.results[0] as Policy | undefined) ?? null,
    pending: (pending?.results[0] as Action | undefined) ?? null,
    named: (named?.results[0] as Action | undefined) ?? null,
    computePending: (compute?.results[0] as { pending: number } | undefined)?.pending === 1,
    exportHeld: (held?.results[0] as { held: number } | undefined)?.held === 1,
  };
}
function validateScope(s: ProductEntitlementScope, o: Observation) {
  if (
    o.id !== s.databaseId ||
    o.projectId !== s.providerProjectId ||
    (o.desiredState === "suspended" &&
      o.suspensionReason !== "manual" &&
      o.suspensionReason !== "idle")
  )
    throw new ProductEntitlementConflictError();
}
function requireFacts(s: Facts) {
  if (!s.target) throw new ProductEntitlementConflictError();
  return s.target;
}
/** Paid coverage whose credit is not exhausted past its grace: the condition of a database above the Free size. */
function paid(s: Facts) {
  return paidDenial(s.account) === null;
}
function free(t: Target, o: Observation) {
  return (
    t.size_class_id === "r256-s500m" &&
    o.sizeClassId === "r256-s500m" &&
    o.resources.memoryMiB === 256 &&
    o.resources.storageMiB === 500
  );
}
function owns(p: Policy | null, o: Observation) {
  return (
    p?.suspended_by_entitlement === 1 &&
    p.suspension_operation_id !== null &&
    p.generation_text === String(o.generation) &&
    o.observedGeneration === o.generation &&
    o.desiredState === "suspended" &&
    o.suspensionReason === "manual" &&
    o.observedState === "hibernated"
  );
}
function job(r: Action): ProductEntitlementAction {
  const n = Number(r.generation_text);
  if (!Number.isSafeInteger(n) || n < 1) throw new ProductEntitlementConflictError();
  return {
    organizationId: r.organization_id,
    projectId: r.project_id,
    physicalEnvironmentId: r.physical_environment_id,
    providerProjectId: r.provider_project_id,
    databaseId: r.database_id,
    actionId: r.action_id,
    claimId: r.claim_id,
    billingEpochId: r.billing_epoch_id,
    action: r.action,
    expectedGeneration: n,
    idempotencyKey: r.idempotency_key,
    providerOperationId: r.provider_operation_id,
    state: r.state as ProductEntitlementAction["state"],
  };
}
function identity(r: Action | null, j: ProductEntitlementAction) {
  if (
    !r ||
    r.claim_id !== j.claimId ||
    r.billing_epoch_id !== j.billingEpochId ||
    r.action !== j.action ||
    r.generation_text !== String(j.expectedGeneration) ||
    r.idempotency_key !== j.idempotencyKey ||
    JSON.stringify([
      r.organization_id,
      r.project_id,
      r.physical_environment_id,
      r.provider_project_id,
      r.database_id,
    ]) !== JSON.stringify(scopeArgs(j))
  )
    throw new ProductEntitlementConflictError();
  return r;
}
function clear(db: D1Database, s: ProductEntitlementScope) {
  return db
    .prepare(
      `UPDATE pgcf_database_entitlement_policies SET suspended_by_entitlement=0,suspension_operation_id=NULL,suspension_generation=NULL WHERE ${WHERE_POLICY}`,
    )
    .bind(...policyArgs(s));
}
function fences(db: D1Database, s: ProductEntitlementScope, f: Facts): D1PreparedStatement[] {
  const target = requireFacts(f);
  return [
    fenceRaceGuard(db, "claim_lost", s.organizationId),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM(${CURRENT}) current WHERE current.signature=?6)`,
      [...scopeArgs(s), target.signature],
    ),
    guard(
      db,
      "precondition_changed",
      f.policyRow === null
        ? `EXISTS(${POLICY})`
        : `NOT EXISTS(SELECT 1 FROM(${POLICY}) policy WHERE policy.signature=?5)`,
      f.policyRow === null ? policyArgs(s) : [...policyArgs(s), f.policyRow.signature],
    ),
    guard(
      db,
      "precondition_changed",
      f.pending === null
        ? `EXISTS(${ACTION} WHERE ${WHERE_POLICY} AND state IN('reserved','dispatched','pending'))`
        : `NOT EXISTS(SELECT 1 FROM(${ACTION} WHERE action_id=?1) a WHERE a.signature=?2)`,
      f.pending === null ? policyArgs(s) : [f.pending.action_id, f.pending.signature],
    ),
  ];
}
async function execute<R>(
  context: CatalogContext,
  s: ProductEntitlementScope,
  build: (db: D1Database) => Command<Facts, R>,
): Promise<R> {
  const db = (await context.router.routeOrganization(s.organizationId)).db;
  return runCommand(db, build(db));
}
export async function readProductEntitlementTargets(
  context: CatalogContext,
  raw: unknown,
): Promise<ProductEntitlementScope[]> {
  const i = z
    .strictObject({
      providerProjectId: providerProject,
      limit: z.number().int().min(1).max(64).default(32),
    })
    .parse(raw);
  const db = (await context.router.routeShard(0)).db;
  const result = await db
    .prepare(
      `SELECT current.organization_id,current.project_id,current.physical_environment_id,current.provider_project_id,current.database_id FROM(${TARGET}) current LEFT JOIN pgcf_database_entitlement_policies policy ON policy.organization_id=current.organization_id AND policy.project_id=current.project_id AND policy.physical_environment_id=current.physical_environment_id AND policy.database_id=current.database_id WHERE current.provider_project_id=?1 AND ${notFencedOrganization("current.organization_id")} ORDER BY policy.last_checked_at NULLS FIRST,current.organization_id,current.project_id,current.physical_environment_id LIMIT ?2`,
    )
    .bind(i.providerProjectId, i.limit)
    .all<Target>();
  return result.results.map((r) => ({
    organizationId: r.organization_id,
    projectId: r.project_id,
    physicalEnvironmentId: r.physical_environment_id,
    providerProjectId: r.provider_project_id,
    databaseId: r.database_id,
  }));
}
async function key(s: ProductEntitlementScope, actionId: string, action: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([...scopeArgs(s), actionId, action])),
    ),
  );
  return "omh-entitlement-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
const checkFailureInput = z.strictObject({ scope: scopeInput, now: managementClock });
/**
 * A reconciler pass that could not check a target (its provider read or claim failed) records the check time, so the targets
 * behind it are reached on the next pass (CORE-58). Only the active target that the scope names, in an organization that is
 * not fenced, is written; the check time only moves forward, and suspension fields are never touched.
 */
export async function recordProductEntitlementCheckFailure(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = checkFailureInput.parse(raw),
    s = i.scope;
  await execute(context, s, (db) => ({
    name: "database.recordEntitlementCheckFailure",
    input: i,
    read: (d) => facts(d, s, null, i.now),
    decide: (f) => {
      requireFacts(f);
      return {
        statements: [
          db
            .prepare(
              `INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at) SELECT ?1,?2,?3,?5,?6 WHERE EXISTS(${CURRENT}) AND ${notFencedOrganization("?1")} ON CONFLICT(organization_id,project_id,physical_environment_id,database_id) DO UPDATE SET last_checked_at=excluded.last_checked_at WHERE excluded.last_checked_at>pgcf_database_entitlement_policies.last_checked_at`,
            )
            .bind(...scopeArgs(s), i.now),
        ],
        result: () => undefined,
      };
    },
  }));
}
export async function claimProductEntitlement(
  context: CatalogContext,
  raw: unknown,
): Promise<ClaimResult> {
  const i = z
      .strictObject({
        scope: scopeInput,
        observation: observationInput,
        input: z.strictObject({ now: managementClock, actionId: ulid, claimId: ulid }),
      })
      .parse(raw),
    s = i.scope,
    o = i.observation,
    request = i.input;
  validateScope(s, o);
  const keys = {
    suspend: await key(s, request.actionId, "suspend"),
    resume: await key(s, request.actionId, "resume"),
  };
  return execute<ClaimResult>(context, s, (db) => ({
    name: "database.claimEntitlement",
    input: i,
    read: (d) => facts(d, s, request.actionId, request.now),
    decide: (f) => {
      const t = requireFacts(f),
        allowed = paid(f) || free(t, o) || f.exportHeld,
        p = f.pending;
      const writes = fences(db, s, f);
      writes.push(
        db
          .prepare(
            "INSERT INTO pgcf_database_entitlement_policies(organization_id,project_id,physical_environment_id,database_id,last_checked_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(organization_id,project_id,physical_environment_id,database_id) DO UPDATE SET last_checked_at=excluded.last_checked_at",
          )
          .bind(...policyArgs(s), request.now),
      );
      let result: ClaimResult;
      if (p) {
        if (p.billing_epoch_id !== t.active_billing_epoch_id)
          throw new ProductEntitlementConflictError();
        if (p.claim_id !== request.claimId && p.claim_expires_at > request.now)
          result = { status: "waiting" };
        else if (
          p.state === "reserved" &&
          ((p.action === "suspend" && allowed) || (p.action === "resume" && !allowed))
        ) {
          writes.push(
            db
              .prepare(
                "UPDATE pgcf_database_entitlement_actions SET state='cancelled',observed_at=?2 WHERE action_id=?1",
              )
              .bind(p.action_id, request.now),
          );
          result = { status: "idle" };
        } else {
          writes.push(
            db
              .prepare(
                "UPDATE pgcf_database_entitlement_actions SET claim_id=?2,claim_expires_at=?3 WHERE action_id=?1",
              )
              .bind(p.action_id, request.claimId, addMilliseconds(request.now, 90_000)),
          );
          result = { status: "action", job: { ...job(p), claimId: request.claimId } };
        }
      } else {
        const own = owns(f.policyRow, o);
        if (f.policyRow?.suspended_by_entitlement && !own) writes.push(clear(db, s));
        const action =
          !allowed && (o.desiredState === "running" || o.suspensionReason === "idle")
            ? "suspend"
            : allowed && own
              ? "resume"
              : null;
        if (action === null) result = { status: "idle" };
        else {
          if (f.named !== null) throw new ProductEntitlementConflictError();
          writes.push(
            db
              .prepare(
                "INSERT INTO pgcf_database_entitlement_actions(action_id,organization_id,project_id,physical_environment_id,billing_epoch_id,target_version,provider_project_id,database_id,action,idempotency_key,state,claim_id,claim_expires_at,created_at,expected_generation) VALUES(?1,?2,?3,?4,?5,CAST(?6 AS INTEGER),?7,?8,?9,?10,'reserved',?11,?12,?13,?14)",
              )
              .bind(
                request.actionId,
                s.organizationId,
                s.projectId,
                s.physicalEnvironmentId,
                t.active_billing_epoch_id,
                t.target_version,
                s.providerProjectId,
                s.databaseId,
                action,
                keys[action],
                request.claimId,
                addMilliseconds(request.now, 90_000),
                request.now,
                o.generation,
              ),
          );
          result = {
            status: "action",
            job: {
              ...s,
              actionId: request.actionId,
              claimId: request.claimId,
              billingEpochId: t.active_billing_epoch_id,
              action,
              expectedGeneration: o.generation,
              idempotencyKey: keys[action],
              providerOperationId: null,
              state: "reserved",
            },
          };
        }
      }
      return { statements: writes, result: () => result };
    },
    retryOn,
    naturalKeyTables: ["pgcf_database_entitlement_actions", "pgcf_database_entitlement_policies"],
  }));
}
export async function beginProductEntitlement(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = z
      .strictObject({ job: jobInput, now: managementClock, observation: observationInput })
      .parse(raw),
    s = i.job;
  validateScope(s, i.observation);
  return execute(context, s, (db) => ({
    name: "database.beginEntitlement",
    input: i,
    read: (d) => facts(d, s, s.actionId, i.now),
    decide: (f) => {
      const t = requireFacts(f),
        r = identity(f.named, s);
      if (t.active_billing_epoch_id !== s.billingEpochId)
        throw new ProductEntitlementConflictError();
      if (!["reserved", "dispatched", "pending"].includes(r.state) || r.claim_expires_at <= i.now)
        throw new ProductEntitlementConflictError();
      const writes = [
        ...fences(db, s, f),
        guard(
          db,
          "precondition_changed",
          "(EXISTS(SELECT 1 FROM pgcf_database_compute_changes WHERE project_id=?1 AND completed_at IS NULL))<>?2",
          [s.projectId, f.computePending ? 1 : 0],
        ),
      ];
      let result = true;
      if (
        s.action === "resume" &&
        s.providerOperationId === null &&
        !owns(f.policyRow, i.observation)
      ) {
        writes.push(
          db
            .prepare(
              "UPDATE pgcf_database_entitlement_actions SET state=CASE WHEN state='reserved' THEN 'cancelled' ELSE 'superseded' END,observed_at=?3 WHERE action_id=?1 AND claim_id=?2",
            )
            .bind(s.actionId, s.claimId, i.now),
          clear(db, s),
        );
        result = false;
      } else {
        const allowed = paid(f) || (free(t, i.observation) && !f.computePending) || f.exportHeld;
        if (
          r.state === "reserved" &&
          ((s.action === "suspend" && allowed) || (s.action === "resume" && !allowed))
        ) {
          writes.push(
            db
              .prepare(
                "UPDATE pgcf_database_entitlement_actions SET state='cancelled',observed_at=?3 WHERE action_id=?1 AND claim_id=?2",
              )
              .bind(s.actionId, s.claimId, i.now),
          );
          result = false;
        } else {
          writes.push(
            db
              .prepare(
                "UPDATE pgcf_database_entitlement_actions SET state=CASE WHEN state='reserved' THEN 'dispatched' ELSE state END,dispatched_at=COALESCE(dispatched_at,?3) WHERE action_id=?1 AND claim_id=?2 AND claim_expires_at>?3 AND state IN('reserved','dispatched','pending')",
              )
              .bind(s.actionId, s.claimId, i.now),
            guard(db, "claim_lost", "changes()<>1"),
          );
        }
      }
      return { statements: writes, result: () => result };
    },
    retryOn,
  }));
}
export async function recordProductEntitlement(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = z
      .strictObject({
        job: jobInput,
        input: z.strictObject({
          now: instant,
          providerOperationId: z
            .string()
            .regex(/^op_[a-z0-9]{20}$/u)
            .nullable(),
          providerGeneration: generation.nullable(),
          state: z.enum(["pending", "succeeded", "failed", "superseded"]),
        }),
      })
      .parse(raw),
    s = i.job,
    v = i.input;
  if (
    (v.providerOperationId === null) !== (v.providerGeneration === null) ||
    (v.state === "succeeded" && v.providerOperationId === null)
  )
    throw new ProductEntitlementConflictError();
  await execute(context, s, (db) => ({
    name: "database.recordEntitlement",
    input: i,
    read: (d) => facts(d, s, s.actionId, v.now),
    decide: (f) => {
      const t = requireFacts(f),
        r = identity(f.named, s);
      if (
        t.active_billing_epoch_id !== s.billingEpochId ||
        (r.provider_operation_id !== null && r.provider_operation_id !== v.providerOperationId) ||
        (r.provider_generation_text !== null &&
          r.provider_generation_text !== String(v.providerGeneration))
      )
        throw new ProductEntitlementConflictError();
      if (
        r.state === v.state &&
        r.observed_at === v.now &&
        r.provider_operation_id === v.providerOperationId &&
        r.provider_generation_text ===
          (v.providerGeneration === null ? null : String(v.providerGeneration))
      )
        return { replay: undefined };
      if (!["dispatched", "pending"].includes(r.state)) throw new ProductEntitlementConflictError();
      const writes = fences(db, s, f);
      writes.push(
        db
          .prepare(
            "UPDATE pgcf_database_entitlement_actions SET state=?4,provider_operation_id=COALESCE(provider_operation_id,?5),provider_generation=COALESCE(provider_generation,?6),observed_at=?3,claim_expires_at=?3 WHERE action_id=?1 AND claim_id=?2 AND state IN('dispatched','pending')",
          )
          .bind(s.actionId, s.claimId, v.now, v.state, v.providerOperationId, v.providerGeneration),
        guard(db, "claim_lost", "changes()<>1"),
      );
      if (v.state === "succeeded" && s.action === "suspend")
        writes.push(
          db
            .prepare(
              `UPDATE pgcf_database_entitlement_policies SET suspended_by_entitlement=1,suspension_operation_id=?5,suspension_generation=?6 WHERE ${WHERE_POLICY}`,
            )
            .bind(...policyArgs(s), v.providerOperationId, v.providerGeneration),
        );
      else if (v.state === "succeeded" || v.state === "superseded") writes.push(clear(db, s));
      return { statements: writes, result: () => undefined };
    },
    retryOn,
  }));
}
