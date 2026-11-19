export function up(pgm) {
  pgm.createTable("storage_gateway_keys", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    key_version: { type: "integer", notNull: true },
    key_sha256: { type: "bytea", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("storage_gateway_keys", "storage_gateway_keys_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id"],
  });
  pgm.addConstraint("storage_gateway_keys", "storage_gateway_keys_bucket_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "project_r2_bucket_receipts (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("storage_gateway_keys", "storage_gateway_keys_shape", {
    check: "key_version=1 AND octet_length(key_sha256)=32",
  });
  pgm.createTrigger("storage_gateway_keys", "storage_gateway_keys_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("project_r2_upload_reservations", {
    transfer_id: { type: "ulid", primaryKey: true },
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    idempotency_key: { type: "varchar(128)", notNull: true },
    request_sha256: { type: "bytea", notNull: true },
    object_key: { type: "text", notNull: true },
    content_type: { type: "text", notNull: true },
    expected_bytes: { type: "bigint", notNull: true },
    requested_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("project_r2_upload_reservations", "project_r2_upload_idempotency_key", {
    unique: ["organization_id", "project_id", "environment_id", "idempotency_key"],
  });
  pgm.addConstraint("project_r2_upload_reservations", "project_r2_upload_object_key", {
    unique: ["organization_id", "project_id", "environment_id", "object_key"],
  });
  pgm.addConstraint("project_r2_upload_reservations", "project_r2_upload_bucket_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "project_r2_bucket_receipts (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_r2_upload_reservations", "project_r2_upload_shape", {
    check: `octet_length(request_sha256)=32 AND expected_bytes BETWEEN 0 AND 1073741824
      AND expires_at>requested_at AND expires_at<=requested_at+interval '5 minutes'
      AND octet_length(object_key) BETWEEN 1 AND 512
      AND object_key!~'(^/|/$|//|(^|/)\\.{1,2}(/|$)|[^A-Za-z0-9._/-])'
      AND content_type~'^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$'`,
  });
  pgm.createTrigger(
    "project_r2_upload_reservations",
    "project_r2_upload_reservations_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );

  pgm.createTable("project_r2_objects", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    transfer_id: { type: "ulid", notNull: true, unique: true },
    object_key: { type: "text", notNull: true },
    content_type: { type: "text", notNull: true },
    size: { type: "bigint", notNull: true },
    etag: { type: "text", notNull: true },
    uploaded_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("project_r2_objects", "project_r2_objects_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "object_key"],
  });
  pgm.addConstraint("project_r2_objects", "project_r2_objects_transfer_fkey", {
    foreignKeys: {
      columns: ["transfer_id"],
      references: "project_r2_upload_reservations (transfer_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_r2_objects", "project_r2_objects_shape", {
    check: "size BETWEEN 0 AND 1073741824 AND etag~'^[0-9a-f]{32}(-[1-9][0-9]{0,4})?$'",
  });
  pgm.createTrigger("project_r2_objects", "project_r2_objects_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM storage_gateway_keys)
      OR EXISTS (SELECT 1 FROM project_r2_upload_reservations)
      OR EXISTS (SELECT 1 FROM project_r2_objects) THEN
      RAISE EXCEPTION 'storage gateway evidence prevents a migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("project_r2_objects");
  pgm.dropTable("project_r2_upload_reservations");
  pgm.dropTable("storage_gateway_keys");
}
