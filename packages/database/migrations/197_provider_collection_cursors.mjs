// Polling fairness/pacing only: a cursor does not certify provider-history completeness.
export const up = (pgm) => {
  pgm.sql(`SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
    CREATE TABLE provider_collection_cursors (
      provider_kind text NOT NULL CHECK(provider_kind IN ('neon','r2')),
      account_id text NOT NULL,
      after_resource_key text NOT NULL DEFAULT '' CHECK(length(after_resource_key)<=256),
      generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
      next_request_at timestamptz NOT NULL DEFAULT '-infinity',
      cycle_started_at timestamptz NOT NULL DEFAULT '-infinity',
      next_cycle_at timestamptz NOT NULL DEFAULT '-infinity',
      PRIMARY KEY(provider_kind,account_id),
      CHECK((provider_kind='r2' AND account_id~'^[0-9a-f]{32}$')
        OR(provider_kind='neon' AND account_id~'^org-[a-z0-9-]{1,56}$'))
    );
    CREATE INDEX provider_collection_r2_resource_idx ON project_r2_bucket_receipts((bucket_name||'/'||jurisdiction));
    DO $migration$ DECLARE scope text:=current_schema(); BEGIN
      EXECUTE format($definition$
        CREATE FUNCTION %I.provider_collection_cursor_guard() RETURNS trigger
        LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $body$
        BEGIN
          IF TG_RELID<>%L::regclass OR TG_OP<>'UPDATE'
            OR NEW.provider_kind IS DISTINCT FROM OLD.provider_kind
            OR NEW.account_id IS DISTINCT FROM OLD.account_id
            OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
            OR (NEW.after_resource_key IS DISTINCT FROM OLD.after_resource_key AND NEW.generation<>OLD.generation+1)
            OR NEW.next_request_at<OLD.next_request_at THEN
            RAISE EXCEPTION 'Provider collection cursor mutation denied' USING ERRCODE='42501';
          END IF;
          RETURN NEW;
        END $body$;
      $definition$,scope,format('%I.provider_collection_cursors',scope));
      EXECUTE format('REVOKE ALL ON FUNCTION %I.provider_collection_cursor_guard() FROM PUBLIC',scope);
    END $migration$;
    CREATE TRIGGER provider_collection_cursor_guard BEFORE UPDATE OR DELETE ON provider_collection_cursors
      FOR EACH ROW EXECUTE FUNCTION provider_collection_cursor_guard();
    ALTER TABLE provider_collection_cursors ENABLE ALWAYS TRIGGER provider_collection_cursor_guard;
    REVOKE ALL ON provider_collection_cursors FROM PUBLIC;
    DO $grants$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
        REVOKE ALL ON provider_collection_cursors FROM control_runtime;
        GRANT SELECT,INSERT,UPDATE ON provider_collection_cursors TO control_runtime;
        REVOKE ALL ON FUNCTION provider_collection_cursor_guard() FROM control_runtime;
      END IF;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metering_runtime') THEN
        REVOKE ALL ON provider_collection_cursors FROM metering_runtime;
        REVOKE ALL ON FUNCTION provider_collection_cursor_guard() FROM metering_runtime;
      END IF;
    END $grants$;
  `);
};
export const down = (pgm) => {
  pgm.sql(`DROP TABLE provider_collection_cursors;
    DROP FUNCTION provider_collection_cursor_guard();
    DROP INDEX provider_collection_r2_resource_idx;`);
};
