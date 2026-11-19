export function up(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM neon_project_placement_reservations) THEN RAISE EXCEPTION 'Resolve active Neon placement reservations before compute-default cutover'; END IF; END $$;
    ALTER TABLE neon_project_placement_reservations ADD COLUMN compute_profile text NOT NULL CHECK(compute_profile IN ('free','paid','performance'));
    ALTER TABLE neon_project_placement_receipts ADD COLUMN provisioned_compute_profile text CHECK(provisioned_compute_profile IN ('free','paid','performance'));
    CREATE FUNCTION guard_neon_compute_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.compute_profile IS DISTINCT FROM OLD.compute_profile THEN RAISE EXCEPTION 'Provisioning compute profile is immutable' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER guard_neon_compute_profile BEFORE UPDATE ON neon_project_placement_reservations FOR EACH ROW EXECUTE FUNCTION guard_neon_compute_profile();`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM neon_project_placement_reservations) OR EXISTS(SELECT 1 FROM neon_project_placement_receipts WHERE provisioned_compute_profile IS NOT NULL) THEN RAISE EXCEPTION 'Compute provisioning evidence prevents rollback'; END IF; END $$;
    DROP TRIGGER guard_neon_compute_profile ON neon_project_placement_reservations;
    DROP FUNCTION guard_neon_compute_profile();
    ALTER TABLE neon_project_placement_reservations DROP COLUMN compute_profile;
    ALTER TABLE neon_project_placement_receipts DROP COLUMN provisioned_compute_profile;`);
}
