-- Paid coverage belongs to the invoice and the subscription that produced it. An invoice grant records when its coverage
-- ends (`covers_until`, the period end plus 14 days, capped by the subscription end when Stripe reported one), so a fully
-- returned invoice can hand the coverage back to the other invoices that still stand. The account records which
-- subscription its Stripe coverage belongs to (`paid_subscription_id`), so a late end of an earlier subscription cannot
-- close the coverage of a newer one. Both columns are nullable: an account without a subscription keeps the rule it had.
--
-- Backfill: the credit log is rotated daily, so it names the period only of grants made today. Every other invoice grant
-- takes an upper bound of its coverage, 60 days after it was granted (a period is at most 32 days and the grace 14), so
-- a return of an old invoice can only leave more coverage in place, never take away the coverage of a current one. An
-- account takes the subscription of its latest invoice grant in the log; an account without one keeps the old rule until
-- its next paid invoice names the subscription. No money or coverage value changes here.
--
-- Rollout: this migration goes to Core BEFORE the Core and Billing Workers that use the new columns, and Core and
-- Billing ship together: the Billing Worker sends the subscription id that the Core end now requires.
ALTER TABLE credit_account ADD COLUMN paid_subscription_id TEXT CHECK (paid_subscription_id IS NULL OR length(paid_subscription_id) BETWEEN 5 AND 256);
ALTER TABLE credit_grant ADD COLUMN covers_until TEXT CHECK (covers_until IS NULL OR covers_until GLOB '????-??-??T??:??:??.??????Z');

UPDATE credit_grant SET covers_until = COALESCE(
  (
    SELECT strftime('%Y-%m-%dT%H:%M:%f', json_extract(log.detail, '$.periodEnd'), '+14 days') || '000Z'
    FROM credit_log log
    WHERE log.key = 'grant:' || credit_grant.key AND log.kind = 'grant'
  ),
  strftime('%Y-%m-%dT%H:%M:%f', credit_grant.granted_at, '+60 days') || '000Z'
)
WHERE credit_grant.key LIKE 'invoice:%';

UPDATE credit_account SET paid_subscription_id = (
  SELECT json_extract(log.detail, '$.subscriptionId')
  FROM credit_log log
  WHERE log.organization_id = credit_account.organization_id AND log.kind = 'grant' AND log.key LIKE 'grant:invoice:%'
  ORDER BY log.seq DESC
  LIMIT 1
)
WHERE credit_account.paid_source = 'stripe';
