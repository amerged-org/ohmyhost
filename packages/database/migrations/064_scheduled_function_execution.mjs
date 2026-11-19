function appendOnly(pgm, table) {
  pgm.createTrigger(table, `${table}_append_only`, {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM deployment_plans
    WHERE framework_plan->'functions'->'scheduled'<> '[]'::jsonb
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(framework_plan->'functions'->'scheduled') item
                  WHERE NOT (item ? 'handler')))
    THEN RAISE EXCEPTION 'scheduled function handler cutover requires current source evidence'
      USING ERRCODE='23514'; END IF; END $$`);
  pgm.sql(`CREATE OR REPLACE FUNCTION valid_functions_requirement(requirement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(requirement)='object'
      AND requirement ?& ARRAY['delivery','timeoutSeconds','maxAttempts','scheduled']
      AND requirement - ARRAY['delivery','timeoutSeconds','maxAttempts','scheduled']='{}'::jsonb
      AND requirement->>'delivery'='at-least-once' AND requirement->'timeoutSeconds'='120'::jsonb
      AND requirement->'maxAttempts'='3'::jsonb AND jsonb_typeof(requirement->'scheduled')='array'
      AND jsonb_array_length(requirement->'scheduled')<=8
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(requirement->'scheduled') WITH ORDINALITY item(value,ord)
        WHERE jsonb_typeof(value)<>'object' OR NOT(value ?& ARRAY['id','cron','handler'])
          OR value-ARRAY['id','cron','handler']<>'{}'::jsonb
          OR value->>'id'!~'^[a-z][a-z0-9-]{0,31}$'
          OR value->>'handler'!~'^src/ohmyhost/functions/(?:[A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*\\.ts$'
          OR length(value->>'handler')>256
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(requirement->'scheduled') WITH ORDINALITY prior(pvalue,pord)
                    WHERE pord<ord AND pvalue->>'id'>=value->>'id')) $$`);
  pgm.sql(`CREATE FUNCTION scheduled_cron_due(cron text, scheduled_at timestamptz) RETURNS boolean
    LANGUAGE plpgsql STABLE AS $$ DECLARE fields text[]:=string_to_array(cron,' ');
      minute integer:=extract(minute FROM scheduled_at AT TIME ZONE 'UTC');
      hour integer:=extract(hour FROM scheduled_at AT TIME ZONE 'UTC');
      day integer:=extract(day FROM scheduled_at AT TIME ZONE 'UTC');
      month integer:=extract(month FROM scheduled_at AT TIME ZONE 'UTC');
      weekday integer:=extract(dow FROM scheduled_at AT TIME ZONE 'UTC');
      step integer;
    BEGIN IF cardinality(fields)<>5 THEN RETURN false; END IF;
      IF fields[1] LIKE '*/%' THEN step:=substring(fields[1] FROM 3)::integer;
        IF step<5 OR minute%step<>0 THEN RETURN false; END IF;
      ELSIF fields[1]::integer<>minute THEN RETURN false; END IF;
      RETURN (fields[2]='*' OR fields[2]::integer=hour)
        AND (fields[3]='*' OR fields[3]::integer=day)
        AND (fields[4]='*' OR fields[4]::integer=month)
        AND (fields[5]='*' OR fields[5]::integer=weekday); END $$`);
  pgm.createTable("scheduled_function_definitions", {
    definition_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    revision_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    function_id: { type: "text", notNull: true },
    cron: { type: "text", notNull: true },
    handler: { type: "text", notNull: true },
    handler_sha256: { type: "bytea", notNull: true },
    runtime_policy: { type: "jsonb", notNull: true },
    timeout_seconds: { type: "integer", notNull: true },
    max_attempts: { type: "integer", notNull: true },
    function_concurrency: { type: "integer", notNull: true },
    project_concurrency: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("scheduled_function_definitions", "scheduled_function_definitions_scope_key", {
    unique: ["organization_id", "project_id", "environment_id", "deployment_id", "function_id"],
  });
  pgm.addConstraint(
    "scheduled_function_definitions",
    "scheduled_function_definitions_composite_key",
    {
      unique: [
        "organization_id",
        "project_id",
        "environment_id",
        "deployment_id",
        "function_id",
        "definition_id",
      ],
    },
  );
  pgm.addConstraint(
    "scheduled_function_definitions",
    "scheduled_function_definitions_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id,project_id,environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "scheduled_function_definitions",
    "scheduled_function_definitions_revision_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "deployment_id", "revision_id"],
        references: "deployment_revisions (organization_id,project_id,deployment_id,revision_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "scheduled_function_definitions",
    "scheduled_function_definitions_candidate_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "candidate_receipt_id"],
        references: "wfp_candidate_receipts (organization_id,project_id,candidate_receipt_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "scheduled_function_definitions",
    "scheduled_function_definitions_shape_check",
    {
      check: `function_id~'^[a-z][a-z0-9-]{0,31}$'
      AND cron~'^(\\*/[5-9]|\\*/[1-5][0-9]|[0-9]|[1-5][0-9]) (\\*|[0-9]|1[0-9]|2[0-3]) (\\*|[1-9]|[12][0-9]|3[01]) (\\*|[1-9]|1[0-2]) (\\*|[0-6])$'
      AND handler~'^src/ohmyhost/functions/(?:[A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*\\.ts$'
      AND length(handler)<=256 AND octet_length(handler_sha256)=32
      AND valid_runtime_policy(runtime_policy) AND timeout_seconds=120 AND max_attempts=3
      AND function_concurrency=1 AND project_concurrency=4`,
    },
  );
  appendOnly(pgm, "scheduled_function_definitions");

  pgm.createTable("scheduled_function_heads", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    function_id: { type: "text", notNull: true },
    definition_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    revision_id: { type: "ulid", notNull: true },
    candidate_receipt_id: { type: "ulid", notNull: true },
    head_version: { type: "integer", notNull: true },
    enabled: { type: "boolean", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("scheduled_function_heads", "scheduled_function_heads_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "function_id"],
  });
  pgm.addConstraint("scheduled_function_heads", "scheduled_function_heads_definition_fkey", {
    foreignKeys: {
      columns: [
        "organization_id",
        "project_id",
        "environment_id",
        "deployment_id",
        "function_id",
        "definition_id",
      ],
      references:
        "scheduled_function_definitions (organization_id,project_id,environment_id,deployment_id,function_id,definition_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("scheduled_function_heads", "scheduled_function_heads_shape_check", {
    check: "head_version>0",
  });

  pgm.createTable("scheduled_function_slots", {
    slot_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    function_id: { type: "text", notNull: true },
    scheduled_at: { type: "timestamptz", notNull: true },
    definition_id: { type: "ulid", notNull: true },
    state: { type: "text", notNull: true },
    attempt_count: { type: "integer", notNull: true, default: 0 },
    active_lease_id: { type: "ulid" },
    claimed_at: { type: "timestamptz" },
    lease_expires_at: { type: "timestamptz" },
    publication_claim_id: { type: "ulid" },
    publication_claimed_at: { type: "timestamptz" },
    publication_lease_expires_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("scheduled_function_slots", "scheduled_function_slots_key", {
    unique: ["project_id", "environment_id", "deployment_id", "function_id", "scheduled_at"],
  });
  pgm.addConstraint("scheduled_function_slots", "scheduled_function_slots_definition_fkey", {
    foreignKeys: {
      columns: [
        "organization_id",
        "project_id",
        "environment_id",
        "deployment_id",
        "function_id",
        "definition_id",
      ],
      references:
        "scheduled_function_definitions (organization_id,project_id,environment_id,deployment_id,function_id,definition_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("scheduled_function_slots", "scheduled_function_slots_shape_check", {
    check: `state IN ('queued','running','retry_pending','succeeded','dlq','stale_acked','cancelled') AND attempt_count BETWEEN 0 AND 3
      AND ((state='running' AND active_lease_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at>claimed_at)
        OR (state<>'running' AND active_lease_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL))
      AND ((publication_claim_id IS NULL AND publication_claimed_at IS NULL AND publication_lease_expires_at IS NULL)
        OR (publication_claim_id IS NOT NULL AND publication_claimed_at IS NOT NULL
          AND publication_lease_expires_at>publication_claimed_at))`,
  });
  pgm.createIndex(
    "scheduled_function_slots",
    ["organization_id", "project_id", "state", "scheduled_at"],
    { name: "scheduled_function_slots_claim_idx" },
  );

  pgm.createTable("scheduled_function_workflow_receipts", {
    publication_receipt_id: { type: "ulid", primaryKey: true },
    slot_id: { type: "ulid", notNull: true, unique: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    publication_claim_id: { type: "ulid", notNull: true },
    workflow_id: { type: "text", notNull: true, unique: true },
    outcome: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "scheduled_function_workflow_receipts",
    "scheduled_function_workflow_receipts_slot_fkey",
    {
      foreignKeys: {
        columns: ["slot_id"],
        references: "scheduled_function_slots",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "scheduled_function_workflow_receipts",
    "scheduled_function_workflow_receipts_shape_check",
    {
      check: `workflow_id~'^scheduled-function-v1-01[0-9A-HJKMNP-TV-Z]{24}$'
        AND outcome IN ('started','adopted')`,
    },
  );
  appendOnly(pgm, "scheduled_function_workflow_receipts");

  pgm.createTable("scheduled_function_attempts", {
    attempt_id: { type: "ulid", primaryKey: true },
    slot_id: { type: "ulid", notNull: true },
    lease_id: { type: "ulid", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    outcome: { type: "text", notNull: true },
    error_code: { type: "text" },
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("scheduled_function_attempts", "scheduled_function_attempts_slot_key", {
    unique: ["slot_id", "attempt_number"],
  });
  pgm.addConstraint("scheduled_function_attempts", "scheduled_function_attempts_lease_key", {
    unique: ["slot_id", "lease_id"],
  });
  pgm.addConstraint("scheduled_function_attempts", "scheduled_function_attempts_slot_fkey", {
    foreignKeys: {
      columns: ["slot_id"],
      references: "scheduled_function_slots",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("scheduled_function_attempts", "scheduled_function_attempts_shape_check", {
    check: `attempt_number BETWEEN 1 AND 3 AND outcome IN ('succeeded','failed','timeout') AND completed_at>=started_at AND ((outcome='succeeded' AND error_code IS NULL) OR (outcome<>'succeeded' AND error_code~'^[A-Z][A-Z0-9_]{0,63}$'))`,
  });
  appendOnly(pgm, "scheduled_function_attempts");

  pgm.createTable("scheduled_function_cancellations", {
    cancellation_id: { type: "ulid", primaryKey: true },
    slot_id: { type: "ulid", notNull: true, unique: true },
    reason: { type: "text", notNull: true },
    cancelled_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint(
    "scheduled_function_cancellations",
    "scheduled_function_cancellations_slot_fkey",
    {
      foreignKeys: {
        columns: ["slot_id"],
        references: "scheduled_function_slots",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "scheduled_function_cancellations",
    "scheduled_function_cancellations_reason_check",
    { check: "reason IN ('project_deletion','stale_head')" },
  );
  appendOnly(pgm, "scheduled_function_cancellations");
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM scheduled_function_definitions) THEN
    RAISE EXCEPTION 'scheduled function evidence prevents a lossless downgrade' USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropTable("scheduled_function_cancellations");
  pgm.dropTable("scheduled_function_attempts");
  pgm.dropTable("scheduled_function_workflow_receipts");
  pgm.dropTable("scheduled_function_slots");
  pgm.dropTable("scheduled_function_heads");
  pgm.dropTable("scheduled_function_definitions");
  pgm.sql("DROP FUNCTION scheduled_cron_due(text,timestamptz)");
  pgm.sql(`CREATE OR REPLACE FUNCTION valid_functions_requirement(requirement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(requirement)='object'
      AND requirement ?& ARRAY['delivery','timeoutSeconds','maxAttempts','scheduled']
      AND requirement - ARRAY['delivery','timeoutSeconds','maxAttempts','scheduled']='{}'::jsonb
      AND requirement->>'delivery'='at-least-once' AND requirement->'timeoutSeconds'='120'::jsonb
      AND requirement->'maxAttempts'='3'::jsonb AND jsonb_typeof(requirement->'scheduled')='array' $$`);
}
