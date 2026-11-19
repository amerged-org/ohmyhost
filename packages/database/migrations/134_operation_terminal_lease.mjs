// Direct deployment completion writers must clear the lease just like event-based writers.
export function up(pgm) {
  pgm.sql(`CREATE FUNCTION clear_terminal_operation_lease() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state NOT IN ('queued','running') THEN NEW.lease_expires_at := NULL; END IF;
      RETURN NEW;
    END
  $$;
  CREATE TRIGGER operations_terminal_lease BEFORE UPDATE ON operations
    FOR EACH ROW EXECUTE FUNCTION clear_terminal_operation_lease();`);
}

export function down(pgm) {
  pgm.sql(`DROP TRIGGER operations_terminal_lease ON operations;
    DROP FUNCTION clear_terminal_operation_lease();`);
}
