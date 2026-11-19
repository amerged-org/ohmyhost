// Connection consent lasts one hour; secret and GitHub handoffs retain ten minutes.
// Existing timestamps and one-use consumption remain unchanged.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`DO $$ DECLARE name text; BEGIN
    -- Migration 172 left this check unnamed. Refuse an absent or unexpected old rule.
    SELECT conname INTO STRICT name FROM pg_constraint
      WHERE conrelid='mcp_portal_handoffs'::regclass AND contype='c' AND convalidated
        AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')
          ='CHECKexpires_at>created_atANDexpires_at<=created_at+''00:10:00''::interval';
    EXECUTE format('ALTER TABLE mcp_portal_handoffs DROP CONSTRAINT %I',name);
  END $$;
  ALTER TABLE mcp_portal_handoffs ADD CONSTRAINT mcp_portal_handoffs_lifetime_check
    CHECK(expires_at>created_at AND
      ((kind='grant' AND expires_at<=created_at+interval '1 hour')
       OR (kind IN ('secret','github') AND expires_at<=created_at+interval '10 minutes')));`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM mcp_portal_handoffs
      WHERE expires_at>created_at+interval '10 minutes') THEN
      RAISE EXCEPTION 'Longer-lived MCP access links prevent rollback';
    END IF;
  END $$;
  ALTER TABLE mcp_portal_handoffs DROP CONSTRAINT mcp_portal_handoffs_lifetime_check;
  ALTER TABLE mcp_portal_handoffs
    ADD CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes');`);
}
