export function up(pgm) {
  pgm.sql(`CREATE TABLE stripe_dispute_movements (
    account_id text NOT NULL,mode text NOT NULL,transaction_id text NOT NULL CHECK(transaction_id ~ '^txn_[A-Za-z0-9_]+$' AND length(transaction_id)<=256),
    dispute_id text NOT NULL CHECK(dispute_id ~ '^du_[A-Za-z0-9_]+$' AND length(dispute_id)<=256),
    checkout_id ulid NOT NULL,organization_id ulid NOT NULL,payment_intent_id text NOT NULL,
    disputed_amount_minor bigint NOT NULL CHECK(disputed_amount_minor>0),
    direction text NOT NULL CHECK(direction IN ('withdrawn','reinstated')),observed_at timestamptz NOT NULL,
    PRIMARY KEY(account_id,mode,transaction_id),
    FOREIGN KEY(checkout_id,organization_id,account_id,mode,payment_intent_id)
      REFERENCES stripe_credit_payments(checkout_id,organization_id,account_id,mode,payment_intent_id)
  );
  CREATE INDEX stripe_dispute_payment ON stripe_dispute_movements(checkout_id,payment_intent_id,dispute_id);
  CREATE TRIGGER stripe_dispute_movement_append_only BEFORE UPDATE OR DELETE ON stripe_dispute_movements FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();`);
}
export function down(pgm) {
  pgm.sql(
    "DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_dispute_movements) THEN RAISE EXCEPTION 'Dispute movement history must be retained'; END IF; END $$; DROP TABLE stripe_dispute_movements;",
  );
}
