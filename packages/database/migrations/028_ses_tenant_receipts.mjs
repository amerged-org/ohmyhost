export function up(pgm) {
  pgm.createTable("ses_tenant_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    accepted_lifecycle_version: { type: "integer", notNull: true },
    provider: { type: "text", notNull: true },
    region: { type: "text", notNull: true },
    tenant_name: { type: "text", notNull: true },
    tenant_id: { type: "text", notNull: true },
    tenant_arn: { type: "text", notNull: true },
    sending_status: { type: "text", notNull: true },
    reputation_policy_arn: { type: "text", notNull: true },
    aws_managed_status: { type: "text", notNull: true },
    customer_managed_status: { type: "text", notNull: true },
    aggregate_sending_status: { type: "text", notNull: true },
    provider_created_at: { type: "timestamptz", notNull: true },
    reputation_observed_at: { type: "timestamptz", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("ses_tenant_receipts", "ses_tenant_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("ses_tenant_receipts", "ses_tenant_receipts_tenant_name_key", {
    unique: ["region", "tenant_name"],
  });
  pgm.addConstraint("ses_tenant_receipts", "ses_tenant_receipts_tenant_id_key", {
    unique: ["region", "tenant_id"],
  });
  pgm.addConstraint("ses_tenant_receipts", "ses_tenant_receipts_tenant_arn_key", {
    unique: ["tenant_arn"],
  });
  pgm.addConstraint("ses_tenant_receipts", "ses_tenant_receipts_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ses_tenant_receipts", "ses_tenant_receipts_shape", {
    check: `accepted_lifecycle_version>=1
      AND provider='aws-ses-v2'
      AND region~'^[a-z]{2}(-[a-z]+)+-[0-9]$'
      AND tenant_name~'^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}$'
      AND tenant_id~'^[A-Za-z0-9_-]{1,128}$'
      AND tenant_arn~'^arn:aws:ses:[a-z]{2}(-[a-z]+)+-[0-9]:[0-9]{12}:tenant/ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}/[A-Za-z0-9_-]{1,128}$'
      AND sending_status IN ('enabled','reinstated','disabled')
      AND reputation_policy_arn=('arn:aws:ses:'||region||':aws:reputation-policy/standard')
      AND aws_managed_status IN ('enabled','reinstated','disabled')
      AND customer_managed_status IN ('enabled','reinstated','disabled')
      AND aggregate_sending_status IN ('enabled','reinstated','disabled')
      AND reputation_observed_at>=provider_created_at
      AND observed_at>=provider_created_at`,
  });
  pgm.createTrigger("ses_tenant_receipts", "ses_tenant_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM ses_tenant_receipts) THEN
      RAISE EXCEPTION 'SES tenant evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("ses_tenant_receipts");
}
