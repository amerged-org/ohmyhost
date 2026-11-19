// A Stripe renewal is paid only after its period ends, and Stripe retries a failed payment for
// days, so Paid coverage continues for 14 days after a period end (owner rule 2026-09-28). A
// subscription that Stripe reports as ended closes that coverage at its end instead: an
// immutable fact per subscription, which every Worker reading a credit balance joins.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE stripe_credit_payments ADD COLUMN paid_at timestamptz
      CHECK(paid_at IS NULL OR (offer='paid' AND paid_at<=confirmed_at));
  CREATE TABLE organization_credit_grant_expirations (
    grant_id ulid PRIMARY KEY,
    organization_id ulid NOT NULL,
    expires_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL CHECK(expires_at<=recorded_at),
    FOREIGN KEY(organization_id,grant_id) REFERENCES organization_credit_grants(organization_id,grant_id)
  );
  CREATE TRIGGER organization_credit_grant_expirations_append_only BEFORE UPDATE OR DELETE ON organization_credit_grant_expirations
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  CREATE TABLE stripe_subscription_ends (
    account_id text NOT NULL CHECK (account_id ~ '^acct_[A-Za-z0-9_]{1,128}$'),
    mode text NOT NULL CHECK (mode IN ('test','live')),
    subscription_id text NOT NULL CHECK (subscription_id ~ '^sub_[A-Za-z0-9_]{1,252}$'),
    organization_id ulid NOT NULL REFERENCES workos_organization_mappings(organization_id),
    ended_at timestamptz NOT NULL,
    observed_at timestamptz NOT NULL,
    PRIMARY KEY (account_id,mode,subscription_id)
  );
  CREATE TRIGGER stripe_subscription_ends_append_only BEFORE UPDATE OR DELETE ON stripe_subscription_ends
    FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_runtime') THEN
      REVOKE ALL ON stripe_subscription_ends FROM control_runtime;
      GRANT SELECT,INSERT ON stripe_subscription_ends TO control_runtime;
      REVOKE ALL ON organization_credit_grant_expirations FROM control_runtime;
      GRANT SELECT ON organization_credit_grant_expirations TO control_runtime;
    END IF;
  END $$;
  LOCK TABLE organization_credit_grants,organization_credit_grant_adjustments,
    organization_paid_access_events,organization_paid_access,stripe_checkout_requests,
    stripe_recharge_attempts IN SHARE MODE;
  -- Preserve the expiry of existing top-ups under the shipped 24-hour rule before widening it.
  -- This appends facts without changing payment, grant, adjustment or spending history.
  WITH access_events AS (
    SELECT organization_id,occurred_at,enabled,paid_until,
      lead(occurred_at) OVER (PARTITION BY organization_id ORDER BY occurred_at,event_id) AS next_at
    FROM organization_paid_access_events
  ), paid_payments AS (
    SELECT * FROM stripe_credit_payments WHERE offer='paid'
  ), payment_changes AS (
    SELECT p.organization_id,p.grant_id,p.period_start AS at,0::bigint AS amount FROM paid_payments p
    UNION ALL
    SELECT a.organization_id,a.grant_id,a.occurred_at,sum(a.amount_micros)::bigint
    FROM organization_credit_grant_adjustments a JOIN paid_payments p USING(organization_id,grant_id)
    WHERE a.occurred_at>=p.period_start AND a.occurred_at<p.period_end
    GROUP BY a.organization_id,a.grant_id,a.occurred_at
  ), payment_timeline AS (
    SELECT organization_id,grant_id,at,sum(amount) AS delta
    FROM payment_changes GROUP BY organization_id,grant_id,at
  ), payment_segments AS (
    SELECT t.organization_id,t.grant_id,t.at,
      lead(t.at,1,p.period_end) OVER (PARTITION BY t.grant_id ORDER BY t.at) AS until,
      sum(t.delta) OVER (PARTITION BY t.grant_id ORDER BY t.at) AS revoked,
      p.credited_micros,p.period_end
    FROM payment_timeline t JOIN paid_payments p USING(organization_id,grant_id)
  ), paid_intervals AS (
    SELECT organization_id,at AS since,
      CASE WHEN until=period_end THEN until+interval '24 hours' ELSE until END AS until
    FROM payment_segments WHERE revoked<credited_micros
    UNION ALL SELECT organization_id,occurred_at,LEAST(paid_until,next_at) FROM access_events WHERE enabled
    UNION ALL SELECT organization_id,updated_at,paid_until FROM organization_paid_access WHERE enabled
  ), paid_coverage AS (
    SELECT organization_id,unnest(range_agg(tstzrange(since,until,'[)'))) AS period
    FROM paid_intervals WHERE until IS NULL OR until>since GROUP BY organization_id
  ), previous_expiry AS (
    SELECT g.grant_id,g.organization_id,
      CASE WHEN coverage.period IS NULL THEN g.granted_at ELSE upper(coverage.period) END AS expires_at
    FROM organization_credit_grants g
    LEFT JOIN stripe_credit_payments purchase ON purchase.organization_id=g.organization_id
      AND purchase.grant_id=g.grant_id AND purchase.offer='topup'
    LEFT JOIN stripe_checkout_requests checkout ON checkout.checkout_id=purchase.checkout_id
    LEFT JOIN stripe_recharge_attempts recharge ON recharge.organization_id=g.organization_id AND recharge.grant_id=g.grant_id
    LEFT JOIN paid_coverage coverage ON coverage.organization_id=g.organization_id
      AND coverage.period @> COALESCE(checkout.created_at,recharge.created_at,g.granted_at)
    WHERE g.kind IN ('stripe_topup','stripe_recharge')
  )
  INSERT INTO organization_credit_grant_expirations(grant_id,organization_id,expires_at,recorded_at)
    SELECT grant_id,organization_id,expires_at,now() FROM previous_expiry WHERE expires_at<=now();`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM stripe_subscription_ends)
      OR EXISTS (SELECT 1 FROM organization_credit_grant_expirations)
      OR EXISTS (SELECT 1 FROM stripe_credit_payments WHERE paid_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Recorded Stripe coverage and expirations prevent a lossless downgrade';
    END IF;
  END $$`);
  pgm.sql(`DROP TABLE stripe_subscription_ends;
    DROP TABLE organization_credit_grant_expirations;
    ALTER TABLE stripe_credit_payments DROP COLUMN paid_at;`);
}
