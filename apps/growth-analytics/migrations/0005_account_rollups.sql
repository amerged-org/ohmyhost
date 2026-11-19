CREATE TABLE growth_account_projection (
  account_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  test_segment TEXT NOT NULL DEFAULT 'unknown',
  workspace_evidence_at TEXT
);
CREATE TABLE growth_workspace_observations (
  account_id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL
);
CREATE TABLE growth_daily_account_rollups (
  cohort_day TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  mature INTEGER NOT NULL,
  positive INTEGER NOT NULL,
  unknown INTEGER NOT NULL,
  incomplete INTEGER NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY(cohort_day, window_days)
);
