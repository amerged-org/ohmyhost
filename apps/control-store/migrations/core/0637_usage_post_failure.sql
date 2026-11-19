-- A usage posting the credit service could not book, kept with its exact lines so that one organization whose posting
-- fails for good cannot hold the shared usage cursor: the service counts the attempts here, and once a posting has
-- reached its attempt limit (at once for a refused posting, and for an organization that already has one) it lets the
-- cursor pass and replays the posting from this row. `key` is the credit_log key of the posting
-- (`usage:<source>:<org>:<window>`, with `:p<part>` for a part above 0); booking the key removes the row. `split` is the
-- layout of the window the posting belongs to: a window is booked either whole or in parts, never both. A row is never for a
-- booked key and never in another layout than the booked one: booking deletes the rows it supersedes in its own batch.
-- `lines` is the posting as it was last sent, stored as it arrived because a posting may fail exactly because of its lines.
CREATE TABLE usage_post_failure (
  key             TEXT PRIMARY KEY,
  organization_id TEXT    NOT NULL,
  source          TEXT    NOT NULL CHECK (source IN ('wfp','pgcf','r2','resources')),
  window_start    TEXT    NOT NULL,
  part            INTEGER NOT NULL CHECK (part BETWEEN 0 AND 255),
  split           INTEGER NOT NULL DEFAULT 0 CHECK (split IN (0,1)),
  attempts        INTEGER NOT NULL CHECK (attempts >= 1),
  reason          TEXT    NOT NULL,
  lines           TEXT    NOT NULL,
  first_failed_at TEXT    NOT NULL,
  last_failed_at  TEXT    NOT NULL
) STRICT;
CREATE INDEX usage_post_failure_due ON usage_post_failure (attempts, last_failed_at);
