export function up(pgm) {
  pgm.addColumn("mail_send_events", {
    reputation_kind: { type: "text" },
  });
  pgm.addConstraint("mail_send_events", "mail_send_events_reputation_shape", {
    check: `reputation_kind IS NULL
      OR (event_type='Bounce' AND reputation_kind='hard_bounce')
      OR (event_type='Complaint' AND reputation_kind='complaint')`,
  });

  pgm.createTable("mail_reputation_states", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    state: { type: "text", notNull: true },
    warmup_started_at: { type: "timestamptz", notNull: true },
    suspended_at: { type: "timestamptz" },
    suspension_reason: { type: "text" },
    triggering_event_id: { type: "uuid" },
    version: { type: "bigint", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_reputation_states", "mail_reputation_states_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("mail_reputation_states", "mail_reputation_states_gateway_key_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "mail_gateway_keys (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_reputation_states", "mail_reputation_states_event_fkey", {
    foreignKeys: {
      columns: ["triggering_event_id"],
      references: "mail_send_events (provider_event_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_reputation_states", "mail_reputation_states_shape", {
    check: `version>=1 AND updated_at>=warmup_started_at
      AND ((state='active' AND suspended_at IS NULL AND suspension_reason IS NULL
            AND triggering_event_id IS NULL)
        OR (state='suspended' AND suspended_at IS NOT NULL
            AND suspension_reason IN ('bounce_rate','complaint_rate')
            AND triggering_event_id IS NOT NULL AND updated_at>=suspended_at))`,
  });

  pgm.createTable("mail_reputation_decisions", {
    decision_id: { type: "uuid", notNull: true, primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    action: { type: "text", notNull: true },
    reason: { type: "text", notNull: true },
    triggering_event_id: { type: "uuid" },
    eligible_send_count: { type: "bigint", notNull: true },
    hard_bounce_count: { type: "bigint", notNull: true },
    complaint_count: { type: "bigint", notNull: true },
    actor_id: { type: "text", notNull: true },
    evidence_sha256: { type: "bytea" },
    occurred_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_reputation_decisions", "mail_reputation_decisions_state_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "mail_reputation_states (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_reputation_decisions", "mail_reputation_decisions_event_fkey", {
    foreignKeys: {
      columns: ["triggering_event_id"],
      references: "mail_send_events (provider_event_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_reputation_decisions", "mail_reputation_decisions_shape", {
    check: `action IN ('suspend','reinstate','retain')
      AND reason IN ('bounce_rate','complaint_rate','manual_review')
      AND eligible_send_count>=0 AND hard_bounce_count>=0 AND complaint_count>=0
      AND length(actor_id) BETWEEN 1 AND 255
      AND ((action='suspend' AND reason IN ('bounce_rate','complaint_rate')
            AND triggering_event_id IS NOT NULL AND actor_id='system:ses-reputation'
            AND evidence_sha256 IS NULL)
        OR (action IN ('reinstate','retain') AND reason='manual_review'
            AND triggering_event_id IS NULL AND actor_id~'^operator:[A-Za-z0-9._@-]{1,246}$'
            AND octet_length(evidence_sha256)=32))`,
  });
  pgm.createTrigger("mail_reputation_decisions", "mail_reputation_decisions_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.sql(`CREATE FUNCTION guard_mail_reputation_state_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'mail reputation state is append-preserving' USING ERRCODE='23514';
    END IF;
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
       OR OLD.project_id IS DISTINCT FROM NEW.project_id
       OR NEW.version<>OLD.version+1
       OR NEW.updated_at<OLD.updated_at
       OR NOT ((OLD.state='active' AND NEW.state='suspended'
                AND NEW.warmup_started_at=OLD.warmup_started_at)
         OR (OLD.state='suspended' AND NEW.state='active'
                AND NEW.warmup_started_at=NEW.updated_at))
    THEN
      RAISE EXCEPTION 'mail reputation state transition is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END $$`);
  pgm.createTrigger("mail_reputation_states", "mail_reputation_states_guard", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "guard_mail_reputation_state_change",
  });

  pgm.sql(`INSERT INTO mail_reputation_states(
      organization_id,project_id,state,warmup_started_at,version,updated_at)
    SELECT organization_id,project_id,'active',created_at,1,created_at FROM mail_gateway_keys`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM mail_reputation_decisions)
       OR EXISTS (SELECT 1 FROM mail_send_events WHERE reputation_kind IS NOT NULL)
       OR EXISTS (
         SELECT 1 FROM mail_reputation_states state
         INNER JOIN mail_gateway_keys key
           ON key.organization_id=state.organization_id AND key.project_id=state.project_id
         WHERE state.state<>'active' OR state.version<>1
           OR state.warmup_started_at<>key.created_at OR state.updated_at<>key.created_at
       ) THEN
      RAISE EXCEPTION 'Mail reputation evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTrigger("mail_reputation_states", "mail_reputation_states_guard");
  pgm.dropFunction("guard_mail_reputation_state_change", []);
  pgm.dropTable("mail_reputation_decisions");
  pgm.dropTable("mail_reputation_states");
  pgm.dropConstraint("mail_send_events", "mail_send_events_reputation_shape");
  pgm.dropColumn("mail_send_events", "reputation_kind");
}
