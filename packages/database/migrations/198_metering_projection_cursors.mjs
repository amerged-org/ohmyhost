/** Four durable cursors for bounded projection maintenance; no event queue or financial authority. */
export function up(pgm) {
  pgm.sql(`CREATE TEMP TABLE metering_projection_cursor_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout;
    SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '5s';
    CREATE TABLE metering_projection_cursors (
      family text PRIMARY KEY CHECK (family IN ('wallet','expiry','reporting','source')),
      cleanup_turn boolean NOT NULL DEFAULT false,
      work_after ulid,
      cleanup_organization_after ulid,
      cleanup_generation_after ulid,
      source_kind_after text,
      source_reference_after text,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
      CHECK ((cleanup_organization_after IS NULL) = (cleanup_generation_after IS NULL)),
      CHECK ((source_kind_after IS NULL) = (source_reference_after IS NULL)),
      CHECK (source_kind_after IS NULL OR length(source_kind_after) BETWEEN 1 AND 64),
      CHECK (source_reference_after IS NULL OR length(source_reference_after) BETWEEN 1 AND 256)
    );
    INSERT INTO metering_projection_cursors(family) VALUES ('wallet'),('expiry'),('reporting'),('source');
    REVOKE ALL ON metering_projection_cursors FROM PUBLIC;
    DO $acl$
    DECLARE holder text; role_name text;
    BEGIN
      FOR holder IN SELECT DISTINCT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(acl.grantee)) END
        FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
        WHERE c.oid = 'metering_projection_cursors'::regclass AND acl.grantee <> c.relowner
      LOOP EXECUTE format('REVOKE ALL ON metering_projection_cursors FROM %s',holder); END LOOP;
      FOREACH role_name IN ARRAY ARRAY['control_runtime','metering_runtime'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
          EXECUTE format('GRANT SELECT ON metering_projection_cursors TO %I',role_name);
          EXECUTE format('GRANT UPDATE(cleanup_turn,work_after,cleanup_organization_after,
            cleanup_generation_after,source_kind_after,source_reference_after,revision)
            ON metering_projection_cursors TO %I',role_name);
        END IF;
      END LOOP;
    END $acl$;
    SELECT set_config('lock_timeout',lock_timeout,true),set_config('statement_timeout',statement_timeout,true)
      FROM pg_temp.metering_projection_cursor_timeouts;
    DROP TABLE pg_temp.metering_projection_cursor_timeouts;`);
}

export function down(pgm) {
  pgm.sql(`CREATE TEMP TABLE metering_projection_cursor_timeouts ON COMMIT DROP AS
    SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout;
    SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '5s';
    DROP TABLE metering_projection_cursors;
    SELECT set_config('lock_timeout',lock_timeout,true),set_config('statement_timeout',statement_timeout,true)
      FROM pg_temp.metering_projection_cursor_timeouts;
    DROP TABLE pg_temp.metering_projection_cursor_timeouts;`);
}
