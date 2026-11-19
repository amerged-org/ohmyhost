export function up(pgm) {
  pgm.sql(`
    LOCK TABLE mail_credit_accounts,mail_send_requests,mail_credit_ledger IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM mail_send_requests WHERE state IN ('reserved','uncertain')) THEN
      RAISE EXCEPTION 'Resolve pending legacy mail before the shared-wallet cutover'; END IF; END $$;
    ALTER TABLE organization_credit_reservations DROP CONSTRAINT credit_reservation_shared_scope;
    ALTER TABLE organization_credit_reservations ADD CONSTRAINT credit_reservation_shared_scope
      CHECK(environment_id IS NOT NULL OR kind IN ('metered_usage','mail_send'));
    ALTER TABLE organization_credit_reservations ADD CONSTRAINT mail_reservation_project_identity
      UNIQUE(organization_id,project_id,reservation_id);
    ALTER TABLE mail_send_requests
      ADD COLUMN credit_reservation_id ulid UNIQUE,
      ADD COLUMN credit_rate_card_id text REFERENCES published_credit_rate_cards(rate_card_id),
      ADD COLUMN credit_meter text,
      ADD COLUMN credit_provider_cost_micros bigint,
      ADD CONSTRAINT mail_send_credit_scope FOREIGN KEY(organization_id,project_id,credit_reservation_id)
        REFERENCES organization_credit_reservations(organization_id,project_id,reservation_id),
      ADD CONSTRAINT mail_send_credit_quote CHECK(
        (credit_reservation_id IS NULL AND credit_rate_card_id IS NULL AND credit_meter IS NULL AND credit_provider_cost_micros IS NULL)
        OR (credit_reservation_id IS NOT NULL AND credit_rate_card_id IS NOT NULL AND credit_meter IS NOT NULL AND credit_provider_cost_micros IS NOT NULL AND credit_provider_cost_micros>0));
    CREATE TRIGGER retired_mail_accounts_readonly BEFORE INSERT OR UPDATE OR DELETE ON mail_credit_accounts
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TRIGGER retired_mail_ledger_readonly BEFORE INSERT ON mail_credit_ledger
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM mail_send_requests WHERE credit_reservation_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM organization_credit_reservations WHERE kind='mail_send' AND environment_id IS NULL)
      OR EXISTS(SELECT 1 FROM usage_meter_activations WHERE meter LIKE 'ses.%') THEN
      RAISE EXCEPTION 'Shared mail credit history must be retained'; END IF; END $$;
    DROP TRIGGER retired_mail_accounts_readonly ON mail_credit_accounts;
    DROP TRIGGER retired_mail_ledger_readonly ON mail_credit_ledger;
    ALTER TABLE mail_send_requests DROP CONSTRAINT mail_send_credit_scope, DROP CONSTRAINT mail_send_credit_quote,
      DROP COLUMN credit_reservation_id,DROP COLUMN credit_rate_card_id,DROP COLUMN credit_meter,DROP COLUMN credit_provider_cost_micros;
    ALTER TABLE organization_credit_reservations DROP CONSTRAINT credit_reservation_shared_scope;
    ALTER TABLE organization_credit_reservations DROP CONSTRAINT mail_reservation_project_identity;
    ALTER TABLE organization_credit_reservations ADD CONSTRAINT credit_reservation_shared_scope
      CHECK(environment_id IS NOT NULL OR kind='metered_usage');
  `);
}
