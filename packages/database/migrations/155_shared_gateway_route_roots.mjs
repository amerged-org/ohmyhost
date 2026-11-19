// A failed first deployment leaves route history in an environment that serves nothing (Sebmer Dev
// operation 01M3C5PEP52T5E3YCM26VWPKXW, 2026-09-25). The next deployment's activation follows that
// history yet names no predecessor, because nothing was served before it, so a revision without a
// predecessor is no longer only revision 1: an activation may start such a root after it.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`DO $$
    DECLARE name text;
    BEGIN
      -- Migration 143 left this check unnamed; STRICT fails unless exactly one check matches.
      SELECT conname INTO STRICT name FROM pg_constraint
       WHERE conrelid='shared_gateway_route_revisions'::regclass AND contype='c'
         AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')='CHECKrevision=1=predecessor_revisionISNULL';
      EXECUTE format('ALTER TABLE shared_gateway_route_revisions DROP CONSTRAINT %I', name);
    END $$;
    ALTER TABLE shared_gateway_route_revisions ADD CONSTRAINT shared_gateway_route_revisions_root_check
      CHECK (predecessor_revision IS NOT NULL OR revision=1 OR action='activate');`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM shared_gateway_route_revisions WHERE revision>1 AND predecessor_revision IS NULL) THEN
        RAISE EXCEPTION 'Route history starts a root after revision 1; the earlier rule cannot hold it';
      END IF;
    END $$;
    ALTER TABLE shared_gateway_route_revisions DROP CONSTRAINT shared_gateway_route_revisions_root_check;
    ALTER TABLE shared_gateway_route_revisions ADD CHECK ((revision=1)=(predecessor_revision IS NULL));`);
}
