export function up(pgm) {
  pgm.createTable("ses_project_mail_resource_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    accepted_lifecycle_version: { type: "integer", notNull: true },
    region: { type: "text", notNull: true },
    configuration_set_name: { type: "text", notNull: true },
    configuration_set_arn: { type: "text", notNull: true },
    tenant_name: { type: "text", notNull: true },
    tenant_id: { type: "text", notNull: true },
    associated_at: { type: "timestamptz", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint(
    "ses_project_mail_resource_receipts",
    "ses_project_mail_resource_receipts_pkey",
    {
      primaryKey: ["organization_id", "project_id"],
    },
  );
  pgm.addConstraint(
    "ses_project_mail_resource_receipts",
    "ses_project_mail_resource_receipts_arn_key",
    {
      unique: ["configuration_set_arn"],
    },
  );
  pgm.addConstraint(
    "ses_project_mail_resource_receipts",
    "ses_project_mail_resource_receipts_tenant_fkey",
    {
      foreignKeys: {
        columns: ["organization_id", "project_id"],
        references: "ses_tenant_receipts (organization_id, project_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint(
    "ses_project_mail_resource_receipts",
    "ses_project_mail_resource_receipts_shape",
    {
      check: `accepted_lifecycle_version>=1
      AND region~'^[a-z]{2}(-[a-z]+)+-[0-9]$'
      AND configuration_set_name~'^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}$'
      AND configuration_set_arn~'^arn:aws:ses:[a-z]{2}(-[a-z]+)+-[0-9]:[0-9]{12}:configuration-set/ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}$'
      AND tenant_name=configuration_set_name
      AND tenant_id~'^[A-Za-z0-9_-]{1,128}$'
      AND observed_at>=associated_at`,
    },
  );
  pgm.createTrigger(
    "ses_project_mail_resource_receipts",
    "ses_project_mail_resource_receipts_append_only",
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
    IF EXISTS (SELECT 1 FROM ses_project_mail_resource_receipts) THEN
      RAISE EXCEPTION 'SES project mail evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("ses_project_mail_resource_receipts");
}
