const scopedTables = [
  "neon_project_placement_receipts",
  "neon_project_placement_reservations",
  "neon_project_role_receipts",
  "neon_project_role_reservations",
  "project_hyperdrive_receipts",
  "project_hyperdrive_reservations",
];

export function up(pgm) {
  pgm.addColumn("projects", {
    data_mode: { type: "text", notNull: true, default: "shared" },
  });
  pgm.addConstraint("projects", "projects_data_mode_shape", {
    check: "data_mode IN ('shared','isolated')",
  });
  pgm.sql(`CREATE FUNCTION reject_project_data_mode_change() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.data_mode IS DISTINCT FROM OLD.data_mode THEN
        RAISE EXCEPTION 'project data mode requires an explicit data migration'
          USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $$`);
  pgm.createTrigger("projects", "projects_data_mode_immutable", {
    when: "BEFORE",
    operation: "UPDATE",
    level: "ROW",
    function: "reject_project_data_mode_change",
  });

  pgm.addColumn("project_r2_delete_requests", { request_environment_id: { type: "ulid" } });
  pgm.dropTrigger("project_r2_delete_requests", "project_r2_delete_requests_append_only");
  pgm.sql("UPDATE project_r2_delete_requests SET request_environment_id=environment_id");
  pgm.alterColumn("project_r2_delete_requests", "request_environment_id", { notNull: true });
  pgm.createTrigger("project_r2_delete_requests", "project_r2_delete_requests_append_only", {
    when: "BEFORE",
    operation: ["UPDATE", "DELETE"],
    level: "ROW",
    function: "reject_append_only_change",
  });
  pgm.dropConstraint("project_r2_delete_requests", "project_r2_delete_idempotency_key");
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_idempotency_key", {
    unique: ["organization_id", "project_id", "request_environment_id", "idempotency_key"],
  });
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_request_environment_fkey", {
    foreignKeys: {
      columns: ["organization_id", "project_id", "request_environment_id"],
      references: "environments (organization_id, project_id, environment_id)",
      onDelete: "RESTRICT",
    },
  });

  pgm.dropConstraint("neon_consumption_observations", "neon_consumption_observations_scope_check");
  pgm.dropConstraint("neon_consumption_observations", "neon_consumption_observations_check1");
  pgm.addConstraint("neon_consumption_observations", "neon_consumption_observations_scope_check", {
    check: "scope IN ('platform','project_shared','project_environment','unattributed')",
  });
  pgm.addConstraint("neon_consumption_observations", "neon_consumption_observations_check1", {
    check: `((scope='project_shared' AND organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL AND cardinality(environment_ids)=2)
      OR (scope='project_environment' AND organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL AND cardinality(environment_ids)=1 AND environment_ids[1] IS NOT NULL)
      OR (scope='platform' AND organization_id IS NULL AND project_id IS NULL AND billing_epoch_id IS NULL AND cardinality(environment_ids)=0)
      OR (scope='unattributed' AND organization_id IS NULL AND billing_epoch_id IS NULL AND cardinality(environment_ids)=0))`,
  });

  for (const table of ["neon_project_role_receipts", "neon_project_role_reservations"])
    pgm.dropConstraint(table, `${table}_project_fkey`);
  for (const table of scopedTables) {
    pgm.dropConstraint(table, `${table}_pkey`);
    pgm.addConstraint(table, `${table}_pkey`, {
      primaryKey: [
        "organization_id",
        "project_id",
        "environment_id",
        ...(table.includes("_role_") ? ["role_name"] : []),
      ],
    });
  }
  for (const table of ["neon_project_role_receipts", "neon_project_role_reservations"])
    pgm.addConstraint(table, `${table}_project_fkey`, {
      foreignKeys: {
        columns: ["organization_id", "project_id", "environment_id"],
        references: "neon_project_placement_receipts (organization_id, project_id, environment_id)",
        onDelete: "RESTRICT",
      },
    });

  // Existing provider display names remain immutable evidence; fresh requests use scoped names.
  for (const table of ["neon_project_placement_receipts", "neon_project_placement_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `project_name~'^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}(-[0-7][0-9a-hjkmnp-tv-z]{25})?$'
        AND region_id~'^aws-[a-z0-9]+(-[a-z0-9]+)*-[0-9]+$'
        AND postgres_version BETWEEN 14 AND 18
        AND ${
          table.endsWith("_receipts")
            ? "provider_project_id~'^[a-z0-9-]{1,60}$' AND default_branch_id~'^[a-z0-9-]{1,60}$' AND cardinality(operation_ids)<=128 AND state='ready'"
            : "(create_started_at IS NULL OR create_started_at>=reserved_at)"
        }`,
    });
  }
  for (const table of ["project_hyperdrive_receipts", "project_hyperdrive_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `provider_project_id~'^[a-z0-9-]{1,60}$'
        AND branch_id~'^[a-z0-9-]{1,60}$'
        AND config_name IN ('ohmyho-'||lower(project_id::text),
          'ohmyho-'||lower(project_id::text)||'-'||lower(environment_id::text))
        AND origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
        AND origin_database='neondb' AND origin_user='ohmyho_runtime'
        AND ${
          table.endsWith("_receipts")
            ? "hyperdrive_id~'^[0-9a-f]{32}$'"
            : "(create_started_at IS NULL OR create_started_at>=reserved_at)"
        }`,
    });
  }
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM projects WHERE data_mode<>'shared')
      OR EXISTS (SELECT 1 FROM neon_project_placement_receipts)
      OR EXISTS (SELECT 1 FROM neon_project_placement_reservations)
      OR EXISTS (SELECT 1 FROM project_hyperdrive_receipts)
      OR EXISTS (SELECT 1 FROM project_hyperdrive_reservations)
      OR EXISTS (SELECT 1 FROM neon_consumption_observations WHERE scope='project_environment')
      OR EXISTS (SELECT 1 FROM project_r2_delete_requests WHERE request_environment_id<>environment_id) THEN
      RAISE EXCEPTION 'database environment evidence prevents a lossless downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  pgm.dropConstraint("project_r2_delete_requests", "project_r2_delete_request_environment_fkey");
  pgm.dropConstraint("project_r2_delete_requests", "project_r2_delete_idempotency_key");
  pgm.addConstraint("project_r2_delete_requests", "project_r2_delete_idempotency_key", {
    unique: ["organization_id", "project_id", "environment_id", "idempotency_key"],
  });
  pgm.dropColumn("project_r2_delete_requests", "request_environment_id");
  pgm.dropConstraint("neon_consumption_observations", "neon_consumption_observations_scope_check");
  pgm.dropConstraint("neon_consumption_observations", "neon_consumption_observations_check1");
  pgm.addConstraint("neon_consumption_observations", "neon_consumption_observations_scope_check", {
    check: "scope IN ('platform','project_shared','unattributed')",
  });
  pgm.addConstraint("neon_consumption_observations", "neon_consumption_observations_check1", {
    check: `((scope='project_shared' AND organization_id IS NOT NULL AND project_id IS NOT NULL AND billing_epoch_id IS NOT NULL AND cardinality(environment_ids)=2)
      OR (scope='platform' AND organization_id IS NULL AND project_id IS NULL AND billing_epoch_id IS NULL AND cardinality(environment_ids)=0)
      OR (scope='unattributed' AND organization_id IS NULL AND billing_epoch_id IS NULL AND cardinality(environment_ids)=0))`,
  });
  for (const table of ["neon_project_role_receipts", "neon_project_role_reservations"])
    pgm.dropConstraint(table, `${table}_project_fkey`);
  for (const table of scopedTables) {
    pgm.dropConstraint(table, `${table}_pkey`);
    pgm.addConstraint(table, `${table}_pkey`, {
      primaryKey: [
        "organization_id",
        "project_id",
        ...(table.includes("_role_") ? ["role_name"] : []),
      ],
    });
  }
  for (const table of ["neon_project_role_receipts", "neon_project_role_reservations"])
    pgm.addConstraint(table, `${table}_project_fkey`, {
      foreignKeys: {
        columns: ["organization_id", "project_id"],
        references: "neon_project_placement_receipts (organization_id, project_id)",
        onDelete: "RESTRICT",
      },
    });
  // Reinstall the previous constraints rather than retaining the wider naming contract.
  for (const table of ["neon_project_placement_receipts", "neon_project_placement_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `project_name~'^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}$'
        AND region_id~'^aws-[a-z0-9]+(-[a-z0-9]+)*-[0-9]+$'
        AND postgres_version BETWEEN 14 AND 18
        AND ${
          table.endsWith("_receipts")
            ? "provider_project_id~'^[a-z0-9-]{1,60}$' AND default_branch_id~'^[a-z0-9-]{1,60}$' AND cardinality(operation_ids)<=128 AND state='ready'"
            : "(create_started_at IS NULL OR create_started_at>=reserved_at)"
        }`,
    });
  }
  for (const table of ["project_hyperdrive_receipts", "project_hyperdrive_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `provider_project_id~'^[a-z0-9-]{1,60}$'
        AND branch_id~'^[a-z0-9-]{1,60}$'
        AND config_name='ohmyho-'||lower(project_id::text)
        AND origin_host~'^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
        AND origin_database='neondb' AND origin_user='ohmyho_runtime'
        AND ${
          table.endsWith("_receipts")
            ? "hyperdrive_id~'^[0-9a-f]{32}$'"
            : "(create_started_at IS NULL OR create_started_at>=reserved_at)"
        }`,
    });
  }
  pgm.dropTrigger("projects", "projects_data_mode_immutable");
  pgm.sql("DROP FUNCTION reject_project_data_mode_change()");
  pgm.dropConstraint("projects", "projects_data_mode_shape");
  pgm.dropColumn("projects", "data_mode");
}
