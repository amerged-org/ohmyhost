export function up(pgm) {
  pgm.sql(`
    ALTER TABLE stripe_recharge_policies DROP CONSTRAINT stripe_recharge_policies_status_check;
    ALTER TABLE stripe_recharge_policies ADD CONSTRAINT stripe_recharge_policies_status_check CHECK(status IN ('off','setup_required','on','payment_required','monthly_limit','needs_reconciliation','tax_required'));
    ALTER TABLE stripe_recharge_attempts ADD COLUMN tax_issue_code text CHECK(tax_issue_code IN ('billing_tax_location_required','billing_tax_calculation_failed','billing_tax_configuration_required'));
    CREATE TABLE stripe_billing_tax_issues (
      organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
      account_id text NOT NULL, mode text NOT NULL CHECK(mode IN ('test','live')),
      invoice_id text NOT NULL CHECK(invoice_id ~ '^in_[A-Za-z0-9_]{1,253}$'),
      code text NOT NULL CHECK(code IN ('billing_tax_location_required','billing_tax_calculation_failed','billing_tax_configuration_required')),
      observed_at timestamptz NOT NULL, resolved_at timestamptz,
      PRIMARY KEY(account_id,mode,invoice_id)
    );
    CREATE INDEX stripe_billing_tax_active ON stripe_billing_tax_issues(organization_id,observed_at DESC) WHERE resolved_at IS NULL;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') AND has_table_privilege('control_runtime','stripe_checkout_requests','INSERT') THEN
      GRANT SELECT,INSERT,UPDATE ON stripe_billing_tax_issues TO control_runtime;
    END IF; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_billing_tax_issues) OR EXISTS(SELECT 1 FROM stripe_recharge_attempts WHERE tax_issue_code IS NOT NULL) THEN RAISE EXCEPTION 'Billing tax issue history must be retained'; END IF; END $$;`,
  );
  pgm.dropTable("stripe_billing_tax_issues");
  pgm.dropColumn("stripe_recharge_attempts", "tax_issue_code");
  pgm.sql(
    `ALTER TABLE stripe_recharge_policies DROP CONSTRAINT stripe_recharge_policies_status_check; ALTER TABLE stripe_recharge_policies ADD CONSTRAINT stripe_recharge_policies_status_check CHECK(status IN ('off','setup_required','on','payment_required','monthly_limit','needs_reconciliation'));`,
  );
}
