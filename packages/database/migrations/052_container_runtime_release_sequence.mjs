export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE runtime_secret_delivery_receipts ADD COLUMN release_sequence bigint;
    WITH sequenced AS (
      SELECT receipt_id,row_number() OVER (
        PARTITION BY organization_id,project_id,environment_id
        ORDER BY completed_at,receipt_id
      ) AS release_sequence
      FROM runtime_secret_delivery_receipts
    )
    UPDATE runtime_secret_delivery_receipts receipt
    SET release_sequence=sequenced.release_sequence
    FROM sequenced WHERE sequenced.receipt_id=receipt.receipt_id;
    ALTER TABLE runtime_secret_delivery_receipts ALTER COLUMN release_sequence SET NOT NULL;
    ALTER TABLE runtime_secret_delivery_receipts
      ADD CONSTRAINT runtime_secret_delivery_receipts_release_sequence_check
        CHECK (release_sequence > 0),
      ADD CONSTRAINT runtime_secret_delivery_receipts_release_sequence_key
        UNIQUE (organization_id,project_id,environment_id,release_sequence);

    ALTER TABLE runtime_secret_delivery_states
      ADD COLUMN next_release_sequence bigint NOT NULL DEFAULT 1,
      ADD COLUMN claimed_release_sequence bigint,
      ADD COLUMN applied_release_sequence bigint NOT NULL DEFAULT 0;
    WITH completed AS (
      SELECT organization_id,project_id,environment_id,max(release_sequence) release_sequence
      FROM runtime_secret_delivery_receipts
      GROUP BY organization_id,project_id,environment_id
    )
    UPDATE runtime_secret_delivery_states state
    SET applied_release_sequence=completed.release_sequence,
        claimed_release_sequence=CASE WHEN state.active_lease_id IS NULL
          THEN NULL ELSE completed.release_sequence+1 END,
        next_release_sequence=completed.release_sequence+
          CASE WHEN state.active_lease_id IS NULL THEN 1 ELSE 2 END
    FROM completed
    WHERE completed.organization_id=state.organization_id
      AND completed.project_id=state.project_id
      AND completed.environment_id=state.environment_id;
    UPDATE runtime_secret_delivery_states
    SET claimed_release_sequence=1,next_release_sequence=2
    WHERE active_lease_id IS NOT NULL AND claimed_release_sequence IS NULL;
    ALTER TABLE runtime_secret_delivery_states
      ADD CONSTRAINT runtime_secret_delivery_states_release_sequence_check CHECK (
        applied_release_sequence >= 0
        AND next_release_sequence > applied_release_sequence
        AND (
          (active_lease_id IS NULL AND claimed_release_sequence IS NULL)
          OR
          (active_lease_id IS NOT NULL AND claimed_release_sequence > applied_release_sequence
            AND claimed_release_sequence < next_release_sequence)
        )
      );

    ALTER TABLE container_application_receipts
      ADD COLUMN runtime_secret_release_sequence bigint;
    UPDATE container_application_receipts application
    SET runtime_secret_release_sequence=(
      SELECT receipt.release_sequence
      FROM runtime_secret_delivery_receipts receipt
      WHERE receipt.organization_id=application.organization_id
        AND receipt.project_id=application.project_id
        AND receipt.environment_id=application.environment_id
        AND receipt.runtime_provider='container'
        AND receipt.generation=application.runtime_secret_generation
        AND receipt.manifest_sha256=application.runtime_secret_manifest_sha256
        AND receipt.manifest_secret_count=application.runtime_secret_count
        AND receipt.completed_at<=application.observed_at
      ORDER BY receipt.completed_at DESC,receipt.release_sequence DESC LIMIT 1
    );
    DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM container_application_receipts
      WHERE runtime_secret_release_sequence IS NULL
    ) THEN
      RAISE EXCEPTION 'container application receipt has no backfillable release sequence'
        USING ERRCODE='23514',
          CONSTRAINT='container_application_receipts_release_sequence_backfill';
    END IF; END $$;
    ALTER TABLE container_application_receipts
      ALTER COLUMN runtime_secret_release_sequence SET NOT NULL,
      ADD CONSTRAINT container_application_receipts_runtime_secret_release_sequence_check
        CHECK (runtime_secret_release_sequence > 0);

    CREATE OR REPLACE FUNCTION enforce_container_application_runtime_secret_receipt()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM runtime_secret_delivery_receipts receipt
        WHERE receipt.organization_id=NEW.organization_id
          AND receipt.project_id=NEW.project_id
          AND receipt.environment_id=NEW.environment_id
          AND receipt.runtime_provider='container'
          AND receipt.release_sequence=NEW.runtime_secret_release_sequence
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
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM runtime_secret_delivery_receipts)
        OR EXISTS (SELECT 1 FROM container_application_receipts)
        OR EXISTS (SELECT 1 FROM runtime_secret_delivery_states
          WHERE next_release_sequence<>1 OR claimed_release_sequence IS NOT NULL
            OR applied_release_sequence<>0) THEN
        RAISE EXCEPTION 'runtime secret release evidence prevents a lossless migration downgrade'
          USING ERRCODE='23514';
      END IF;
    END $$;

    CREATE OR REPLACE FUNCTION enforce_container_application_runtime_secret_receipt()
    RETURNS trigger LANGUAGE plpgsql AS $$
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
    ALTER TABLE container_application_receipts
      DROP CONSTRAINT container_application_receipts_runtime_secret_release_sequence_check,
      DROP COLUMN runtime_secret_release_sequence;
    ALTER TABLE runtime_secret_delivery_states
      DROP CONSTRAINT runtime_secret_delivery_states_release_sequence_check,
      DROP COLUMN next_release_sequence,
      DROP COLUMN claimed_release_sequence,
      DROP COLUMN applied_release_sequence;
    ALTER TABLE runtime_secret_delivery_receipts
      DROP CONSTRAINT runtime_secret_delivery_receipts_release_sequence_key,
      DROP CONSTRAINT runtime_secret_delivery_receipts_release_sequence_check,
      DROP COLUMN release_sequence;
  `);
};
