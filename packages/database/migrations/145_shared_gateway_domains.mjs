/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_gateway_script_name_check;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_gateway_script_name_check
      CHECK (gateway_script_name='ohmyho-gateway-production'
        OR gateway_script_name~'^[a-z]+-[a-z]+-[a-z]+$'
        OR gateway_script_name='g-p-'||lower(project_id::text)||'-prod');
    CREATE OR REPLACE FUNCTION project_gateway_script_name(
      project_id ulid,handle text,environment_name text,production_domain text
    ) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT CASE WHEN $3 IN ('dev','prod') THEN CASE
        WHEN $4=$2||'.check.omh.st' THEN 'ohmyho-gateway-production'
        WHEN $4 IN ($2||'.dev.check.omh.st',$2||'.poc.aixyte.com')
          THEN 'ohmyho-gateway-poc-private-fullstack'
      END END
    $$;
  `);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM shared_gateway_route_revisions)
        OR EXISTS (SELECT 1 FROM paid_project_domains WHERE gateway_script_name='ohmyho-gateway-production') THEN
        RAISE EXCEPTION 'shared gateway routes must be retired before reverting domain routing';
      END IF;
    END $$;
    ALTER TABLE paid_project_domains DROP CONSTRAINT paid_project_domains_gateway_script_name_check;
    ALTER TABLE paid_project_domains ADD CONSTRAINT paid_project_domains_gateway_script_name_check
      CHECK (gateway_script_name~'^[a-z]+-[a-z]+-[a-z]+$'
        OR gateway_script_name='g-p-'||lower(project_id::text)||'-prod');
    CREATE OR REPLACE FUNCTION project_gateway_script_name(
      project_id ulid,handle text,environment_name text,production_domain text
    ) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
      SELECT CASE WHEN $3 IN ('dev','prod') THEN CASE
        WHEN $4=$2||'.check.omh.st' THEN 'g-p-'||lower($1::text)||'-'||$3
        WHEN $4 IN ($2||'.dev.check.omh.st',$2||'.poc.aixyte.com')
          THEN CASE $3 WHEN 'dev' THEN 'dev-'||$2 ELSE $2 END
      END END
    $$;
  `);
}
