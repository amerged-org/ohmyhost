/** A top-up above USD 100 grants 125 credits per dollar for the part above; the payment row proves it. */
export function up(pgm) {
  pgm.sql(`ALTER TABLE stripe_credit_payments DROP CONSTRAINT stripe_topup_payments_check1;
    ALTER TABLE stripe_credit_payments ADD CONSTRAINT stripe_credit_payments_credited_micros_check CHECK(
      credited_micros=CASE WHEN amount_subtotal_minor<=10000 THEN amount_subtotal_minor*1000000
        ELSE amount_subtotal_minor*1250000-2500000000 END);`);
}
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM stripe_credit_payments WHERE credited_micros<>amount_subtotal_minor*1000000)
      THEN RAISE EXCEPTION 'Volume bonus payment history must be retained'; END IF; END $$;
    ALTER TABLE stripe_credit_payments DROP CONSTRAINT stripe_credit_payments_credited_micros_check;
    ALTER TABLE stripe_credit_payments ADD CONSTRAINT stripe_topup_payments_check1 CHECK(credited_micros=amount_subtotal_minor*1000000);`);
}
