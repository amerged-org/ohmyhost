export function up(pgm) {
  pgm.sql(`CREATE OR REPLACE FUNCTION valid_storage_requirement(requirement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT requirement IN (
      '{"enabled":false}'::jsonb,
      '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":false}'::jsonb,
      '{"enabled":true,"provider":"r2","jurisdiction":"us","public":false}'::jsonb
    ) $$`);
  updateBucketConstraints(pgm, "jurisdiction IN ('eu','us')");
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM project_r2_bucket_receipts WHERE jurisdiction='us')
      OR EXISTS (SELECT 1 FROM project_r2_bucket_reservations WHERE jurisdiction='us')
      OR EXISTS (SELECT 1 FROM deployment_plans WHERE framework_plan->'storage'->>'jurisdiction'='us')
    THEN RAISE EXCEPTION 'cannot remove US storage support while durable US evidence exists'
      USING ERRCODE='55000'; END IF;
  END $$`);
  updateBucketConstraints(pgm, "jurisdiction='eu'");
  pgm.sql(`CREATE OR REPLACE FUNCTION valid_storage_requirement(requirement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT requirement IN (
      '{"enabled":false}'::jsonb,
      '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":false}'::jsonb
    ) $$`);
}

function updateBucketConstraints(pgm, jurisdiction) {
  for (const table of ["project_r2_bucket_receipts", "project_r2_bucket_reservations"]) {
    pgm.dropConstraint(table, `${table}_shape`);
    pgm.addConstraint(table, `${table}_shape`, {
      check: `bucket_name='ohmyho-'||lower(project_id::text)||'-'||lower(environment_id::text)
        AND ${jurisdiction} AND storage_class='Standard' AND NOT public_access
        AND ${
          table === "project_r2_bucket_receipts"
            ? "provider_bucket_id~'^[0-9a-f]{32}$'"
            : "(create_started_at IS NULL OR create_started_at>=reserved_at)"
        }`,
    });
  }
}
