const AUTH_PREDICATE = "valid_customer_auth_requirement";

const predicate = (versions) => `CREATE OR REPLACE FUNCTION ${AUTH_PREDICATE}(requirement jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
      IF jsonb_typeof(requirement)<>'object' THEN RETURN false; END IF;
      IF requirement='{"provider":"none"}'::jsonb THEN RETURN true; END IF;
      RETURN requirement ?& ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']
        AND requirement-ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']='{}'::jsonb
        AND requirement->>'provider'='better-auth' AND requirement->>'version' IN (${versions})
        AND requirement->>'deployment' IN ('embedded','companion')
        AND requirement->>'routePath'='/api/auth' AND requirement->>'databaseSchema'='auth'
        AND requirement->>'databaseBindingName'='OHMYHOST_DATABASE'
        AND requirement->>'authSecretName'='BETTER_AUTH_SECRET';
    EXCEPTION WHEN OTHERS THEN RETURN false; END $$`;

/** Admit the managed Better Auth 1.7.7 pin; persisted 1.7.1 plans stay valid and unrewritten. */
export function up(pgm) {
  pgm.sql(predicate("'1.7.1','1.7.7'"));
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM deployment_plans WHERE framework_plan->'auth'->>'version'='1.7.7'
    ) THEN RAISE EXCEPTION 'persisted Better Auth 1.7.7 plans prevent migration downgrade'
      USING ERRCODE='23514'; END IF;
  END $$`);
  pgm.sql(predicate("'1.7.1'"));
}
