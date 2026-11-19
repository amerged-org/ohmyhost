-- The start of the Paid renewal that funds the monthly allowance now (BIL-10). A paid invoice whose period began at or before
-- that start nets the allowance the renewal already spent, so one period never gives two allowances. The lazy renewal sets it
-- and the invoice that replaces the renewal clears it; a Free renewal leaves it empty.
ALTER TABLE credit_account ADD COLUMN paid_renewal_at TEXT CHECK (paid_renewal_at IS NULL OR paid_renewal_at GLOB '????-??-??T??:??:??.??????Z');
