/** P30: preserve prior issuance history while new automation keys have no expiry. */
export function up(pgm) {
  pgm.sql("ALTER TABLE user_api_key_requests ALTER COLUMN expires_at DROP NOT NULL");
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM user_api_key_requests WHERE expires_at IS NULL) THEN
      RAISE EXCEPTION 'Retain API-key issuance history before removing non-expiring keys';
    END IF;
  END $$;
  ALTER TABLE user_api_key_requests ALTER COLUMN expires_at SET NOT NULL`);
}
