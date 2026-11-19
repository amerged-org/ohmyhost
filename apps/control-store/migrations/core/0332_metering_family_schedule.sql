-- Original financial-family scheduling (186 / 192 / 193). These are unpriced hints and revisions, never measurements
-- supplied by a caller. All four families share the owner/organization claim of 0254 on this same Core.
ALTER TABLE organization_metering_work ADD COLUMN completed_context TEXT
  CHECK (completed_context IS NULL OR (json_valid(completed_context) AND completed_claim_token IS NOT NULL));
CREATE TABLE lifetime_day_hints (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('wfp-script', 'custom-hostname')),
  resource_reference TEXT NOT NULL CHECK (length(resource_reference) BETWEEN 1 AND 253),
  day TEXT NOT NULL CHECK (day GLOB '????-??-??'),
  hint_id TEXT NOT NULL UNIQUE CHECK (length(hint_id) = 26),
  status TEXT NOT NULL CHECK (status IN ('pending', 'evaluated_no_charge', 'unresolved_route', 'covered')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  evaluated_revision INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0 AND evaluated_revision <= revision),
  evaluated_at TEXT NOT NULL,
  routed_organization_id TEXT,
  routed_project_id TEXT,
  routed_billing_epoch_id TEXT,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_served_at TEXT,
  last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled',
    'idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown')),
  covered_valuation_id TEXT REFERENCES usage_valuations (valuation_id),
  covered_at TEXT,
  PRIMARY KEY (source_kind, resource_reference, day),
  CHECK ((routed_organization_id IS NULL) = (routed_project_id IS NULL)
    AND (routed_project_id IS NULL) = (routed_billing_epoch_id IS NULL)),
  CHECK ((status = 'pending' AND routed_organization_id IS NOT NULL AND covered_valuation_id IS NULL AND covered_at IS NULL)
    OR (status = 'covered' AND covered_valuation_id IS NOT NULL AND covered_at IS NOT NULL)
    OR (status IN ('evaluated_no_charge','unresolved_route') AND routed_organization_id IS NULL
      AND covered_valuation_id IS NULL AND covered_at IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX lifetime_day_hints_due_idx ON lifetime_day_hints (routed_organization_id, available_at, day, hint_id)
  WHERE status = 'pending';
CREATE INDEX lifetime_day_hints_unresolved_idx ON lifetime_day_hints (source_kind, resource_reference, available_at, day)
  WHERE status = 'unresolved_route';
CREATE TRIGGER lifetime_day_hints_identity BEFORE UPDATE ON lifetime_day_hints
  WHEN NEW.source_kind IS NOT OLD.source_kind OR NEW.resource_reference IS NOT OLD.resource_reference
    OR NEW.day IS NOT OLD.day OR NEW.hint_id IS NOT OLD.hint_id
    OR (OLD.status = 'covered' AND
      (NEW.status IS NOT OLD.status OR NEW.covered_valuation_id IS NOT OLD.covered_valuation_id OR NEW.covered_at IS NOT OLD.covered_at))
BEGIN SELECT RAISE(ABORT, 'lifetime hint identity and covered receipt are immutable'); END;

CREATE TABLE neon_metering_source_hints (
  provider_organization_id TEXT NOT NULL CHECK (length(provider_organization_id) BETWEEN 5 AND 60
    AND provider_organization_id GLOB 'org-*' AND substr(provider_organization_id,5) NOT GLOB '*[^a-z0-9-]*'),
  provider_project_id TEXT NOT NULL CHECK (length(provider_project_id) BETWEEN 1 AND 60 AND provider_project_id NOT GLOB '*[^a-z0-9-]*'),
  period_id TEXT NOT NULL CHECK (length(period_id) = 36),
  timeframe_start TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('compute_unit_seconds','root_branch_bytes_month','child_branch_bytes_month',
    'instant_restore_bytes_month','snapshot_storage_bytes_month','public_network_transfer_bytes','private_network_transfer_bytes','extra_branches_month')),
  financial_source_reference TEXT NOT NULL,
  latest_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  routed_organization_id TEXT REFERENCES organization_metering_work (organization_id),
  available_at TEXT,
  last_served_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled','idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','invalid_measurement','measurement_conflict','attribution_unresolved','rate_unresolved','activation_unresolved','compute_unresolved','epoch_unresolved','source_ambiguous','unknown')),
  evaluated_revision INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0 AND evaluated_revision <= revision),
  last_completed_work_id TEXT,
  last_completed_valuation_id TEXT REFERENCES usage_valuations (valuation_id),
  PRIMARY KEY (provider_organization_id, provider_project_id, period_id, timeframe_start, metric),
  CHECK ((available_at IS NOT NULL) = (routed_organization_id IS NOT NULL AND evaluated_revision < revision))
) STRICT, WITHOUT ROWID;
CREATE INDEX neon_metering_source_hints_organization_idx ON neon_metering_source_hints (routed_organization_id, available_at,
  provider_organization_id, provider_project_id, period_id, timeframe_start, metric) WHERE available_at IS NOT NULL;
CREATE INDEX neon_metering_source_hints_financial_idx ON neon_metering_source_hints (financial_source_reference,
  provider_organization_id, provider_project_id, period_id, timeframe_start, metric) WHERE routed_organization_id IS NOT NULL;

CREATE TABLE r2_metering_source_hints (
  account_id TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^0-9a-f]*'),
  bucket_name TEXT NOT NULL CHECK (length(bucket_name) BETWEEN 1 AND 128),
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('eu','us')),
  timeframe_start TEXT NOT NULL,
  meter TEXT NOT NULL CHECK (meter IN ('r2.storage.standard','r2.storage.observed','r2.class_a','r2.class_b')),
  financial_source_reference TEXT NOT NULL,
  latest_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  routed_organization_id TEXT REFERENCES organization_metering_work (organization_id),
  available_at TEXT,
  last_served_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled','idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','invalid_measurement','measurement_conflict','attribution_unresolved','rate_unresolved','activation_unresolved','compute_unresolved','epoch_unresolved','source_ambiguous','unknown')),
  evaluated_revision INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0 AND evaluated_revision <= revision),
  last_completed_work_id TEXT,
  last_completed_valuation_id TEXT REFERENCES usage_valuations (valuation_id),
  PRIMARY KEY (account_id, bucket_name, jurisdiction, timeframe_start, meter),
  CHECK ((available_at IS NOT NULL) = (routed_organization_id IS NOT NULL AND evaluated_revision < revision))
) STRICT, WITHOUT ROWID;
CREATE INDEX r2_metering_source_hints_organization_idx ON r2_metering_source_hints (routed_organization_id, available_at,
  account_id, bucket_name, jurisdiction, timeframe_start, meter) WHERE available_at IS NOT NULL;
CREATE INDEX r2_metering_source_hints_financial_idx ON r2_metering_source_hints (financial_source_reference,
  account_id, bucket_name, jurisdiction, timeframe_start, meter) WHERE routed_organization_id IS NOT NULL;

CREATE TABLE credit_maintenance_due (
  organization_id TEXT NOT NULL PRIMARY KEY,
  source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  due_at TEXT,
  evaluated_revision INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_revision >= 0 AND evaluated_revision <= source_revision),
  evaluated_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled',
    'idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown')),
  CHECK ((evaluated_revision = 0) = (evaluated_at IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX credit_maintenance_due_idx ON credit_maintenance_due (due_at, organization_id) WHERE due_at IS NOT NULL;
CREATE TABLE credit_maintenance_notices (
  notice_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('mapping_state','project_ownership','credit_expiration','stripe_payment','stripe_subscription_end','paid_access_event','paid_access','stripe_checkout','stripe_recharge')),
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_owner TEXT CHECK (claim_owner IN ('control','metering')),
  claim_token TEXT,
  claim_epoch INTEGER CHECK (claim_epoch > 0),
  claimed_at TEXT,
  lease_until TEXT,
  processed_at TEXT,
  last_failure_code TEXT CHECK (last_failure_code IN ('lock_not_available','statement_canceled','idle_in_transaction_timeout','transaction_timeout','deadlock','read_only_violation','budget_unsupported','connection','unknown')),
  CHECK ((claim_owner IS NULL AND claim_token IS NULL AND claim_epoch IS NULL AND claimed_at IS NULL AND lease_until IS NULL)
    OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL
      AND claimed_at IS NOT NULL AND lease_until > claimed_at AND processed_at IS NULL))
) STRICT;
CREATE INDEX credit_maintenance_notices_due_idx ON credit_maintenance_notices (next_attempt_at, notice_id)
  WHERE processed_at IS NULL;
CREATE INDEX credit_maintenance_notices_pending_org_idx ON credit_maintenance_notices (organization_id) WHERE processed_at IS NULL;
CREATE TABLE credit_maintenance_bootstrap (
  job TEXT NOT NULL PRIMARY KEY CHECK (job = 'mappings'),
  cursor_organization_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  last_served_at TEXT,
  completed_at TEXT
) STRICT, WITHOUT ROWID;
INSERT INTO credit_maintenance_bootstrap(job) VALUES ('mappings');
CREATE TRIGGER maintenance_bootstrap_identity BEFORE UPDATE ON credit_maintenance_bootstrap
  WHEN OLD.completed_at IS NOT NULL OR NEW.job IS NOT OLD.job
BEGIN SELECT RAISE(ABORT, 'credit maintenance bootstrap identity is immutable and completed is terminal'); END;

CREATE TRIGGER neon_metering_source_hints_guard BEFORE UPDATE ON neon_metering_source_hints
  WHEN NEW.provider_organization_id IS NOT OLD.provider_organization_id
    OR NEW.provider_project_id IS NOT OLD.provider_project_id OR NEW.period_id IS NOT OLD.period_id
    OR NEW.timeframe_start IS NOT OLD.timeframe_start OR NEW.metric IS NOT OLD.metric
    OR NEW.financial_source_reference IS NOT OLD.financial_source_reference
    OR NEW.latest_observed_at < OLD.latest_observed_at
    OR NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
    OR (NEW.latest_observed_at > OLD.latest_observed_at AND NEW.revision = OLD.revision)
    OR (NEW.routed_organization_id IS NOT OLD.routed_organization_id AND NEW.revision = OLD.revision)
    OR NEW.evaluated_revision < OLD.evaluated_revision
BEGIN SELECT RAISE(ABORT, 'provider source hint identity, pointer and revision are immutable or monotone'); END;
CREATE TRIGGER r2_metering_source_hints_guard BEFORE UPDATE ON r2_metering_source_hints
  WHEN NEW.account_id IS NOT OLD.account_id OR NEW.bucket_name IS NOT OLD.bucket_name
    OR NEW.jurisdiction IS NOT OLD.jurisdiction OR NEW.timeframe_start IS NOT OLD.timeframe_start
    OR NEW.meter IS NOT OLD.meter OR NEW.financial_source_reference IS NOT OLD.financial_source_reference
    OR NEW.latest_observed_at < OLD.latest_observed_at
    OR NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1
    OR (NEW.latest_observed_at > OLD.latest_observed_at AND NEW.revision = OLD.revision)
    OR (NEW.routed_organization_id IS NOT OLD.routed_organization_id AND NEW.revision = OLD.revision)
    OR NEW.evaluated_revision < OLD.evaluated_revision
BEGIN SELECT RAISE(ABORT, 'provider source hint identity, pointer and revision are immutable or monotone'); END;
