export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM container_application_receipts) THEN
        RAISE EXCEPTION 'legacy container application receipts cannot be backfilled with runtime secret evidence'
          USING ERRCODE='23514',
            CONSTRAINT='container_application_receipts_runtime_secret_backfill';
      END IF;
      IF EXISTS (
        SELECT 1 FROM runtime_secret_delivery_states WHERE applied_secret_count > 100
        UNION ALL
        SELECT 1 FROM runtime_secret_delivery_receipts WHERE manifest_secret_count > 100
        UNION ALL
        SELECT 1 FROM (
          SELECT organization_id,project_id,environment_id,count(*) AS secret_count
          FROM environment_secrets GROUP BY organization_id,project_id,environment_id
        ) secrets WHERE secret_count > 100
      ) THEN
        RAISE EXCEPTION 'runtime secret count exceeds the unified limit of 100'
          USING ERRCODE='23514',CONSTRAINT='runtime_secret_delivery_limit_100';
      END IF;
    END $$;

    ALTER TABLE runtime_secret_delivery_states
      ADD COLUMN runtime_provider text,
      ADD COLUMN claimed_runtime_provider text;
    UPDATE runtime_secret_delivery_states SET runtime_provider='wfp'
      WHERE provider_tag IS NOT NULL;
    UPDATE runtime_secret_delivery_states SET claimed_runtime_provider='wfp'
      WHERE active_lease_id IS NOT NULL;
    ALTER TABLE runtime_secret_delivery_states
      ADD CONSTRAINT runtime_secret_delivery_states_runtime_provider_check CHECK (
        runtime_provider IS NULL OR runtime_provider IN ('wfp','container')
      ),
      ADD CONSTRAINT runtime_secret_delivery_states_claimed_provider_check CHECK (
        (active_lease_id IS NULL AND claimed_runtime_provider IS NULL)
        OR (active_lease_id IS NOT NULL AND claimed_runtime_provider IN ('wfp','container'))
      );

    ALTER TABLE runtime_secret_delivery_receipts
      ADD COLUMN runtime_provider text NOT NULL DEFAULT 'wfp';
    ALTER TABLE runtime_secret_delivery_receipts ALTER COLUMN runtime_provider DROP DEFAULT;
    ALTER TABLE runtime_secret_delivery_receipts
      ADD CONSTRAINT runtime_secret_delivery_receipts_runtime_provider_check
        CHECK (runtime_provider IN ('wfp','container'));
    CREATE INDEX runtime_secret_delivery_receipts_container_evidence_idx
      ON runtime_secret_delivery_receipts(
        organization_id,project_id,environment_id,generation,manifest_secret_count
      ) WHERE runtime_provider='container';

    ALTER TABLE runtime_secret_delivery_states
      DROP CONSTRAINT runtime_secret_delivery_states_manifest_check;
    ALTER TABLE runtime_secret_delivery_states
      ADD CONSTRAINT runtime_secret_delivery_states_manifest_check CHECK (
        (provider_tag IS NULL AND runtime_provider IS NULL AND applied_manifest_sha256 IS NULL
          AND applied_secret_count=0 AND cardinality(applied_secret_names)=0)
        OR
        (provider_tag IS NOT NULL AND runtime_provider IN ('wfp','container')
          AND octet_length(applied_manifest_sha256)=32
          AND applied_secret_count=cardinality(applied_secret_names)
          AND applied_secret_count BETWEEN 0 AND 100)
      );
    ALTER TABLE runtime_secret_delivery_receipts
      DROP CONSTRAINT runtime_secret_delivery_receipts_manifest_check;
    ALTER TABLE runtime_secret_delivery_receipts
      ADD CONSTRAINT runtime_secret_delivery_receipts_manifest_check CHECK (
        octet_length(manifest_sha256)=32
        AND manifest_secret_count=cardinality(applied_secret_names)
        AND manifest_secret_count BETWEEN 0 AND 100
      );

    DROP TRIGGER environment_secrets_name_limit ON environment_secrets;
    DROP FUNCTION enforce_runtime_secret_name_limit();
    CREATE FUNCTION enforce_runtime_secret_name_limit() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        PERFORM 1 FROM runtime_secret_delivery_states
        WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
          AND environment_id=NEW.environment_id FOR UPDATE;
      END IF;
      IF TG_OP='INSERT' AND (
        SELECT count(*) >= 100 FROM environment_secrets
        WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
          AND environment_id=NEW.environment_id
      ) THEN
        RAISE EXCEPTION 'runtime secret name limit exceeded' USING ERRCODE='22023';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER environment_secrets_name_limit
      BEFORE INSERT ON environment_secrets
      FOR EACH ROW EXECUTE FUNCTION enforce_runtime_secret_name_limit();

    ALTER TABLE container_application_receipts
      ADD COLUMN runtime_secret_generation bigint NOT NULL,
      ADD COLUMN runtime_secret_manifest_sha256 bytea NOT NULL,
      ADD COLUMN runtime_secret_count integer NOT NULL;
    ALTER TABLE container_application_receipts
      ADD CONSTRAINT container_application_receipts_runtime_secret_shape CHECK (
        runtime_secret_generation >= 0
        AND octet_length(runtime_secret_manifest_sha256)=32
        AND runtime_secret_count BETWEEN 0 AND 100
      );

    CREATE FUNCTION enforce_container_application_runtime_secret_receipt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM runtime_secret_delivery_receipts receipt
        WHERE receipt.organization_id=NEW.organization_id
          AND receipt.project_id=NEW.project_id
          AND receipt.environment_id=NEW.environment_id
          AND receipt.runtime_provider='container'
          AND receipt.generation=NEW.runtime_secret_generation
          AND receipt.manifest_sha256=NEW.runtime_secret_manifest_sha256
          AND receipt.manifest_secret_count=NEW.runtime_secret_count
          AND receipt.completed_at<=NEW.observed_at
      ) THEN
        RAISE EXCEPTION 'container application receipt requires completed container runtime secret evidence'
          USING ERRCODE='23503',
            CONSTRAINT='container_application_receipts_runtime_secret_receipt';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER container_application_receipts_runtime_secret_receipt
      BEFORE INSERT ON container_application_receipts
      FOR EACH ROW EXECUTE FUNCTION enforce_container_application_runtime_secret_receipt();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM deployment_plans
        WHERE framework_plan->>'adapter'='vite-static' AND framework_plan->>'runtime'='edge') THEN
        RAISE EXCEPTION 'Vite companion plans prevent a migration downgrade'
          USING ERRCODE='23514';
      END IF;
      IF EXISTS (SELECT 1 FROM project_r2_delete_requests)
        OR EXISTS (SELECT 1 FROM project_r2_delete_receipts) THEN
        RAISE EXCEPTION 'storage deletion evidence prevents a migration downgrade'
          USING ERRCODE='23514';
      END IF;
      IF EXISTS (SELECT 1 FROM runtime_secret_delivery_states WHERE runtime_provider='container'
        OR claimed_runtime_provider='container')
        OR EXISTS (SELECT 1 FROM runtime_secret_delivery_receipts WHERE runtime_provider='container')
        OR EXISTS (SELECT 1 FROM container_application_receipts) THEN
        RAISE EXCEPTION 'container runtime secret evidence prevents a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END $$;

    DROP TRIGGER container_application_receipts_runtime_secret_receipt
      ON container_application_receipts;
    DROP FUNCTION enforce_container_application_runtime_secret_receipt();
    ALTER TABLE container_application_receipts
      DROP CONSTRAINT container_application_receipts_runtime_secret_shape;
    ALTER TABLE container_application_receipts
      DROP COLUMN runtime_secret_generation,
      DROP COLUMN runtime_secret_manifest_sha256,
      DROP COLUMN runtime_secret_count;

    DROP TRIGGER environment_secrets_name_limit ON environment_secrets;
    DROP FUNCTION enforce_runtime_secret_name_limit();
    CREATE FUNCTION enforce_runtime_secret_name_limit() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        PERFORM 1 FROM runtime_secret_delivery_states
        WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
          AND environment_id=NEW.environment_id FOR UPDATE;
      END IF;
      IF TG_OP='INSERT' AND (
        SELECT count(*) >= 128 FROM environment_secrets
        WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id
          AND environment_id=NEW.environment_id
      ) THEN
        RAISE EXCEPTION 'runtime secret name limit exceeded' USING ERRCODE='22023';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER environment_secrets_name_limit
      BEFORE INSERT ON environment_secrets
      FOR EACH ROW EXECUTE FUNCTION enforce_runtime_secret_name_limit();

    ALTER TABLE runtime_secret_delivery_receipts
      DROP CONSTRAINT runtime_secret_delivery_receipts_manifest_check;
    ALTER TABLE runtime_secret_delivery_receipts
      ADD CONSTRAINT runtime_secret_delivery_receipts_manifest_check CHECK (
        octet_length(manifest_sha256)=32
        AND manifest_secret_count=cardinality(applied_secret_names)
        AND manifest_secret_count BETWEEN 0 AND 128
      );
    ALTER TABLE runtime_secret_delivery_states
      DROP CONSTRAINT runtime_secret_delivery_states_manifest_check;
    ALTER TABLE runtime_secret_delivery_states
      ADD CONSTRAINT runtime_secret_delivery_states_manifest_check CHECK (
        (provider_tag IS NULL AND applied_manifest_sha256 IS NULL
          AND applied_secret_count=0 AND cardinality(applied_secret_names)=0)
        OR
        (provider_tag IS NOT NULL AND octet_length(applied_manifest_sha256)=32
          AND applied_secret_count=cardinality(applied_secret_names)
          AND applied_secret_count BETWEEN 0 AND 128)
      );
    ALTER TABLE runtime_secret_delivery_receipts
      DROP CONSTRAINT runtime_secret_delivery_receipts_runtime_provider_check;
    DROP INDEX runtime_secret_delivery_receipts_container_evidence_idx;
    ALTER TABLE runtime_secret_delivery_receipts
      DROP COLUMN runtime_provider;
    ALTER TABLE runtime_secret_delivery_states
      DROP CONSTRAINT runtime_secret_delivery_states_claimed_provider_check,
      DROP CONSTRAINT runtime_secret_delivery_states_runtime_provider_check,
      DROP COLUMN claimed_runtime_provider,
      DROP COLUMN runtime_provider;
  `);
};
