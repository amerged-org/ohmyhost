-- Original Stripe identities/bookkeeping from PostgreSQL migrations 090/091/093/094/114/118/126/157.
-- One CONTROL_CORE authority. Policy lots/periods/origins remain the existing finance facts; the
-- composed payment command writes their exact Stripe metadata in the SAME batch. No data is seeded.
CREATE TABLE stripe_billing_customers (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=26 AND substr(request_id,1,1) BETWEEN '0' AND '7' AND request_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  account_id TEXT NOT NULL CHECK(account_id GLOB 'acct_*' AND substr(account_id,6) NOT GLOB '*[^A-Za-z0-9_]*' AND length(account_id) BETWEEN 6 AND 133),
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 255),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  provider_id TEXT CHECK(provider_id IS NULL OR (provider_id GLOB 'cus_*' AND substr(provider_id,5) NOT GLOB '*[^A-Za-z0-9_]*' AND length(provider_id) BETWEEN 5 AND 132)),
  provider_confirmed_at TEXT CHECK(provider_confirmed_at IS NULL OR provider_confirmed_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK((provider_id IS NULL AND provider_confirmed_at IS NULL) OR (provider_id IS NOT NULL AND provider_confirmed_at IS NOT NULL AND provider_confirmed_at>=created_at)),
  UNIQUE(account_id,mode,provider_id),
  UNIQUE(organization_id,account_id,mode,provider_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER stripe_customer_identity BEFORE UPDATE ON stripe_billing_customers
WHEN OLD.provider_id IS NOT NULL OR NEW.provider_id IS NULL OR
  NEW.organization_id<>OLD.organization_id OR NEW.request_id<>OLD.request_id OR
  NEW.account_id<>OLD.account_id OR NEW.mode<>OLD.mode OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'Billing intent may only acquire its first provider identity'); END;
CREATE TRIGGER stripe_customer_no_delete BEFORE DELETE ON stripe_billing_customers
BEGIN SELECT RAISE(ABORT,'Billing intent is immutable'); END;

CREATE TABLE stripe_checkout_requests (
  checkout_id TEXT PRIMARY KEY CHECK(length(checkout_id)=26 AND substr(checkout_id,1,1) BETWEEN '0' AND '7' AND checkout_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 255),
  idempotency_key_sha256 BLOB NOT NULL CHECK(length(idempotency_key_sha256)=32),
  offer TEXT NOT NULL CHECK(offer IN ('paid','topup')),
  packs INTEGER NOT NULL CHECK(packs BETWEEN 1 AND 100 AND (offer='topup' OR packs=1)),
  price_id TEXT NOT NULL CHECK(price_id GLOB 'price_*' AND substr(price_id,7) NOT GLOB '*[^A-Za-z0-9_]*' AND length(price_id) BETWEEN 7 AND 134),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.??????Z' AND expires_at>created_at AND
    expires_at<=strftime('%Y-%m-%dT%H:%M:%S',substr(created_at,1,19),'+24 hours') || substr(created_at,20)),
  provider_id TEXT CHECK(provider_id IS NULL OR (provider_id GLOB 'cs_*' AND substr(provider_id,4) NOT GLOB '*[^A-Za-z0-9_]*' AND length(provider_id) BETWEEN 4 AND 256)),
  provider_confirmed_at TEXT CHECK(provider_confirmed_at IS NULL OR provider_confirmed_at GLOB '????-??-??T??:??:??.??????Z'),
  CHECK((provider_id IS NULL AND provider_confirmed_at IS NULL) OR (provider_id IS NOT NULL AND provider_confirmed_at IS NOT NULL AND provider_confirmed_at>=created_at)),
  FOREIGN KEY(organization_id,account_id,mode,customer_id) REFERENCES stripe_billing_customers(organization_id,account_id,mode,provider_id),
  UNIQUE(organization_id,created_by,idempotency_key_sha256),
  UNIQUE(account_id,mode,provider_id),
  UNIQUE(checkout_id,organization_id,account_id,mode,provider_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER stripe_checkout_identity BEFORE UPDATE ON stripe_checkout_requests
WHEN OLD.provider_id IS NOT NULL OR NEW.provider_id IS NULL OR
  NEW.checkout_id<>OLD.checkout_id OR NEW.organization_id<>OLD.organization_id OR NEW.account_id<>OLD.account_id OR
  NEW.mode<>OLD.mode OR NEW.customer_id<>OLD.customer_id OR NEW.created_by<>OLD.created_by OR
  NEW.idempotency_key_sha256<>OLD.idempotency_key_sha256 OR NEW.offer<>OLD.offer OR NEW.packs<>OLD.packs OR
  NEW.price_id<>OLD.price_id OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT,'Billing intent may only acquire its first provider identity'); END;
CREATE TRIGGER stripe_checkout_no_delete BEFORE DELETE ON stripe_checkout_requests
BEGIN SELECT RAISE(ABORT,'Billing intent is immutable'); END;

CREATE TABLE stripe_credit_payments (
  checkout_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  session_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL CHECK(payment_intent_id GLOB 'pi_*' AND substr(payment_intent_id,4) NOT GLOB '*[^A-Za-z0-9_]*' AND length(payment_intent_id) BETWEEN 4 AND 256),
  amount_subtotal_minor INTEGER NOT NULL CHECK(amount_subtotal_minor>0),
  amount_total_minor INTEGER NOT NULL CHECK(amount_total_minor>=amount_subtotal_minor),
  currency TEXT NOT NULL CHECK(currency='usd'),
  -- Exact original volume formula without overflowing SQLite into floating-point multiplication.
  credited_micros INTEGER NOT NULL CHECK(
    (amount_subtotal_minor<=10000 AND credited_micros=amount_subtotal_minor*1000000) OR
    (amount_subtotal_minor>10000 AND credited_micros%1250000=0 AND credited_micros/1250000=amount_subtotal_minor-2000)),
  grant_id TEXT PRIMARY KEY CHECK(length(grant_id)=26 AND substr(grant_id,1,1) BETWEEN '0' AND '7' AND grant_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  confirmed_at TEXT NOT NULL CHECK(confirmed_at GLOB '????-??-??T??:??:??.??????Z'),
  offer TEXT NOT NULL CHECK(offer IN ('paid','topup')),
  subscription_id TEXT,
  invoice_id TEXT,
  period_start TEXT CHECK(period_start IS NULL OR period_start GLOB '????-??-??T??:??:??.??????Z'),
  period_end TEXT CHECK(period_end IS NULL OR period_end GLOB '????-??-??T??:??:??.??????Z'),
  paid_at TEXT CHECK(paid_at IS NULL OR (paid_at GLOB '????-??-??T??:??:??.??????Z' AND offer='paid' AND paid_at<=confirmed_at)),
  UNIQUE(account_id,mode,payment_intent_id),
  UNIQUE(checkout_id,organization_id,account_id,mode,payment_intent_id),
  FOREIGN KEY(checkout_id,organization_id,account_id,mode,session_id) REFERENCES stripe_checkout_requests(checkout_id,organization_id,account_id,mode,provider_id),
  FOREIGN KEY(organization_id,grant_id) REFERENCES credit_lots(organization_id,grant_id),
  CHECK((offer='topup' AND subscription_id IS NULL AND invoice_id IS NULL AND period_start IS NULL AND period_end IS NULL)
    OR (offer='paid' AND subscription_id IS NOT NULL AND invoice_id IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL
      AND subscription_id GLOB 'sub_*' AND substr(subscription_id,5) NOT GLOB '*[^A-Za-z0-9_]*' AND length(subscription_id) BETWEEN 5 AND 256
      AND invoice_id GLOB 'in_*' AND substr(invoice_id,4) NOT GLOB '*[^A-Za-z0-9_]*' AND length(invoice_id) BETWEEN 4 AND 256 AND period_end>period_start
      AND period_end<=strftime('%Y-%m-%dT%H:%M:%S',substr(period_start,1,19),'+32 days') || substr(period_start,20)
      AND credited_micros=1000000000))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX stripe_one_topup_per_checkout ON stripe_credit_payments(checkout_id) WHERE offer='topup';
CREATE UNIQUE INDEX stripe_one_invoice ON stripe_credit_payments(account_id,mode,invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX stripe_one_paid_period ON stripe_credit_payments(account_id,mode,subscription_id,period_start) WHERE offer='paid';
CREATE INDEX stripe_paid_org_period ON stripe_credit_payments(organization_id,period_end) WHERE offer='paid';
CREATE TRIGGER stripe_payment_append_only BEFORE UPDATE ON stripe_credit_payments
BEGIN SELECT RAISE(ABORT,'Stripe payment is append-only'); END;
CREATE TRIGGER stripe_payment_no_delete BEFORE DELETE ON stripe_credit_payments
BEGIN SELECT RAISE(ABORT,'Stripe payment is append-only'); END;

CREATE TABLE stripe_refund_observations (
  observation_id TEXT PRIMARY KEY CHECK(length(observation_id)=26 AND substr(observation_id,1,1) BETWEEN '0' AND '7' AND observation_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  checkout_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  refund_id TEXT NOT NULL CHECK(refund_id GLOB 're_*' AND substr(refund_id,4) NOT GLOB '*[^A-Za-z0-9_]*' AND length(refund_id) BETWEEN 4 AND 256),
  amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
  status TEXT NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled')),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(account_id,mode,refund_id,status),
  FOREIGN KEY(checkout_id,organization_id,account_id,mode,payment_intent_id)
    REFERENCES stripe_credit_payments(checkout_id,organization_id,account_id,mode,payment_intent_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX stripe_refund_checkout ON stripe_refund_observations(checkout_id,refund_id);
CREATE TRIGGER stripe_refund_append_only BEFORE UPDATE ON stripe_refund_observations
BEGIN SELECT RAISE(ABORT,'Stripe refund observation is append-only'); END;
CREATE TRIGGER stripe_refund_no_delete BEFORE DELETE ON stripe_refund_observations
BEGIN SELECT RAISE(ABORT,'Stripe refund observation is append-only'); END;

CREATE TABLE stripe_dispute_movements (
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  transaction_id TEXT NOT NULL CHECK(transaction_id GLOB 'txn_*' AND substr(transaction_id,5) NOT GLOB '*[^A-Za-z0-9_]*' AND length(transaction_id) BETWEEN 5 AND 256),
  dispute_id TEXT NOT NULL CHECK(dispute_id GLOB 'du_*' AND substr(dispute_id,4) NOT GLOB '*[^A-Za-z0-9_]*' AND length(dispute_id) BETWEEN 4 AND 256),
  checkout_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  disputed_amount_minor INTEGER NOT NULL CHECK(disputed_amount_minor>0),
  direction TEXT NOT NULL CHECK(direction IN ('withdrawn','reinstated')),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(account_id,mode,transaction_id),
  FOREIGN KEY(checkout_id,organization_id,account_id,mode,payment_intent_id)
    REFERENCES stripe_credit_payments(checkout_id,organization_id,account_id,mode,payment_intent_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX stripe_dispute_payment ON stripe_dispute_movements(checkout_id,payment_intent_id,dispute_id);
CREATE TRIGGER stripe_dispute_append_only BEFORE UPDATE ON stripe_dispute_movements
BEGIN SELECT RAISE(ABORT,'Stripe dispute movement is append-only'); END;
CREATE TRIGGER stripe_dispute_no_delete BEFORE DELETE ON stripe_dispute_movements
BEGIN SELECT RAISE(ABORT,'Stripe dispute movement is append-only'); END;

CREATE TABLE stripe_billing_tax_issues (
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  invoice_id TEXT NOT NULL CHECK(invoice_id GLOB 'in_*' AND substr(invoice_id,4) NOT GLOB '*[^A-Za-z0-9_]*' AND length(invoice_id) BETWEEN 4 AND 256),
  code TEXT NOT NULL CHECK(code IN ('billing_tax_location_required','billing_tax_calculation_failed','billing_tax_configuration_required')),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  resolved_at TEXT CHECK(resolved_at IS NULL OR resolved_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(account_id,mode,invoice_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX stripe_billing_tax_active ON stripe_billing_tax_issues(organization_id,observed_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE stripe_recharge_policies (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  monthly_limit_minor INTEGER NOT NULL CHECK(monthly_limit_minor BETWEEN 1000 AND 100000),
  status TEXT NOT NULL CHECK(status IN ('off','setup_required','on','payment_required','monthly_limit','needs_reconciliation','tax_required')),
  setup_id TEXT NOT NULL CHECK(length(setup_id)=26 AND substr(setup_id,1,1) BETWEEN '0' AND '7' AND setup_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  setup_session_id TEXT,
  payment_method_id TEXT,
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.??????Z'),
  checked_at TEXT CHECK(checked_at IS NULL OR checked_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE TABLE stripe_recharge_consents (
  id TEXT PRIMARY KEY CHECK(length(id)=26 AND substr(id,1,1) BETWEEN '0' AND '7' AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL REFERENCES stripe_recharge_policies(organization_id),
  actor_id TEXT NOT NULL,
  key_hash BLOB NOT NULL,
  payload_hash BLOB NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  monthly_limit_minor INTEGER NOT NULL CHECK(monthly_limit_minor BETWEEN -2147483648 AND 2147483647),
  consent_version TEXT,
  occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z'),
  UNIQUE(organization_id,actor_id,key_hash)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER stripe_recharge_consents_append_only BEFORE UPDATE ON stripe_recharge_consents
BEGIN SELECT RAISE(ABORT,'Stripe recharge consent is append-only'); END;
CREATE TRIGGER stripe_recharge_consents_no_delete BEFORE DELETE ON stripe_recharge_consents
BEGIN SELECT RAISE(ABORT,'Stripe recharge consent is append-only'); END;
CREATE TABLE stripe_recharge_attempts (
  id TEXT PRIMARY KEY CHECK(length(id)=26 AND substr(id,1,1) BETWEEN '0' AND '7' AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL REFERENCES stripe_recharge_policies(organization_id),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK(policy_revision BETWEEN -2147483648 AND 2147483647),
  payment_method_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  remaining_minor INTEGER NOT NULL CHECK(remaining_minor BETWEEN 900 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('creating','draft','paying','paid','void','needs_reconciliation')),
  invoice_id TEXT,
  payment_intent_id TEXT,
  total_minor INTEGER CHECK(total_minor IS NULL OR total_minor BETWEEN 900 AND 2147483647),
  grant_id TEXT REFERENCES credit_lots(grant_id),
  checked_at TEXT CHECK(checked_at IS NULL OR checked_at GLOB '????-??-??T??:??:??.??????Z'),
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK(refunded_minor BETWEEN -2147483648 AND 2147483647),
  tax_issue_code TEXT CHECK(tax_issue_code IN ('billing_tax_location_required','billing_tax_calculation_failed','billing_tax_configuration_required')),
  UNIQUE(account_id,mode,invoice_id),
  UNIQUE(account_id,mode,payment_intent_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX stripe_recharge_one_unresolved ON stripe_recharge_attempts(organization_id) WHERE state NOT IN ('paid','void');
CREATE TABLE stripe_recharge_reversal_observations (
  attempt_id TEXT NOT NULL REFERENCES stripe_recharge_attempts(id),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('refund','dispute')),
  reference_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled','withdrawn','reinstated')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 2147483647),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(account_id,mode,reference_id,status)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER stripe_recharge_reversals_append_only BEFORE UPDATE ON stripe_recharge_reversal_observations
BEGIN SELECT RAISE(ABORT,'Stripe recharge reversal is append-only'); END;
CREATE TRIGGER stripe_recharge_reversals_no_delete BEFORE DELETE ON stripe_recharge_reversal_observations
BEGIN SELECT RAISE(ABORT,'Stripe recharge reversal is append-only'); END;
