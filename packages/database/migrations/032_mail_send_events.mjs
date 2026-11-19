export function up(pgm) {
  pgm.createTable("ses_event_destination_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    configuration_set_name: { type: "text", notNull: true },
    event_destination_name: { type: "text", notNull: true },
    event_bus_arn: { type: "text", notNull: true },
    matching_event_types: { type: "jsonb", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("ses_event_destination_receipts", "ses_event_destination_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("ses_event_destination_receipts", "ses_event_destination_receipts_mail_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "ses_project_mail_resource_receipts (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ses_event_destination_receipts", "ses_event_destination_receipts_shape", {
    check: `configuration_set_name~'^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}$'
      AND event_destination_name='ohmyho-events'
      AND event_bus_arn~'^arn:aws:events:[a-z]{2}(-[a-z]+)+-[0-9]:[0-9]{12}:event-bus/default$'
      AND matching_event_types='["BOUNCE","COMPLAINT","DELIVERY","DELIVERY_DELAY","REJECT","RENDERING_FAILURE","SEND"]'::jsonb`,
  });
  pgm.createTrigger(
    "ses_event_destination_receipts",
    "ses_event_destination_receipts_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );

  pgm.addConstraint("mail_send_requests", "mail_send_requests_scope_identity_key", {
    unique: ["organization_id", "project_id", "request_id"],
  });
  pgm.createTable("mail_send_events", {
    provider_event_id: { type: "uuid", notNull: true, primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    request_id: { type: "ulid", notNull: true },
    provider_message_id: { type: "text", notNull: true },
    event_type: { type: "text", notNull: true },
    outcome: { type: "text", notNull: true },
    detail_sha256: { type: "bytea", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
    sent_at: { type: "timestamptz", notNull: true },
    received_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_send_events", "mail_send_events_request_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "request_id"],
      references: "mail_send_requests (organization_id, project_id, request_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_send_events", "mail_send_events_shape", {
    check: `length(provider_message_id) BETWEEN 1 AND 256
      AND provider_message_id~'^[A-Za-z0-9._-]+$'
      AND event_type IN ('Send','Delivery','DeliveryDelay','Bounce','Complaint','Reject','Rendering Failure')
      AND outcome IN ('accepted','delivered','delayed','bounced','complained','failed')
      AND octet_length(detail_sha256)=32
      AND received_at>=sent_at`,
  });
  pgm.createTrigger("mail_send_events", "mail_send_events_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("mail_send_outcomes", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    request_id: { type: "ulid", notNull: true },
    outcome: { type: "text", notNull: true },
    provider_event_id: { type: "uuid", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
    version: { type: "bigint", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("mail_send_outcomes", "mail_send_outcomes_pkey", {
    primaryKey: ["organization_id", "project_id", "request_id"],
  });
  pgm.addConstraint("mail_send_outcomes", "mail_send_outcomes_request_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "request_id"],
      references: "mail_send_requests (organization_id, project_id, request_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_send_outcomes", "mail_send_outcomes_event_fkey", {
    foreignKeys: {
      columns: ["provider_event_id"],
      references: "mail_send_events (provider_event_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("mail_send_outcomes", "mail_send_outcomes_shape", {
    check: `outcome IN ('accepted','delivered','delayed','bounced','complained','failed')
      AND version>=1 AND updated_at>=occurred_at`,
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM mail_send_events)
       OR EXISTS (SELECT 1 FROM mail_send_outcomes)
       OR EXISTS (SELECT 1 FROM ses_event_destination_receipts) THEN
      RAISE EXCEPTION 'Mail send event evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("mail_send_outcomes");
  pgm.dropTable("mail_send_events");
  pgm.dropTable("ses_event_destination_receipts");
  pgm.dropConstraint("mail_send_requests", "mail_send_requests_scope_identity_key");
}
