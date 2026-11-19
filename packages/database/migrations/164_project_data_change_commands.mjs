// P1 accepts one confirmed, idempotent operation whose immutable intent owns the data transition.
const EVENT = "ProjectDataChangeRequestedV1";
const CHANGE_KINDS =
  "''isolate_prod_keeps_data'',''isolate_dev_keeps_data'',''share_prod_keeps_data'',''reset_dev''";

export function up(pgm) {
  pgm.addColumns("product_command_intents", {
    data_change: { type: "text" },
    data_change_snapshot: { type: "jsonb" },
  });
  pgm.sql(`DO $$ DECLARE item record; definition text; BEGIN
    FOR item IN SELECT conrelid::regclass AS table_name,conname AS name,
        pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace=current_schema()::regnamespace AND contype='c' AND conname<>'product_command_intents_shape_check'
        AND position('= ANY (ARRAY[' in pg_get_constraintdef(oid))>0
        AND position('${EVENT}' in pg_get_constraintdef(oid))=0
        AND (position('ProjectDeletionRequestedV1' in pg_get_constraintdef(oid))>0
          OR position('DeploymentPromotionRequestedV1' in pg_get_constraintdef(oid))>0)
    LOOP
      IF position('ProjectDeletionRequestedV1' in item.definition)>0 THEN
        definition := replace(item.definition,'''ProjectDeletionRequestedV1''::text',
          '''ProjectDeletionRequestedV1''::text, ''${EVENT}''::text');
      ELSE
        definition := replace(item.definition,'''DeploymentPromotionRequestedV1''::text',
          '''DeploymentPromotionRequestedV1''::text, ''${EVENT}''::text');
      END IF;
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.table_name,item.name);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.table_name,item.name,definition);
    END LOOP;
  END $$`);
  pgm.sql(`DO $$ DECLARE previous_shape text; inner_shape text; BEGIN
    SELECT pg_get_constraintdef(oid) INTO STRICT previous_shape FROM pg_constraint
      WHERE conrelid='product_command_intents'::regclass
        AND conname='product_command_intents_shape_check';
    inner_shape := substring(previous_shape from 8 for length(previous_shape)-8);
    ALTER TABLE product_command_intents DROP CONSTRAINT product_command_intents_shape_check;
    EXECUTE format('ALTER TABLE product_command_intents ADD CONSTRAINT product_command_intents_shape_check CHECK (
      (event_type=%L AND data_change IN (${CHANGE_KINDS})
        AND jsonb_typeof(data_change_snapshot)=''object''
        AND data_change_snapshot ?& ARRAY[''transition'',''environmentHeads'',''registrationGenerations'']
        AND data_change_snapshot-ARRAY[''transition'',''environmentHeads'',''registrationGenerations'']=''{}''::jsonb
        AND jsonb_typeof(data_change_snapshot->''transition'')=''object''
        AND jsonb_typeof(data_change_snapshot->''environmentHeads'')=''array''
        AND jsonb_array_length(data_change_snapshot->''environmentHeads'')=2
        AND jsonb_typeof(data_change_snapshot->''registrationGenerations'')=''array''
        AND installation_id IS NULL AND repository_owner IS NULL AND repository_name IS NULL
        AND plan_id IS NULL AND source_connection_id IS NULL AND deployment_id IS NULL
        AND target_deployment_id IS NULL AND target_revision_id IS NULL AND target_artifact_id IS NULL
        AND expected_etag IS NOT NULL AND cleanup_run_id IS NOT NULL AND requested_handle IS NULL
        AND source_environment_id IS NULL AND source_deployment_id IS NULL
        AND source_revision_id IS NULL AND source_artifact_id IS NULL AND source_artifact_sha256 IS NULL
        AND expected_source_head_version IS NULL AND expected_target_head_version IS NULL)
      OR (event_type<>%L AND data_change IS NULL AND data_change_snapshot IS NULL AND (%s)))',
      '${EVENT}','${EVENT}',inner_shape);
    EXECUTE format('COMMENT ON CONSTRAINT product_command_intents_shape_check ON product_command_intents IS %L',
      'pre-data-change:'||previous_shape);
  END $$`);
  pgm.sql(`DO $$ DECLARE item record; definition text; BEGIN
    FOR item IN SELECT conname AS name,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='action_confirmations'::regclass AND contype='c'
        AND position('''delete''::text' in pg_get_constraintdef(oid))>0
    LOOP
      definition := item.definition;
      definition := regexp_replace(definition,'action = ANY \\(ARRAY\\[([^]]*)\\]\\)', 'action = ANY (ARRAY[\\1, ''data_change''::text])','g');
      definition := replace(definition,'action = ''delete''::text','action = ANY (ARRAY[''delete''::text, ''data_change''::text])');
      EXECUTE format('ALTER TABLE action_confirmations DROP CONSTRAINT %I',item.name);
      EXECUTE format('ALTER TABLE action_confirmations ADD CONSTRAINT %I %s',item.name,definition);
      EXECUTE format('COMMENT ON CONSTRAINT %I ON action_confirmations IS %L',item.name,
        'pre-data-change:'||item.definition);
    END LOOP;
  END $$`);
}

export function down(pgm) {
  pgm.sql(`DO $$ DECLARE item record; definition text; BEGIN
    IF EXISTS(SELECT 1 FROM product_command_intents WHERE event_type='${EVENT}')
      OR EXISTS(SELECT 1 FROM action_confirmations WHERE action='data_change') THEN
      RAISE EXCEPTION 'Recorded data change operations prevent a lossless downgrade';
    END IF;
    FOR item IN SELECT conrelid::regclass AS table_name,conname AS name,
        obj_description(oid,'pg_constraint') AS previous_definition
      FROM pg_constraint WHERE conrelid IN ('product_command_intents'::regclass,'action_confirmations'::regclass)
        AND obj_description(oid,'pg_constraint') LIKE 'pre-data-change:%'
    LOOP
      definition := substring(item.previous_definition from length('pre-data-change:')+1);
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.table_name,item.name);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.table_name,item.name,definition);
    END LOOP;
    FOR item IN SELECT conrelid::regclass AS table_name,conname AS name,
        pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace=current_schema()::regnamespace AND contype='c' AND position('${EVENT}' in pg_get_constraintdef(oid))>0
    LOOP
      definition := replace(item.definition,', ''${EVENT}''::text','');
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.table_name,item.name);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.table_name,item.name,definition);
    END LOOP;
  END $$`);
  pgm.dropColumns("product_command_intents", ["data_change", "data_change_snapshot"]);
}
