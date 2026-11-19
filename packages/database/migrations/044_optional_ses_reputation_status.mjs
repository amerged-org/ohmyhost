const CONSTRAINT = "ses_tenant_receipts_shape";

export function up(pgm) {
  replaceConstraint(pgm, true);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM ses_tenant_receipts
    WHERE aws_managed_status='unknown' OR customer_managed_status='unknown'
  ) THEN RAISE EXCEPTION 'optional SES reputation evidence prevents a lossless migration downgrade'
    USING ERRCODE='23514'; END IF; END $$`);
  replaceConstraint(pgm, false);
}

function replaceConstraint(pgm, allowUnknown) {
  const componentStatuses = allowUnknown
    ? "'enabled','reinstated','disabled','unknown'"
    : "'enabled','reinstated','disabled'";
  pgm.dropConstraint("ses_tenant_receipts", CONSTRAINT);
  pgm.addConstraint("ses_tenant_receipts", CONSTRAINT, {
    check: `accepted_lifecycle_version>=1
      AND provider='aws-ses-v2'
      AND region~'^[a-z]{2}(-[a-z]+)+-[0-9]$'
      AND tenant_name~'^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}$'
      AND tenant_id~'^[A-Za-z0-9_-]{1,128}$'
      AND tenant_arn~'^arn:aws:ses:[a-z]{2}(-[a-z]+)+-[0-9]:[0-9]{12}:tenant/ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}/[A-Za-z0-9_-]{1,128}$'
      AND sending_status IN ('enabled','reinstated','disabled')
      AND reputation_policy_arn=('arn:aws:ses:'||region||':aws:reputation-policy/standard')
      AND aws_managed_status IN (${componentStatuses})
      AND customer_managed_status IN (${componentStatuses})
      AND aggregate_sending_status IN ('enabled','reinstated','disabled')
      AND reputation_observed_at>=provider_created_at
      AND observed_at>=provider_created_at`,
  });
}
