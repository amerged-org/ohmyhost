-- Preview identity and two-phase lease; legacy rows retain their original cutoff.
ALTER TABLE preview_sessions ADD COLUMN public_uuid TEXT;
ALTER TABLE preview_sessions ADD COLUMN startup_deadline_at TEXT;
ALTER TABLE preview_sessions ADD COLUMN first_ready_at TEXT;
ALTER TABLE preview_sessions ADD COLUMN ready_expires_at TEXT;
ALTER TABLE preview_sessions ADD COLUMN ready_ack_at TEXT;
CREATE UNIQUE INDEX preview_public_uuid ON preview_sessions(public_uuid) WHERE public_uuid IS NOT NULL;
CREATE TRIGGER preview_lifecycle_immutable BEFORE UPDATE ON preview_sessions
WHEN (OLD.public_uuid IS NOT NULL AND NEW.public_uuid IS NOT OLD.public_uuid)
 OR (OLD.startup_deadline_at IS NOT NULL AND NEW.startup_deadline_at IS NOT OLD.startup_deadline_at)
 OR (OLD.first_ready_at IS NOT NULL AND NEW.first_ready_at IS NOT OLD.first_ready_at)
 OR (OLD.ready_expires_at IS NOT NULL AND NEW.ready_expires_at IS NOT OLD.ready_expires_at)
 OR (OLD.ready_ack_at IS NOT NULL AND NEW.ready_ack_at IS NOT OLD.ready_ack_at)
BEGIN SELECT RAISE(ABORT,'preview_lifecycle_immutable'); END;
CREATE TRIGGER preview_lifecycle_valid_insert BEFORE INSERT ON preview_sessions
WHEN NEW.startup_deadline_at IS NOT NULL AND (
 NEW.public_uuid IS NULL OR abs((julianday(NEW.startup_deadline_at)-julianday(NEW.created_at))*86400-120)>0.01
 OR NEW.first_ready_at IS NOT NULL OR NEW.ready_expires_at IS NOT NULL OR NEW.ready_ack_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'preview_lifecycle_invalid'); END;
CREATE TRIGGER preview_lifecycle_valid_update BEFORE UPDATE ON preview_sessions
WHEN NEW.startup_deadline_at IS NOT NULL AND (
 NEW.public_uuid IS NULL OR (NEW.first_ready_at IS NULL)<>(NEW.ready_expires_at IS NULL)
 OR (NEW.first_ready_at IS NOT NULL AND (NEW.first_ready_at>=NEW.startup_deadline_at OR abs((julianday(NEW.ready_expires_at)-julianday(NEW.first_ready_at))*86400-900)>0.01))
 OR (NEW.ready_ack_at IS NOT NULL AND (NEW.first_ready_at IS NULL OR NEW.ready_ack_at<NEW.first_ready_at OR NEW.ready_ack_at>=NEW.startup_deadline_at))
 OR (NEW.status IN('ready','sleeping') AND NEW.ready_ack_at IS NULL))
BEGIN SELECT RAISE(ABORT,'preview_lifecycle_invalid'); END;
