export function up(pgm) {
  pgm.dropConstraint("webhook_inbox", "webhook_inbox_check");
  pgm.addConstraint("webhook_inbox", "webhook_inbox_check", {
    check:
      "octet_length(body_sha256)=32 AND attempt_count>=0 AND max_attempts>0 AND attempt_count<=max_attempts AND (last_error_code IS NULL OR last_error_code~'^[A-Z][A-Z0-9_]{1,63}$') AND ((state='pending' AND attempt_count=0 AND claim_id IS NULL AND acknowledged_at IS NULL) OR (state='processing' AND attempt_count>0 AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at AND acknowledged_at IS NULL) OR (state='retry_wait' AND attempt_count>0 AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL) OR (state='acknowledged' AND attempt_count>=0 AND claim_id IS NULL AND last_error_code IS NULL AND acknowledged_at IS NOT NULL) OR (state='reconciliation_required' AND attempt_count=max_attempts AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL))",
  });

  pgm.createTable("workos_terminal_revocations", {
    kind: { type: "text", notNull: true },
    resource_id: { type: "text", notNull: true },
    workos_user_id: { type: "text" },
    workos_organization_id: { type: "text" },
    source_event_id: { type: "text", notNull: true, unique: true },
    effective_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("workos_terminal_revocations", "workos_terminal_revocations_pkey", {
    primaryKey: ["kind", "resource_id"],
  });
  pgm.addConstraint("workos_terminal_revocations", "workos_terminal_revocations_shape_check", {
    check: `kind IN ('session','user','organization')
      AND resource_id=btrim(resource_id) AND length(resource_id) BETWEEN 1 AND 255
      AND source_event_id=btrim(source_event_id) AND length(source_event_id) BETWEEN 1 AND 255
      AND (workos_user_id IS NULL OR
        (workos_user_id=btrim(workos_user_id) AND length(workos_user_id) BETWEEN 1 AND 255))
      AND (workos_organization_id IS NULL OR
        (workos_organization_id=btrim(workos_organization_id)
          AND length(workos_organization_id) BETWEEN 1 AND 255))
      AND (
        (kind='session' AND workos_user_id IS NOT NULL)
        OR (kind='user' AND resource_id=workos_user_id)
        OR (kind='organization' AND resource_id=workos_organization_id AND workos_user_id IS NULL)
      )`,
  });
  pgm.createTrigger("workos_terminal_revocations", "workos_terminal_revocations_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("workos_membership_sync_barriers", {
    workos_organization_id: { type: "text", notNull: true },
    workos_user_id: { type: "text", notNull: true },
    source_event_id: { type: "text", notNull: true },
    event_created_at: { type: "timestamptz", notNull: true },
    reconciled_at: { type: "timestamptz" },
  });
  pgm.addConstraint("workos_membership_sync_barriers", "workos_membership_sync_barriers_pkey", {
    primaryKey: ["workos_organization_id", "workos_user_id"],
  });
  pgm.addConstraint(
    "workos_membership_sync_barriers",
    "workos_membership_sync_barriers_shape_check",
    {
      check: `workos_organization_id=btrim(workos_organization_id)
        AND length(workos_organization_id) BETWEEN 1 AND 255
        AND workos_user_id=btrim(workos_user_id) AND length(workos_user_id) BETWEEN 1 AND 255
        AND source_event_id=btrim(source_event_id) AND length(source_event_id) BETWEEN 1 AND 255
        AND (reconciled_at IS NULL OR reconciled_at>=event_created_at)`,
    },
  );
  pgm.createIndex("workos_membership_sync_barriers", ["workos_organization_id", "workos_user_id"], {
    name: "workos_membership_sync_barriers_open_idx",
    where: "reconciled_at IS NULL",
  });
}

export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM webhook_inbox WHERE state='acknowledged' AND attempt_count=0) THEN
         RAISE EXCEPTION 'directly acknowledged WorkOS inbox evidence must be retained before downgrade'
           USING ERRCODE='23514', CONSTRAINT='workos_authentication_state_downgrade_requires_empty';
       END IF;
     END $$`,
  );
  pgm.dropTable("workos_membership_sync_barriers");
  pgm.dropTrigger("workos_terminal_revocations", "workos_terminal_revocations_append_only");
  pgm.dropTable("workos_terminal_revocations");
  pgm.dropConstraint("webhook_inbox", "webhook_inbox_check");
  pgm.addConstraint("webhook_inbox", "webhook_inbox_check", {
    check:
      "octet_length(body_sha256)=32 AND attempt_count>=0 AND max_attempts>0 AND attempt_count<=max_attempts AND (last_error_code IS NULL OR last_error_code~'^[A-Z][A-Z0-9_]{1,63}$') AND ((state='pending' AND attempt_count=0 AND claim_id IS NULL AND acknowledged_at IS NULL) OR (state='processing' AND attempt_count>0 AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at AND acknowledged_at IS NULL) OR (state='retry_wait' AND attempt_count>0 AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL) OR (state='acknowledged' AND attempt_count>0 AND claim_id IS NULL AND last_error_code IS NULL AND acknowledged_at IS NOT NULL) OR (state='reconciliation_required' AND attempt_count=max_attempts AND claim_id IS NULL AND last_error_code IS NOT NULL AND acknowledged_at IS NULL))",
  });
}
