import type { Ulid } from "@ohmyhost/platform";
// Exact original fixed SQL predicates; ownership projects are the qualified Core current-owner representation.
import { FINAL_DELIVERY_CODES } from "./queue-recovery-deployment-logic.js";
/** The closed final codes of a parked delivery, as SQL: the event and its last attempt carry the same one. */
const FINAL_CODES = FINAL_DELIVERY_CODES.map((code) => `'${code}'`).join(",");
/** The event types whose final Queue send may be handed off: every type a Workflow run can carry. */
const HANDOFF_TYPES =
  "'SourceLinkRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1','ProjectDeletionRequestedV1','ProjectDataChangeRequestedV1'";
/** The types that run in an active project without a cleanup run. */
const ACTIVE_TYPES =
  "'SourceLinkRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1'";
/** Each handoff type is handed off only in its own lifecycle: a deletion while deleting, a data change or deployment-type command while active. */
const HANDOFF_LIFECYCLE = `((run.event_type='ProjectDeletionRequestedV1' AND project.lifecycle_state='deleting') OR (run.event_type IN ('ProjectDataChangeRequestedV1',${ACTIVE_TYPES}) AND project.lifecycle_state='active'))`;
/** The cleanup a handoff requires: a deletion or data change has an open cleanup run, the other types have none. */
const HANDOFF_CLEANUP = `((run.event_type IN ('ProjectDeletionRequestedV1','ProjectDataChangeRequestedV1') AND cleanup.state IN ('pending','running','reconciliation_required')) OR (run.event_type IN (${ACTIVE_TYPES}) AND intent.cleanup_run_id IS NULL AND cleanup.cleanup_run_id IS NULL))`;
export const FIND = `SELECT run.project_id,run.environment_id,run.event_id,run.billing_epoch_id,
            run.workflow_id logical_workflow_id,run.event_type,intent.data_change,
            (event.acknowledged_at IS NULL) queue_handoff_pending
     FROM product_workflow_runs run
     INNER JOIN product_command_intents intent
       ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
      AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
      AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
     INNER JOIN operations operation
       ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id
      AND operation.operation_id=run.operation_id
     INNER JOIN outbox_events event
       ON event.event_id=run.event_id AND event.organization_id=run.organization_id
      AND event.project_id=run.project_id AND event.operation_id=run.operation_id
     INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
     INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
       ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
     LEFT JOIN cleanup_runs cleanup
       ON cleanup.organization_id=run.organization_id AND cleanup.project_id=run.project_id
      AND cleanup.operation_id=run.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id
     WHERE run.organization_id=?1 AND run.operation_id=?2
       AND run.event_type IN ('SourceLinkRequestedV1','ProjectDeletionRequestedV1',
                              'DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1','ProjectDataChangeRequestedV1')
       AND run.state IN ('queued','reconciliation_required')
       AND run.active_reconciliation_attempt_id IS NULL
       AND run.active_replay_attempt_id IS NULL AND operation.state IN ('queued','running')
       AND (event.acknowledged_at IS NOT NULL OR (
         run.event_type IN (${HANDOFF_TYPES})
         AND event.current_attempt_id IS NOT NULL
         AND event.attempt_count=5 AND event.max_attempts=5
         AND event.last_error_code IN (${FINAL_CODES})
         AND event.reconciliation_required_at IS NOT NULL
         AND event.claimed_at IS NULL AND event.lease_expires_at IS NULL
         AND EXISTS (
           SELECT 1 FROM delivery_attempts attempt
           WHERE attempt.event_id=event.event_id AND attempt.attempt_id=event.current_attempt_id
             AND attempt.attempt_number=5 AND attempt.status='reconciliation_required'
             AND attempt.error_code=event.last_error_code
             AND attempt.failed_at IS NOT NULL AND attempt.next_available_at IS NULL
             AND attempt.acknowledged_at IS NULL
         )
       )) AND ownership.state='active'
       AND NOT EXISTS (
         SELECT 1 FROM product_provider_mutation_claims claim
         WHERE claim.organization_id=run.organization_id AND claim.project_id=run.project_id
           AND (run.event_type<>'ProjectDataChangeRequestedV1' OR claim.operation_id<>run.operation_id)
       )
       AND (
         (run.event_type IN ('SourceLinkRequestedV1','DeploymentRollbackRequestedV1',
                             'DeploymentPromotionRequestedV1')
          AND project.lifecycle_state='active'
          AND intent.cleanup_run_id IS NULL AND cleanup.cleanup_run_id IS NULL)
         OR
         (run.event_type='ProjectDeletionRequestedV1' AND project.lifecycle_state='deleting'
          AND intent.cleanup_run_id IS NOT NULL
          AND cleanup.state IN ('pending','running','reconciliation_required'))
         OR (run.event_type='ProjectDataChangeRequestedV1' AND project.lifecycle_state='active'
          AND intent.cleanup_run_id IS NOT NULL AND cleanup.state IN ('pending','running','reconciliation_required'))
       )`;
/**
 * An event of any Workflow run type exhausted before its Workflow run row existed: the publisher lost its final lease after it
 * claimed the event and before it accepted the run. Nothing else can give it a run, so accepting its current attempt is
 * the recovery; FIND then hands the event off. The same lifecycle and cleanup conditions as FIND apply.
 */
export const RUNLESS_FIND = `SELECT event.event_id,event.project_id,event.billing_epoch_id,event.event_type,
            event.current_attempt_id attempt_id,intent.environment_id,intent.plan_id,intent.requested_handle,intent.data_change
     FROM outbox_events event
     INNER JOIN product_command_intents intent
       ON intent.organization_id=event.organization_id AND intent.project_id=event.project_id
      AND intent.operation_id=event.operation_id AND intent.billing_epoch_id=event.billing_epoch_id
      AND intent.event_type=event.event_type
     INNER JOIN operations operation
       ON operation.organization_id=event.organization_id AND operation.project_id=event.project_id
      AND operation.operation_id=event.operation_id
     INNER JOIN projects project
       ON project.organization_id=event.organization_id AND project.project_id=event.project_id
     LEFT JOIN cleanup_runs cleanup
       ON cleanup.organization_id=event.organization_id AND cleanup.project_id=event.project_id
      AND cleanup.operation_id=event.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id
     WHERE event.organization_id=?1 AND event.operation_id=?2
       AND event.event_type IN (${HANDOFF_TYPES})
       AND event.current_attempt_id IS NOT NULL
       AND event.attempt_count=5 AND event.max_attempts=5
       AND event.last_error_code IN (${FINAL_CODES})
       AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NOT NULL
       AND event.claimed_at IS NULL AND event.lease_expires_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM product_workflow_runs run WHERE run.event_id=event.event_id)
       AND EXISTS (
         SELECT 1 FROM delivery_attempts attempt
         WHERE attempt.event_id=event.event_id AND attempt.attempt_id=event.current_attempt_id
           AND attempt.attempt_number=5 AND attempt.status='reconciliation_required'
           AND attempt.error_code=event.last_error_code
           AND attempt.failed_at IS NOT NULL AND attempt.next_available_at IS NULL
           AND attempt.acknowledged_at IS NULL
       )
       AND operation.state IN ('queued','running')
       AND project.owner_state='active'
       AND (
         (event.event_type='ProjectDeletionRequestedV1' AND project.lifecycle_state='deleting'
          AND intent.cleanup_run_id IS NOT NULL AND cleanup.state IN ('pending','running','reconciliation_required'))
         OR (event.event_type='ProjectDataChangeRequestedV1' AND project.lifecycle_state='active'
          AND intent.cleanup_run_id IS NOT NULL AND cleanup.state IN ('pending','running','reconciliation_required'))
         OR (event.event_type IN (${ACTIVE_TYPES}) AND project.lifecycle_state='active'
          AND intent.cleanup_run_id IS NULL AND cleanup.cleanup_run_id IS NULL)
       )`;
export const HANDOFF_UPDATE = `UPDATE outbox_events AS event SET acknowledged_at=?8,reconciliation_required_at=NULL
     WHERE event.event_id=?1 AND event.organization_id=?2 AND event.project_id=?3
       AND event.operation_id=?4 AND event.billing_epoch_id=?5
       AND event.event_type IN (${HANDOFF_TYPES})
       AND event.current_attempt_id IS NOT NULL
       AND event.attempt_count=5 AND event.max_attempts=5
       AND event.last_error_code IN (${FINAL_CODES})
       AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NOT NULL
       AND event.claimed_at IS NULL AND event.lease_expires_at IS NULL
       AND EXISTS (
         SELECT 1 FROM product_workflow_runs run
         INNER JOIN product_command_intents intent
           ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
          AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
          AND intent.event_type=run.event_type
         LEFT JOIN cleanup_runs cleanup
           ON cleanup.organization_id=intent.organization_id AND cleanup.project_id=intent.project_id
          AND cleanup.operation_id=intent.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id
         INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
         INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
           ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
         WHERE run.workflow_id=?6 AND run.event_id=event.event_id
           AND run.organization_id=event.organization_id AND run.project_id=event.project_id
           AND run.environment_id=?7 AND run.operation_id=event.operation_id
           AND run.event_type IN (${HANDOFF_TYPES})
           AND run.state IN ('queued','reconciliation_required')
           AND run.active_reconciliation_attempt_id IS NULL
           AND run.active_replay_attempt_id IS NULL
           AND ${HANDOFF_CLEANUP}
           AND ${HANDOFF_LIFECYCLE} AND ownership.state='active'
       ) RETURNING event_id`;
export const HANDOFF_REPLAY = `SELECT 1 FROM outbox_events event INNER JOIN audit_events audit
         ON audit.organization_id=event.organization_id AND audit.project_id=event.project_id
        AND audit.operation_id=event.operation_id AND audit.audit_event_id=?6
       WHERE event.event_id=?1 AND event.organization_id=?2 AND event.project_id=?3
         AND event.operation_id=?4 AND event.billing_epoch_id=?5
         AND event.event_type IN (${HANDOFF_TYPES})
         AND event.acknowledged_at IS NOT NULL AND event.reconciliation_required_at IS NULL
         AND audit.event_type='ProjectDeletionQueueDeliveryRecovered'`;
export const HANDOFF_AUDIT = `INSERT INTO audit_events(
       organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,
       payload,occurred_at,billing_epoch_id)
     VALUES(?1,?2,?3,?4,'ProjectDeletionQueueDeliveryRecovered','user',?5,?6,?7,?8)`;
export const EXISTING = `SELECT attempt_id FROM product_workflow_replay_attempts
     WHERE organization_id=?1 AND operation_id=?2 AND idempotency_sha256=?3`;
export const LATEST = `SELECT attempt_number FROM product_workflow_replay_attempts
     WHERE logical_workflow_id=?1 ORDER BY attempt_number DESC LIMIT 1`;
export const INSERT_ATTEMPT = `INSERT INTO product_workflow_replay_attempts(
       attempt_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,
       logical_workflow_id,physical_workflow_id,event_type,idempotency_sha256,attempt_number,
       actor_id,created_at)
     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`;
export const ACTIVATE = `UPDATE product_workflow_runs
     SET state='queued',reconciliation_code=NULL,active_replay_attempt_id=?2,updated_at=?3
     WHERE workflow_id=?1 AND state IN ('queued','reconciliation_required')
       AND active_replay_attempt_id IS NULL
       AND active_reconciliation_attempt_id IS NULL RETURNING 1`;
export const CLEANUP = `SELECT state FROM cleanup_runs
       WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3`;
export const RESTART_CLEANUP = `UPDATE cleanup_runs
         SET state='running',revision=revision+1,reconciliation_code=NULL,updated_at=?4,
             completed_at=NULL
         WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3
           AND state IN ('pending','reconciliation_required')`;
export const PREPARED_AUDIT = `INSERT INTO audit_events(
       organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,
       payload,occurred_at,billing_epoch_id)
     VALUES(?1,?2,?3,?4,'ProductWorkflowReplayPrepared','user',?5,?6,?7,?8)`;
export const READ_ATTEMPT = `SELECT attempt.attempt_id,attempt.physical_workflow_id,attempt.event_id,
            attempt.organization_id,attempt.project_id,attempt.environment_id,
            attempt.operation_id,attempt.billing_epoch_id,attempt.event_type,
            operation.state operation_state,run.state run_state,run.active_reconciliation_attempt_id,
            run.active_replay_attempt_id,
            failure.failure_id,intent.data_change
     FROM product_workflow_replay_attempts attempt
     INNER JOIN product_workflow_runs run
       ON run.workflow_id=attempt.logical_workflow_id AND run.event_id=attempt.event_id
      AND run.organization_id=attempt.organization_id AND run.project_id=attempt.project_id
      AND run.environment_id=attempt.environment_id AND run.operation_id=attempt.operation_id
      AND run.billing_epoch_id=attempt.billing_epoch_id AND run.event_type=attempt.event_type
     INNER JOIN operations operation
       ON operation.organization_id=attempt.organization_id AND operation.project_id=attempt.project_id
      AND operation.operation_id=attempt.operation_id
     LEFT JOIN product_command_intents intent ON intent.organization_id=attempt.organization_id AND intent.project_id=attempt.project_id AND intent.operation_id=attempt.operation_id
     LEFT JOIN product_workflow_replay_failures failure ON failure.attempt_id=attempt.attempt_id
     WHERE attempt.organization_id=?1 AND attempt.operation_id=?2 AND attempt.attempt_id=?3
       AND attempt.actor_id=?4 AND attempt.idempotency_sha256=?5`;
export const FAILURE_REPLAY = `SELECT 1 FROM product_workflow_replay_failures failure
     INNER JOIN product_workflow_replay_attempts attempt ON attempt.attempt_id=failure.attempt_id
     WHERE failure.attempt_id=?1 AND failure.organization_id=?2 AND failure.operation_id=?3
       AND failure.actor_id=?4 AND attempt.actor_id=?4`;
export const INSERT_FAILURE = `INSERT INTO product_workflow_replay_failures(
       failure_id,attempt_id,organization_id,operation_id,physical_workflow_id,terminal_status,
       evidence_sha256,actor_id,created_at)
     SELECT ?1,attempt.attempt_id,attempt.organization_id,attempt.operation_id,
            attempt.physical_workflow_id,?5,?6,?7,?8
     FROM product_workflow_replay_attempts attempt
     INNER JOIN product_workflow_runs run
       ON run.workflow_id=attempt.logical_workflow_id AND run.active_replay_attempt_id=attempt.attempt_id
     WHERE attempt.attempt_id=?2 AND attempt.organization_id=?3 AND attempt.operation_id=?4
       AND attempt.actor_id=?7 AND run.state='queued' RETURNING 1`;
export const RELEASE_FAILURE = `UPDATE product_workflow_runs SET active_replay_attempt_id=NULL,updated_at=?3
     WHERE organization_id=?1 AND operation_id=?2 AND active_replay_attempt_id=?4 RETURNING 1`;

export interface ProductWorkflowReplayCandidate {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly eventId: Ulid;
  readonly billingEpochId: Ulid;
  readonly logicalWorkflowId: string;
  readonly eventType:
    | "SourceLinkRequestedV1"
    | "ProjectDeletionRequestedV1"
    | "ProjectDataChangeRequestedV1"
    | "DeploymentRollbackRequestedV1"
    | "DeploymentPromotionRequestedV1";
  readonly queueHandoffPending?: boolean;
  readonly dataChange?: string | null;
}

// Fixed original UPDATE/INSERT selection predicates, read-only at every observation call.
export const HANDOFF_ELIGIBLE = `SELECT event.event_id FROM outbox_events event
     WHERE event.event_id=?1 AND event.organization_id=?2 AND event.project_id=?3
       AND event.operation_id=?4 AND event.billing_epoch_id=?5
       AND event.event_type IN (${HANDOFF_TYPES})
       AND event.current_attempt_id IS NOT NULL
       AND event.attempt_count=5 AND event.max_attempts=5
       AND event.last_error_code IN (${FINAL_CODES})
       AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NOT NULL
       AND event.claimed_at IS NULL AND event.lease_expires_at IS NULL
       AND EXISTS (
         SELECT 1 FROM product_workflow_runs run
         INNER JOIN product_command_intents intent
           ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
          AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
          AND intent.event_type=run.event_type
         LEFT JOIN cleanup_runs cleanup
           ON cleanup.organization_id=intent.organization_id AND cleanup.project_id=intent.project_id
          AND cleanup.operation_id=intent.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id
         INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
         INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
           ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
         WHERE run.workflow_id=?6 AND run.event_id=event.event_id
           AND run.organization_id=event.organization_id AND run.project_id=event.project_id
           AND run.environment_id=?7 AND run.operation_id=event.operation_id
           AND run.event_type IN (${HANDOFF_TYPES})
           AND run.state IN ('queued','reconciliation_required')
           AND run.active_reconciliation_attempt_id IS NULL
           AND run.active_replay_attempt_id IS NULL
           AND ${HANDOFF_CLEANUP}
           AND ${HANDOFF_LIFECYCLE} AND ownership.state='active'
       )`;
export const FAILURE_ELIGIBLE = `SELECT attempt.attempt_id
     FROM product_workflow_replay_attempts attempt
     INNER JOIN product_workflow_runs run
       ON run.workflow_id=attempt.logical_workflow_id AND run.active_replay_attempt_id=attempt.attempt_id
     WHERE attempt.attempt_id=?2 AND attempt.organization_id=?3 AND attempt.operation_id=?4
       AND attempt.actor_id=?7 AND run.state='queued'`;
