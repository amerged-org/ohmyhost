export function up(pgm) {
  pgm.createTable("ecr_image_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    deployment_id: { type: "ulid", notNull: true },
    registry_id: { type: "text", notNull: true },
    repository_name: { type: "text", notNull: true },
    repository_url: { type: "text", notNull: true },
    image_digest: { type: "bytea", notNull: true },
    image_tag: { type: "text", notNull: true },
    image_reference: { type: "text", notNull: true },
    published_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_pkey", {
    primaryKey: ["organization_id", "project_id", "environment_id", "operation_id"],
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_deployment_key", {
    unique: ["organization_id", "project_id", "deployment_id"],
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_operation_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "operation_id"],
      references: "operations (organization_id, project_id, operation_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ecr_image_receipts", "ecr_image_receipts_shape", {
    check: `registry_id~'^[0-9]{12}$'
      AND repository_name~'^[a-z0-9]+([._/-][a-z0-9]+)*$'
      AND repository_url~'^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9]+([._/-][a-z0-9]+)*$'
      AND octet_length(image_digest)=32
      AND image_tag='deployment-'||lower(deployment_id::text)
      AND image_reference=repository_url||'@sha256:'||encode(image_digest,'hex')`,
  });
  pgm.createTrigger("ecr_image_receipts", "ecr_image_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM ecr_image_receipts) THEN
    RAISE EXCEPTION 'ECR image evidence prevents a lossless migration downgrade'
      USING ERRCODE='23514'; END IF; END $$`);
  pgm.dropTable("ecr_image_receipts");
}
