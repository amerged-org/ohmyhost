/** Non-destructive Paid expiry control; serving intervals and native usage remain authoritative. */
export function up(pgm) {
  pgm.sql(`
    CREATE TABLE pgcf_database_entitlement_policies (
      organization_id ulid NOT NULL,project_id ulid NOT NULL,physical_environment_id ulid NOT NULL,database_id text NOT NULL,
      suspended_by_entitlement boolean NOT NULL DEFAULT false,suspension_operation_id text,suspension_generation bigint,last_checked_at timestamptz NOT NULL,
      CHECK((suspended_by_entitlement AND suspension_operation_id IS NOT NULL AND suspension_generation IS NOT NULL AND suspension_operation_id~'^op_[a-z0-9]{20}$' AND suspension_generation>0) OR (NOT suspended_by_entitlement AND suspension_operation_id IS NULL AND suspension_generation IS NULL)),
      PRIMARY KEY(organization_id,project_id,physical_environment_id,database_id),
      FOREIGN KEY(organization_id,project_id,physical_environment_id) REFERENCES project_data_environments(organization_id,project_id,data_environment_id),
      CHECK(database_id~'^[a-z][a-z0-9]{19}$')
    );
    CREATE TABLE pgcf_database_entitlement_actions (
      action_id ulid PRIMARY KEY,organization_id ulid NOT NULL,project_id ulid NOT NULL,physical_environment_id ulid NOT NULL,
      billing_epoch_id ulid NOT NULL,target_version bigint NOT NULL,provider_project_id text NOT NULL,database_id text NOT NULL,
      action text NOT NULL CHECK(action IN ('suspend','resume')),expected_generation bigint NOT NULL CHECK(expected_generation>0),idempotency_key text NOT NULL UNIQUE,
      state text NOT NULL CHECK(state IN ('reserved','dispatched','pending','succeeded','failed','cancelled','superseded')),
      provider_operation_id text,provider_generation bigint CHECK(provider_generation>0),claim_id ulid NOT NULL,claim_expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,dispatched_at timestamptz,observed_at timestamptz,
      FOREIGN KEY(organization_id,project_id,physical_environment_id,target_version) REFERENCES database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version),
      FOREIGN KEY(billing_epoch_id,project_id,organization_id) REFERENCES billing_epochs(billing_epoch_id,project_id,organization_id),
      CHECK(provider_project_id~'^prj_[a-z0-9]{20}$' AND database_id~'^[a-z][a-z0-9]{19}$'),
      CHECK(idempotency_key~'^omh-entitlement-[a-f0-9]{64}$'),
      CHECK(provider_operation_id IS NULL OR provider_operation_id~'^op_[a-z0-9]{20}$'),
      CHECK((provider_operation_id IS NULL)=(provider_generation IS NULL)),
      CHECK(state<>'succeeded' OR (provider_operation_id IS NOT NULL AND provider_generation IS NOT NULL))
    );
    CREATE UNIQUE INDEX pgcf_entitlement_one_pending ON pgcf_database_entitlement_actions
      (organization_id,project_id,physical_environment_id,database_id) WHERE state IN ('reserved','dispatched','pending');
    CREATE FUNCTION guard_pgcf_entitlement_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','provider_operation_id','provider_generation','claim_id','claim_expires_at','dispatched_at','observed_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','provider_operation_id','provider_generation','claim_id','claim_expires_at','dispatched_at','observed_at'])
        OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id)
        OR (OLD.provider_generation IS NOT NULL AND NEW.provider_generation IS DISTINCT FROM OLD.provider_generation)
        OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
        OR (OLD.state IN ('succeeded','failed','cancelled','superseded') AND NEW IS DISTINCT FROM OLD)
      THEN RAISE EXCEPTION 'PGCF entitlement action identity is immutable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER guard_pgcf_entitlement_action BEFORE UPDATE OR DELETE ON pgcf_database_entitlement_actions
      FOR EACH ROW EXECUTE FUNCTION guard_pgcf_entitlement_action();
    REVOKE ALL ON pgcf_database_entitlement_policies,pgcf_database_entitlement_actions FROM PUBLIC;
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      GRANT SELECT,INSERT,UPDATE ON pgcf_database_entitlement_policies,pgcf_database_entitlement_actions TO control_runtime;
    END IF; END $$;
  `);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pgcf_database_entitlement_actions) THEN RAISE EXCEPTION 'PGCF entitlement evidence prevents downgrade'; END IF; END $$;
    DROP TABLE pgcf_database_entitlement_actions;DROP FUNCTION guard_pgcf_entitlement_action();DROP TABLE pgcf_database_entitlement_policies;`);
}
