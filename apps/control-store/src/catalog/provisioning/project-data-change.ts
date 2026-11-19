import { createHash } from "node:crypto";
import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import { type CatalogContext, routeOrganization, ulid, publicTimestamp } from "../common.js";
import { generatedJsonb } from "../../jsonb-generated.js";
import type { ProjectDataAssignments, ProjectDataChangeSnapshot } from "@ohmyhost/database";
import { parseProjectDataChangeSnapshot } from "./context-snapshots.js";
import {
  lifecycleConflict,
  lifecycleTime,
  lifecycleEncodedUlid,
  inventoryDigest,
  inventoryTargetGuards,
  inventoryInsertStatements,
  type InventoryTarget,
  type LifecycleInventoryRecord,
  type LifecycleScope,
} from "./lifecycle-inventory.js";

interface CurrentRow {
  data_mode: "shared" | "isolated";
  environment_id: string;
  name: "dev" | "prod";
  data_environment_id: string;
  assignment_version: string;
  assigned_at: string;
}
const CURRENT = `SELECT p.data_mode,e.environment_id,e.name,a.data_environment_id,CAST(a.assignment_version AS TEXT) assignment_version,a.assigned_at FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id JOIN environment_data_assignments a ON a.organization_id=e.organization_id AND a.project_id=e.project_id AND a.environment_id=e.environment_id AND a.assignment_version=(SELECT MAX(latest.assignment_version) FROM environment_data_assignments latest WHERE latest.organization_id=e.organization_id AND latest.project_id=e.project_id AND latest.environment_id=e.environment_id) WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND e.name IN('dev','prod') ORDER BY e.name`;
function integer(value: unknown, min: number) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) lifecycleConflict("Project data version is unavailable");
  return n;
}
/** Native two-environment latest assignment view, including original PG Date millisecond reply. */
export async function readCurrentDataAssignments(
  db: D1Database,
  input: LifecycleScope,
): Promise<ProjectDataAssignments | null> {
  const rows = (
    await db.prepare(CURRENT).bind(input.organizationId, input.projectId).all<CurrentRow>()
  ).results;
  if (rows.length !== 2) return null;
  const [dev, prod] = rows;
  if (!dev || !prod || dev.name !== "dev" || prod.name !== "prod")
    lifecycleConflict("Project data assignments conflict");
  const assignment = (r: CurrentRow) => ({
    environmentId: parseUlid(r.environment_id),
    environment: r.name,
    dataEnvironmentId: parseUlid(r.data_environment_id),
    assignmentVersion: integer(r.assignment_version, 1),
    assignedAt: publicTimestamp(r.assigned_at),
  });
  return Object.freeze({ dataMode: dev.data_mode, dev: assignment(dev), prod: assignment(prod) });
}
/** PG jsonb equality ignores object order and numeric spelling; array paths remain significant. */
function equivalentJson(left: string, right: string): string {
  const rows = (value: string) =>
    `SELECT fullkey,CASE WHEN type IN('integer','real') THEN 'number' ELSE type END,atom FROM json_tree(${value})`;
  return `NOT EXISTS(${rows(left)} EXCEPT ${rows(right)}) AND NOT EXISTS(${rows(right)} EXCEPT ${rows(left)})`;
}
function assignmentGuards(
  db: D1Database,
  input: LifecycleScope,
  expected: ProjectDataAssignments,
  dates: boolean,
): D1PreparedStatement[] {
  const args = [input.organizationId, input.projectId];
  return [
    guard(db, "precondition_changed", `(SELECT COUNT(*) FROM(${CURRENT}))<>2`, args),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND data_mode=?3)",
      [...args, expected.dataMode],
    ),
    ...(["dev", "prod"] as const).map((name) => {
      const a = expected[name];
      return guard(
        db,
        "precondition_changed",
        `NOT EXISTS(SELECT 1 FROM(${CURRENT}) a WHERE a.environment_id=?3 AND a.name=?4 AND a.data_environment_id=?5 AND CAST(a.assignment_version AS INTEGER)=CAST(?6 AS INTEGER)${dates ? " AND substr(a.assigned_at,1,23)||'Z'=?7" : ""})`,
        [
          ...args,
          a.environmentId,
          name,
          a.dataEnvironmentId,
          a.assignmentVersion,
          ...(dates ? [a.assignedAt] : []),
        ],
      );
    }),
  ];
}
export const DATA_TARGET_READY = `EXISTS(SELECT 1 FROM database_provider_target_heads h JOIN database_provider_target_revisions t USING(organization_id,project_id,physical_environment_id,target_version) JOIN projects p ON p.organization_id=h.organization_id AND p.project_id=h.project_id AND p.owner_state='active' WHERE h.organization_id=?1 AND h.project_id=?2 AND h.physical_environment_id=?3 AND h.state='active' AND((t.provider='neon' AND EXISTS(SELECT 1 FROM neon_project_placement_receipts placement WHERE placement.organization_id=h.organization_id AND placement.project_id=h.project_id AND placement.environment_id=h.physical_environment_id AND placement.provider_project_id=t.provider_project_id AND placement.default_branch_id=t.branch_id AND placement.state='ready')) OR(t.provider='pgcf' AND EXISTS(SELECT 1 FROM project_database_registration_receipts r WHERE r.organization_id=h.organization_id AND r.project_id=h.project_id AND r.physical_environment_id=h.physical_environment_id AND r.status='active' AND json_extract(r.metadata,'$.provider')='pgcf' AND json_extract(r.metadata,'$.providerProjectId')=t.provider_project_id AND json_extract(r.metadata,'$.databaseId')=t.database_id AND NOT EXISTS(SELECT 1 FROM project_database_registration_receipts newer WHERE newer.organization_id=h.organization_id AND newer.project_id=h.project_id AND newer.physical_environment_id=h.physical_environment_id AND newer.registration_version>r.registration_version) AND NOT EXISTS(SELECT 1 FROM project_database_registration_reservations pending WHERE pending.organization_id=h.organization_id AND pending.project_id=h.project_id AND pending.physical_environment_id=h.physical_environment_id AND pending.registration_version>r.registration_version)))))`;
export interface DataChangeAcceptanceInput extends LifecycleScope {
  readonly environmentId: string;
  readonly operationId: string;
  readonly expectedProjectVersion: number;
  readonly snapshot: ProjectDataChangeSnapshot;
}
/** Native verifyProjectDataChangeAcceptance as final guards inside the parent acceptance transaction. */
export function dataChangeAcceptanceStatements(
  db: D1Database,
  input: DataChangeAcceptanceInput,
): D1PreparedStatement[] {
  const snapshot = parseProjectDataChangeSnapshot(input.snapshot);
  if (input.environmentId !== snapshot.transition.before.dev.environmentId) lifecycleConflict();
  integer(input.expectedProjectVersion, 1);
  const statements = [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND p.lifecycle_version=?3 AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.organization_id=?1 AND o.project_id=?2 AND o.operation_id<>?4 AND o.state IN('queued','running')) AND NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims c WHERE c.organization_id=?1 AND c.project_id=?2))`,
      [input.organizationId, input.projectId, input.expectedProjectVersion, input.operationId],
    ),
    ...assignmentGuards(db, input, snapshot.transition.before, true),
    guard(
      db,
      "precondition_changed",
      "(SELECT COUNT(*) FROM environments WHERE organization_id=?1 AND project_id=?2 AND name IN('dev','prod'))<>2",
      [input.organizationId, input.projectId],
    ),
  ];
  for (const head of snapshot.environmentHeads)
    statements.push(
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND head_version=?4)",
        [input.organizationId, input.projectId, head.environmentId, head.expectedHeadVersion],
      ),
    );
  for (const generation of snapshot.registrationGenerations)
    statements.push(
      guard(
        db,
        "precondition_changed",
        `COALESCE((SELECT MAX(registration_version) FROM(SELECT registration_version FROM project_database_registration_receipts WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 UNION ALL SELECT registration_version FROM project_database_registration_reservations WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3)),0)<>?4`,
        [
          input.organizationId,
          input.projectId,
          generation.dataEnvironmentId,
          generation.registrationVersion,
        ],
      ),
    );
  if (snapshot.transition.change === "share_prod_keeps_data")
    statements.push(
      guard(db, "precondition_changed", `NOT(${DATA_TARGET_READY})`, [
        input.organizationId,
        input.projectId,
        snapshot.transition.before.prod.dataEnvironmentId,
      ]),
    );
  return statements;
}
const DATA_TARGETS = `SELECT DISTINCT provider,resource_kind,locator FROM(SELECT 'cloudflare' provider,'wfp-script' resource_kind,c.dispatch_namespace||'/'||c.immutable_script_name locator FROM wfp_candidate_receipts c WHERE c.organization_id=?1 AND c.project_id=?2 AND c.environment_id=?3 AND ?4=1 AND(EXISTS(SELECT 1 FROM wfp_publish_receipts p WHERE p.candidate_receipt_id=c.candidate_receipt_id) OR NOT EXISTS(SELECT 1 FROM wfp_candidate_cleanup_receipts d WHERE d.candidate_receipt_id=c.candidate_receipt_id)) UNION SELECT t.provider,CASE WHEN t.provider='neon' THEN 'project' ELSE 'database' END,CASE WHEN t.provider='neon' THEN t.provider_project_id ELSE t.database_id END FROM database_provider_target_heads h JOIN database_provider_target_revisions t USING(organization_id,project_id,physical_environment_id,target_version) WHERE h.organization_id=?1 AND h.project_id=?2 AND h.physical_environment_id IN(SELECT value FROM json_each(?5)) AND h.state='active')`;
export interface DataChangeInventoryInput extends LifecycleScope {
  readonly operationId: string;
  readonly snapshot: ProjectDataChangeSnapshot;
  readonly now: string;
}
export interface DataChangeInventoryPlan {
  readonly input: DataChangeInventoryInput;
  readonly targets: readonly InventoryTarget[];
  readonly records: readonly LifecycleInventoryRecord[];
}
const targetParams = (input: DataChangeInventoryInput) => [
  input.organizationId,
  input.projectId,
  input.snapshot.transition.before.dev.environmentId,
  input.snapshot.transition.removeDevDeployment ? 1 : 0,
  JSON.stringify(input.snapshot.transition.retiredDataEnvironmentIds),
];
/** Original data-change hashedUlid has NO delete mask and hashes operation+'/'+digestHex. */
export function dataChangeInventoryRecord(
  operationId: string,
  target: InventoryTarget,
): LifecycleInventoryRecord {
  const hash = inventoryDigest(target.provider, target.resource_kind, target.locator),
    id = createHash("sha256")
      .update(`${operationId}/${Buffer.from(hash).toString("hex")}`)
      .digest()
      .subarray(0, 16);
  return {
    resourceRecordId: lifecycleEncodedUlid(id),
    provider: target.provider,
    resourceKind: target.resource_kind,
    externalRefHash: hash,
    cleanupLocator: `encoded/${Buffer.from(target.locator).toString("base64url")}`,
  };
}
export async function readDataChangeInventoryPlan(
  db: D1Database,
  input: DataChangeInventoryInput,
): Promise<DataChangeInventoryPlan> {
  const snapshot = parseProjectDataChangeSnapshot(input.snapshot);
  lifecycleTime.parse(input.now);
  for (const id of [input.organizationId, input.projectId, input.operationId]) parseUlid(id);
  const fixed = { ...input, snapshot },
    targets = (
      await db
        .prepare(DATA_TARGETS)
        .bind(...targetParams(fixed))
        .all<InventoryTarget>()
    ).results;
  if (
    targets.some(
      (t) =>
        typeof t.provider !== "string" ||
        typeof t.resource_kind !== "string" ||
        typeof t.locator !== "string",
    )
  )
    lifecycleConflict("Data change inventory target unavailable");
  return Object.freeze({
    input: Object.freeze(fixed),
    targets: Object.freeze(targets.map((t) => Object.freeze({ ...t }))),
    records: Object.freeze(targets.map((t) => dataChangeInventoryRecord(input.operationId, t))),
  });
}
/** Compose after the parent's original intent acceptance; target guards run before all inventory inserts. */
export function dataChangeInventoryStatements(
  db: D1Database,
  plan: DataChangeInventoryPlan,
): D1PreparedStatement[] {
  const i = plan.input;
  return [
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM product_command_intents i WHERE i.organization_id=?1 AND i.project_id=?2 AND i.operation_id=?3 AND i.event_type='ProjectDataChangeRequestedV1' AND i.data_change=?4 AND ${equivalentJson("i.data_change_snapshot", "?5")})`,
      [
        i.organizationId,
        i.projectId,
        i.operationId,
        i.snapshot.transition.change,
        generatedJsonb(i.snapshot),
      ],
    ),
    ...inventoryTargetGuards(db, DATA_TARGETS, targetParams(i), plan.targets),
    ...inventoryInsertStatements(
      db,
      {
        organizationId: i.organizationId,
        projectId: i.projectId,
        operationId: i.operationId,
        recordedAt: i.now,
      },
      plan.records,
    ),
  ];
}

interface PersistenceInput extends LifecycleScope {
  operationId: string;
  claimId: string;
  snapshot: ProjectDataChangeSnapshot;
  now: string;
}
const persistenceInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  claimId: ulid,
  snapshot: z.unknown(),
  now: lifecycleTime,
});
const AUTH = `SELECT c.cleanup_run_id,c.state,i.billing_epoch_id FROM product_provider_mutation_claims claim JOIN projects p ON p.organization_id=claim.organization_id AND p.project_id=claim.project_id JOIN operations o ON o.organization_id=claim.organization_id AND o.project_id=claim.project_id AND o.operation_id=claim.operation_id JOIN product_command_intents i ON i.organization_id=claim.organization_id AND i.project_id=claim.project_id AND i.operation_id=claim.operation_id JOIN cleanup_runs c ON c.organization_id=i.organization_id AND c.project_id=i.project_id AND c.operation_id=i.operation_id AND c.cleanup_run_id=i.cleanup_run_id WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.operation_id=?3 AND claim.claim_id=?4 AND claim.event_type='ProjectDataChangeRequestedV1' AND i.event_type=claim.event_type AND i.environment_id=claim.environment_id AND ${equivalentJson("i.data_change_snapshot", "?5")} AND i.data_change=?6 AND o.state IN('queued','running') AND p.owner_state='active' AND p.lifecycle_state='active' AND p.lifecycle_version=claim.accepted_lifecycle_version AND claim.billing_epoch_id=i.billing_epoch_id AND o.billing_epoch_id=i.billing_epoch_id AND p.active_billing_epoch_id=i.billing_epoch_id AND c.state IN('pending','running','reconciliation_required')`;
type Authority = { cleanup_run_id: string; state: string; billing_epoch_id: string };
const authParams = (i: PersistenceInput) => [
  i.organizationId,
  i.projectId,
  i.operationId,
  i.claimId,
  generatedJsonb(i.snapshot),
  i.snapshot.transition.change,
];
function authorityGuard(db: D1Database, i: PersistenceInput, a: Authority) {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(${AUTH} AND c.cleanup_run_id=?7 AND c.state=?8 AND i.billing_epoch_id=?9)`,
    [...authParams(i), a.cleanup_run_id, a.state, a.billing_epoch_id],
  );
}
function parsePersistence(raw: unknown): PersistenceInput {
  const input = persistenceInput.parse(raw);
  return { ...input, snapshot: parseProjectDataChangeSnapshot(input.snapshot) };
}
function unknown(name: string): never {
  throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
}
export async function startLifecycleDataChange(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = parsePersistence(raw),
    { db } = await routeOrganization(context, input.organizationId),
    name = "workflow.startDataChange";
  return runCommand<Authority | null, "created" | "existing">(db, {
    name,
    input,
    lookup: async () => unknown(name),
    retryOn: ["precondition_changed"],
    read: (r) =>
      r
        .prepare(AUTH)
        .bind(...authParams(input))
        .first<Authority>(),
    decide: (a) => {
      if (!a) lifecycleConflict();
      if (a.state !== "pending") return { replay: "existing" };
      return {
        statements: [
          authorityGuard(db, input, a),
          db
            .prepare(
              "UPDATE cleanup_runs SET state='running',revision=revision+1,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='pending'",
            )
            .bind(input.organizationId, input.projectId, input.operationId, input.now),
        ],
        result: () => "created",
      };
    },
  });
}
/** Assignment append, mode switch and the original single audit share this ONE actual worker command. */
export async function switchLifecycleDataAssignments(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = parsePersistence(raw),
    { db } = await routeOrganization(context, input.organizationId),
    name = "workflow.switchDataAssignments",
    transition = input.snapshot.transition,
    changed = transition.redeployEnvironments[0] as "dev" | "prod",
    target = transition.after[changed],
    auditId = lifecycleEncodedUlid(
      createHash("sha256").update(`${input.operationId}:data-changed`).digest().subarray(0, 16),
    ),
    payload = generatedJsonb({
      change: transition.change,
      from: transition.before,
      to: transition.after,
    });
  return runCommand<
    {
      authority: Authority | null;
      current: ProjectDataAssignments | null;
      assignment: boolean;
      audit: boolean;
    },
    "created" | "existing"
  >(db, {
    name,
    input,
    lookup: async () => unknown(name),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["environment_data_assignments", "project_data_environments", "audit_events"],
    read: async (r) => {
      const authority = await r
          .prepare(AUTH)
          .bind(...authParams(input))
          .first<Authority>(),
        current = await readCurrentDataAssignments(r, input),
        result = await r.batch([
          r
            .prepare(
              "SELECT 1 FROM environment_data_assignments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND assignment_version=?4 AND operation_id=?5",
            )
            .bind(
              input.organizationId,
              input.projectId,
              target.environmentId,
              target.assignmentVersion,
              input.operationId,
            ),
          r
            .prepare(
              `SELECT 1 FROM audit_events WHERE organization_id=?1 AND audit_event_id=?2 AND project_id=?3 AND operation_id=?4 AND event_type='ProjectDataChanged' AND actor_type='system' AND actor_id='deployment-workflow' AND ${equivalentJson("payload", "?5")} AND billing_epoch_id=?6`,
            )
            .bind(
              input.organizationId,
              auditId,
              input.projectId,
              input.operationId,
              payload,
              authority?.billing_epoch_id ?? null,
            ),
        ]);
      return {
        authority,
        current,
        assignment: !!result[0]?.results.length,
        audit: !!result[1]?.results.length,
      };
    },
    decide: (s) => {
      if (!s.authority || !s.current) lifecycleConflict();
      if (
        s.current[changed].assignmentVersion === target.assignmentVersion &&
        s.current[changed].dataEnvironmentId === target.dataEnvironmentId
      ) {
        if (!s.assignment || !s.audit) lifecycleConflict("Data assignment replay or audit changed");
        return { replay: "existing" };
      }
      if (
        s.current.dataMode !== transition.before.dataMode ||
        (["dev", "prod"] as const).some(
          (name) =>
            s.current?.[name].assignmentVersion !== transition.before[name].assignmentVersion ||
            s.current?.[name].dataEnvironmentId !== transition.before[name].dataEnvironmentId,
        )
      )
        lifecycleConflict("Project data assignments changed");
      const statements = [
        authorityGuard(db, input, s.authority),
        ...assignmentGuards(db, input, s.current, false),
      ];
      if (transition.change !== "share_prod_keeps_data")
        statements.push(
          db
            .prepare(
              "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at)VALUES(?,?,?,?)",
            )
            .bind(input.organizationId, input.projectId, target.dataEnvironmentId, input.now),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at,operation_id)VALUES(?,?,?,?,?,?,?)",
          )
          .bind(
            input.organizationId,
            input.projectId,
            target.environmentId,
            target.dataEnvironmentId,
            target.assignmentVersion,
            input.now,
            input.operationId,
          ),
        db
          .prepare("UPDATE projects SET data_mode=?3 WHERE organization_id=?1 AND project_id=?2")
          .bind(input.organizationId, input.projectId, transition.after.dataMode),
        db
          .prepare(
            "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id)VALUES(?,?,?,?,'ProjectDataChanged','system','deployment-workflow',?,?,?)",
          )
          .bind(
            input.organizationId,
            auditId,
            input.projectId,
            input.operationId,
            payload,
            input.now,
            s.authority.billing_epoch_id,
          ),
      );
      return { statements, result: () => "created" };
    },
  });
}
