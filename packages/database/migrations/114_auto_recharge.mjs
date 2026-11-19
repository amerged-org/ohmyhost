export function up(pgm) {
  pgm.sql(`
    CREATE TABLE stripe_recharge_policies (
      organization_id ulid PRIMARY KEY REFERENCES workos_organization_mappings(organization_id),
      account_id text NOT NULL, mode text NOT NULL CHECK(mode IN ('test','live')),
      enabled boolean NOT NULL, revision integer NOT NULL CHECK(revision>0),
      monthly_limit_minor integer NOT NULL CHECK(monthly_limit_minor BETWEEN 1000 AND 100000),
      status text NOT NULL CHECK(status IN ('off','setup_required','on','payment_required','monthly_limit','needs_reconciliation')),
      setup_id ulid NOT NULL, setup_session_id text, payment_method_id text,
      updated_at timestamptz NOT NULL, checked_at timestamptz
    );
    CREATE TABLE stripe_recharge_consents (
      id ulid PRIMARY KEY, organization_id ulid NOT NULL REFERENCES stripe_recharge_policies(organization_id),
      actor_id text NOT NULL, key_hash bytea NOT NULL, payload_hash bytea NOT NULL,
      enabled boolean NOT NULL, monthly_limit_minor integer NOT NULL, consent_version text,
      occurred_at timestamptz NOT NULL, UNIQUE(organization_id,actor_id,key_hash)
    );
    CREATE TRIGGER stripe_recharge_consents_append_only BEFORE UPDATE OR DELETE ON stripe_recharge_consents FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TABLE stripe_recharge_attempts (
      id ulid PRIMARY KEY, organization_id ulid NOT NULL REFERENCES stripe_recharge_policies(organization_id),
      account_id text NOT NULL, mode text NOT NULL, policy_revision integer NOT NULL,
      payment_method_id text NOT NULL, created_at timestamptz NOT NULL,
      remaining_minor integer NOT NULL CHECK(remaining_minor>=900),
      state text NOT NULL CHECK(state IN ('creating','draft','paying','paid','void','needs_reconciliation')),
      invoice_id text, payment_intent_id text, total_minor integer CHECK(total_minor>=900),
      grant_id ulid REFERENCES organization_credit_grants(grant_id),
      checked_at timestamptz, refunded_minor integer NOT NULL DEFAULT 0,
      UNIQUE(account_id,mode,invoice_id), UNIQUE(account_id,mode,payment_intent_id)
    );
    CREATE UNIQUE INDEX stripe_recharge_one_unresolved ON stripe_recharge_attempts(organization_id) WHERE state NOT IN ('paid','void');
    CREATE TABLE stripe_recharge_reversal_observations (
      attempt_id ulid NOT NULL REFERENCES stripe_recharge_attempts(id), account_id text NOT NULL,mode text NOT NULL,
      kind text NOT NULL CHECK(kind IN ('refund','dispute')), reference_id text NOT NULL,group_id text NOT NULL,
      status text NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled','withdrawn','reinstated')),
      amount_minor integer NOT NULL CHECK(amount_minor>0),observed_at timestamptz NOT NULL,
      PRIMARY KEY(account_id,mode,reference_id,status)
    );
    CREATE TRIGGER stripe_recharge_reversals_append_only BEFORE UPDATE OR DELETE ON stripe_recharge_reversal_observations FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') AND has_table_privilege('control_runtime','stripe_checkout_requests','INSERT') THEN
      GRANT SELECT,INSERT,UPDATE ON stripe_recharge_policies,stripe_recharge_attempts TO control_runtime;
      GRANT SELECT,INSERT ON stripe_recharge_consents,stripe_recharge_reversal_observations TO control_runtime;
    END IF; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(
    `DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_recharge_consents) THEN RAISE EXCEPTION 'Recharge consent and financial history must be retained'; END IF; END $$;`,
  );
  pgm.dropTable("stripe_recharge_reversal_observations");
  pgm.dropTable("stripe_recharge_attempts");
  pgm.dropTable("stripe_recharge_consents");
  pgm.dropTable("stripe_recharge_policies");
}
