/** Delayed final usage belongs to its serving interval and epoch, including after retirement. */
const trusted = (sql) =>
  `DO $install$ BEGIN EXECUTE replace($definition$${sql}$definition$, '@S@', quote_ident(current_schema())); END $install$;`;

export function up(pgm) {
  pgm.sql(`
    CREATE TABLE billing_environment_scopes (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, environment_id ulid NOT NULL,
      PRIMARY KEY(organization_id,project_id,environment_id),
      FOREIGN KEY(project_id,environment_id) REFERENCES environments(project_id,environment_id)
    );
    INSERT INTO billing_environment_scopes
      SELECT organization_id,project_id,environment_id FROM environments
      UNION SELECT organization_id,project_id,environment_id FROM environment_data_assignments;
    CREATE TRIGGER billing_environment_scopes_append_only BEFORE UPDATE OR DELETE
      ON billing_environment_scopes FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
    -- Logical environment ownership remains proved by the same exact three-column scope.
    -- Keeping the historical scope makes delayed financial work independent of current ownership.
    DO $$ DECLARE dependency record; BEGIN
      FOR dependency IN SELECT conname FROM pg_constraint
        WHERE conrelid='organization_credit_reservations'::regclass AND confrelid='environments'::regclass LOOP
        EXECUTE format('ALTER TABLE organization_credit_reservations DROP CONSTRAINT %I',dependency.conname);
      END LOOP;
    END $$;
    ALTER TABLE organization_credit_reservations
      ADD CONSTRAINT organization_credit_reservations_historical_environment_fk
        FOREIGN KEY(organization_id,project_id,environment_id)
        REFERENCES billing_environment_scopes(organization_id,project_id,environment_id);
    ALTER TABLE metering_cohort_work DROP CONSTRAINT metering_cohort_work_environment_fk,
      ADD CONSTRAINT metering_cohort_work_environment_fk FOREIGN KEY(organization_id,project_id,environment_id)
        REFERENCES billing_environment_scopes(organization_id,project_id,environment_id);

    CREATE TABLE pgcf_database_serving_intervals (
      organization_id ulid NOT NULL, project_id ulid NOT NULL, physical_environment_id ulid NOT NULL,
      target_version bigint NOT NULL, provider_project_id text NOT NULL, database_id text NOT NULL,
      started_at timestamptz NOT NULL, billable_from timestamptz NOT NULL, ended_at timestamptz,
      PRIMARY KEY(organization_id,project_id,physical_environment_id,started_at),
      FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version)
        REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version),
      CHECK(billable_from=date_trunc('hour',started_at,'UTC')+interval '1 hour'),
      CHECK(ended_at IS NULL OR ended_at>=started_at)
    );
    CREATE UNIQUE INDEX pgcf_serving_interval_open_physical ON pgcf_database_serving_intervals
      (organization_id,project_id,physical_environment_id) WHERE ended_at IS NULL;
    CREATE UNIQUE INDEX pgcf_serving_interval_open_database ON pgcf_database_serving_intervals
      (provider_project_id,database_id) WHERE ended_at IS NULL;
    CREATE INDEX pgcf_serving_interval_usage ON pgcf_database_serving_intervals
      (provider_project_id,database_id,started_at);
    INSERT INTO pgcf_database_serving_intervals
      SELECT h.organization_id,h.project_id,h.physical_environment_id,h.target_version,
        r.provider_project_id,r.database_id,h.activated_at,date_trunc('hour',h.activated_at,'UTC')+interval '1 hour',NULL
      FROM database_provider_target_heads h JOIN database_provider_target_revisions r
        USING(organization_id,project_id,physical_environment_id,target_version)
      WHERE h.state='active' AND h.activated_at IS NOT NULL AND r.provider='pgcf';
  `);
  pgm.sql(
    trusted(`
    CREATE FUNCTION @S@.capture_billing_environment_scope() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
      INSERT INTO @S@.billing_environment_scopes VALUES(NEW.organization_id,NEW.project_id,NEW.environment_id)
        ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER capture_billing_environment_scope AFTER INSERT OR UPDATE OF organization_id ON @S@.environments
      FOR EACH ROW EXECUTE FUNCTION @S@.capture_billing_environment_scope();
    CREATE FUNCTION @S@.guard_pgcf_serving_interval() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
      IF TG_OP='DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
        OR (to_jsonb(OLD)-'ended_at') IS DISTINCT FROM (to_jsonb(NEW)-'ended_at') THEN
        RAISE EXCEPTION 'PGCF serving history is immutable';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER guard_pgcf_serving_interval BEFORE UPDATE OR DELETE ON @S@.pgcf_database_serving_intervals
      FOR EACH ROW EXECUTE FUNCTION @S@.guard_pgcf_serving_interval();
    CREATE FUNCTION @S@.capture_pgcf_serving_interval() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
    DECLARE previous @S@.pgcf_database_serving_intervals%ROWTYPE;
      target @S@.database_provider_target_revisions%ROWTYPE; finish timestamptz;
    BEGIN
      IF TG_OP<>'INSERT' THEN
        SELECT * INTO previous FROM @S@.pgcf_database_serving_intervals
          WHERE organization_id=OLD.organization_id AND project_id=OLD.project_id
            AND physical_environment_id=OLD.physical_environment_id AND ended_at IS NULL FOR UPDATE;
      END IF;
      IF TG_OP<>'DELETE' AND NEW.state='active' AND NEW.activated_at IS NOT NULL THEN
        SELECT * INTO target FROM @S@.database_provider_target_revisions
          WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
            AND physical_environment_id=NEW.physical_environment_id AND target_version=NEW.target_version
            AND provider='pgcf';
      END IF;
      IF previous.started_at IS NOT NULL THEN
        IF target.database_id IS NOT NULL AND previous.organization_id=NEW.organization_id
          AND previous.project_id=NEW.project_id AND previous.physical_environment_id=NEW.physical_environment_id
          AND previous.provider_project_id=target.provider_project_id AND previous.database_id=target.database_id
          AND previous.started_at=NEW.activated_at THEN RETURN NEW; END IF;
        finish:=CASE WHEN TG_OP='DELETE' OR NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
          THEN clock_timestamp() ELSE NEW.updated_at END;
        UPDATE @S@.pgcf_database_serving_intervals SET ended_at=finish
          WHERE organization_id=previous.organization_id AND project_id=previous.project_id
            AND physical_environment_id=previous.physical_environment_id AND started_at=previous.started_at;
      END IF;
      IF target.database_id IS NOT NULL THEN
        INSERT INTO @S@.pgcf_database_serving_intervals
          VALUES(NEW.organization_id,NEW.project_id,NEW.physical_environment_id,NEW.target_version,
            target.provider_project_id,target.database_id,NEW.activated_at,
            date_trunc('hour',NEW.activated_at,'UTC')+interval '1 hour',NULL);
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER capture_pgcf_serving_interval AFTER INSERT OR UPDATE OR DELETE ON @S@.database_provider_target_heads
      FOR EACH ROW EXECUTE FUNCTION @S@.capture_pgcf_serving_interval();
  `),
  );
  pgm.sql(`
    REVOKE ALL ON billing_environment_scopes,pgcf_database_serving_intervals FROM PUBLIC;
    REVOKE ALL ON FUNCTION capture_billing_environment_scope(),guard_pgcf_serving_interval(),capture_pgcf_serving_interval() FROM PUBLIC;
    DO $$ DECLARE runtime_role text; BEGIN
      FOR runtime_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('control_runtime','metering_runtime') LOOP
        EXECUTE format('REVOKE ALL ON TABLE billing_environment_scopes,pgcf_database_serving_intervals FROM %I',runtime_role);
        EXECUTE format('GRANT SELECT ON TABLE billing_environment_scopes,pgcf_database_serving_intervals TO %I',runtime_role);
        EXECUTE format('REVOKE ALL ON FUNCTION capture_billing_environment_scope(),guard_pgcf_serving_interval(),capture_pgcf_serving_interval() FROM %I',runtime_role);
      END LOOP;
    END $$;
  `);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pgcf_database_serving_intervals) THEN
    RAISE EXCEPTION 'PGCF serving history must be retained'; END IF; END $$;
    ALTER TABLE organization_credit_reservations DROP CONSTRAINT organization_credit_reservations_historical_environment_fk,
      ADD FOREIGN KEY(organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,environment_id);
    ALTER TABLE metering_cohort_work DROP CONSTRAINT metering_cohort_work_environment_fk,
      ADD CONSTRAINT metering_cohort_work_environment_fk FOREIGN KEY(organization_id,project_id,environment_id)
        REFERENCES environments(organization_id,project_id,environment_id);
    DROP TRIGGER capture_pgcf_serving_interval ON database_provider_target_heads;
    DROP FUNCTION capture_pgcf_serving_interval();
    DROP TABLE pgcf_database_serving_intervals; DROP FUNCTION guard_pgcf_serving_interval();
    DROP TRIGGER capture_billing_environment_scope ON environments;
    DROP FUNCTION capture_billing_environment_scope(); DROP TABLE billing_environment_scopes;
  `);
}
