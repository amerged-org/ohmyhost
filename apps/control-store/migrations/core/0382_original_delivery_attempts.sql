-- Original001 delivery history is authoritative, not reconstructible from a current fence or last outcome.
-- A populated prototype that already discarded history must refuse this forward migration, never fabricate it.
INSERT INTO guard_fail(code)
SELECT 'precondition_changed' WHERE EXISTS (
  SELECT 1 FROM outbox_events WHERE attempt_count <> 0 OR current_attempt_id IS NOT NULL
    OR claimed_at IS NOT NULL OR lease_expires_at IS NOT NULL OR last_attempt_status IS NOT NULL
);

CREATE TABLE delivery_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY CHECK (length(attempt_id) = 26 AND attempt_id GLOB '[0-7]*'
    AND attempt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  event_id TEXT NOT NULL REFERENCES outbox_events(event_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN -2147483648 AND 2147483647),
  claimed_at TEXT NOT NULL CHECK (claimed_at GLOB '????-??-??T??:??:??.??????Z'),
  lease_expires_at TEXT NOT NULL CHECK (lease_expires_at GLOB '????-??-??T??:??:??.??????Z'),
  failed_at TEXT CHECK (failed_at IS NULL OR failed_at GLOB '????-??-??T??:??:??.??????Z'),
  next_available_at TEXT CHECK (next_available_at IS NULL OR next_available_at GLOB '????-??-??T??:??:??.??????Z'),
  error_code TEXT CHECK (error_code IS NULL OR (error_code GLOB '[A-Z]*' AND length(error_code) BETWEEN 2 AND 64
    AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  acknowledged_at TEXT CHECK (acknowledged_at IS NULL OR acknowledged_at GLOB '????-??-??T??:??:??.??????Z'),
  status TEXT NOT NULL CHECK (status IN ('claimed','retry_scheduled','reconciliation_required','acknowledged')),
  UNIQUE (event_id,attempt_number),
  CHECK ((status='claimed' AND failed_at IS NULL AND next_available_at IS NULL AND error_code IS NULL AND acknowledged_at IS NULL)
    OR (status='retry_scheduled' AND failed_at IS NOT NULL AND next_available_at IS NOT NULL AND error_code IS NOT NULL AND acknowledged_at IS NULL)
    OR (status='reconciliation_required' AND failed_at IS NOT NULL AND next_available_at IS NULL AND error_code IS NOT NULL AND acknowledged_at IS NULL)
    OR (status='acknowledged' AND failed_at IS NULL AND next_available_at IS NULL AND error_code IS NULL AND acknowledged_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
