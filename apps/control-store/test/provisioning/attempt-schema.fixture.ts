import { Buffer } from "node:buffer";
import type { TestPostgres } from "../../../control-api/test/postgres.js";
import { newUlid } from "../../src/catalog/common.js";
import type { D1Database } from "../../src/d1-types.js";
import type { TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";

export const ATTEMPT_TABLES = [
  "product_provider_mutation_observations",
  "product_provider_reconciliation_attempts",
  "product_workflow_replay_attempts",
  "product_workflow_replay_failures",
] as const;
export type AttemptTable = (typeof ATTEMPT_TABLES)[number];
export type AttemptRow = Record<string, string | number | Uint8Array | null>;
export const AT = "2026-10-28T12:00:00.123456Z";
export const hash = (n = 3) => new Uint8Array(32).fill(n);

export async function attemptColumns(pg: TestPostgres, table: string) {
  return (
    await pg.pool.query<{ column_name: string; data_type: string }>(
      "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
      [table],
    )
  ).rows;
}

const PROJECT_CREATED_AT = "2026-09-01T00:00:00.000Z",
  MAPPING_TIME = "2026-09-10T10:00:00.000Z";
const connectNative = (pg: TestPostgres) => pg.pool.connect();
type NativeClient = Awaited<ReturnType<typeof connectNative>>;
/** Plain SQL for the PostgreSQL schema comparison: the organization mapping, project, epoch, ownership and environments the attempt rows reference. */
async function seedNativeScope(
  client: NativeClient,
  w: {
    organizationId: string;
    workosOrganizationId: string;
    projectId: string;
    createdEventId: string;
    epochId: string;
    devEnvironmentId: string;
    prodEnvironmentId: string;
    handle: string;
  },
) {
  await client.query(
    `INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at)
    VALUES($1,$2,'active',1,decode(repeat('aa',32),'hex'),$3,$3,$3)`,
    [w.organizationId, w.workosOrganizationId, MAPPING_TIME],
  );
  await client.query(
    `INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at)
    VALUES($1,$2,'Billing scale',$3,'human-id-4.2.0-sha256-project-handle-words-v1',0,$4,$5)`,
    [w.projectId, w.organizationId, w.handle, w.createdEventId, PROJECT_CREATED_AT],
  );
  await client.query(
    `INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
    VALUES($1,$2,$3,$4,'user:billing-scale-test')`,
    [w.epochId, w.projectId, w.organizationId, PROJECT_CREATED_AT],
  );
  await client.query(
    `INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
    VALUES($1,$2,'active',1,$3,$4)`,
    [w.projectId, w.organizationId, w.epochId, PROJECT_CREATED_AT],
  );
  await client.query(
    `INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at)
    VALUES($1,$2,$3,'dev','{}',$5,$5),($1,$2,$4,'prod','{}',$5,$5)`,
    [w.organizationId, w.projectId, w.devEnvironmentId, w.prodEnvironmentId, PROJECT_CREATED_AT],
  );
}

/** Actual accepted parent graph in both native engines; no constraints or temporal triggers are disabled. */
export async function seedAttemptGraph(control: TestControl, pg: TestPostgres) {
  const p = await seedProject(control),
    db = control.core,
    operationId = newUlid(),
    eventId = newUlid(),
    claimId = newUlid(),
    workflowId = `logical-attempt-${eventId}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'running',?,?)",
      )
      .bind(p.organizationId, p.projectId, operationId, p.billingEpochId, AT, AT),
    db
      .prepare(
        "INSERT INTO outbox_events(organization_id,project_id,operation_id,billing_epoch_id,event_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts) VALUES(?,?,?,?,?,'ProjectHandleChangeRequestedV1','{}',?,?,?,3)",
      )
      .bind(p.organizationId, p.projectId, operationId, p.billingEpochId, eventId, AT, AT, AT),
    db
      .prepare(
        "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,expected_etag,requested_handle,created_at) VALUES(?,?,?,?,?,'ProjectHandleChangeRequestedV1','captured-etag','gentle-panda-change',?)",
      )
      .bind(p.organizationId, p.projectId, p.devEnvironmentId, operationId, p.billingEpochId, AT),
    db
      .prepare(
        "INSERT INTO product_workflow_runs(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,workflow_id,event_id,state,created_at,updated_at,intermediate_evidence,evidence_archive_key) VALUES(?,?,?,?,?,'ProjectHandleChangeRequestedV1',?,?,'queued',?,?,'{ \"raw\" : [1,1,null] }','retained-archive')",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        operationId,
        p.billingEpochId,
        workflowId,
        eventId,
        AT,
        AT,
      ),
    db
      .prepare(
        "INSERT INTO product_provider_mutation_claims(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,logical_workflow_id,event_id,claim_id,accepted_lifecycle_version,claimed_at) VALUES(?,?,?,?,?,'ProjectHandleChangeRequestedV1',?,?,?,2147483647,?)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        operationId,
        p.billingEpochId,
        workflowId,
        eventId,
        claimId,
        AT,
      ),
  ]);
  const project = await db
    .prepare(
      "SELECT created_event_id,workos_organization_id FROM projects JOIN organizations USING(organization_id) WHERE project_id=?",
    )
    .bind(p.projectId)
    .first<{ created_event_id: string; workos_organization_id: string }>();
  if (project === null) throw new Error("Missing actual native graph identity");
  const client = await connectNative(pg);
  try {
    await client.query("BEGIN");
    await seedNativeScope(client, {
      organizationId: p.organizationId,
      workosOrganizationId: project.workos_organization_id,
      projectId: p.projectId,
      createdEventId: project.created_event_id,
      epochId: p.billingEpochId,
      devEnvironmentId: p.devEnvironmentId,
      prodEnvironmentId: p.prodEnvironmentId,
      handle: p.handle,
    });
    for (const table of [
      "operations",
      "outbox_events",
      "product_command_intents",
      "product_workflow_runs",
      "product_provider_mutation_claims",
    ]) {
      const columns = (
        await client.query<{ column_name: string; data_type: string }>(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows;
      const rows = (
        await db
          .prepare(`SELECT * FROM ${table} WHERE organization_id=? AND project_id=?`)
          .bind(p.organizationId, p.projectId)
          .all()
      ).results;
      for (const row of rows) {
        const shared = columns.filter((column) => Object.hasOwn(row, column.column_name));
        await client.query(
          `INSERT INTO ${table}(${shared.map((column) => column.column_name).join(",")}) VALUES(${shared.map((_, index) => `$${index + 1}`).join(",")})`,
          shared.map((column) => {
            const value = row[column.column_name];
            return value !== null && column.data_type === "bytea"
              ? Buffer.from(value as Uint8Array)
              : value;
          }),
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { control, pg, db, p, operationId, eventId, claimId, workflowId };
}
export type AttemptGraph = Awaited<ReturnType<typeof seedAttemptGraph>>;

export function observation(r: AttemptGraph, attempt = 0): AttemptRow {
  return {
    observation_id: newUlid(),
    claim_id: r.claimId,
    organization_id: r.p.organizationId,
    project_id: r.p.projectId,
    environment_id: r.p.devEnvironmentId,
    operation_id: r.operationId,
    event_id: r.eventId,
    billing_epoch_id: r.p.billingEpochId,
    logical_workflow_id: r.workflowId,
    event_type: "ProjectHandleChangeRequestedV1",
    accepted_lifecycle_version: 2147483647,
    observation_kind: "uncertainty",
    attempt_number: attempt,
    evidence_sha256: hash(),
    hint_phase: "database",
    expected_artifact_sha256: null,
    hint_provider_tag: "opaque provider tag " + "é".repeat(300),
    hint_product_deployment_id: null,
    source_state: "unknown",
    build_state: "cleanup_failable",
    gateway_state: "unknown",
    gateway_provider_tag: null,
    gateway_observed_at: null,
    wfp_state: "unknown",
    wfp_provider_tag: null,
    wfp_product_deployment_id: null,
    wfp_artifact_sha256: hash(7),
    wfp_observed_at: AT,
    actor_id: "é".repeat(255),
    created_at: AT,
  };
}
export function reconciliation(r: AttemptGraph, original: AttemptRow): AttemptRow {
  return {
    attempt_id: newUlid(),
    observation_id: original["observation_id"] ?? null,
    claim_id: r.claimId,
    organization_id: r.p.organizationId,
    project_id: r.p.projectId,
    environment_id: r.p.devEnvironmentId,
    operation_id: r.operationId,
    event_id: r.eventId,
    billing_epoch_id: r.p.billingEpochId,
    logical_workflow_id: r.workflowId,
    event_type: "ProjectHandleChangeRequestedV1",
    accepted_lifecycle_version: 2147483647,
    physical_workflow_id: `physical-reconcile-${newUlid()}`,
    mode: "retry",
    outcome: "prepared",
    idempotency_sha256: hash(8),
    attempt_number: 32,
    actor_id: "actor:attempt",
    created_at: AT,
  };
}
export function replay(r: AttemptGraph): AttemptRow {
  return {
    attempt_id: newUlid(),
    organization_id: r.p.organizationId,
    project_id: r.p.projectId,
    environment_id: r.p.devEnvironmentId,
    operation_id: r.operationId,
    event_id: r.eventId,
    billing_epoch_id: r.p.billingEpochId,
    logical_workflow_id: r.workflowId,
    physical_workflow_id: `physical-replay-${newUlid()}`,
    event_type: "ProjectHandleChangeRequestedV1",
    idempotency_sha256: hash(9),
    attempt_number: 32,
    actor_id: "actor:attempt",
    created_at: AT,
  };
}
export function failure(r: AttemptGraph, original: AttemptRow): AttemptRow {
  return {
    failure_id: newUlid(),
    attempt_id: original["attempt_id"] ?? null,
    organization_id: r.p.organizationId,
    operation_id: r.operationId,
    physical_workflow_id: original["physical_workflow_id"] ?? null,
    terminal_status: "errored",
    evidence_sha256: hash(10),
    actor_id: original["actor_id"] ?? null,
    created_at: AT,
  };
}

export async function insertAttemptCore(db: D1Database, table: AttemptTable, row: AttemptRow) {
  const keys = Object.keys(row);
  await db
    .prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
    .bind(...keys.map((key) => row[key]))
    .run();
}
export async function insertAttemptNative(pg: TestPostgres, table: AttemptTable, row: AttemptRow) {
  const keys = Object.keys(row);
  await pg.pool.query(
    `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, index) => `$${index + 1}`).join(",")})`,
    keys.map((key) =>
      row[key] instanceof Uint8Array ? Buffer.from(row[key] as Uint8Array) : row[key],
    ),
  );
}
export async function insertAttemptBoth(r: AttemptGraph, table: AttemptTable, row: AttemptRow) {
  await insertAttemptNative(r.pg, table, row);
  await insertAttemptCore(r.db, table, row);
}
export async function attemptFacts(
  r: Pick<AttemptGraph, "pg" | "db">,
  table: AttemptTable,
  organizationId?: string,
) {
  const columns = await attemptColumns(r.pg, table),
    primary = table.endsWith("observations")
      ? "observation_id"
      : table.endsWith("failures")
        ? "failure_id"
        : "attempt_id";
  const native = (
    await r.pg.pool.query(
      `SELECT ${columns.map((column) => (column.data_type === "bytea" ? `encode(${column.column_name},'hex') AS ${column.column_name}` : column.data_type.startsWith("timestamp") ? `to_char(${column.column_name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column.column_name}` : `${column.column_name}::text`)).join(",")} FROM ${table}${organizationId === undefined ? "" : " WHERE organization_id=$1"} ORDER BY ${primary}`,
      organizationId === undefined ? [] : [organizationId],
    )
  ).rows;
  const core = (
    await r.db
      .prepare(
        `SELECT ${columns.map((column) => (column.data_type === "bytea" ? `CASE WHEN ${column.column_name} IS NULL THEN NULL ELSE lower(hex(${column.column_name})) END AS ${column.column_name}` : column.data_type === "integer" ? `CAST(${column.column_name} AS TEXT) AS ${column.column_name}` : column.column_name)).join(",")} FROM ${table}${organizationId === undefined ? "" : " WHERE organization_id=?"} ORDER BY ${primary}`,
      )
      .bind(...(organizationId === undefined ? [] : [organizationId]))
      .all()
  ).results;
  return { native, core };
}
