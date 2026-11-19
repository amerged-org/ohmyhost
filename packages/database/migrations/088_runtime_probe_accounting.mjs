export function up(pgm) {
  pgm.sql(`CREATE TABLE runtime_probe_windows (
    window_id ulid PRIMARY KEY,
    candidate_receipt_id ulid NOT NULL REFERENCES wfp_candidate_receipts(candidate_receipt_id),
    starts_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK(expires_at-starts_at=interval '210 seconds')
  );
  CREATE INDEX runtime_probe_window_lookup ON runtime_probe_windows(candidate_receipt_id,starts_at,expires_at);
  CREATE TRIGGER runtime_probe_windows_append_only BEFORE UPDATE OR DELETE ON runtime_probe_windows
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();`);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM runtime_probe_windows) THEN
    RAISE EXCEPTION 'Runtime probe accounting history must be retained'; END IF; END $$;`);
  pgm.dropTable("runtime_probe_windows");
}
