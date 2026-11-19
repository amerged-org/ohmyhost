-- The granted or bounded Paid access that a Stripe coverage overwrote (BIL-18). `granted_until` is its end and `granted_source`
-- its source. The invoice that overwrites it captures it; a Stripe end or a refund of the invoice restores it when it runs
-- past the Stripe coverage that remains, so a subscription never cuts access that Stripe did not give.
ALTER TABLE credit_account ADD COLUMN granted_until TEXT CHECK (granted_until IS NULL OR granted_until GLOB '????-??-??T??:??:??.??????Z');
ALTER TABLE credit_account ADD COLUMN granted_source TEXT CHECK (granted_source IS NULL OR granted_source IN ('granted', 'manual'));
