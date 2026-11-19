-- Q1 identity lane (directory). Two routing facts that live outside any organization shard.
--
-- mcp_handoff_routes: a portal handoff is looked up by its request hash alone (the consent page and the callbacks
-- hold only the opaque token), so the directory records which organization owns the hash; the handoff row
-- itself lives in the organization's shard. The row is written before the shard row and is harmless alone.
CREATE TABLE mcp_handoff_routes (
  request_hash     TEXT NOT NULL PRIMARY KEY CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  organization_id  TEXT NOT NULL REFERENCES org_directory (organization_id),
  expires_at       TEXT NOT NULL CHECK (expires_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE INDEX mcp_handoff_routes_expiry ON mcp_handoff_routes (expires_at);

-- pending_membership_barriers: a WorkOS membership webhook can arrive before its organization has a shard row, and
-- the barrier lives in the shard (it references organizations). Fail closed until then: the newest such event per
-- (WorkOS organization, user) is kept here and is opened as a real barrier in the same shard batch that applies the
-- organization's first snapshot, which closes it only when the snapshot is not older than the event.
CREATE TABLE pending_membership_barriers (
  workos_organization_id  TEXT NOT NULL CHECK (workos_organization_id GLOB 'org_*' AND length(workos_organization_id) BETWEEN 5 AND 128),
  workos_user_id          TEXT NOT NULL CHECK (length(workos_user_id) BETWEEN 1 AND 255),
  source_event_id         TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 255),
  event_created_at        TEXT NOT NULL CHECK (event_created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY (workos_organization_id, workos_user_id)
) STRICT, WITHOUT ROWID;
