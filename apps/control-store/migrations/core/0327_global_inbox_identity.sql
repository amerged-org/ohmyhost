-- A legacy unmapped copy may coexist only with the identical global event during atomic adoption.
-- There is no expiry policy for this buffer in the original PostgreSQL inbox. Retain every unmatched fact.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS (
  SELECT 1 FROM webhook_inbox i JOIN inbox_unrouted u
    ON i.inbox_event_id = u.inbox_event_id OR (i.provider = u.provider AND i.external_event_id = u.external_event_id)
  WHERE i.inbox_event_id <> u.inbox_event_id OR i.provider <> u.provider
    OR i.external_event_id <> u.external_event_id OR i.body_sha256 IS NOT u.body_sha256
);

CREATE TRIGGER webhook_inbox_cross_identity_insert BEFORE INSERT ON webhook_inbox
WHEN EXISTS (SELECT 1 FROM inbox_unrouted u
  WHERE (u.inbox_event_id = NEW.inbox_event_id OR (u.provider = NEW.provider AND u.external_event_id = NEW.external_event_id))
    AND (u.inbox_event_id <> NEW.inbox_event_id OR u.provider <> NEW.provider
      OR u.external_event_id <> NEW.external_event_id OR u.body_sha256 IS NOT NEW.body_sha256))
BEGIN SELECT RAISE(ABORT, 'cross-inbox identity conflict'); END;
CREATE TRIGGER webhook_inbox_cross_identity_update BEFORE UPDATE OF inbox_event_id, provider, external_event_id, body_sha256 ON webhook_inbox
WHEN EXISTS (SELECT 1 FROM inbox_unrouted u
  WHERE (u.inbox_event_id = NEW.inbox_event_id OR (u.provider = NEW.provider AND u.external_event_id = NEW.external_event_id))
    AND (u.inbox_event_id <> NEW.inbox_event_id OR u.provider <> NEW.provider
      OR u.external_event_id <> NEW.external_event_id OR u.body_sha256 IS NOT NEW.body_sha256))
BEGIN SELECT RAISE(ABORT, 'cross-inbox identity conflict'); END;
CREATE TRIGGER inbox_unrouted_cross_identity_insert BEFORE INSERT ON inbox_unrouted
WHEN EXISTS (SELECT 1 FROM webhook_inbox i
  WHERE (i.inbox_event_id = NEW.inbox_event_id OR (i.provider = NEW.provider AND i.external_event_id = NEW.external_event_id))
    AND (i.inbox_event_id <> NEW.inbox_event_id OR i.provider <> NEW.provider
      OR i.external_event_id <> NEW.external_event_id OR i.body_sha256 IS NOT NEW.body_sha256))
BEGIN SELECT RAISE(ABORT, 'cross-inbox identity conflict'); END;
CREATE TRIGGER inbox_unrouted_cross_identity_update BEFORE UPDATE OF inbox_event_id, provider, external_event_id, body_sha256 ON inbox_unrouted
WHEN EXISTS (SELECT 1 FROM webhook_inbox i
  WHERE (i.inbox_event_id = NEW.inbox_event_id OR (i.provider = NEW.provider AND i.external_event_id = NEW.external_event_id))
    AND (i.inbox_event_id <> NEW.inbox_event_id OR i.provider <> NEW.provider
      OR i.external_event_id <> NEW.external_event_id OR i.body_sha256 IS NOT NEW.body_sha256))
BEGIN SELECT RAISE(ABORT, 'cross-inbox identity conflict'); END;
CREATE TRIGGER inbox_unrouted_delete_requires_canonical BEFORE DELETE ON inbox_unrouted
WHEN NOT EXISTS (SELECT 1 FROM webhook_inbox i WHERE i.inbox_event_id = OLD.inbox_event_id
  AND i.provider = OLD.provider AND i.external_event_id = OLD.external_event_id AND i.body_sha256 = OLD.body_sha256)
BEGIN SELECT RAISE(ABORT, 'retained inbox buffer requires its identical canonical event before consumption'); END;

CREATE INDEX webhook_inbox_provider_claim ON webhook_inbox(provider, claim_id, inbox_event_id)
  WHERE state = 'processing';
