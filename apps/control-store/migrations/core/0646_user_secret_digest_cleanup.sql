-- Legacy user secrets kept an unsalted SHA-256 of their plaintext beside the sealed envelope, a guessing oracle for a
-- low-entropy value. The control API now stores a keyed digest for user values and receipts; this clears the legacy
-- digests of user rows only. Platform-generated keys keep their digest, because gateway joins compare it in SQL.
-- The envelope trigger refuses a digest change without a revision bump, so it is lifted for this rewrite and restored.
DROP TRIGGER environment_secrets_envelope_by_revision;
UPDATE environment_secrets
   SET value_sha256 = zeroblob(32)
 WHERE name NOT IN ('DATABASE_URL', 'BETTER_AUTH_SECRET', 'OHMYHOST_MAIL_KEY', 'OHMYHOST_STORAGE_KEY', 'OHMYHOST_AI_KEY')
   AND value_sha256 <> zeroblob(32);
CREATE TRIGGER environment_secrets_envelope_by_revision BEFORE UPDATE ON environment_secrets
  WHEN (NEW.ciphertext IS NOT OLD.ciphertext OR NEW.nonce IS NOT OLD.nonce OR NEW.value_sha256 IS NOT OLD.value_sha256 OR NEW.key_version IS NOT OLD.key_version)
   AND NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'secret envelope changes only with a revision bump'); END;
