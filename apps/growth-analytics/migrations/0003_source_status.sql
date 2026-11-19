CREATE TABLE growth_source_status (
  source TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  completed_scan_at TEXT,
  error_class TEXT,
  quality_flags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(quality_flags))
);
