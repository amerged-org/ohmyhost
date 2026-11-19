-- WorkOS onboarding retains the original source073/079/113/154 contracts. user_signup remains the ONE
-- canonical origin/attribution row: origin_present distinguishes an absent origin from a frozen NULL source.
ALTER TABLE user_signup ADD COLUMN origin_present INTEGER NOT NULL DEFAULT 1 CHECK (origin_present IN (0,1));
CREATE TABLE signup_sources (
  source_id TEXT NOT NULL PRIMARY KEY CHECK (length(source_id) BETWEEN 1 AND 64 AND source_id GLOB '[a-z0-9]*' AND source_id NOT GLOB '*[^a-z0-9_-]*'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  admits_beta INTEGER NOT NULL DEFAULT 0 CHECK (admits_beta IN (0,1)),
  bonus_micros INTEGER NOT NULL DEFAULT 0 CHECK (bonus_micros >= 0)
) STRICT, WITHOUT ROWID;
-- Source configuration is imported exactly; no new campaign or bonus is seeded by this migration.

-- Exact original powered-by history; organization attribution survives transfer. The global identity is its
-- project parent, while the live referrer lookup also requires the period's organization to own it currently.
CREATE TABLE project_powered_by_flag_periods (
  period_id TEXT NOT NULL PRIMARY KEY CHECK (length(period_id) = 26 AND period_id GLOB '[0-7]*' AND period_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  project_id TEXT NOT NULL REFERENCES project_identities(project_id),
  enabled_at TEXT NOT NULL CHECK (enabled_at GLOB '????-??-??T??:??:??.??????Z'),
  disabled_at TEXT CHECK (disabled_at IS NULL OR (disabled_at GLOB '????-??-??T??:??:??.??????Z' AND disabled_at >= enabled_at))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX project_powered_by_flag_periods_one_open ON project_powered_by_flag_periods(project_id) WHERE disabled_at IS NULL;
CREATE INDEX project_powered_by_flag_periods_project ON project_powered_by_flag_periods(project_id,enabled_at);
CREATE TRIGGER project_powered_by_flag_periods_close_only_update BEFORE UPDATE ON project_powered_by_flag_periods
WHEN NOT (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL AND NEW.period_id = OLD.period_id
  AND NEW.organization_id = OLD.organization_id AND NEW.project_id = OLD.project_id AND NEW.enabled_at = OLD.enabled_at)
BEGIN SELECT RAISE(ABORT, 'Powered-by flag periods may only be closed'); END;
CREATE TRIGGER project_powered_by_flag_periods_close_only_delete BEFORE DELETE ON project_powered_by_flag_periods
BEGIN SELECT RAISE(ABORT, 'Powered-by flag periods may only be closed'); END;

-- The original request shape and foreign-key semantics also protect the merged representation. In particular,
-- retention cannot silently remove the first onboarding request that later referral payment attribution needs.
CREATE TRIGGER onboarding_requests_shape_insert BEFORE INSERT ON onboarding_requests
WHEN (NEW.membership_attempted = 1 AND NEW.workos_organization_id IS NULL)
  OR NOT ((NEW.completed_at IS NULL AND NEW.organization_id IS NULL)
    OR (NEW.completed_at IS NOT NULL AND NEW.organization_id IS NOT NULL AND NEW.workos_organization_id IS NOT NULL))
  OR (NEW.signup_source IS NOT NULL AND NOT EXISTS (SELECT 1 FROM signup_sources WHERE source_id = NEW.signup_source))
  OR (NEW.organization_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organizations WHERE organization_id = NEW.organization_id))
BEGIN SELECT RAISE(ABORT, 'Invalid onboarding request shape'); END;
CREATE TRIGGER onboarding_requests_shape_update BEFORE UPDATE ON onboarding_requests
WHEN (NEW.membership_attempted = 1 AND NEW.workos_organization_id IS NULL)
  OR NOT ((NEW.completed_at IS NULL AND NEW.organization_id IS NULL)
    OR (NEW.completed_at IS NOT NULL AND NEW.organization_id IS NOT NULL AND NEW.workos_organization_id IS NOT NULL))
  OR (NEW.signup_source IS NOT NULL AND NOT EXISTS (SELECT 1 FROM signup_sources WHERE source_id = NEW.signup_source))
  OR (NEW.organization_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organizations WHERE organization_id = NEW.organization_id))
BEGIN SELECT RAISE(ABORT, 'Invalid onboarding request shape'); END;
CREATE TRIGGER onboarding_requests_attributed_delete BEFORE DELETE ON onboarding_requests
WHEN EXISTS (SELECT 1 FROM user_signup WHERE first_request_id = OLD.request_id)
BEGIN SELECT RAISE(ABORT, 'The attributed onboarding request is retained'); END;
CREATE TRIGGER user_signup_shape_insert BEFORE INSERT ON user_signup
WHEN (NEW.origin_present = 0 AND NEW.origin_source IS NOT NULL)
  OR NOT ((NEW.attributed_source IS NULL AND NEW.first_request_id IS NULL AND NEW.bonus_micros IS NULL AND NEW.credit_grant_id IS NULL AND NEW.attributed_at IS NULL)
    OR (NEW.attributed_source IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.bonus_micros IS NOT NULL AND NEW.attributed_at IS NOT NULL))
  OR (NEW.origin_present = 0 AND NEW.attributed_source IS NULL)
  OR (NEW.attributed_source IS NOT NULL AND NOT EXISTS (SELECT 1 FROM signup_sources WHERE source_id = NEW.attributed_source))
  OR (NEW.first_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM onboarding_requests WHERE request_id = NEW.first_request_id))
  OR (NEW.credit_grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM credit_lots WHERE grant_id = NEW.credit_grant_id))
BEGIN SELECT RAISE(ABORT, 'Invalid signup attribution shape'); END;
CREATE TRIGGER user_signup_shape_update BEFORE UPDATE ON user_signup
WHEN (NEW.origin_present = 0 AND NEW.origin_source IS NOT NULL)
  OR NOT ((NEW.attributed_source IS NULL AND NEW.first_request_id IS NULL AND NEW.bonus_micros IS NULL AND NEW.credit_grant_id IS NULL AND NEW.attributed_at IS NULL)
    OR (NEW.attributed_source IS NOT NULL AND NEW.first_request_id IS NOT NULL AND NEW.bonus_micros IS NOT NULL AND NEW.attributed_at IS NOT NULL))
  OR (NEW.origin_present = 0 AND NEW.attributed_source IS NULL)
  OR (NEW.attributed_source IS NOT NULL AND NOT EXISTS (SELECT 1 FROM signup_sources WHERE source_id = NEW.attributed_source))
  OR (NEW.first_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM onboarding_requests WHERE request_id = NEW.first_request_id))
  OR (NEW.credit_grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM credit_lots WHERE grant_id = NEW.credit_grant_id))
BEGIN SELECT RAISE(ABORT, 'Invalid signup attribution shape'); END;
