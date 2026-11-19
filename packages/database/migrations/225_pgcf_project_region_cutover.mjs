/** Install owner-only cutover tooling; this migration never changes a project region. */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE pgcf_project_region_cutovers (
      cutover_id ulid PRIMARY KEY, one_time boolean NOT NULL DEFAULT true UNIQUE CHECK(one_time),
      manifest_sha256 bytea NOT NULL CHECK(octet_length(manifest_sha256)=32),
      writer_freeze_sha256 bytea NOT NULL CHECK(octet_length(writer_freeze_sha256)=32),
      project_manifest jsonb NOT NULL CHECK(jsonb_typeof(project_manifest)='array'),
      expected_active_count integer NOT NULL CHECK(expected_active_count>0),
      changed_eu_count integer NOT NULL CHECK(changed_eu_count>=0 AND changed_eu_count<=expected_active_count),
      executed_by name NOT NULL, executed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER pgcf_project_region_cutovers_append_only BEFORE UPDATE OR DELETE ON pgcf_project_region_cutovers
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    REVOKE ALL ON pgcf_project_region_cutovers FROM PUBLIC;

    CREATE FUNCTION apply_pgcf_project_region_cutover(
      p_cutover_id ulid,p_manifest_sha256 bytea,p_writer_freeze_sha256 bytea,
      p_project_manifest jsonb,p_expected_active_count integer,p_expected_eu_count integer
    ) RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE prior pgcf_project_region_cutovers%ROWTYPE; item jsonb; actual_count integer; changed_count integer;
    BEGIN
      IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='projects'::regclass) THEN
        RAISE EXCEPTION 'project region cutover requires the schema owner' USING ERRCODE='42501';
      END IF;
      IF p_cutover_id IS NULL OR octet_length(p_manifest_sha256) IS DISTINCT FROM 32 OR octet_length(p_writer_freeze_sha256) IS DISTINCT FROM 32
        OR jsonb_typeof(p_project_manifest) IS DISTINCT FROM 'array' OR p_expected_active_count IS NULL OR p_expected_active_count<1
        OR p_expected_eu_count IS NULL OR p_expected_eu_count<0 OR p_expected_eu_count>p_expected_active_count
        OR jsonb_array_length(p_project_manifest)<>p_expected_active_count THEN
        RAISE EXCEPTION 'project region cutover manifest is invalid' USING ERRCODE='23514';
      END IF;
      LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE project_ownerships IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE pgcf_project_region_cutovers IN EXCLUSIVE MODE;
      SELECT * INTO prior FROM pgcf_project_region_cutovers;
      IF FOUND THEN
        IF prior.cutover_id=p_cutover_id AND prior.manifest_sha256=p_manifest_sha256 AND prior.writer_freeze_sha256=p_writer_freeze_sha256
          AND prior.project_manifest=p_project_manifest AND prior.expected_active_count=p_expected_active_count AND prior.changed_eu_count=p_expected_eu_count THEN
          RETURN prior.changed_eu_count;
        END IF;
        RAISE EXCEPTION 'project region cutover already has a different immutable manifest' USING ERRCODE='55000';
      END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(p_project_manifest) LOOP
        IF jsonb_typeof(item)<>'object' OR NOT(item ?& ARRAY['organizationId','projectId','fromRegion','lifecycleVersion'])
          OR item-ARRAY['organizationId','projectId','fromRegion','lifecycleVersion']<>'{}'::jsonb
          OR jsonb_typeof(item->'organizationId') IS DISTINCT FROM 'string' OR item->>'organizationId' !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
          OR jsonb_typeof(item->'projectId') IS DISTINCT FROM 'string' OR item->>'projectId' !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
          OR jsonb_typeof(item->'fromRegion') IS DISTINCT FROM 'string' OR item->>'fromRegion' NOT IN ('us','eu')
          OR jsonb_typeof(item->'lifecycleVersion') IS DISTINCT FROM 'number' OR item->>'lifecycleVersion' !~ '^[1-9][0-9]*$'
          OR (item->>'lifecycleVersion')::numeric>9007199254740991 THEN
          RAISE EXCEPTION 'project region cutover row is invalid' USING ERRCODE='23514';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT value->>'projectId') FROM jsonb_array_elements(p_project_manifest))<>p_expected_active_count
        OR (SELECT count(*) FROM jsonb_array_elements(p_project_manifest) WHERE value->>'fromRegion'='eu')<>p_expected_eu_count THEN
        RAISE EXCEPTION 'project region cutover manifest counts conflict' USING ERRCODE='23514';
      END IF;
      SELECT count(*) INTO actual_count FROM projects p JOIN project_ownerships o USING(project_id) WHERE p.lifecycle_state='active' AND o.state='active';
      IF actual_count<>p_expected_active_count OR EXISTS(
        SELECT 1 FROM projects p JOIN project_ownerships o USING(project_id)
        WHERE p.lifecycle_state='active' AND o.state='active' AND NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements(p_project_manifest) expected
          WHERE expected->>'projectId'=p.project_id::text AND expected->>'organizationId'=o.organization_id::text
            AND expected->>'fromRegion'=p.region AND (expected->>'lifecycleVersion')::bigint=p.lifecycle_version
        )
      ) THEN RAISE EXCEPTION 'active project inventory changed after freeze' USING ERRCODE='40001'; END IF;
      IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid='projects'::regclass AND tgname='projects_region_immutable') IS DISTINCT FROM 'O' THEN
        RAISE EXCEPTION 'ordinary project region immutability is not enabled' USING ERRCODE='55000';
      END IF;
      ALTER TABLE projects DISABLE TRIGGER projects_region_immutable;
      UPDATE projects p SET region='us' FROM jsonb_array_elements(p_project_manifest) expected
        WHERE p.project_id::text=expected->>'projectId' AND p.region='eu';
      GET DIAGNOSTICS changed_count=ROW_COUNT;
      ALTER TABLE projects ENABLE TRIGGER projects_region_immutable;
      IF changed_count<>p_expected_eu_count THEN RAISE EXCEPTION 'project region update count conflicts' USING ERRCODE='40001'; END IF;
      INSERT INTO pgcf_project_region_cutovers(cutover_id,manifest_sha256,writer_freeze_sha256,project_manifest,expected_active_count,changed_eu_count,executed_by)
        VALUES(p_cutover_id,p_manifest_sha256,p_writer_freeze_sha256,p_project_manifest,p_expected_active_count,changed_count,current_user);
      RETURN changed_count;
    END $$;
    REVOKE ALL ON FUNCTION apply_pgcf_project_region_cutover(ulid,bytea,bytea,jsonb,integer,integer) FROM PUBLIC;

    CREATE FUNCTION project_database_target_is_ready(p_organization_id ulid,p_project_id ulid,p_physical_environment_id ulid)
      RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(
        SELECT 1 FROM database_provider_target_heads head
        JOIN database_provider_target_revisions target USING(organization_id,project_id,physical_environment_id,target_version)
        JOIN project_ownerships ownership USING(organization_id,project_id)
        WHERE head.organization_id=p_organization_id AND head.project_id=p_project_id
          AND head.physical_environment_id=p_physical_environment_id AND head.state='active' AND ownership.state='active'
          AND ((target.provider='neon' AND EXISTS(SELECT 1 FROM neon_project_placement_receipts placement
            WHERE placement.organization_id=head.organization_id AND placement.project_id=head.project_id
              AND placement.environment_id=head.physical_environment_id AND placement.provider_project_id=target.provider_project_id
              AND placement.default_branch_id=target.branch_id AND placement.state='ready'))
            OR (target.provider='pgcf' AND EXISTS(
              SELECT 1 FROM project_database_registration_receipts registration
              WHERE registration.organization_id=head.organization_id AND registration.project_id=head.project_id
                AND registration.physical_environment_id=head.physical_environment_id AND registration.status='active'
                AND registration.metadata->>'provider'='pgcf' AND registration.metadata->>'providerProjectId'=target.provider_project_id
                AND registration.metadata->>'databaseId'=target.database_id
                AND NOT EXISTS(SELECT 1 FROM project_database_registration_receipts newer
                  WHERE newer.organization_id=head.organization_id AND newer.project_id=head.project_id AND newer.physical_environment_id=head.physical_environment_id
                    AND newer.registration_version>registration.registration_version)
                AND NOT EXISTS(SELECT 1 FROM project_database_registration_reservations pending
                  WHERE pending.organization_id=head.organization_id AND pending.project_id=head.project_id AND pending.physical_environment_id=head.physical_environment_id
                    AND pending.registration_version>registration.registration_version)
            )))
      )
    $$;

    CREATE FUNCTION database_provider_binding_is_current(p_organization_id ulid,p_project_id ulid,p_environment_id ulid,p_staged_at timestamptz)
      RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT NOT EXISTS(
        SELECT 1 FROM database_provider_target_heads head
        JOIN database_provider_target_revisions target USING(organization_id,project_id,physical_environment_id,target_version)
        WHERE head.organization_id=p_organization_id AND head.project_id=p_project_id
          AND head.physical_environment_id=current_data_environment(p_organization_id,p_project_id,p_environment_id)
          AND head.state='active' AND target.provider='pgcf'
          AND (p_staged_at IS NULL OR p_staged_at <= (
            SELECT min(bound.created_at) FROM database_provider_target_revisions bound
            WHERE bound.organization_id=target.organization_id AND bound.project_id=target.project_id
              AND bound.physical_environment_id=target.physical_environment_id AND bound.provider='pgcf'
              AND bound.provider_project_id=target.provider_project_id AND bound.database_id=target.database_id
          ))
      )
    $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pgcf_project_region_cutovers) THEN RAISE EXCEPTION 'applied project region cutover prevents downgrade'; END IF; END $$;
    DROP FUNCTION project_database_target_is_ready(ulid,ulid,ulid);
    DROP FUNCTION database_provider_binding_is_current(ulid,ulid,ulid,timestamptz);
    DROP FUNCTION apply_pgcf_project_region_cutover(ulid,bytea,bytea,jsonb,integer,integer);
    DROP TABLE pgcf_project_region_cutovers;`);
}
