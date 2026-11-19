const ULID_CHECK = "VALUE ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'";

export function up(pgm) {
  pgm.createDomain("ulid", "text", { check: ULID_CHECK });

  pgm.createTable("projects", {
    project_id: { type: "ulid", primaryKey: true },
    created_organization_id: { type: "ulid", notNull: true },
    name: { type: "text", notNull: true },
    created_event_id: { type: "ulid", notNull: true, unique: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("projects", "projects_name_check", {
    check: "name=btrim(name) AND length(name) BETWEEN 1 AND 128",
  });

  pgm.createTable("billing_epochs", {
    billing_epoch_id: { type: "ulid", primaryKey: true },
    project_id: { type: "ulid", notNull: true, references: "projects", onDelete: "RESTRICT" },
    organization_id: { type: "ulid", notNull: true },
    started_at: { type: "timestamptz", notNull: true },
    ended_at: { type: "timestamptz" },
    created_by_principal_id: { type: "text", notNull: true },
  });
  pgm.addConstraint("billing_epochs", "billing_epochs_scope_key", {
    unique: ["billing_epoch_id", "project_id", "organization_id"],
  });
  pgm.createIndex("billing_epochs", "project_id", {
    name: "billing_epochs_one_open_per_project_key",
    unique: true,
    where: "ended_at IS NULL",
  });
  pgm.addConstraint("billing_epochs", "billing_epochs_interval_check", {
    check: "ended_at IS NULL OR ended_at >= started_at",
  });

  pgm.createTable("project_ownerships", {
    project_id: { type: "ulid", primaryKey: true, references: "projects", onDelete: "RESTRICT" },
    organization_id: { type: "ulid", notNull: true },
    state: { type: "text", notNull: true },
    ownership_version: { type: "integer", notNull: true },
    active_billing_epoch_id: { type: "ulid", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("project_ownerships", "project_ownerships_scope_key", {
    unique: ["organization_id", "project_id"],
  });
  pgm.addConstraint("project_ownerships", "project_ownerships_state_check", {
    check:
      "state IN ('active', 'transfer_pending_frozen', 'security_frozen') AND ownership_version > 0",
  });
  pgm.addConstraint("project_ownerships", "project_ownerships_epoch_fkey", {
    foreignKeys: {
      columns: ["active_billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
      deferrable: true,
      initiallyDeferred: true,
    },
  });

  pgm.createTable("project_transfer_intents", {
    transfer_id: { type: "ulid", primaryKey: true },
    project_id: { type: "ulid", notNull: true, references: "projects", onDelete: "RESTRICT" },
    source_organization_id: { type: "ulid", notNull: true },
    target_organization_id: { type: "ulid", notNull: true },
    state: { type: "text", notNull: true },
    expected_ownership_version: { type: "integer", notNull: true },
    initiated_by_principal_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
    cancelled_at: { type: "timestamptz" },
    failure_code: { type: "text" },
  });
  pgm.addConstraint("project_transfer_intents", "project_transfer_intents_state_check", {
    check: `source_organization_id <> target_organization_id AND expected_ownership_version > 0 AND (
      (state = 'pending_frozen' AND completed_at IS NULL AND cancelled_at IS NULL AND failure_code IS NULL)
      OR (state = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND failure_code IS NULL)
      OR (state = 'cancelled_to_source' AND completed_at IS NULL AND cancelled_at IS NOT NULL AND failure_code IS NULL)
      OR (state = 'failed_frozen' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND failure_code IS NOT NULL))`,
  });
  pgm.createIndex("project_transfer_intents", "project_id", {
    unique: true,
    where: "state = 'pending_frozen'",
  });

  pgm.createTable("environments", {
    organization_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    name: { type: "text", notNull: true },
    desired_state: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("environments", "environments_pkey", {
    primaryKey: ["organization_id", "environment_id"],
  });
  pgm.addConstraint("environments", "environments_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
      onUpdate: "CASCADE",
      deferrable: true,
      initiallyDeferred: true,
    },
  });
  pgm.addConstraint("environments", "environments_name_key", {
    unique: ["organization_id", "project_id", "name"],
  });

  pgm.createTable("operations", {
    organization_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    state: { type: "text", notNull: true },
    failure: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
  });
  pgm.addConstraint("operations", "operations_pkey", {
    primaryKey: ["organization_id", "operation_id"],
  });
  pgm.addConstraint("operations", "operations_operation_id_key", { unique: ["operation_id"] });
  pgm.addConstraint("operations", "operations_scope_key", {
    unique: ["organization_id", "project_id", "operation_id"],
  });
  pgm.addConstraint("operations", "operations_billing_epoch_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("operations", "operations_state_check", {
    check: "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
  });

  pgm.createTable("provider_resources", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    capability: { type: "text", notNull: true },
    provider: { type: "text", notNull: true },
    external_id: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    state: { type: "text", notNull: true },
  });
  pgm.addConstraint("provider_resources", "provider_resources_pkey", {
    primaryKey: ["organization_id", "operation_id", "capability"],
  });
  pgm.addConstraint("provider_resources", "provider_resources_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("provider_resources", "provider_resources_capability_check", {
    check:
      "capability IN ('static-hosting', 'edge-runtime', 'container-runtime', 'build', 'database', 'domain', 'mail', 'usage')",
  });
  pgm.addConstraint("provider_resources", "provider_resources_state_check", {
    check: "state IN ('pending', 'ready', 'failed', 'removed')",
  });
  pgm.addConstraint("provider_resources", "provider_resources_identity_check", {
    check:
      "provider = btrim(provider) AND length(provider) BETWEEN 1 AND 128 AND external_id = btrim(external_id) AND length(external_id) BETWEEN 1 AND 512",
  });
  pgm.addConstraint("provider_resources", "provider_resources_observation_check", {
    check: "observed_at >= created_at",
  });
  pgm.createIndex("provider_resources", ["capability", "provider", "external_id"], {
    unique: true,
  });

  pgm.createTable("operation_events", {
    organization_id: { type: "ulid", notNull: true },
    event_id: { type: "ulid", primaryKey: true },
    operation_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    revision: { type: "integer", notNull: true },
    event_type: { type: "text", notNull: true },
    idempotency_key: { type: "text" },
    payload: { type: "jsonb", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("operation_events", "operation_events_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("operation_events", "operation_events_revision_check", {
    check: "revision >= 0",
  });
  pgm.createIndex("operation_events", ["organization_id", "operation_id", "revision"], {
    unique: true,
  });
  pgm.createIndex("operation_events", ["organization_id", "operation_id", "idempotency_key"], {
    unique: true,
    where: "idempotency_key IS NOT NULL",
  });

  pgm.createTable("audit_events", {
    organization_id: { type: "ulid", notNull: true },
    audit_event_id: { type: "ulid", primaryKey: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid" },
    event_type: { type: "text", notNull: true },
    actor_type: { type: "text", notNull: true },
    actor_id: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    occurred_at: { type: "timestamptz", notNull: true },
    billing_epoch_id: { type: "ulid", notNull: true },
  });
  pgm.addConstraint("audit_events", "audit_events_billing_epoch_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("audit_events", "audit_events_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });

  pgm.createTable("outbox_events", {
    organization_id: { type: "ulid", notNull: true },
    event_id: { type: "ulid", primaryKey: true },
    project_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    event_type: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    initial_available_at: { type: "timestamptz", notNull: true },
    available_at: { type: "timestamptz", notNull: true },
    attempt_count: { type: "integer", notNull: true, default: 0 },
    max_attempts: { type: "integer", notNull: true },
    current_attempt_id: { type: "ulid" },
    claimed_at: { type: "timestamptz" },
    lease_expires_at: { type: "timestamptz" },
    last_error_code: { type: "text" },
    reconciliation_required_at: { type: "timestamptz" },
    acknowledged_at: { type: "timestamptz" },
    billing_epoch_id: { type: "ulid", notNull: true },
  });
  pgm.addConstraint("outbox_events", "outbox_events_attempts_check", {
    check: "attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts",
  });
  pgm.addConstraint("outbox_events", "outbox_events_reconciliation_check", {
    check:
      "reconciliation_required_at IS NULL OR (acknowledged_at IS NULL AND last_error_code IS NOT NULL)",
  });
  pgm.addConstraint("outbox_events", "outbox_events_error_code_check", {
    check: "last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'",
  });
  pgm.addConstraint("outbox_events", "outbox_events_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("outbox_events", "outbox_events_billing_epoch_fkey", {
    foreignKeys: {
      columns: ["billing_epoch_id", "project_id", "organization_id"],
      references: "billing_epochs (billing_epoch_id, project_id, organization_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.createIndex("outbox_events", ["available_at", "created_at", "event_id"], {
    where: "acknowledged_at IS NULL AND reconciliation_required_at IS NULL",
  });
  pgm.createIndex("outbox_events", ["lease_expires_at", "created_at", "event_id"], {
    name: "outbox_events_expired_final_lease_idx",
    where: `acknowledged_at IS NULL
      AND reconciliation_required_at IS NULL
      AND current_attempt_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND attempt_count = max_attempts`,
  });
  pgm.createIndex("audit_events", ["organization_id", "occurred_at", "audit_event_id"], {
    name: "audit_events_organization_cursor_idx",
  });

  pgm.createTable("delivery_attempts", {
    attempt_id: { type: "ulid", primaryKey: true },
    event_id: {
      type: "ulid",
      notNull: true,
      references: "outbox_events",
      onDelete: "RESTRICT",
    },
    attempt_number: { type: "integer", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true },
    lease_expires_at: { type: "timestamptz", notNull: true },
    failed_at: { type: "timestamptz" },
    next_available_at: { type: "timestamptz" },
    error_code: { type: "text" },
    acknowledged_at: { type: "timestamptz" },
    status: { type: "text", notNull: true },
  });
  pgm.addConstraint("delivery_attempts", "delivery_attempts_event_number_key", {
    unique: ["event_id", "attempt_number"],
  });
  pgm.addConstraint("delivery_attempts", "delivery_attempts_status_check", {
    check: "status IN ('claimed', 'retry_scheduled', 'reconciliation_required', 'acknowledged')",
  });
  pgm.addConstraint("delivery_attempts", "delivery_attempts_outcome_check", {
    check: `
      (status = 'claimed' AND failed_at IS NULL AND next_available_at IS NULL
        AND error_code IS NULL AND acknowledged_at IS NULL)
      OR (status = 'retry_scheduled' AND failed_at IS NOT NULL AND next_available_at IS NOT NULL
        AND error_code IS NOT NULL AND acknowledged_at IS NULL)
      OR (status = 'reconciliation_required' AND failed_at IS NOT NULL
        AND next_available_at IS NULL AND error_code IS NOT NULL AND acknowledged_at IS NULL)
      OR (status = 'acknowledged' AND failed_at IS NULL AND next_available_at IS NULL
        AND error_code IS NULL AND acknowledged_at IS NOT NULL)
    `,
  });
  pgm.addConstraint("delivery_attempts", "delivery_attempts_error_code_check", {
    check: "error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'",
  });

  pgm.sql(`
    CREATE FUNCTION require_project_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM project_ownerships WHERE project_id=NEW.project_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'projects must commit with ownership and billing epoch'
          USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER projects_require_ownership
      AFTER INSERT ON projects DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION require_project_ownership();

    CREATE FUNCTION require_remaining_project_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM projects WHERE project_id=OLD.project_id)
        AND NOT EXISTS (SELECT 1 FROM project_ownerships WHERE project_id=OLD.project_id) THEN
        RAISE EXCEPTION 'project ownership cannot be removed while the project exists'
          USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER project_ownerships_cannot_orphan
      AFTER DELETE OR UPDATE ON project_ownerships
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION require_remaining_project_ownership();

    CREATE FUNCTION require_active_current_owner() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM project_ownerships
        WHERE project_id=NEW.project_id AND organization_id=NEW.organization_id AND state='active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'current-state writes require active current project ownership'
          USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER operations_require_current_owner BEFORE INSERT ON operations
      FOR EACH ROW EXECUTE FUNCTION require_active_current_owner();
    CREATE TRIGGER environments_require_current_owner BEFORE INSERT OR UPDATE ON environments
      FOR EACH ROW EXECUTE FUNCTION require_active_current_owner();

    CREATE FUNCTION reject_project_identity_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.created_organization_id IS DISTINCT FROM OLD.created_organization_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'project creation identity is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER projects_identity_immutable BEFORE UPDATE ON projects
      FOR EACH ROW EXECUTE FUNCTION reject_project_identity_change();

    CREATE FUNCTION reject_event_scope_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.billing_epoch_id IS DISTINCT FROM OLD.billing_epoch_id THEN
        RAISE EXCEPTION 'event-time organization, project, and billing epoch are immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER operations_scope_immutable BEFORE UPDATE ON operations
      FOR EACH ROW EXECUTE FUNCTION reject_event_scope_change();
    CREATE TRIGGER outbox_events_scope_immutable BEFORE UPDATE ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION reject_event_scope_change();

    CREATE FUNCTION reject_append_only_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END;
    $$;

    CREATE TRIGGER operation_events_append_only
      BEFORE UPDATE OR DELETE ON operation_events
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

    CREATE TRIGGER audit_events_append_only
      BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}

export function down(pgm) {
  pgm.dropTrigger("audit_events", "audit_events_append_only");
  pgm.dropTrigger("operation_events", "operation_events_append_only");
  pgm.dropFunction("reject_append_only_change", []);
  pgm.dropTrigger("outbox_events", "outbox_events_scope_immutable");
  pgm.dropTrigger("operations", "operations_scope_immutable");
  pgm.dropFunction("reject_event_scope_change", []);
  pgm.dropTrigger("projects", "projects_identity_immutable");
  pgm.dropFunction("reject_project_identity_change", []);
  pgm.dropTrigger("projects", "projects_require_ownership");
  pgm.dropFunction("require_project_ownership", []);
  pgm.dropTrigger("project_ownerships", "project_ownerships_cannot_orphan");
  pgm.dropFunction("require_remaining_project_ownership", []);
  pgm.dropTrigger("operations", "operations_require_current_owner");
  pgm.dropTrigger("environments", "environments_require_current_owner");
  pgm.dropFunction("require_active_current_owner", []);
  pgm.dropTable("delivery_attempts");
  pgm.dropTable("outbox_events");
  pgm.dropTable("audit_events");
  pgm.dropTable("operation_events");
  pgm.dropTable("provider_resources");
  pgm.dropTable("operations");
  pgm.dropTable("environments");
  pgm.dropTable("project_transfer_intents");
  pgm.dropTable("project_ownerships");
  pgm.dropTable("billing_epochs");
  pgm.dropTable("projects");
  pgm.dropDomain("ulid");
}
