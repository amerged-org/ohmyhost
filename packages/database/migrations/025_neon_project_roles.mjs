export function up(pgm) {
  pgm.createTable("neon_project_role_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    provider_project_id: { type: "text", notNull: true },
    branch_id: { type: "text", notNull: true },
    role_name: { type: "text", notNull: true },
    operation_ids: { type: "uuid[]", notNull: true },
    state: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("neon_project_role_receipts", "neon_project_role_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "role_name"],
  });
  pgm.addConstraint("neon_project_role_receipts", "neon_project_role_receipts_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "neon_project_placement_receipts (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("neon_project_role_receipts", "neon_project_role_receipts_shape", {
    check: `provider_project_id~'^[a-z0-9-]{1,60}$'
      AND branch_id~'^[a-z0-9-]{1,60}$'
      AND role_name IN ('ohmyho_migration','ohmyho_readonly','ohmyho_runtime')
      AND cardinality(operation_ids)<=128
      AND state='ready'`,
  });
  pgm.createTrigger("neon_project_role_receipts", "neon_project_role_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("neon_project_role_reservations", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    provider_project_id: { type: "text", notNull: true },
    branch_id: { type: "text", notNull: true },
    role_name: { type: "text", notNull: true },
    reserved_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    create_started_at: { type: "timestamptz" },
  });
  pgm.addConstraint("neon_project_role_reservations", "neon_project_role_reservations_pkey", {
    primaryKey: ["organization_id", "project_id", "role_name"],
  });
  pgm.addConstraint("neon_project_role_reservations", "neon_project_role_reservations_claim_fkey", {
    foreignKeys: {
      columns: ["claim_id", "organization_id", "project_id", "environment_id", "operation_id"],
      references:
        "product_provider_mutation_claims (claim_id, organization_id, project_id, environment_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint(
    "neon_project_role_reservations",
    "neon_project_role_reservations_project_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id"],
        references: "neon_project_placement_receipts (organization_id, project_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint("neon_project_role_reservations", "neon_project_role_reservations_shape", {
    check: `provider_project_id~'^[a-z0-9-]{1,60}$'
      AND branch_id~'^[a-z0-9-]{1,60}$'
      AND role_name IN ('ohmyho_migration','ohmyho_readonly','ohmyho_runtime')
      AND (create_started_at IS NULL OR create_started_at>=reserved_at)`,
  });
  pgm.sql(`CREATE FUNCTION guard_neon_project_role_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        IF NOT EXISTS (
          SELECT 1 FROM neon_project_role_receipts receipt
          WHERE receipt.organization_id=OLD.organization_id AND receipt.project_id=OLD.project_id
            AND receipt.role_name=OLD.role_name AND receipt.claim_id=OLD.claim_id
        ) THEN RAISE EXCEPTION 'active Neon role reservation cannot be deleted'
          USING ERRCODE='55000'; END IF;
        RETURN OLD;
      END IF;
      IF OLD.create_started_at IS NOT NULL OR NEW.create_started_at IS NULL
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
        OR NEW.provider_project_id IS DISTINCT FROM OLD.provider_project_id
        OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
        OR NEW.role_name IS DISTINCT FROM OLD.role_name
        OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
        RAISE EXCEPTION 'Neon role reservation permits only one create authorization'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END
  $$`);
  pgm.createTrigger(
    "neon_project_role_reservations",
    "neon_project_role_reservations_change_guard",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "guard_neon_project_role_reservation_change",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM neon_project_role_receipts)
      OR EXISTS (SELECT 1 FROM neon_project_role_reservations) THEN
      RAISE EXCEPTION 'Neon role evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("neon_project_role_reservations");
  pgm.sql("DROP FUNCTION guard_neon_project_role_reservation_change()");
  pgm.dropTable("neon_project_role_receipts");
}
