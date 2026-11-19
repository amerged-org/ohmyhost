export function up(pgm) {
  pgm.sql(`CREATE TABLE organization_credit_grace_periods (
    organization_id ulid PRIMARY KEY REFERENCES workos_organization_mappings(organization_id),
    exhausted_at timestamptz NOT NULL
  );`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM organization_credit_grace_periods) THEN
    RAISE EXCEPTION 'Active credit grace deadlines must be retained'; END IF; END $$;`);
  pgm.dropTable("organization_credit_grace_periods");
}
