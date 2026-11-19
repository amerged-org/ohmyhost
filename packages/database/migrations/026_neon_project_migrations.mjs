export function up(pgm) {
  pgm.createTable("neon_project_migration_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    provider_project_id: { type: "text", notNull: true },
    branch_id: { type: "text", notNull: true },
    bundle_sha256: { type: "bytea", notNull: true },
    applied_paths: { type: "text[]", notNull: true },
    replayed_paths: { type: "text[]", notNull: true },
    completed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("neon_project_migration_receipts", "neon_project_migration_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "operation_id"],
  });
  pgm.addConstraint(
    "neon_project_migration_receipts",
    "neon_project_migration_receipts_operation_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "operation_id"],
        references: "operations (organization_id, project_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint("neon_project_migration_receipts", "neon_project_migration_receipts_shape", {
    check: `provider_project_id~'^[a-z0-9-]{1,60}$'
      AND branch_id~'^[a-z0-9-]{1,60}$'
      AND octet_length(bundle_sha256)=32
      AND cardinality(applied_paths)<=128 AND cardinality(replayed_paths)<=128`,
  });
  pgm.createTrigger(
    "neon_project_migration_receipts",
    "neon_project_migration_receipts_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM neon_project_migration_receipts) THEN
      RAISE EXCEPTION 'Neon migration evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("neon_project_migration_receipts");
}
