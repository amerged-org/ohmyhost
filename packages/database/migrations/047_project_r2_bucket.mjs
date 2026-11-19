export function up(pgm) {
  pgm.createTable("project_r2_bucket_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    bucket_name: { type: "text", notNull: true },
    provider_bucket_id: { type: "text", notNull: true },
    jurisdiction: { type: "text", notNull: true },
    storage_class: { type: "text", notNull: true },
    public_access: { type: "boolean", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("project_r2_bucket_receipts", "project_r2_bucket_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id"],
  });
  pgm.addConstraint("project_r2_bucket_receipts", "project_r2_bucket_receipts_name_key", {
    unique: ["bucket_name"],
  });
  pgm.addConstraint("project_r2_bucket_receipts", "project_r2_bucket_receipts_id_key", {
    unique: ["provider_bucket_id"],
  });
  pgm.addConstraint("project_r2_bucket_receipts", "project_r2_bucket_receipts_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_r2_bucket_receipts", "project_r2_bucket_receipts_shape", {
    check: `bucket_name='ohmyho-'||lower(project_id::text)||'-'||lower(environment_id::text)
      AND provider_bucket_id~'^[0-9a-f]{32}$' AND jurisdiction='eu'
      AND storage_class='Standard' AND NOT public_access`,
  });
  pgm.createTrigger("project_r2_bucket_receipts", "project_r2_bucket_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("project_r2_bucket_reservations", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    bucket_name: { type: "text", notNull: true },
    jurisdiction: { type: "text", notNull: true },
    storage_class: { type: "text", notNull: true },
    public_access: { type: "boolean", notNull: true },
    reserved_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    create_started_at: { type: "timestamptz" },
  });
  pgm.addConstraint("project_r2_bucket_reservations", "project_r2_bucket_reservations_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id"],
  });
  pgm.addConstraint("project_r2_bucket_reservations", "project_r2_bucket_reservations_claim_fkey", {
    foreignKeys: {
      columns: ["claim_id", "organization_id", "project_id", "environment_id", "operation_id"],
      references:
        "product_provider_mutation_claims (claim_id, organization_id, project_id, environment_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_r2_bucket_reservations", "project_r2_bucket_reservations_shape", {
    check: `bucket_name='ohmyho-'||lower(project_id::text)||'-'||lower(environment_id::text)
      AND jurisdiction='eu' AND storage_class='Standard' AND NOT public_access
      AND (create_started_at IS NULL OR create_started_at>=reserved_at)`,
  });
  pgm.sql(`CREATE FUNCTION guard_project_r2_bucket_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN
        IF NOT EXISTS (
          SELECT 1 FROM project_r2_bucket_receipts receipt
          WHERE receipt.organization_id=OLD.organization_id AND receipt.project_id=OLD.project_id
            AND receipt.environment_id=OLD.environment_id AND receipt.claim_id=OLD.claim_id
        ) THEN RAISE EXCEPTION 'active R2 bucket reservation cannot be deleted'
          USING ERRCODE='55000'; END IF;
        RETURN OLD;
      END IF;
      IF OLD.create_started_at IS NOT NULL OR NEW.create_started_at IS NULL
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
        OR NEW.bucket_name IS DISTINCT FROM OLD.bucket_name
        OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
        OR NEW.storage_class IS DISTINCT FROM OLD.storage_class
        OR NEW.public_access IS DISTINCT FROM OLD.public_access
        OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
        RAISE EXCEPTION 'R2 bucket reservation permits only one create authorization'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.createTrigger(
    "project_r2_bucket_reservations",
    "project_r2_bucket_reservations_change_guard",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "guard_project_r2_bucket_reservation_change",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_r2_bucket_receipts)
      OR EXISTS (SELECT 1 FROM project_r2_bucket_reservations) THEN
      RAISE EXCEPTION 'R2 bucket evidence prevents a migration downgrade' USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("project_r2_bucket_reservations");
  pgm.sql("DROP FUNCTION guard_project_r2_bucket_reservation_change()");
  pgm.dropTable("project_r2_bucket_receipts");
}
