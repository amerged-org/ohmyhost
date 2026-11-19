-- Preview preparation has its own real operation, not a product deployment claim.
CREATE TABLE preview_r2_bucket_reservations (
 organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 preparation_id TEXT NOT NULL REFERENCES preview_resource_preparations(preparation_id),
 bucket_name TEXT NOT NULL, jurisdiction TEXT NOT NULL CHECK(jurisdiction IN('eu','us')),
 observe_only INTEGER NOT NULL CHECK(observe_only IN(0,1)),
 reserved_at TEXT NOT NULL, create_started_at TEXT,
 PRIMARY KEY(organization_id,project_id,environment_id,preparation_id),
 FOREIGN KEY(project_id,environment_id) REFERENCES environment_identities(project_id,environment_id),
 CHECK(bucket_name='ohmyho-'||lower(project_id)||'-'||lower(environment_id)),
 CHECK(create_started_at IS NULL OR (observe_only=0 AND create_started_at>=reserved_at))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preview_r2_bucket_reservations_immutable BEFORE UPDATE ON preview_r2_bucket_reservations
 WHEN OLD.create_started_at IS NOT NULL OR NEW.create_started_at IS NULL OR NEW.organization_id IS NOT OLD.organization_id OR NEW.project_id IS NOT OLD.project_id OR NEW.environment_id IS NOT OLD.environment_id OR NEW.preparation_id IS NOT OLD.preparation_id OR NEW.bucket_name IS NOT OLD.bucket_name OR NEW.jurisdiction IS NOT OLD.jurisdiction OR NEW.observe_only IS NOT OLD.observe_only OR NEW.reserved_at IS NOT OLD.reserved_at
 BEGIN SELECT RAISE(ABORT,'preview R2 reservation permits one create dispatch'); END;
CREATE TRIGGER preview_r2_bucket_reservations_no_delete BEFORE DELETE ON preview_r2_bucket_reservations
 BEGIN SELECT RAISE(ABORT,'preview R2 reservations are retained evidence'); END;
CREATE TABLE preview_r2_bucket_absence_observations (
 organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 PRIMARY KEY(organization_id,project_id,environment_id,preparation_id),
 FOREIGN KEY(organization_id,project_id,environment_id,preparation_id) REFERENCES preview_r2_bucket_reservations(organization_id,project_id,environment_id,preparation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preview_r2_bucket_absence_no_update BEFORE UPDATE ON preview_r2_bucket_absence_observations BEGIN SELECT RAISE(ABORT,'preview R2 absence evidence is immutable'); END;
CREATE TRIGGER preview_r2_bucket_absence_no_delete BEFORE DELETE ON preview_r2_bucket_absence_observations BEGIN SELECT RAISE(ABORT,'preview R2 absence evidence is immutable'); END;
