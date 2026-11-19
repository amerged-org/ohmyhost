export function up(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM deployment_plans
      WHERE framework_plan->'auth' ? 'databaseSecretName'
    ) THEN RAISE EXCEPTION 'legacy DATABASE_URL auth plans require explicit replanning'
      USING ERRCODE='23514'; END IF;
  END $$`);
  pgm.sql(`CREATE OR REPLACE FUNCTION valid_customer_auth_requirement(requirement jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
      IF jsonb_typeof(requirement)<>'object' THEN RETURN false; END IF;
      IF requirement='{"provider":"none"}'::jsonb THEN RETURN true; END IF;
      RETURN requirement ?& ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']
        AND requirement-ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']='{}'::jsonb
        AND requirement->>'provider'='better-auth' AND requirement->>'version'='1.7.1'
        AND requirement->>'deployment' IN ('embedded','companion')
        AND requirement->>'routePath'='/api/auth' AND requirement->>'databaseSchema'='auth'
        AND requirement->>'databaseBindingName'='HYPERDRIVE'
        AND requirement->>'authSecretName'='BETTER_AUTH_SECRET';
    EXCEPTION WHEN OTHERS THEN RETURN false; END $$`);
  pgm.createTable("project_hyperdrive_receipts", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    provider_project_id: { type: "text", notNull: true },
    branch_id: { type: "text", notNull: true },
    config_name: { type: "text", notNull: true },
    origin_host: { type: "text", notNull: true },
    origin_database: { type: "text", notNull: true },
    origin_user: { type: "text", notNull: true },
    hyperdrive_id: { type: "text", notNull: true },
    observed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("project_hyperdrive_receipts", "project_hyperdrive_receipts_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint("project_hyperdrive_receipts", "project_hyperdrive_receipts_id_key", {
    unique: ["hyperdrive_id"],
  });
  pgm.addConstraint("project_hyperdrive_receipts", "project_hyperdrive_receipts_name_key", {
    unique: ["config_name"],
  });
  pgm.addConstraint("project_hyperdrive_receipts", "project_hyperdrive_receipts_project_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id"],
      references: "project_ownerships (organization_id, project_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("project_hyperdrive_receipts", "project_hyperdrive_receipts_shape", {
    check: `provider_project_id~'^[a-z0-9-]{1,60}$'
      AND branch_id~'^[a-z0-9-]{1,60}$'
      AND config_name='ohmyho-'||lower(project_id::text)
      AND origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
      AND origin_database='neondb' AND origin_user='ohmyho_runtime'
      AND hyperdrive_id~'^[0-9a-f]{32}$'`,
  });
  pgm.createTrigger("project_hyperdrive_receipts", "project_hyperdrive_receipts_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });

  pgm.createTable("project_hyperdrive_reservations", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    environment_id: { type: "ulid", notNull: true },
    operation_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    provider_project_id: { type: "text", notNull: true },
    branch_id: { type: "text", notNull: true },
    config_name: { type: "text", notNull: true },
    origin_host: { type: "text", notNull: true },
    origin_database: { type: "text", notNull: true },
    origin_user: { type: "text", notNull: true },
    reserved_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    create_started_at: { type: "timestamptz" },
  });
  pgm.addConstraint("project_hyperdrive_reservations", "project_hyperdrive_reservations_pkey", {
    primaryKey: ["organization_id", "project_id"],
  });
  pgm.addConstraint(
    "project_hyperdrive_reservations",
    "project_hyperdrive_reservations_claim_fkey",
    {
      foreignKeys: {
        columns: ["claim_id", "organization_id", "project_id", "environment_id", "operation_id"],
        references:
          "product_provider_mutation_claims (claim_id, organization_id, project_id, environment_id, operation_id)",
        onDelete: "RESTRICT",
      },
    },
  );
  pgm.addConstraint("project_hyperdrive_reservations", "project_hyperdrive_reservations_shape", {
    check: `provider_project_id~'^[a-z0-9-]{1,60}$'
      AND branch_id~'^[a-z0-9-]{1,60}$'
      AND config_name='ohmyho-'||lower(project_id::text)
      AND origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
      AND origin_database='neondb' AND origin_user='ohmyho_runtime'
      AND (create_started_at IS NULL OR create_started_at>=reserved_at)`,
  });
  pgm.sql(`CREATE FUNCTION guard_project_hyperdrive_reservation_change() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN
        IF NOT EXISTS (
          SELECT 1 FROM project_hyperdrive_receipts receipt
          WHERE receipt.organization_id=OLD.organization_id AND receipt.project_id=OLD.project_id
            AND receipt.claim_id=OLD.claim_id
        ) THEN RAISE EXCEPTION 'active Hyperdrive reservation cannot be deleted'
          USING ERRCODE='55000'; END IF;
        RETURN OLD;
      END IF;
      IF OLD.create_started_at IS NOT NULL OR NEW.create_started_at IS NULL
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.project_id IS DISTINCT FROM OLD.project_id
        OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
        OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
        OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
        OR NEW.provider_project_id IS DISTINCT FROM OLD.provider_project_id
        OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
        OR NEW.config_name IS DISTINCT FROM OLD.config_name
        OR NEW.origin_host IS DISTINCT FROM OLD.origin_host
        OR NEW.origin_database IS DISTINCT FROM OLD.origin_database
        OR NEW.origin_user IS DISTINCT FROM OLD.origin_user
        OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
        RAISE EXCEPTION 'Hyperdrive reservation permits only one create authorization'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.createTrigger(
    "project_hyperdrive_reservations",
    "project_hyperdrive_reservations_change_guard",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "guard_project_hyperdrive_reservation_change",
    },
  );
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_hyperdrive_receipts)
      OR EXISTS (SELECT 1 FROM project_hyperdrive_reservations) THEN
      RAISE EXCEPTION 'Hyperdrive evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropTable("project_hyperdrive_reservations");
  pgm.sql("DROP FUNCTION guard_project_hyperdrive_reservation_change()");
  pgm.dropTable("project_hyperdrive_receipts");
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM deployment_plans
      WHERE framework_plan->'auth' ? 'databaseBindingName'
    ) THEN RAISE EXCEPTION 'Hyperdrive auth plans prevent a lossless migration downgrade'
      USING ERRCODE='23514'; END IF;
  END $$`);
  pgm.sql(`CREATE OR REPLACE FUNCTION valid_customer_auth_requirement(requirement jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
      IF jsonb_typeof(requirement)<>'object' THEN RETURN false; END IF;
      IF requirement='{"provider":"none"}'::jsonb THEN RETURN true; END IF;
      RETURN requirement ?& ARRAY['provider','version','deployment','routePath','databaseSchema','databaseSecretName','authSecretName']
        AND requirement-ARRAY['provider','version','deployment','routePath','databaseSchema','databaseSecretName','authSecretName']='{}'::jsonb
        AND requirement->>'provider'='better-auth' AND requirement->>'version'='1.7.1'
        AND requirement->>'deployment' IN ('embedded','companion')
        AND requirement->>'routePath'='/api/auth' AND requirement->>'databaseSchema'='auth'
        AND requirement->>'databaseSecretName'='DATABASE_URL'
        AND requirement->>'authSecretName'='BETTER_AUTH_SECRET';
    EXCEPTION WHEN OTHERS THEN RETURN false; END $$`);
}
