export function up(pgm) {
  pgm.sql(`
    ALTER TABLE github_source_authorizations
      ALTER COLUMN session_id DROP NOT NULL,
      ALTER COLUMN token_expires_at DROP NOT NULL,
      ADD COLUMN user_api_key_id text,
      ADD CONSTRAINT github_authorization_credential CHECK (
        (session_id IS NOT NULL AND session_id ~ '^session_[A-Za-z0-9_]+$' AND user_api_key_id IS NULL AND token_expires_at IS NOT NULL)
        OR (session_id IS NULL AND user_api_key_id IS NOT NULL AND user_api_key_id ~ '^api_key_[A-Za-z0-9_]{1,120}$')
      );
  `);
}

export function down(pgm) {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM github_source_authorizations WHERE user_api_key_id IS NOT NULL) THEN
        RAISE EXCEPTION 'User-key GitHub consent history requires retention before rollback';
      END IF;
    END $$;
    ALTER TABLE github_source_authorizations
      DROP CONSTRAINT github_authorization_credential,
      DROP COLUMN user_api_key_id,
      ALTER COLUMN token_expires_at SET NOT NULL,
      ALTER COLUMN session_id SET NOT NULL;
  `);
}
