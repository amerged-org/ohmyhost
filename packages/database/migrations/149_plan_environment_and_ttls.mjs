/**
 * Owner decisions of 2026-09-23 (D312): a deployment plan targets one named environment, so a
 * customer can build straight into Prod; plans stay valid for up to 24 hours; a Dev access ticket
 * lives one hour. Existing plans were all Dev plans with a 15-minute lifetime and existing tickets
 * ten minutes, so both old shapes stay valid.
 */
const REWRITE = (table, constraint, from, to) => `
  DO $rewrite$ DECLARE definition text; BEGIN
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid='${table}'::regclass AND conname='${constraint}';
    IF definition IS NULL OR position('${from.replaceAll("'", "''")}' IN definition)=0 THEN
      RAISE EXCEPTION '${constraint} does not have the expected shape';
    END IF;
    EXECUTE 'ALTER TABLE ${table} DROP CONSTRAINT ${constraint}';
    EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${constraint} '
      || replace(definition, '${from.replaceAll("'", "''")}', '${to.replaceAll("'", "''")}');
  END $rewrite$;`;

const PLAN_TTL_OLD = "(expires_at = (created_at + '00:15:00'::interval))";
const PLAN_TTL_NEW =
  "(expires_at > created_at) AND (expires_at <= (created_at + '24:00:00'::interval))";
const TICKET_TTL_OLD = "(expires_at = (issued_at + '00:10:00'::interval))";
const TICKET_TTL_NEW =
  "(expires_at = ANY (ARRAY[(issued_at + '00:10:00'::interval), (issued_at + '01:00:00'::interval)]))";

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function up(pgm) {
  pgm.sql(`ALTER TABLE deployment_plans ADD COLUMN environment_id ulid`);
  pgm.sql(`ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only`);
  pgm.sql(`UPDATE deployment_plans plan SET environment_id=environment.environment_id
    FROM environments environment
    WHERE environment.organization_id=plan.organization_id
      AND environment.project_id=plan.project_id AND environment.name='dev'`);
  pgm.sql(`ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only`);
  pgm.sql(`ALTER TABLE deployment_plans ALTER COLUMN environment_id SET NOT NULL,
    ADD CONSTRAINT deployment_plans_environment_fkey
      FOREIGN KEY (organization_id, project_id, environment_id)
      REFERENCES environments(organization_id, project_id, environment_id) ON DELETE RESTRICT`);
  pgm.sql(REWRITE("deployment_plans", "deployment_plans_shape_check", PLAN_TTL_OLD, PLAN_TTL_NEW));
  pgm.sql(
    REWRITE("dev_access_tickets", "dev_access_tickets_shape_check", TICKET_TTL_OLD, TICKET_TTL_NEW),
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export async function down(pgm) {
  pgm.sql(`DO $refuse$ BEGIN
    IF EXISTS (SELECT 1 FROM deployment_plans plan INNER JOIN environments environment
               ON environment.environment_id=plan.environment_id WHERE environment.name<>'dev')
       OR EXISTS (SELECT 1 FROM deployment_plans WHERE expires_at<>created_at+interval '15 minutes')
       OR EXISTS (SELECT 1 FROM dev_access_tickets WHERE expires_at<>issued_at+interval '10 minutes') THEN
      RAISE EXCEPTION 'Prod plans or longer-lived plans and tickets exist; migration 149 cannot be reverted';
    END IF;
  END $refuse$;`);
  pgm.sql(
    REWRITE("dev_access_tickets", "dev_access_tickets_shape_check", TICKET_TTL_NEW, TICKET_TTL_OLD),
  );
  pgm.sql(REWRITE("deployment_plans", "deployment_plans_shape_check", PLAN_TTL_NEW, PLAN_TTL_OLD));
  pgm.sql(`ALTER TABLE deployment_plans DROP CONSTRAINT deployment_plans_environment_fkey,
    DROP COLUMN environment_id`);
}
