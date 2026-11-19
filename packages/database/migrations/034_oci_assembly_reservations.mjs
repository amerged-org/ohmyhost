export function up(pgm) {
  pgm.createTable("oci_assembly_input_reservations", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    input_fingerprint: { type: "bytea", notNull: true },
    claim_id: { type: "text", notNull: true },
    claim_mode: { type: "text", notNull: true },
    claimed_at: { type: "timestamptz", notNull: true },
    lease_expires_at: { type: "timestamptz", notNull: true },
    attempt_number: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    start_allowed_until: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("oci_assembly_input_reservations", "oci_assembly_input_reservations_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint(
    "oci_assembly_input_reservations",
    "oci_assembly_input_reservations_claim_id_key",
    { unique: ["claim_id"] },
  );
  pgm.addConstraint(
    "oci_assembly_input_reservations",
    "oci_assembly_input_reservations_environment_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "environments (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "oci_assembly_input_reservations",
    "oci_assembly_input_reservations_operation_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id", "operation_id"],
        references: "operations (organization_id, project_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint("oci_assembly_input_reservations", "oci_assembly_input_reservations_shape", {
    check: `octet_length(input_fingerprint)=32
      AND claim_id~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND claim_mode IN ('start','observe')
      AND attempt_number>0 AND claimed_at>=created_at
      AND lease_expires_at>claimed_at
      AND lease_expires_at<=claimed_at+interval '300 seconds'
      AND start_allowed_until=created_at+interval '4 minutes'
      AND (claim_mode='observe' OR claimed_at<start_allowed_until)`,
  });

  pgm.createTable("oci_assembly_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    provider_build_id: { type: "text", notNull: true },
    codebuild_project_name: { type: "text", notNull: true },
    input_fingerprint: { type: "bytea", notNull: true },
    assembly_claim_id: { type: "text", notNull: true },
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_build_id_key", {
    unique: ["provider_build_id"],
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("oci_assembly_receipts", "oci_assembly_receipts_shape", {
    check: `length(provider_build_id) BETWEEN 1 AND 512
      AND length(codebuild_project_name) BETWEEN 1 AND 255
      AND octet_length(input_fingerprint)=32
      AND assembly_claim_id~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
  });
  pgm.createTrigger("oci_assembly_receipts", "oci_assembly_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.sql(`CREATE FUNCTION enforce_oci_assembly_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'oci_assembly_input_reservations is append-only' USING ERRCODE='55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM oci_assembly_receipts receipt
        WHERE receipt.organization_id=OLD.organization_id
          AND receipt.project_id=OLD.project_id
          AND receipt.environment_id=OLD.environment_id
          AND receipt.operation_id=OLD.operation_id
      ) OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.start_allowed_until IS DISTINCT FROM OLD.start_allowed_until
        OR NEW.claim_id=OLD.claim_id
        OR OLD.lease_expires_at>NEW.claimed_at
        OR NEW.claimed_at<=OLD.claimed_at
        OR NEW.lease_expires_at<=OLD.lease_expires_at
        OR NEW.attempt_number<>OLD.attempt_number+1
        OR (OLD.claim_mode='observe' AND NEW.claim_mode<>'observe')
        OR (NEW.claim_mode='start' AND NEW.claimed_at>=NEW.start_allowed_until) THEN
        RAISE EXCEPTION 'oci_assembly_input_reservations permits only expired claim renewal'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.createTrigger("oci_assembly_input_reservations", "oci_assembly_input_reservations_guard", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "enforce_oci_assembly_reservation_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM oci_assembly_receipts)
       OR EXISTS (SELECT 1 FROM oci_assembly_input_reservations) THEN
      RAISE EXCEPTION 'OCI assembly evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTrigger("oci_assembly_input_reservations", "oci_assembly_input_reservations_guard");
  pgm.dropFunction("enforce_oci_assembly_reservation_change", []);
  pgm.dropTable("oci_assembly_receipts");
  pgm.dropTable("oci_assembly_input_reservations");
}
