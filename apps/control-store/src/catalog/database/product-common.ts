import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { CommandConflictError } from "../../run-command.js";
import { guard } from "../../guards.js";
import { OrganizationCreditError, type CreditErrorCode } from "../billing/errors.js";
import { addMilliseconds, auditStatement, OPERATION_LEASE_MILLISECONDS } from "../common.js";
import type { RuntimeDecision, RuntimeDenial } from "../credit/index.js";
import { currentDataEnvironment } from "./authority.js";

/** Original161: an accepted queued/running data-change operation closes direct SQL admission. */
export const DATA_CHANGE_PENDING = `EXISTS(SELECT 1 FROM product_command_intents i JOIN operations op
 ON op.organization_id=i.organization_id AND op.project_id=i.project_id AND op.operation_id=i.operation_id
 WHERE i.organization_id=p.organization_id AND i.project_id=p.project_id AND i.event_type='ProjectDataChangeRequestedV1' AND op.state IN('queued','running'))`;

/** Current PGCF SQL target, including the latest native registration and logical authorization. */
export const SQL_TARGET = `SELECT e.environment_id,p.active_billing_epoch_id,p.lifecycle_version,p.ownership_version,p.data_mode,
 h.physical_environment_id,CAST(h.target_version AS TEXT) target_version,t.provider_project_id,t.database_id,t.size_class_id,
 json_extract(reg.metadata,'$.originHost') origin_host,
 json_array(e.environment_id,p.active_billing_epoch_id,p.lifecycle_version,p.ownership_version,h.physical_environment_id,CAST(h.target_version AS TEXT),t.provider_project_id,t.database_id,reg.metadata) signature
 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
 JOIN billing_epochs epoch ON epoch.organization_id=p.organization_id AND epoch.project_id=p.project_id AND epoch.billing_epoch_id=p.active_billing_epoch_id AND epoch.ended_at IS NULL
 JOIN database_provider_target_heads h ON h.organization_id=e.organization_id AND h.project_id=e.project_id AND h.physical_environment_id=${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")}
 JOIN database_provider_target_revisions t ON t.organization_id=h.organization_id AND t.project_id=h.project_id AND t.physical_environment_id=h.physical_environment_id AND t.target_version=h.target_version
 JOIN project_database_registration_receipts reg ON reg.organization_id=h.organization_id AND reg.project_id=h.project_id AND reg.physical_environment_id=h.physical_environment_id
 WHERE e.organization_id=?1 AND e.project_id=?2 AND e.name=?3 AND p.owner_state='active' AND p.lifecycle_state='active' AND NOT ${DATA_CHANGE_PENDING}
 AND h.state='active' AND h.activated_at IS NOT NULL AND t.provider='pgcf'
 AND reg.registration_version=(SELECT max(newer.registration_version) FROM project_database_registration_receipts newer WHERE newer.organization_id=reg.organization_id AND newer.project_id=reg.project_id AND newer.physical_environment_id=reg.physical_environment_id)
 AND reg.status='active' AND json_extract(reg.metadata,'$.provider')='pgcf'
 AND json_extract(reg.metadata,'$.databaseId')=t.database_id AND json_extract(reg.metadata,'$.providerProjectId')=t.provider_project_id
 AND EXISTS(SELECT 1 FROM json_each(reg.metadata,'$.authorizedEnvironmentIds') allowed WHERE allowed.value=e.environment_id)`;

export interface SqlTargetRow {
  environment_id: string;
  active_billing_epoch_id: string;
  lifecycle_version: number;
  ownership_version: number;
  data_mode: "shared" | "isolated";
  physical_environment_id: string;
  target_version: string;
  provider_project_id: string;
  database_id: string;
  size_class_id: string;
  origin_host: string;
  signature: string;
}
export const targetParams = (input: {
  organizationId: string;
  projectId: string;
  environment: "dev" | "prod";
}) => [input.organizationId, input.projectId, input.environment];
export function targetGuard(
  db: D1Database,
  input: { organizationId: string; projectId: string; environment: "dev" | "prod" },
  row: SqlTargetRow,
): D1PreparedStatement {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM(${SQL_TARGET}) current WHERE current.signature=?4)`,
    [...targetParams(input), row.signature],
  );
}
export class ProductDatabaseError extends CommandConflictError {
  constructor(code: string) {
    super(code, code);
  }
}

const REFUSALS: Record<RuntimeDenial, CreditErrorCode> = {
  project_unavailable: "organization_credit_scope_missing",
  insufficient_organization_credits: "insufficient_organization_credits",
  project_budget_exceeded: "project_budget_exceeded",
};

/**
 * The refusal of a serving decision (`readRuntimeDecision`) as the error of the product commands: credit exhausted past
 * its grace, a `stop` budget reached, or a scope that is no longer active. Null when the command is admitted. The
 * decision is read with the command's snapshot; the balance itself needs no fence, because it is only ever changed by
 * single atomic statements.
 */
export function admissionRefusal(decision: RuntimeDecision): OrganizationCreditError | null {
  return decision.reason === null ? null : new OrganizationCreditError(REFUSALS[decision.reason]);
}

/** Original operation transition, composed into the owning product transaction with its fixed actor and key. */
export function productTransition(
  db: D1Database,
  scope: { organizationId: string; projectId: string; operationId: string; billingEpochId: string },
  input: {
    action: "start" | "succeed" | "fail";
    eventCount: number;
    operationEventId: string;
    auditEventId: string;
    now: string;
    kind: "write" | "compute";
    principalId?: string;
    failureCode?: string;
  },
): D1PreparedStatement[] {
  const event =
    input.action === "start"
      ? "OperationStarted"
      : input.action === "succeed"
        ? "OperationSucceeded"
        : "OperationFailed";
  const state =
    input.action === "start" ? "running" : input.action === "succeed" ? "succeeded" : "failed";
  const failure =
    input.action === "fail"
      ? {
          code: input.failureCode,
          message:
            input.kind === "write"
              ? input.failureCode
              : publicOperationFailure(input.failureCode ?? "operation_failed").message,
        }
      : null;
  const key =
    input.kind === "write"
      ? `database-write-${input.action === "start" ? "start" : "complete"}`
      : `database-compute:${input.action}`;
  return [
    db
      .prepare(
        "UPDATE operations SET state=?4,failure=?5,updated_at=?6,lease_expires_at=?7 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state=?8",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.operationId,
        state,
        failure === null ? null : JSON.stringify(failure),
        input.now,
        input.action === "start" ? addMilliseconds(input.now, OPERATION_LEASE_MILLISECONDS) : null,
        input.action === "start" ? "queued" : "running",
      ),
    guard(db, "operation_conflict", "changes()<>1"),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
      )
      .bind(
        scope.organizationId,
        input.operationEventId,
        scope.operationId,
        scope.projectId,
        input.eventCount,
        event,
        key,
        JSON.stringify(failure === null ? {} : { failure }),
        input.now,
      ),
    auditStatement(db, scope.organizationId, {
      auditEventId: input.auditEventId,
      projectId: scope.projectId,
      operationId: scope.operationId,
      billingEpochId: scope.billingEpochId,
      eventType: event,
      actorType: input.principalId === undefined ? "service" : "principal",
      actorId:
        input.principalId ??
        (input.kind === "write" ? "database-write" : "database-compute-change"),
      payload: {},
      occurredAt: input.now,
    }),
  ];
}
