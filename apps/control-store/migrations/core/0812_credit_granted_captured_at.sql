-- When the granted or bounded Paid access kept in `granted_until` was captured by a Stripe coverage (BIL-18 review). A referral
-- clawback takes its thirty days off that end only for a reward granted at or before this instant: a reward that came later
-- was never added to the access that the invoice kept aside.
ALTER TABLE credit_account ADD COLUMN granted_captured_at TEXT CHECK (granted_captured_at IS NULL OR granted_captured_at GLOB '????-??-??T??:??:??.??????Z');
