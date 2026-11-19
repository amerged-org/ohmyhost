import { newUlid } from "../../src/catalog/common.js";
import { Buffer } from "node:buffer";
import type { D1Database } from "../../src/d1-types.js";
import type { SeededProject } from "../support/platform-fixtures.js";

/** The project's data identities as native environment creation leaves them: one data environment per
 * environment, both environments assigned (version 1) to the dev environment's. */
export const CONTEXT_DATA_ASSIGNED_AT = "2026-09-01T00:00:00.000000Z";
export interface ContextFixture {
  readonly db: D1Database;
  readonly project: SeededProject;
}

/** Completes the prior builds' admitted intents and adds the data identities to the real gateway graph.
 * Every constraint and trigger of the Core stays enabled. */
export async function seedContextData(r: ContextFixture) {
  await completeContextIntents(r);
  const p = r.project;
  await r.db.batch([
    ...[p.devEnvironmentId, p.prodEnvironmentId].map((dataEnvironmentId) =>
      r.db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
        )
        .bind(p.organizationId, p.projectId, dataEnvironmentId, CONTEXT_DATA_ASSIGNED_AT),
    ),
    ...[p.devEnvironmentId, p.prodEnvironmentId].map((environmentId) =>
      r.db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,1,?5)",
        )
        .bind(
          p.organizationId,
          p.projectId,
          environmentId,
          p.devEnvironmentId,
          CONTEXT_DATA_ASSIGNED_AT,
        ),
    ),
  ]);
}
/** Writes one synthetic fact row; no reader is mocked and no constraint is disabled. */
export async function insertContext(
  r: ContextFixture,
  table: string,
  row: Record<string, unknown>,
) {
  const columns = Object.keys(row),
    parameters = columns.map((key) => {
      const value = row[key];
      return value instanceof Uint8Array
        ? Buffer.from(value)
        : value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : typeof value === "boolean"
            ? Number(value)
            : value;
    });
  await r.db
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    )
    .bind(...parameters)
    .run();
}
export async function updateContext(r: ContextFixture, sql: string, parameters: unknown[]) {
  await r.db
    .prepare(sql)
    .bind(...parameters.map((value) => (typeof value === "boolean" ? Number(value) : value)))
    .run();
}

/** Prior builds need their exact admitted intent to be valid rollback/promotion artifacts. */
async function completeContextIntents(r: ContextFixture) {
  const candidates = (
    await r.db
      .prepare(
        `SELECT deployment.operation_id,deployment.deployment_id,deployment.environment_id,deployment.created_at,plan.plan_id,plan.source_connection_id,plan.source_generation,operation.state FROM deployment_revisions revision JOIN deployments deployment ON deployment.organization_id=revision.organization_id AND deployment.project_id=revision.project_id AND deployment.deployment_id=revision.deployment_id JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id JOIN operations operation ON operation.organization_id=deployment.organization_id AND operation.project_id=deployment.project_id AND operation.operation_id=deployment.operation_id WHERE deployment.organization_id=?1 AND deployment.project_id=?2 AND NOT EXISTS(SELECT 1 FROM product_command_intents intent WHERE intent.organization_id=deployment.organization_id AND intent.project_id=deployment.project_id AND intent.operation_id=deployment.operation_id)`,
      )
      .bind(r.project.organizationId, r.project.projectId)
      .all()
  ).results;
  for (const row of candidates) {
    const event = newUlid(),
      workflow = newUlid(),
      at = String(row["created_at"]);
    await r.db.batch([
      r.db
        .prepare(
          "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,plan_id,source_connection_id,deployment_id,source_generation,created_at) VALUES(?1,?2,?3,?4,?5,'DeploymentRequestedV1',?6,?7,?8,?9,?10)",
        )
        .bind(
          r.project.organizationId,
          r.project.projectId,
          row["environment_id"],
          row["operation_id"],
          r.project.billingEpochId,
          row["plan_id"],
          row["source_connection_id"],
          row["deployment_id"],
          row["source_generation"],
          at,
        ),
      r.db
        .prepare(
          "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,billing_epoch_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts) VALUES(?1,?2,?3,?4,?5,'DeploymentRequestedV1','{}',?6,?6,?6,3)",
        )
        .bind(
          r.project.organizationId,
          event,
          r.project.projectId,
          row["operation_id"],
          r.project.billingEpochId,
          at,
        ),
      r.db
        .prepare(
          "INSERT INTO product_workflow_runs(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,workflow_id,event_id,state,terminal_evidence,created_at,updated_at,completed_at) VALUES(?1,?2,?3,?4,?5,'DeploymentRequestedV1',?6,?7,'completed','{}',?8,?8,?8)",
        )
        .bind(
          r.project.organizationId,
          r.project.projectId,
          row["environment_id"],
          row["operation_id"],
          r.project.billingEpochId,
          workflow,
          event,
          at,
        ),
    ]);
  }
}

/** Races a real D1 batch once; every SQL statement still executes on the real D1 database. */
export function beforeContextSnapshot(db: D1Database, hook: () => Promise<void>): D1Database {
  let pending = true;
  type Wrapped = ReturnType<D1Database["prepare"]> & {
    inner: ReturnType<D1Database["prepare"]>;
    sql: string;
  };
  const wrap = (inner: ReturnType<D1Database["prepare"]>, sql: string): Wrapped => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: () => inner.first(),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as Wrapped[];
      if (
        pending &&
        wrapped.some((value) => value.sql.startsWith("SELECT * FROM (")) &&
        wrapped.some((value) => value.sql.includes("FROM product_source_archive_objects"))
      ) {
        pending = false;
        await hook();
      }
      return db.batch(wrapped.map((value) => value.inner));
    },
  };
}
