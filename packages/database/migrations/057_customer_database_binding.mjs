const AUTH_PREDICATE = "valid_customer_auth_requirement";
const PLAN_CONSTRAINT = "deployment_plans_framework_plan_check";
const V5 = "ohmyhost.framework-plan/v5";
const OLD_BINDING = "HYPERDRIVE";
const NEW_BINDING = "OHMYHOST_DATABASE";

const canonicalBetterAuth = (bindingPredicate) => `(jsonb_typeof(framework_plan->'auth')='object'
  AND framework_plan->'auth' ?& ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']
  AND (framework_plan->'auth')-ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']='{}'::jsonb
  AND framework_plan->'auth'->>'provider'='better-auth'
  AND framework_plan->'auth'->>'version'='1.7.1'
  AND framework_plan->'auth'->>'deployment' IN ('embedded','companion')
  AND framework_plan->'auth'->>'routePath'='/api/auth'
  AND framework_plan->'auth'->>'databaseSchema'='auth'
  AND ${bindingPredicate}
  AND framework_plan->'auth'->>'authSecretName'='BETTER_AUTH_SECRET')`;

const acceptedBeforeCutover = `(framework_plan->'auth'='{"provider":"none"}'::jsonb
  OR ${canonicalBetterAuth(
    `framework_plan->'auth'->>'databaseBindingName' IN ('${OLD_BINDING}','${NEW_BINDING}')`,
  )})`;

export function up(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM deployment_plans
      WHERE framework_plan IS NOT NULL
        AND (jsonb_typeof(framework_plan)<>'object'
          OR framework_plan->>'schemaVersion' IS DISTINCT FROM '${V5}'
          OR (${acceptedBeforeCutover}) IS NOT TRUE)
    ) THEN RAISE EXCEPTION 'persisted customer auth plan is not canonical for database binding cutover'
      USING ERRCODE='23514'; END IF;
  END $$`);
  pgm.sql(`CREATE OR REPLACE FUNCTION ${AUTH_PREDICATE}(requirement jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
      IF jsonb_typeof(requirement)<>'object' THEN RETURN false; END IF;
      IF requirement='{"provider":"none"}'::jsonb THEN RETURN true; END IF;
      RETURN requirement ?& ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']
        AND requirement-ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']='{}'::jsonb
        AND requirement->>'provider'='better-auth' AND requirement->>'version'='1.7.1'
        AND requirement->>'deployment' IN ('embedded','companion')
        AND requirement->>'routePath'='/api/auth' AND requirement->>'databaseSchema'='auth'
        AND requirement->>'databaseBindingName'='${NEW_BINDING}'
        AND requirement->>'authSecretName'='BETTER_AUTH_SECRET';
    EXCEPTION WHEN OTHERS THEN RETURN false; END $$`);
  pgm.sql("ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only");
  pgm.sql(`UPDATE deployment_plans
    SET framework_plan=jsonb_set(
      framework_plan,
      '{auth,databaseBindingName}',
      to_jsonb('${NEW_BINDING}'::text),
      false)
    WHERE framework_plan IS NOT NULL
      AND framework_plan->'auth'->>'provider'='better-auth'
      AND framework_plan->'auth'->>'databaseBindingName'='${OLD_BINDING}'`);
  pgm.sql("ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only");
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM deployment_plans
      WHERE framework_plan IS NOT NULL
        AND (framework_plan->>'schemaVersion' IS DISTINCT FROM '${V5}'
          OR ${AUTH_PREDICATE}(framework_plan->'auth') IS NOT TRUE)
    ) THEN RAISE EXCEPTION 'customer database binding cutover left an invalid deployment plan'
      USING ERRCODE='23514'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='${PLAN_CONSTRAINT}'
        AND conrelid='deployment_plans'::regclass
        AND contype='c' AND convalidated
    ) THEN RAISE EXCEPTION 'deployment plan constraint is not validated after database binding cutover'
      USING ERRCODE='23514'; END IF;
  END $$`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM deployment_plans
      WHERE framework_plan->'auth'->>'provider'='better-auth'
    ) THEN RAISE EXCEPTION 'customer database binding cutover cannot restore live HYPERDRIVE plans'
      USING ERRCODE='23514'; END IF;
  END $$`);
  pgm.sql(`CREATE OR REPLACE FUNCTION ${AUTH_PREDICATE}(requirement jsonb)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN
      IF jsonb_typeof(requirement)<>'object' THEN RETURN false; END IF;
      IF requirement='{"provider":"none"}'::jsonb THEN RETURN true; END IF;
      RETURN requirement ?& ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']
        AND requirement-ARRAY['provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName']='{}'::jsonb
        AND requirement->>'provider'='better-auth' AND requirement->>'version'='1.7.1'
        AND requirement->>'deployment' IN ('embedded','companion')
        AND requirement->>'routePath'='/api/auth' AND requirement->>'databaseSchema'='auth'
        AND requirement->>'databaseBindingName'='${OLD_BINDING}'
        AND requirement->>'authSecretName'='BETTER_AUTH_SECRET';
    EXCEPTION WHEN OTHERS THEN RETURN false; END $$`);
}
