-- DOM-13: the customer mail-webhook signing secret is derived from the domain and a generation. Generation zero is the
-- original derivation, so every existing receiver keeps its secret until its URL changes or the owner rotates it; each
-- change then advances the generation and the earlier secret stops verifying. No data changes: existing rows start at zero.
ALTER TABLE resend_mail_domains ADD COLUMN webhook_secret_generation INTEGER NOT NULL DEFAULT 0 CHECK(webhook_secret_generation BETWEEN 0 AND 2147483647);
