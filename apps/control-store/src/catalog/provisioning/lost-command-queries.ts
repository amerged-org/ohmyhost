// Exact original lost-rename predicate. No current ordinary context or inventory mirror substitutes for it.
export const ABANDONED = `SELECT 1 FROM audit_events WHERE organization_id=?1 AND operation_id=?2 AND event_type=?3`;
export const LOST = `SELECT event.project_id,event.billing_epoch_id,event.event_id,run.workflow_id
       FROM outbox_events event
       INNER JOIN delivery_attempts attempt
         ON attempt.event_id=event.event_id AND attempt.attempt_id=event.current_attempt_id
       INNER JOIN operations operation
         ON operation.organization_id=event.organization_id AND operation.project_id=event.project_id
        AND operation.operation_id=event.operation_id
        AND operation.billing_epoch_id=event.billing_epoch_id
       INNER JOIN product_command_intents intent
         ON intent.organization_id=event.organization_id AND intent.project_id=event.project_id
        AND intent.operation_id=event.operation_id AND intent.event_type=event.event_type
        AND intent.billing_epoch_id=event.billing_epoch_id
        AND intent.environment_id=event.payload->>'environmentId'
       INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
         ON ownership.organization_id=event.organization_id AND ownership.project_id=event.project_id
        AND ownership.state='active'
       LEFT JOIN product_workflow_runs run
         ON run.organization_id=event.organization_id AND run.operation_id=event.operation_id
      WHERE event.organization_id=?1 AND event.operation_id=?2
        AND event.event_type='ProjectHandleChangeRequestedV1'
        AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NOT NULL
        AND event.claimed_at IS NULL AND event.lease_expires_at IS NULL
        AND event.attempt_count=event.max_attempts
        AND event.last_error_code IN ('FINAL_ATTEMPT_LEASE_EXPIRED','PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN')
        AND attempt.attempt_number=event.attempt_count AND attempt.status='reconciliation_required'
        AND attempt.error_code=event.last_error_code AND attempt.failed_at IS NOT NULL
        AND attempt.next_available_at IS NULL AND attempt.acknowledged_at IS NULL
        AND operation.state='queued'
        AND (run.workflow_id IS NULL OR (
          run.event_id=event.event_id AND run.environment_id=intent.environment_id
          AND run.state='queued' AND run.intermediate_evidence IS NULL
          AND run.terminal_evidence IS NULL AND run.active_reconciliation_attempt_id IS NULL
          AND run.active_replay_attempt_id IS NULL))
        AND NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims claim
          WHERE claim.organization_id=event.organization_id AND claim.operation_id=event.operation_id)
        AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions route
          WHERE route.organization_id=event.organization_id AND route.operation_id=event.operation_id)
      `;
