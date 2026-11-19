// The cron order check compared text in the server's collation, so the same canonical order
// that the application produces was valid on one server and rejected on another. The
// application sorts by code point, and the check now does the same explicitly.
const ORDERED_CRONS = `CREATE OR REPLACE FUNCTION valid_function_crons(requirement jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(requirement)='object'
    AND requirement ?& ARRAY['crons'] AND requirement - ARRAY['crons']='{}'::jsonb
    AND jsonb_typeof(requirement->'crons')='array'
    AND jsonb_array_length(requirement->'crons') BETWEEN 1 AND 8
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(requirement->'crons') WITH ORDINALITY item(value,ord)
      WHERE jsonb_typeof(value)<>'string'
        OR (value#>>'{}')!~'^(\\*\\/([5-9]|[1-5][0-9])|[0-9]|[1-5][0-9]) (\\*|[0-9]|1[0-9]|2[0-3]) (\\*|[1-9]|[12][0-9]|3[01]) (\\*|[1-9]|1[0-2]) (\\*|[0-6])$'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(requirement->'crons') WITH ORDINALITY prior(pvalue,pord)
          WHERE pord<ord AND (pvalue#>>'{}') COLLATE "C">=(value#>>'{}') COLLATE "C")) $$`;

export function up(pgm) {
  pgm.sql(ORDERED_CRONS);
}

export function down(pgm) {
  pgm.sql(ORDERED_CRONS.replace(/ COLLATE "C"/gu, ""));
}
