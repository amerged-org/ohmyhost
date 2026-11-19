export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE runtime_secret_delivery_states (
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      desired_generation bigint NOT NULL DEFAULT 0,
      applied_generation bigint NOT NULL DEFAULT 0,
      active_lease_id ulid,
      claimed_generation bigint,
      claimed_trigger text,
      claimed_at timestamptz,
      lease_expires_at timestamptz,
      provider_tag text,
      applied_secret_names text[] NOT NULL DEFAULT '{}',
      applied_manifest_sha256 bytea,
      applied_secret_count integer NOT NULL DEFAULT 0,
      last_failure_code text,
      last_failed_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CONSTRAINT runtime_secret_delivery_states_pkey PRIMARY KEY (
        organization_id, project_id, environment_id
      ),
      CONSTRAINT runtime_secret_delivery_states_environment_fkey
        FOREIGN KEY (organization_id, project_id, environment_id)
        REFERENCES environments(organization_id, project_id, environment_id)
        ON DELETE CASCADE,
      CONSTRAINT runtime_secret_delivery_states_generation_check CHECK (
        desired_generation >= 0 AND applied_generation >= 0
        AND applied_generation <= desired_generation
      ),
      CONSTRAINT runtime_secret_delivery_states_lease_check CHECK (
        (active_lease_id IS NULL AND claimed_generation IS NULL AND claimed_trigger IS NULL
          AND claimed_at IS NULL AND lease_expires_at IS NULL)
        OR
        (active_lease_id IS NOT NULL AND claimed_generation IS NOT NULL
          AND claimed_generation >= applied_generation
          AND claimed_generation <= desired_generation
          AND claimed_trigger IN ('deploy','rollback','reconcile')
          AND claimed_at IS NOT NULL AND lease_expires_at > claimed_at)
      ),
      CONSTRAINT runtime_secret_delivery_states_provider_tag_check CHECK (
        provider_tag IS NULL OR provider_tag ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      ),
      CONSTRAINT runtime_secret_delivery_states_manifest_check CHECK (
        (provider_tag IS NULL AND applied_manifest_sha256 IS NULL
          AND applied_secret_count = 0 AND cardinality(applied_secret_names) = 0)
        OR
        (provider_tag IS NOT NULL AND octet_length(applied_manifest_sha256) = 32
          AND applied_secret_count = cardinality(applied_secret_names)
          AND applied_secret_count BETWEEN 0 AND 128)
      ),
      CONSTRAINT runtime_secret_delivery_states_failure_check CHECK (
        (last_failure_code IS NULL AND last_failed_at IS NULL)
        OR
        (last_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$' AND last_failed_at IS NOT NULL)
      ),
      CONSTRAINT runtime_secret_delivery_states_time_check CHECK (updated_at >= created_at)
    );

    INSERT INTO runtime_secret_delivery_states (
      organization_id, project_id, environment_id, created_at, updated_at
    )
    SELECT organization_id, project_id, environment_id, created_at, updated_at
    FROM environments;

    CREATE FUNCTION initialize_runtime_secret_delivery_state() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO runtime_secret_delivery_states (
        organization_id,project_id,environment_id,created_at,updated_at
      ) VALUES (
        NEW.organization_id,NEW.project_id,NEW.environment_id,NEW.created_at,NEW.updated_at
      );
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER environments_runtime_secret_delivery_state
      AFTER INSERT ON environments
      FOR EACH ROW EXECUTE FUNCTION initialize_runtime_secret_delivery_state();

    CREATE INDEX runtime_secret_delivery_pending_idx
      ON runtime_secret_delivery_states(updated_at, organization_id, project_id, environment_id)
      WHERE desired_generation > applied_generation OR last_failure_code IS NOT NULL
        OR active_lease_id IS NOT NULL;

    CREATE TABLE runtime_secret_delivery_receipts (
      receipt_id ulid PRIMARY KEY,
      organization_id ulid NOT NULL,
      project_id ulid NOT NULL,
      environment_id ulid NOT NULL,
      lease_id ulid NOT NULL UNIQUE,
      generation bigint NOT NULL,
      trigger text NOT NULL,
      provider_tag text NOT NULL,
      applied_secret_names text[] NOT NULL,
      manifest_sha256 bytea NOT NULL,
      manifest_secret_count integer NOT NULL,
      completed_at timestamptz NOT NULL,
      CONSTRAINT runtime_secret_delivery_receipts_environment_fkey
        FOREIGN KEY (organization_id, project_id, environment_id)
        REFERENCES environments(organization_id, project_id, environment_id)
        ON DELETE RESTRICT,
      CONSTRAINT runtime_secret_delivery_receipts_generation_check CHECK (generation >= 0),
      CONSTRAINT runtime_secret_delivery_receipts_trigger_check
        CHECK (trigger IN ('deploy','rollback','reconcile')),
      CONSTRAINT runtime_secret_delivery_receipts_provider_tag_check
        CHECK (provider_tag ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
      CONSTRAINT runtime_secret_delivery_receipts_manifest_check CHECK (
        octet_length(manifest_sha256) = 32
        AND manifest_secret_count = cardinality(applied_secret_names)
        AND manifest_secret_count BETWEEN 0 AND 128
      )
    );

    CREATE TRIGGER runtime_secret_delivery_receipts_append_only
      BEFORE UPDATE OR DELETE ON runtime_secret_delivery_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

    CREATE FUNCTION preserve_runtime_secret_generations() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.desired_generation < OLD.desired_generation
        OR NEW.applied_generation < OLD.applied_generation THEN
        RAISE EXCEPTION 'runtime secret generations are monotonic' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER runtime_secret_delivery_generations_monotonic
      BEFORE UPDATE ON runtime_secret_delivery_states
      FOR EACH ROW EXECUTE FUNCTION preserve_runtime_secret_generations();

    CREATE FUNCTION enforce_runtime_secret_name_limit() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM runtime_secret_delivery_states
        WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
          AND environment_id=NEW.environment_id
        FOR UPDATE;
      END IF;
      IF TG_OP = 'INSERT' AND (
        SELECT count(*) >= 128 FROM environment_secrets
        WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
          AND environment_id=NEW.environment_id
      ) THEN
        RAISE EXCEPTION 'runtime secret name limit exceeded' USING ERRCODE = '22023';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER environment_secrets_name_limit
      BEFORE INSERT ON environment_secrets
      FOR EACH ROW EXECUTE FUNCTION enforce_runtime_secret_name_limit();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER environment_secrets_name_limit ON environment_secrets;
    DROP FUNCTION enforce_runtime_secret_name_limit();
    DROP TRIGGER environments_runtime_secret_delivery_state ON environments;
    DROP FUNCTION initialize_runtime_secret_delivery_state();
    DROP TRIGGER runtime_secret_delivery_generations_monotonic ON runtime_secret_delivery_states;
    DROP FUNCTION preserve_runtime_secret_generations();
    DROP TRIGGER runtime_secret_delivery_receipts_append_only ON runtime_secret_delivery_receipts;
    DROP TABLE runtime_secret_delivery_receipts;
    DROP TABLE runtime_secret_delivery_states;
  `);
};
