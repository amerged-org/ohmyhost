import { z } from "zod";
import { routeOrganization, ulid, publicTimestamp, type CatalogContext } from "../common.js";
import { readContextSnapshot } from "../provisioning/context-queries.js";
import { integer, text } from "../provisioning/context-values.js";
import { acceptedOperationOf } from "./accepted-operation.js";
import {
  API_PRODUCT_DEPLOYMENT_SQL,
  apiDeploymentOf,
  apiOperationReconciliationOf,
} from "./reads.js";
const input = z.strictObject({ organizationId: ulid, operationId: ulid });
const OP = "SELECT * FROM operations WHERE organization_id=?1 AND operation_id=?2";
const EVENTS = `SELECT event.* FROM operation_events event JOIN operations operation ON operation.organization_id=event.organization_id AND operation.operation_id=event.operation_id AND operation.project_id=event.project_id
 WHERE operation.organization_id=?1 AND operation.operation_id=?2 ORDER BY event.revision`;
const DEPLOYMENT_ID = `SELECT deployment.deployment_id FROM deployments deployment JOIN projects ownership ON ownership.organization_id=deployment.organization_id AND ownership.project_id=deployment.project_id AND ownership.owner_state='active'
 JOIN operations operation ON operation.organization_id=deployment.organization_id AND operation.project_id=deployment.project_id AND operation.operation_id=deployment.operation_id
 WHERE operation.organization_id=?1 AND operation.operation_id=?2`;
const BLOCKING = `SELECT claim.operation_id FROM operations waiting JOIN product_provider_mutation_claims claim ON claim.organization_id=waiting.organization_id AND claim.project_id=waiting.project_id
 JOIN operations holder ON holder.organization_id=claim.organization_id AND holder.operation_id=claim.operation_id
 WHERE waiting.organization_id=?1 AND waiting.operation_id=?2 AND waiting.state='queued' AND holder.state IN('queued','running') AND claim.operation_id<>waiting.operation_id`;
const RECONCILIATION = `SELECT run.state,COALESCE(run.active_reconciliation_attempt_id,run.active_replay_attempt_id) attempt_id,run.updated_at
 FROM product_workflow_runs run JOIN operations operation ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id
 JOIN projects ownership ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id AND ownership.owner_state<>'transferred'
 WHERE run.organization_id=?1 AND run.operation_id=?2 AND operation.state IN('queued','running')
 AND(run.state='reconciliation_required' OR(run.state='queued' AND COALESCE(run.active_reconciliation_attempt_id,run.active_replay_attempt_id) IS NOT NULL))`;
const PROJECT_ID =
  "(SELECT project_id FROM operations WHERE organization_id=?1 AND operation_id=?2)";
const DEPLOYMENT = `${API_PRODUCT_DEPLOYMENT_SQL.replaceAll("?2", PROJECT_ID)} AND deployment.operation_id=?2
 AND EXISTS(SELECT 1 FROM operations open WHERE open.organization_id=?1 AND open.operation_id=?2 AND open.state IN('queued','running'))`;
/** Full original getOperation persistence: history, every-state deployment ID and open-state observations share ONE snapshot. */
export async function readApiProductOperation(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    parameters = [i.organizationId, i.operationId];
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await readContextSnapshot(
      db,
      [OP, EVENTS, DEPLOYMENT_ID, BLOCKING, RECONCILIATION, DEPLOYMENT].map((sql) => ({
        sql,
        parameters,
      })),
    );
    if (rows === null) continue;
    const row = rows[0]?.[0],
      events = rows[1] ?? [];
    if (row === undefined || events.length === 0) return null;
    if (
      (rows[0]?.length ?? 0) > 1 ||
      (rows[2]?.length ?? 0) > 1 ||
      (rows[3]?.length ?? 0) > 1 ||
      (rows[4]?.length ?? 0) > 1 ||
      (rows[5]?.length ?? 0) > 1
    )
      throw new TypeError("Operation persistence projection is ambiguous");
    const accepted = acceptedOperationOf(row, events),
      open = accepted.state === "queued" || accepted.state === "running",
      failure =
        row["failure"] === null
          ? null
          : (JSON.parse(text(row, "failure")) as Record<string, unknown>),
      deployment = open && rows[5]?.[0] !== undefined ? apiDeploymentOf(rows[5][0]) : null;
    return {
      operation: {
        organizationId: i.organizationId,
        operationId: accepted.operationId,
        projectId: text(row, "project_id"),
        state: accepted.state,
        failure:
          failure === null
            ? null
            : { code: String(failure["code"]), message: String(failure["message"]) },
        createdAt: accepted.createdAt,
        updatedAt: accepted.updatedAt,
        events: events.map((e) => ({
          eventId: text(e, "event_id"),
          operationId: text(e, "operation_id"),
          projectId: text(e, "project_id"),
          revision: integer(e["revision"]),
          type: text(e, "event_type"),
          idempotencyKey: e["idempotency_key"] === null ? null : text(e, "idempotency_key"),
          payload: JSON.parse(text(e, "payload")) as Record<string, unknown>,
          occurredAt: publicTimestamp(text(e, "occurred_at")),
        })),
      },
      failureDiagnostic: accepted.failureDiagnostic,
      deploymentId: rows[2]?.[0] === undefined ? null : text(rows[2][0], "deployment_id"),
      blockingOperationId:
        open && rows[3]?.[0] !== undefined ? text(rows[3][0], "operation_id") : null,
      reconciliation: open ? apiOperationReconciliationOf(rows[4]?.[0]) : null,
      deploymentObservation:
        deployment === null
          ? null
          : {
              ...(deployment.buildCompletedAt === undefined
                ? {}
                : { buildCompletedAt: deployment.buildCompletedAt }),
              projectId: deployment.projectId,
              deploymentId: deployment.deploymentId,
              phase:
                accepted.state === "queued"
                  ? ("queued" as const)
                  : deployment.buildCompletedAt !== undefined || deployment.kind !== "deploy"
                    ? ("publishing" as const)
                    : ("building" as const),
              mailRequired: deployment.mailRequired === true,
            },
    };
  }
  throw new Error("Operation persistence snapshot changed repeatedly");
}
