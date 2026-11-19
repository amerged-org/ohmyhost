export function up(pgm) {
  pgm.createTable("container_worker_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    created_operation_id: { type: "ulid", notNull: true },
    script_name: { type: "text", notNull: true },
    module_digest: { type: "bytea", notNull: true },
    durable_object_namespace_id: { type: "uuid", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_script_key", {
    unique: ["script_name"],
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_namespace_key", {
    unique: ["durable_object_namespace_id"],
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "created_operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("container_worker_receipts", "container_worker_receipts_shape", {
    check: `script_name='r-'||lower(project_id::text) AND octet_length(module_digest)=32`,
  });
  pgm.createTrigger("container_worker_receipts", "container_worker_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM container_worker_receipts) THEN
    RAISE EXCEPTION 'Container Worker evidence prevents a lossless migration downgrade'
      USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropTable("container_worker_receipts");
}
