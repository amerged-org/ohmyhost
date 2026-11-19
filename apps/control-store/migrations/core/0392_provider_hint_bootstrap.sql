-- Original192 bootstrap; triggers and canonical raw facts are0337.
CREATE TABLE provider_hint_bootstrap (job TEXT NOT NULL PRIMARY KEY CHECK(job IN ('neon','r2')),
cursor_provider_organization_id TEXT,
cursor_provider_project_id TEXT,
cursor_period_id TEXT,
cursor_timeframe_start TEXT,
cursor_metric TEXT,
cursor_observed_at TEXT,
cursor_account_id TEXT,
cursor_bucket_name TEXT,
cursor_jurisdiction TEXT,
cursor_meter TEXT,
generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),scanned INTEGER NOT NULL DEFAULT 0 CHECK(scanned>=0),last_served_at TEXT,completed_at TEXT,
CHECK((job='neon' AND cursor_account_id IS NULL AND cursor_bucket_name IS NULL AND cursor_jurisdiction IS NULL AND cursor_meter IS NULL AND ((cursor_provider_organization_id IS NULL AND cursor_provider_project_id IS NULL AND cursor_period_id IS NULL AND cursor_timeframe_start IS NULL AND cursor_metric IS NULL AND cursor_observed_at IS NULL) OR (cursor_provider_organization_id IS NOT NULL AND cursor_provider_project_id IS NOT NULL AND cursor_period_id IS NOT NULL AND cursor_timeframe_start IS NOT NULL AND cursor_metric IS NOT NULL AND cursor_observed_at IS NOT NULL))) OR (job='r2' AND cursor_provider_organization_id IS NULL AND cursor_provider_project_id IS NULL AND cursor_period_id IS NULL AND cursor_metric IS NULL AND ((cursor_account_id IS NULL AND cursor_bucket_name IS NULL AND cursor_jurisdiction IS NULL AND cursor_timeframe_start IS NULL AND cursor_meter IS NULL AND cursor_observed_at IS NULL) OR (cursor_account_id IS NOT NULL AND cursor_bucket_name IS NOT NULL AND cursor_jurisdiction IS NOT NULL AND cursor_timeframe_start IS NOT NULL AND cursor_meter IS NOT NULL AND cursor_observed_at IS NOT NULL))))) STRICT, WITHOUT ROWID;
INSERT INTO provider_hint_bootstrap(job) VALUES('neon'),('r2');
CREATE TRIGGER provider_hint_bootstrap_guard BEFORE UPDATE ON provider_hint_bootstrap WHEN OLD.completed_at IS NOT NULL OR NEW.job IS NOT OLD.job OR NEW.generation<OLD.generation OR NEW.scanned<OLD.scanned OR (OLD.cursor_observed_at IS NOT NULL AND (NEW.cursor_observed_at IS NULL OR CASE OLD.job  WHEN 'neon' THEN (NEW.cursor_provider_organization_id,NEW.cursor_provider_project_id,NEW.cursor_period_id,NEW.cursor_timeframe_start,NEW.cursor_metric,NEW.cursor_observed_at)<(OLD.cursor_provider_organization_id,OLD.cursor_provider_project_id,OLD.cursor_period_id,OLD.cursor_timeframe_start,OLD.cursor_metric,OLD.cursor_observed_at) WHEN 'r2' THEN (NEW.cursor_account_id,NEW.cursor_bucket_name,NEW.cursor_jurisdiction,NEW.cursor_timeframe_start,NEW.cursor_meter,NEW.cursor_observed_at)<(OLD.cursor_account_id,OLD.cursor_bucket_name,OLD.cursor_jurisdiction,OLD.cursor_timeframe_start,OLD.cursor_meter,OLD.cursor_observed_at) END)) BEGIN SELECT RAISE(ABORT,'Provider bootstrap identity, cursor and counters are immutable or monotone'); END;
