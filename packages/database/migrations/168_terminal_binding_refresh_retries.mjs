// Failed private maintenance requests retain their immutable custody; new requests may retry it.
export function up(pgm) {
  pgm.sql(`DROP INDEX product_binding_refresh_snapshot_key;
    CREATE INDEX product_binding_refresh_snapshot_history_idx ON product_command_intents
      (organization_id,project_id,environment_id,binding_refresh_snapshot)
      WHERE binding_refresh_snapshot IS NOT NULL;`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_command_intents
      WHERE binding_refresh_snapshot IS NOT NULL
      GROUP BY organization_id,project_id,environment_id,binding_refresh_snapshot
      HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Recorded binding refresh retries prevent lossless downgrade' USING ERRCODE='23514';
    END IF;
  END $$;
  DROP INDEX product_binding_refresh_snapshot_history_idx;
  CREATE UNIQUE INDEX product_binding_refresh_snapshot_key ON product_command_intents
    (organization_id,project_id,environment_id,binding_refresh_snapshot)
    WHERE binding_refresh_snapshot IS NOT NULL;`);
}
