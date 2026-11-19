export function up(pgm) {
  pgm.dropConstraint("webhook_inbox", "webhook_inbox_provider_signature_check");
  pgm.addConstraint("webhook_inbox", "webhook_inbox_provider_signature_check", {
    check:
      "(provider='workos' AND signature_timestamp IS NOT NULL) OR (provider IN ('github','stripe') AND signature_timestamp IS NULL)",
  });
}
export function down(pgm) {
  pgm.sql(
    "DO $$ BEGIN IF EXISTS(SELECT 1 FROM webhook_inbox WHERE provider='stripe') THEN RAISE EXCEPTION 'Stripe webhook history must be retained'; END IF; END $$",
  );
  pgm.dropConstraint("webhook_inbox", "webhook_inbox_provider_signature_check");
  pgm.addConstraint("webhook_inbox", "webhook_inbox_provider_signature_check", {
    check:
      "(provider='workos' AND signature_timestamp IS NOT NULL) OR (provider='github' AND signature_timestamp IS NULL)",
  });
}
