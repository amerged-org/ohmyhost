export function up(pgm) {
  pgm.sql(`CREATE TABLE database_provider_cutover_authorizations (
    operation_id ulid PRIMARY KEY,organization_id ulid NOT NULL,project_id ulid NOT NULL,physical_environment_id ulid NOT NULL,
    manifest_sha256 bytea NOT NULL CHECK(octet_length(manifest_sha256)=32),expected_lifecycle_version integer NOT NULL CHECK(expected_lifecycle_version>0),
    source_target_version bigint NOT NULL CHECK(source_target_version>0),source_registration jsonb NOT NULL CHECK(valid_project_database_registration_metadata_neon(source_registration) IS TRUE),
    target_provider_project_id text NOT NULL CHECK(target_provider_project_id~'^prj_[a-z0-9]{20}$'),target_region_id text NOT NULL CHECK(target_region_id='us-dev'),target_size_class_id text NOT NULL,
    approved_at timestamptz NOT NULL,approved_by text NOT NULL CHECK(length(approved_by) BETWEEN 1 AND 256),
    FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
    FOREIGN KEY(organization_id,project_id,physical_environment_id,source_target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version),
    CHECK(source_registration->>'organizationId'=organization_id::text AND source_registration->>'projectId'=project_id::text AND source_registration->>'physicalEnvironmentId'=physical_environment_id::text AND source_registration->>'status'='active')
  );
  CREATE TRIGGER database_provider_cutover_authorizations_append_only BEFORE UPDATE OR DELETE ON database_provider_cutover_authorizations FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE TABLE database_provider_cutover_verifications (
    operation_id ulid PRIMARY KEY REFERENCES database_provider_cutover_authorizations(operation_id),
    target_database_id text NOT NULL CHECK(target_database_id~'^[a-z][a-z0-9]{19}$'),
    writer_fence_sha256 bytea NOT NULL CHECK(octet_length(writer_fence_sha256)=32),verification_sha256 bytea NOT NULL CHECK(octet_length(verification_sha256)=32),
    verified_at timestamptz NOT NULL,verified_by text NOT NULL CHECK(length(verified_by) BETWEEN 1 AND 256)
  );
  CREATE TRIGGER database_provider_cutover_verifications_append_only BEFORE UPDATE OR DELETE ON database_provider_cutover_verifications FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE TABLE database_provider_cutover_releases (
    operation_id ulid PRIMARY KEY REFERENCES database_provider_cutover_authorizations(operation_id),released_at timestamptz NOT NULL,released_by text NOT NULL
  );
  CREATE TRIGGER database_provider_cutover_releases_append_only BEFORE UPDATE OR DELETE ON database_provider_cutover_releases FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE TABLE database_provider_cutover_binding_refreshes (
    cutover_operation_id ulid NOT NULL REFERENCES database_provider_cutover_authorizations(operation_id),refresh_operation_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,project_id ulid NOT NULL,environment_id ulid NOT NULL,physical_environment_id ulid NOT NULL,
    target_version bigint NOT NULL,target_registration_version bigint NOT NULL,approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),approved_by text NOT NULL DEFAULT current_user,
    FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id),
    FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version)
  );
  CREATE TRIGGER database_provider_cutover_binding_refreshes_append_only BEFORE UPDATE OR DELETE ON database_provider_cutover_binding_refreshes FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE TABLE database_provider_cutover_receipts (
    operation_id ulid NOT NULL REFERENCES database_provider_cutover_authorizations(operation_id),
    phase text NOT NULL CHECK(phase IN ('prepared','roles_ready','source_revoked','registered','activated')),
    metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(operation_id,phase)
  );
  CREATE TRIGGER database_provider_cutover_receipts_append_only BEFORE UPDATE OR DELETE ON database_provider_cutover_receipts FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE FUNCTION pgcf_provider_cutover_pending(org ulid,project ulid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM database_provider_cutover_authorizations a WHERE a.organization_id=org AND a.project_id=project AND NOT EXISTS(SELECT 1 FROM database_provider_cutover_releases released WHERE released.operation_id=a.operation_id)) $$;
  CREATE FUNCTION pgcf_cutover_binding_refresh_permitted(org ulid,project ulid,environment ulid,operation ulid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM database_provider_cutover_binding_refreshes permit JOIN database_provider_cutover_authorizations a ON a.operation_id=permit.cutover_operation_id JOIN operations op ON op.operation_id=a.operation_id JOIN database_provider_target_heads h ON h.organization_id=permit.organization_id AND h.project_id=permit.project_id AND h.physical_environment_id=permit.physical_environment_id AND h.target_version=permit.target_version JOIN database_provider_target_revisions r ON r.organization_id=h.organization_id AND r.project_id=h.project_id AND r.physical_environment_id=h.physical_environment_id AND r.target_version=h.target_version WHERE permit.organization_id=org AND permit.project_id=project AND permit.environment_id=environment AND permit.refresh_operation_id=operation AND a.organization_id=org AND a.project_id=project AND op.state='succeeded' AND h.state='active' AND r.provider='pgcf' AND current_data_environment(org,project,environment)=permit.physical_environment_id AND EXISTS(SELECT 1 FROM project_database_registration_receipts registration WHERE registration.organization_id=org AND registration.project_id=project AND registration.physical_environment_id=permit.physical_environment_id AND registration.registration_version=permit.target_registration_version AND registration.status='active' AND registration.metadata->>'databaseId'=r.database_id AND registration.registration_version=(SELECT max(latest.registration_version) FROM project_database_registration_receipts latest WHERE latest.organization_id=org AND latest.project_id=project AND latest.physical_environment_id=permit.physical_environment_id))) $$;
  CREATE FUNCTION fence_project_provider_cutover() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF pgcf_provider_cutover_pending(NEW.organization_id,NEW.project_id) AND NOT(NEW.event_type='DeploymentRequestedV1' AND pgcf_cutover_binding_refresh_permitted(NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.operation_id) AND EXISTS(SELECT 1 FROM product_command_intents intent WHERE intent.organization_id=NEW.organization_id AND intent.project_id=NEW.project_id AND intent.operation_id=NEW.operation_id AND intent.environment_id=NEW.environment_id AND intent.event_type='DeploymentRequestedV1' AND intent.binding_refresh_snapshot IS NOT NULL AND intent.binding_refresh_snapshot->>'dataEnvironmentId'=current_data_environment(NEW.organization_id,NEW.project_id,NEW.environment_id)::text AND intent.binding_refresh_snapshot->>'registrationVersion'=(SELECT permit.target_registration_version::text FROM database_provider_cutover_binding_refreshes permit WHERE permit.refresh_operation_id=NEW.operation_id))) THEN RAISE EXCEPTION 'project provider cutover is not released' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER fence_project_provider_cutover BEFORE INSERT ON product_provider_mutation_claims FOR EACH ROW EXECUTE FUNCTION fence_project_provider_cutover();
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
    GRANT SELECT ON database_provider_cutover_authorizations,database_provider_cutover_verifications,database_provider_cutover_releases,database_provider_cutover_binding_refreshes TO control_runtime;
    GRANT SELECT,INSERT ON database_provider_cutover_receipts TO control_runtime;
  END IF; END $$;`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM database_provider_cutover_authorizations) THEN RAISE EXCEPTION 'provider cutover evidence prevents downgrade'; END IF; END $$;
    DROP TRIGGER fence_project_provider_cutover ON product_provider_mutation_claims; DROP FUNCTION fence_project_provider_cutover(); DROP FUNCTION pgcf_cutover_binding_refresh_permitted(ulid,ulid,ulid,ulid); DROP FUNCTION pgcf_provider_cutover_pending(ulid,ulid);
    DROP TABLE database_provider_cutover_receipts; DROP TABLE database_provider_cutover_binding_refreshes; DROP TABLE database_provider_cutover_releases; DROP TABLE database_provider_cutover_verifications; DROP TABLE database_provider_cutover_authorizations;`);
}
