// A customer may choose a project's address, so the stored shape widens from the three generated
// words to one to five lowercase words of letters and digits. Every constraint keeps the rest of
// its predicate: only the handle shape inside it changes, and a chosen handle records its own
// provenance instead of the generator's evidence.
// The shape appears anchored in a handle check and unanchored inside an origin pattern.
const CORE = "[a-z]+-[a-z]+-[a-z]+";
const GENERATED = "^[a-z]+-[a-z]+-[a-z]+$";
const CHOSEN = "^[a-z0-9]+(-[a-z0-9]+){0,4}$";
const GENERATED_ORIGIN = "^https://(dev-)?[a-z]+-[a-z]+-[a-z]+[.](dev[.])?check[.]omh[.]st$";
const CHOSEN_ORIGIN = "^https://(dev-)?[a-z0-9]+(-[a-z0-9]+){0,4}[.](dev[.])?check[.]omh[.]st$";

function rewrite(search, from, to, fromOrigin, toOrigin, lengthFrom, lengthTo) {
  return `DO $$
    DECLARE constraint_record record; widened text;
    BEGIN
      FOR constraint_record IN
        SELECT conrelid::regclass AS table_name, conname AS name, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE contype='c' AND position(${quote(search)} in pg_get_constraintdef(oid)) > 0
      LOOP
        widened := replace(constraint_record.definition, ${quote(from)}, ${quote(to)});
        widened := replace(widened, ${quote(fromOrigin)}, ${quote(toOrigin)});
        widened := replace(widened, ${quote(lengthFrom)}, ${quote(lengthTo)});
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_record.table_name, constraint_record.name);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', constraint_record.table_name, constraint_record.name, widened);
      END LOOP;
    END $$;`;
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function up(pgm) {
  pgm.sql(
    rewrite(
      CORE,
      GENERATED,
      CHOSEN,
      GENERATED_ORIGIN,
      CHOSEN_ORIGIN,
      "(length(handle) <= 59)",
      "(length(handle) >= 3 AND length(handle) <= 59)",
    ),
  );
  pgm.sql(`ALTER TABLE projects DROP CONSTRAINT projects_handle_evidence_check;
    ALTER TABLE projects ADD CONSTRAINT projects_handle_evidence_check CHECK (
      (handle_version='human-id-4.2.0-sha256-project-handle-words-v1' AND handle_attempt BETWEEN 0 AND 31)
      OR (handle_version='customer-chosen-v1' AND handle_attempt=0));`);
}

export function down(pgm) {
  // Narrowing again is only possible while every stored handle still has the generated shape.
  pgm.sql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM projects WHERE handle !~ '${GENERATED}'
                    OR handle_version<>'human-id-4.2.0-sha256-project-handle-words-v1') THEN
        RAISE EXCEPTION 'a customer-chosen project handle cannot be narrowed back to the generated shape'
          USING ERRCODE='23514';
      END IF;
    END $$;`);
  pgm.sql(`ALTER TABLE projects DROP CONSTRAINT projects_handle_evidence_check;
    ALTER TABLE projects ADD CONSTRAINT projects_handle_evidence_check CHECK (
      handle_version='human-id-4.2.0-sha256-project-handle-words-v1' AND handle_attempt BETWEEN 0 AND 31);`);
  pgm.sql(
    rewrite(
      "[a-z0-9]+(-[a-z0-9]+){0,4}",
      CHOSEN,
      GENERATED,
      CHOSEN_ORIGIN,
      GENERATED_ORIGIN,
      "(length(handle) >= 3 AND length(handle) <= 59)",
      "(length(handle) <= 59)",
    ),
  );
}
