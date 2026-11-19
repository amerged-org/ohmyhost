CREATE TABLE growth_delivery_failures (
  message_id TEXT PRIMARY KEY,
  event_id TEXT,
  enqueued_at TEXT,
  failed_at TEXT NOT NULL,
  resolved_at TEXT,
  error_class TEXT NOT NULL CHECK (error_class='delivery_exhausted')
);
CREATE INDEX growth_delivery_failures_event ON growth_delivery_failures(event_id);
