-- core-v1 source: migrations/directory/0090_inbox_unrouted_policy.sql
-- The unrouted inbox keeps the policy of the original event instead of a constant: the event's own max_attempts (existing rows
-- keep the previous fixed 10), its signature timestamp, the last routing attempt and a terminal classification. A row with a
-- terminal code is never retried and never silently skipped: it stays visible until its retention ends.
ALTER TABLE inbox_unrouted ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts BETWEEN 1 AND 1000);
ALTER TABLE inbox_unrouted ADD COLUMN signature_timestamp TEXT CHECK (signature_timestamp IS NULL OR signature_timestamp GLOB '????-??-??T??:??:??.??????Z');
ALTER TABLE inbox_unrouted ADD COLUMN route_attempts INTEGER NOT NULL DEFAULT 0 CHECK (route_attempts >= 0);
ALTER TABLE inbox_unrouted ADD COLUMN last_route_attempt_at TEXT CHECK (last_route_attempt_at IS NULL OR last_route_attempt_at GLOB '????-??-??T??:??:??.??????Z');
ALTER TABLE inbox_unrouted ADD COLUMN terminal_code TEXT CHECK (terminal_code IS NULL OR (terminal_code GLOB '[A-Z]*' AND length(terminal_code) BETWEEN 2 AND 64 AND terminal_code NOT GLOB '*[^A-Z0-9_]*'));
ALTER TABLE inbox_unrouted ADD COLUMN terminal_at TEXT CHECK (terminal_at IS NULL OR terminal_at GLOB '????-??-??T??:??:??.??????Z');
CREATE INDEX inbox_unrouted_open ON inbox_unrouted (received_at, inbox_event_id) WHERE terminal_code IS NULL;
