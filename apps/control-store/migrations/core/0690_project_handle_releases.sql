-- A project handle that a rename gives up is held for 30 days against every other organization. The organization that
-- released it may claim it again at once. Project admission (initial and customer) and the rename itself refuse a handle
-- with a row of another organization whose `quarantined_until` is still ahead. One row per handle: a later release of the
-- same handle replaces the earlier row, which is only ever written after its quarantine has passed or by its own holder.
--
-- Backfill: none. Renames before this migration did not record the handle they gave up, so those handles stay free as before.
--
-- Rollout: applies to Core before the Core Worker that writes the row. Without the row the Worker admits every handle as before.
CREATE TABLE project_handle_releases (
  handle            TEXT NOT NULL PRIMARY KEY
    CHECK (length(handle) BETWEEN 1 AND 59 AND handle NOT GLOB '*[^a-z0-9-]*' AND handle NOT GLOB '-*'
           AND handle NOT GLOB '*-' AND handle NOT GLOB '*--*'),
  organization_id   TEXT NOT NULL REFERENCES org_directory (organization_id),
  project_id        TEXT NOT NULL CHECK (length(project_id) = 26),
  released_at       TEXT NOT NULL CHECK (released_at GLOB '????-??-??T??:??:??.??????Z'),
  quarantined_until TEXT NOT NULL CHECK (quarantined_until GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
