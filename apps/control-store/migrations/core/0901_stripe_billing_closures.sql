-- The Stripe billing of a deleted organization ends once: Billing cancels its subscriptions and detaches its cards. A
-- row is made by the first sync that sees the organization deleted, leased for one attempt, and closed when Stripe has
-- ended the billing. The Stripe customer itself and its intent are kept.
CREATE TABLE stripe_billing_closures (
  organization_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL CHECK(account_id GLOB 'acct_*' AND substr(account_id,6) NOT GLOB '*[^A-Za-z0-9_]*' AND length(account_id) BETWEEN 6 AND 133),
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  customer_id TEXT NOT NULL CHECK(customer_id GLOB 'cus_*' AND substr(customer_id,5) NOT GLOB '*[^A-Za-z0-9_]*' AND length(customer_id) BETWEEN 5 AND 132),
  requested_at TEXT NOT NULL CHECK(requested_at GLOB '????-??-??T??:??:??.??????Z'),
  leased_until TEXT CHECK(leased_until IS NULL OR leased_until GLOB '????-??-??T??:??:??.??????Z'),
  closed_at TEXT CHECK(closed_at IS NULL OR closed_at GLOB '????-??-??T??:??:??.??????Z'),
  FOREIGN KEY(organization_id,account_id,mode,customer_id) REFERENCES stripe_billing_customers(organization_id,account_id,mode,provider_id)
) STRICT, WITHOUT ROWID;
