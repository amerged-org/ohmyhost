-- The platform overrun of an organization is booked in `overrun_micros` and never resets. The monthly ceiling of that
-- overrun (USD 50 a month) needs the overrun of the current month alone, so the account keeps the overrun as it stood when
-- its month began (`overrun_base_micros`). The renewal sets it, and the month's overrun is the difference. Existing accounts
-- start with their whole overrun as the base: the ceiling counts only overrun booked after this migration.
ALTER TABLE credit_account ADD COLUMN overrun_base_micros INTEGER NOT NULL DEFAULT 0 CHECK (overrun_base_micros >= 0);
UPDATE credit_account SET overrun_base_micros = overrun_micros;
