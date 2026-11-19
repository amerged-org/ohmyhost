/** Provider identity is separate from historical Neon receipts and logical Dev/Prod assignment. */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE database_provider_target_revisions (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, physical_environment_id ulid NOT NULL,
      target_version bigint NOT NULL CHECK(target_version>0), provider text NOT NULL CHECK(provider IN ('neon','pgcf')),
      provider_project_id text NOT NULL, database_id text, branch_id text, region_id text NOT NULL,
      size_class_id text, runtime_role text NOT NULL, credential_reference text NOT NULL,
      operation_id ulid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(organization_id,project_id,physical_environment_id,target_version),
      FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
      FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
      CHECK(runtime_role='ohmyho_rw_'||lower(physical_environment_id::text)),
      CHECK(length(credential_reference) BETWEEN 1 AND 256),
      CHECK((provider='neon' AND provider_project_id~'^[a-z0-9-]{1,60}$' AND branch_id IS NOT NULL AND branch_id~'^[a-z0-9-]{1,60}$' AND database_id IS NULL AND size_class_id IS NULL)
         OR(provider='pgcf' AND provider_project_id~'^prj_[a-z0-9]{20}$' AND database_id IS NOT NULL AND database_id~'^[a-z][a-z0-9]{19}$' AND branch_id IS NULL AND region_id IN ('us-dev','eu-dev') AND size_class_id IS NOT NULL AND size_class_id~'^[a-z][a-z0-9-]{0,30}[a-z0-9]$'))
    );
    CREATE TRIGGER database_provider_target_revisions_append_only BEFORE UPDATE OR DELETE ON database_provider_target_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    CREATE TABLE database_provider_target_heads (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, physical_environment_id ulid NOT NULL,
      target_version bigint NOT NULL, state text NOT NULL CHECK(state IN ('active','retired')),
      activated_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(organization_id,project_id,physical_environment_id),
      FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version)
    );
    INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,branch_id,region_id,runtime_role,credential_reference,operation_id,created_at)
      SELECT organization_id,project_id,environment_id,1,'neon',provider_project_id,default_branch_id,region_id,'ohmyho_rw_'||lower(environment_id::text),'registry:'||environment_id::text,NULL,created_at FROM neon_project_placement_receipts;
    INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state)
      SELECT r.organization_id,r.project_id,r.physical_environment_id,1,CASE WHEN p.lifecycle_state='active' AND o.state='active' AND EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=o.organization_id AND e.project_id=p.project_id AND current_data_environment(e.organization_id,e.project_id,e.environment_id)=r.physical_environment_id) THEN 'active' ELSE 'retired' END
      FROM database_provider_target_revisions r JOIN projects p USING(project_id) JOIN project_ownerships o USING(project_id);
    CREATE INDEX database_provider_target_revisions_resource ON database_provider_target_revisions(provider,provider_project_id,database_id);
    CREATE FUNCTION guard_database_provider_target_head() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target database_provider_target_revisions%ROWTYPE; BEGIN
      IF TG_OP='UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.physical_environment_id IS DISTINCT FROM OLD.physical_environment_id OR NEW.target_version<OLD.target_version) THEN RAISE EXCEPTION 'provider target identity cannot be rewritten' USING ERRCODE='55000'; END IF;
      SELECT * INTO target FROM database_provider_target_revisions WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND physical_environment_id=NEW.physical_environment_id AND target_version=NEW.target_version;
      IF NEW.state='active' AND target.provider='pgcf' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('pgcf-target/'||target.provider_project_id||'/'||target.database_id,0));
        IF EXISTS(SELECT 1 FROM database_provider_target_heads h JOIN database_provider_target_revisions r USING(organization_id,project_id,physical_environment_id,target_version) WHERE h.state='active' AND r.provider='pgcf' AND r.provider_project_id=target.provider_project_id AND r.database_id=target.database_id AND (h.organization_id,h.project_id,h.physical_environment_id) IS DISTINCT FROM (NEW.organization_id,NEW.project_id,NEW.physical_environment_id)) THEN RAISE EXCEPTION 'PGCF database already belongs to another physical identity' USING ERRCODE='42501'; END IF;
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER guard_database_provider_target_head BEFORE INSERT OR UPDATE ON database_provider_target_heads FOR EACH ROW EXECUTE FUNCTION guard_database_provider_target_head();
    CREATE FUNCTION capture_initial_neon_provider_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,branch_id,region_id,runtime_role,credential_reference,created_at)
        VALUES(NEW.organization_id,NEW.project_id,NEW.environment_id,1,'neon',NEW.provider_project_id,NEW.default_branch_id,NEW.region_id,'ohmyho_rw_'||lower(NEW.environment_id::text),'registry:'||NEW.environment_id::text,NEW.created_at) ON CONFLICT DO NOTHING;
      INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state)
        SELECT NEW.organization_id,NEW.project_id,NEW.environment_id,1,'active' WHERE EXISTS(SELECT 1 FROM projects p JOIN project_ownerships o USING(project_id) WHERE p.project_id=NEW.project_id AND p.lifecycle_state='active' AND o.organization_id=NEW.organization_id AND o.state='active') ON CONFLICT DO NOTHING;
      RETURN NEW; END $$;
    CREATE TRIGGER capture_initial_neon_provider_target AFTER INSERT ON neon_project_placement_receipts FOR EACH ROW EXECUTE FUNCTION capture_initial_neon_provider_target();
    CREATE TABLE database_provider_operations (
      organization_id ulid NOT NULL,project_id ulid NOT NULL,physical_environment_id ulid NOT NULL,
      operation_id ulid NOT NULL,claim_id ulid NOT NULL,step text NOT NULL CHECK(step~'^[a-z][a-z0-9_.:-]{0,127}$'),
      idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key~'^omh-[a-f0-9]{64}$'),
      provider_project_id text NOT NULL CHECK(provider_project_id~'^prj_[a-z0-9]{20}$'),
      request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),request_body jsonb NOT NULL,
      provider_operation_id text CHECK(provider_operation_id~'^op_[a-z0-9]{20}$'),database_id text CHECK(database_id~'^[a-z][a-z0-9]{19}$'),
      state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','pending','succeeded','failed')),
      dispatched_at timestamptz,observed_at timestamptz,
      PRIMARY KEY(organization_id,project_id,physical_environment_id,operation_id,step),
      FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
      FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id),
      CHECK(jsonb_typeof(request_body)='object'),
      CHECK((state='reserved')=(dispatched_at IS NULL))
    );
    CREATE FUNCTION guard_database_provider_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['provider_operation_id','database_id','state','dispatched_at','observed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['provider_operation_id','database_id','state','dispatched_at','observed_at'])
        OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id)
        OR (OLD.database_id IS NOT NULL AND NEW.database_id IS DISTINCT FROM OLD.database_id)
        OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
        OR (OLD.state IN ('succeeded','failed') AND NEW IS DISTINCT FROM OLD)
      THEN RAISE EXCEPTION 'provider operation identity is immutable' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER database_provider_operations_guard BEFORE UPDATE OR DELETE ON database_provider_operations FOR EACH ROW EXECUTE FUNCTION guard_database_provider_operation_identity();
    CREATE TABLE pgcf_database_migration_receipts (
      organization_id ulid NOT NULL,project_id ulid NOT NULL,physical_environment_id ulid NOT NULL,operation_id ulid NOT NULL,claim_id ulid NOT NULL,
      provider_project_id text NOT NULL CHECK(provider_project_id~'^prj_[a-z0-9]{20}$'),database_id text NOT NULL CHECK(database_id~'^[a-z][a-z0-9]{19}$'),
      bundle_sha256 bytea NOT NULL CHECK(octet_length(bundle_sha256)=32),applied_paths text[] NOT NULL,replayed_paths text[] NOT NULL,completed_at timestamptz NOT NULL,
      PRIMARY KEY(organization_id,project_id,physical_environment_id,operation_id),
      FOREIGN KEY(organization_id,project_id,operation_id) REFERENCES operations(organization_id,project_id,operation_id)
    );
    CREATE TRIGGER pgcf_database_migration_receipts_append_only BEFORE UPDATE OR DELETE ON pgcf_database_migration_receipts FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT,INSERT ON database_provider_target_revisions,pgcf_database_migration_receipts TO control_runtime;
      GRANT SELECT,INSERT,UPDATE ON database_provider_target_heads,database_provider_operations TO control_runtime;
    END IF; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM database_provider_target_revisions WHERE provider='pgcf') OR EXISTS(SELECT 1 FROM database_provider_operations) THEN RAISE EXCEPTION 'provider evidence prevents downgrade'; END IF; END $$;
    DROP TRIGGER capture_initial_neon_provider_target ON neon_project_placement_receipts; DROP FUNCTION capture_initial_neon_provider_target(); DROP TABLE pgcf_database_migration_receipts; DROP TABLE database_provider_operations; DROP FUNCTION guard_database_provider_operation_identity(); DROP TABLE database_provider_target_heads; DROP FUNCTION guard_database_provider_target_head(); DROP TABLE database_provider_target_revisions;`);
}
