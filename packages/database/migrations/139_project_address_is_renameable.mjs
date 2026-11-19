// A project's address was part of its creation identity, so it could never change. A customer may
// now rename a project, so the three handle columns move together while the rest of the identity —
// the project, its organization, its name, its creation event and time — stays immutable.
export function up(pgm) {
  pgm.sql(`CREATE OR REPLACE FUNCTION reject_project_identity_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.created_organization_id IS DISTINCT FROM OLD.created_organization_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'project creation identity is immutable' USING ERRCODE='55000';
      END IF;
      -- An address moves as a whole: the handle, how it was chosen, and the attempt behind it.
      IF (NEW.handle IS DISTINCT FROM OLD.handle
          OR NEW.handle_version IS DISTINCT FROM OLD.handle_version
          OR NEW.handle_attempt IS DISTINCT FROM OLD.handle_attempt)
        AND NOT (NEW.handle IS DISTINCT FROM OLD.handle
                 AND NEW.handle_version='customer-chosen-v1' AND NEW.handle_attempt=0) THEN
        RAISE EXCEPTION 'project address may only change to a chosen one' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END;
    $$;`);
}

export function down(pgm) {
  pgm.sql(`CREATE OR REPLACE FUNCTION reject_project_identity_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.created_organization_id IS DISTINCT FROM OLD.created_organization_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.handle IS DISTINCT FROM OLD.handle
        OR NEW.handle_version IS DISTINCT FROM OLD.handle_version
        OR NEW.handle_attempt IS DISTINCT FROM OLD.handle_attempt
        OR NEW.created_event_id IS DISTINCT FROM OLD.created_event_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'project creation identity is immutable' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END;
    $$;`);
}
