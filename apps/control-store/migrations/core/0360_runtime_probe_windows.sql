-- Original PostgreSQL088. The exact candidate identity is supplied by the canonical WFP static migration0334/0336.
-- No runtime activation or inferred probe receipt is installed by this migration.
CREATE TABLE runtime_probe_windows (
  window_id TEXT PRIMARY KEY CHECK (length(window_id)=26 AND window_id GLOB '[0-7]*' AND window_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  candidate_receipt_id TEXT NOT NULL REFERENCES wfp_candidate_receipts(candidate_receipt_id),
  starts_at TEXT NOT NULL CHECK (starts_at GLOB '????-??-??T??:??:??.??????Z'),
  expires_at TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%S', starts_at, '+210 seconds') || substr(starts_at,20))
) STRICT, WITHOUT ROWID;
CREATE INDEX runtime_probe_window_lookup ON runtime_probe_windows(candidate_receipt_id,starts_at,expires_at);
CREATE TRIGGER runtime_probe_windows_no_update BEFORE UPDATE ON runtime_probe_windows
BEGIN SELECT RAISE(ABORT,'Runtime probe accounting history is append-only'); END;
CREATE TRIGGER runtime_probe_windows_no_delete BEFORE DELETE ON runtime_probe_windows
BEGIN SELECT RAISE(ABORT,'Runtime probe accounting history is append-only'); END;
