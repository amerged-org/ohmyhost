export function up(pgm) {
  pgm.sql(`
    CREATE TABLE stripe_billing_customers (
      organization_id ulid PRIMARY KEY REFERENCES workos_organization_mappings(organization_id),
      request_id ulid NOT NULL UNIQUE,
      account_id text NOT NULL CHECK(account_id ~ '^acct_[A-Za-z0-9_]{1,128}$'),
      mode text NOT NULL CHECK(mode IN ('test','live')),
      created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 255),
      created_at timestamptz NOT NULL,
      provider_id text CHECK(provider_id ~ '^cus_[A-Za-z0-9_]{1,128}$'),
      provider_confirmed_at timestamptz,
      CHECK((provider_id IS NULL AND provider_confirmed_at IS NULL) OR (provider_id IS NOT NULL AND provider_confirmed_at IS NOT NULL AND provider_confirmed_at>=created_at)),
      UNIQUE(account_id,mode,provider_id),
      UNIQUE(organization_id,account_id,mode,provider_id)
    );
    CREATE TABLE stripe_checkout_requests (
      checkout_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      account_id text NOT NULL,
      mode text NOT NULL,
      customer_id text NOT NULL,
      created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 255),
      idempotency_key_sha256 bytea NOT NULL CHECK(octet_length(idempotency_key_sha256)=32),
      offer text NOT NULL CHECK(offer IN ('paid','topup')),
      packs integer NOT NULL CHECK(packs BETWEEN 1 AND 100 AND (offer='topup' OR packs=1)),
      price_id text NOT NULL CHECK(price_id ~ '^price_[A-Za-z0-9_]{1,128}$'),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours'),
      provider_id text CHECK(provider_id ~ '^cs_[A-Za-z0-9_]+$' AND length(provider_id)<=256),
      provider_confirmed_at timestamptz,
      CHECK((provider_id IS NULL AND provider_confirmed_at IS NULL) OR (provider_id IS NOT NULL AND provider_confirmed_at IS NOT NULL AND provider_confirmed_at>=created_at)),
      FOREIGN KEY(organization_id,account_id,mode,customer_id) REFERENCES stripe_billing_customers(organization_id,account_id,mode,provider_id),
      UNIQUE(organization_id,created_by,idempotency_key_sha256),
      UNIQUE(account_id,mode,provider_id),
      UNIQUE(checkout_id,organization_id,account_id,mode,provider_id)
    );
    CREATE TABLE stripe_topup_payments (
      checkout_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      account_id text NOT NULL,
      mode text NOT NULL,
      session_id text NOT NULL,
      payment_intent_id text NOT NULL CHECK(payment_intent_id ~ '^pi_[A-Za-z0-9_]+$' AND length(payment_intent_id)<=256),
      amount_subtotal_minor bigint NOT NULL CHECK(amount_subtotal_minor>0),
      amount_total_minor bigint NOT NULL CHECK(amount_total_minor>=amount_subtotal_minor),
      currency text NOT NULL CHECK(currency='usd'),
      credited_micros bigint NOT NULL CHECK(credited_micros=amount_subtotal_minor*1000000),
      grant_id ulid NOT NULL,
      confirmed_at timestamptz NOT NULL,
      UNIQUE(account_id,mode,payment_intent_id),
      FOREIGN KEY(checkout_id,organization_id,account_id,mode,session_id) REFERENCES stripe_checkout_requests(checkout_id,organization_id,account_id,mode,provider_id),
      FOREIGN KEY(organization_id,grant_id) REFERENCES organization_credit_grants(organization_id,grant_id)
    );
    CREATE FUNCTION protect_stripe_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing intent is immutable'; END IF;
      IF OLD.provider_id IS NOT NULL OR NEW.provider_id IS NULL OR
        (to_jsonb(NEW)-ARRAY['provider_id','provider_confirmed_at'])<>(to_jsonb(OLD)-ARRAY['provider_id','provider_confirmed_at']) THEN
        RAISE EXCEPTION 'Billing intent may only acquire its first provider identity'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER stripe_customer_identity BEFORE UPDATE OR DELETE ON stripe_billing_customers FOR EACH ROW EXECUTE FUNCTION protect_stripe_intent();
    CREATE TRIGGER stripe_checkout_identity BEFORE UPDATE OR DELETE ON stripe_checkout_requests FOR EACH ROW EXECUTE FUNCTION protect_stripe_intent();
    CREATE TRIGGER stripe_payment_append_only BEFORE UPDATE OR DELETE ON stripe_topup_payments FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_billing_customers) OR EXISTS(SELECT 1 FROM stripe_checkout_requests) OR EXISTS(SELECT 1 FROM stripe_topup_payments)
    THEN RAISE EXCEPTION 'Billing purchase history must be retained'; END IF; END $$;
    DROP TABLE stripe_topup_payments;
    DROP TABLE stripe_checkout_requests;
    DROP TABLE stripe_billing_customers;
    DROP FUNCTION protect_stripe_intent();`);
}
