-- A parked Stripe inbox row counts its parkings. The Billing Worker alerts on the first parking only: a re-driven row
-- that fails again is the same loss. Expand-only: existing parked rows start at one, so they never alert again.
ALTER TABLE webhook_inbox ADD COLUMN park_count INTEGER NOT NULL DEFAULT 0 CHECK (park_count BETWEEN 0 AND 2147483647);
UPDATE webhook_inbox SET park_count = 1 WHERE state = 'reconciliation_required' AND park_count = 0;
