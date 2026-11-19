// Renaming a project is an orchestrated command: the gateways move first and the address is stored
// only once both serve it. The command tables learn the new event type, and an intent carries the
// requested address the way a deployment intent carries its plan.
const NEW_EVENT = "ProjectHandleChangeRequestedV1";
const AFTER = "ProjectDeletionRequestedV1";

/** Adds the new event type next to project deletion wherever an event list is enumerated. */
const EXTEND_EVENT_LISTS = `DO $$
  DECLARE constraint_record record; widened text;
  BEGIN
    FOR constraint_record IN
      SELECT conrelid::regclass AS table_name, conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE contype='c' AND position('${NEW_EVENT}' in pg_get_constraintdef(oid)) = 0
         AND (position('${AFTER}' in pg_get_constraintdef(oid)) > 0
           OR position('DeploymentPromotionRequestedV1' in pg_get_constraintdef(oid)) > 0)
    LOOP
      -- Two families enumerate events: the whole command set, and the provider-mutating
      -- subset a rename joins because it re-publishes gateways.
      widened := replace(constraint_record.definition, '''${AFTER}''::text]', '''${AFTER}''::text, ''${NEW_EVENT}''::text]');
      widened := replace(widened, '''DeploymentPromotionRequestedV1''::text]', '''DeploymentPromotionRequestedV1''::text, ''${NEW_EVENT}''::text]');
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_record.table_name, constraint_record.name);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', constraint_record.table_name, constraint_record.name, widened);
    END LOOP;
  END $$;`;

export function up(pgm) {
  pgm.addColumns("product_command_intents", { requested_handle: { type: "text" } });
  pgm.sql(EXTEND_EVENT_LISTS);
  // The rename intent locates nothing but the address it asks for.
  pgm.sql(`ALTER TABLE product_command_intents DROP CONSTRAINT product_command_intents_shape_check;
    ALTER TABLE product_command_intents ADD CONSTRAINT product_command_intents_shape_check CHECK (
      ((event_type='${NEW_EVENT}' AND installation_id IS NULL AND repository_owner IS NULL
        AND repository_name IS NULL AND plan_id IS NULL AND source_connection_id IS NULL
        AND deployment_id IS NULL AND target_deployment_id IS NULL AND target_revision_id IS NULL
        AND target_artifact_id IS NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL
        AND source_environment_id IS NULL AND source_deployment_id IS NULL
        AND source_revision_id IS NULL AND source_artifact_id IS NULL
        AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL
        AND expected_target_head_version IS NULL
        AND requested_handle ~ '^[a-z0-9]+(-[a-z0-9]+){0,4}$'
        AND length(requested_handle) BETWEEN 3 AND 59)
      OR (event_type<>'${NEW_EVENT}' AND requested_handle IS NULL AND ${previousShape()})));`);
}

/** The predicate the shape check carried before the rename command existed. */
function previousShape() {
  return `(event_type='SourceLinkRequestedV1'
      AND installation_id IS NOT NULL AND repository_owner IS NOT NULL AND repository_name IS NOT NULL
      AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
      AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
      AND expected_etag IS NULL AND cleanup_run_id IS NULL AND source_environment_id IS NULL
      AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL
      AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL
      AND expected_target_head_version IS NULL)
    OR (event_type='DeploymentRequestedV1'
      AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
      AND plan_id IS NOT NULL AND source_connection_id IS NOT NULL AND deployment_id IS NOT NULL
      AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
      AND expected_etag IS NULL AND cleanup_run_id IS NULL AND source_environment_id IS NULL
      AND source_deployment_id IS NULL AND source_revision_id IS NULL AND source_artifact_id IS NULL
      AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL
      AND expected_target_head_version IS NULL)
    OR (event_type='DeploymentRollbackRequestedV1'
      AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
      AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL
      AND target_deployment_id IS NOT NULL AND target_revision_id IS NOT NULL
      AND target_artifact_id IS NOT NULL AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL
      AND source_environment_id IS NULL AND source_deployment_id IS NULL
      AND source_revision_id IS NULL AND source_artifact_id IS NULL
      AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL
      AND expected_target_head_version IS NULL)
    OR (event_type='DeploymentPromotionRequestedV1'
      AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
      AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NOT NULL
      AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
      AND expected_etag IS NOT NULL AND cleanup_run_id IS NULL
      AND source_environment_id IS NOT NULL AND source_deployment_id IS NOT NULL
      AND source_revision_id IS NOT NULL AND source_artifact_id IS NOT NULL
      AND octet_length(source_artifact_sha256)=32 AND expected_source_head_version>=0
      AND expected_target_head_version>=0)
    OR (event_type='${AFTER}'
      AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
      AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
      AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
      AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL
      AND source_environment_id IS NULL AND source_deployment_id IS NULL
      AND source_revision_id IS NULL AND source_artifact_id IS NULL
      AND source_artifact_sha256 IS NULL AND expected_source_head_version IS NULL
      AND expected_target_head_version IS NULL)`;
}

export function down(pgm) {
  pgm.sql(`DELETE FROM product_command_intents WHERE event_type='${NEW_EVENT}';`);
  pgm.sql(`ALTER TABLE product_command_intents DROP CONSTRAINT product_command_intents_shape_check;
    ALTER TABLE product_command_intents ADD CONSTRAINT product_command_intents_shape_check CHECK (${previousShape()});`);
  pgm.dropColumns("product_command_intents", ["requested_handle"]);
  pgm.sql(`DO $$
    DECLARE constraint_record record; narrowed text;
    BEGIN
      FOR constraint_record IN
        SELECT conrelid::regclass AS table_name, conname AS name, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE contype='c' AND position('${NEW_EVENT}' in pg_get_constraintdef(oid)) > 0
      LOOP
        narrowed := replace(constraint_record.definition, ', ''${NEW_EVENT}''::text', '');
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_record.table_name, constraint_record.name);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', constraint_record.table_name, constraint_record.name, narrowed);
      END LOOP;
    END $$;`);
}
