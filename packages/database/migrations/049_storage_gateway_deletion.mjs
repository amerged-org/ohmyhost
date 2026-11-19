export function up(pgm) {
  pgm.createTable("project_r2_delete_requests", {
    deletion_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    idempotency_key: { type: "varchar(128)", notNull: true },
    request_sha256: { type: "bytea", notNull: true },
    object_key: { type: "text", notNull: true },
    requested_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_idempotency_key", {
    unique: ["organization_id", "project_id", "environment_id", "idempotency_key"],
  });
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_object_key", {
    unique: ["organization_id", "project_id", "environment_id", "object_key"],
  });
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_bucket_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "project_r2_bucket_receipts (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_shape", {
    check: `octet_length(request_sha256)=32 AND octet_length(object_key) BETWEEN 1 AND 512
      AND object_key!~'(^/|/$|//|(^|/)\\.{1,2}(/|$)|[^A-Za-z0-9._/-])'`,
  });
  pgm.createTrigger("project_r2_delete_requests", "project_r2_delete_requests_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("project_r2_delete_receipts", {
    deletion_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    object_key: { type: "text", notNull: true },
    deleted_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("project_r2_delete_receipts", "project_r2_delete_receipts_object_key", {
    unique: ["organization_id", "project_id", "environment_id", "object_key"],
  });
  pgm.addConstraint("project_r2_delete_receipts", "project_r2_delete_receipts_request_fkey", {
    foreignKeys: {
      columns: ["deletion_id"],
      references: "project_r2_delete_requests (deletion_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.createTrigger("project_r2_delete_receipts", "project_r2_delete_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_r2_delete_requests)
      OR EXISTS (SELECT 1 FROM project_r2_delete_receipts) THEN
      RAISE EXCEPTION 'storage deletion evidence prevents a migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("project_r2_delete_receipts");
  pgm.dropTable("project_r2_delete_requests");
}
