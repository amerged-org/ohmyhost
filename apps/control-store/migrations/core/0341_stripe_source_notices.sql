-- Original 193 Stripe notice authority. The complete raw caller/converter writes originals and
-- normalized policy mirrors in ONE guarded Core batch. Only the ORIGINAL fact emits a notice,
-- so mirror order cannot double an allocator revision. Mirror-only policy helpers stay off Runtime.
-- Unrelated source wakes/subscription ends/manual access/expiration hooks remain unchanged.
DROP TRIGGER maintenance_notice_credit_paid_periods_insert;
DROP TRIGGER maintenance_notice_credit_paid_periods_update;
DROP TRIGGER maintenance_notice_credit_paid_periods_delete;
DROP TRIGGER maintenance_notice_credit_topup_origins_insert;
DROP TRIGGER maintenance_notice_credit_topup_origins_update;
DROP TRIGGER maintenance_notice_credit_topup_origins_delete;

CREATE TRIGGER maintenance_notice_stripe_credit_payments_insert AFTER INSERT ON stripe_credit_payments
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  VALUES(NEW.organization_id,'stripe_payment',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;
CREATE TRIGGER maintenance_notice_stripe_credit_payments_update AFTER UPDATE OF organization_id, grant_id, offer, account_id, mode, subscription_id, invoice_id, period_start, period_end, paid_at, confirmed_at, credited_micros, checkout_id ON stripe_credit_payments
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.grant_id IS NOT OLD.grant_id OR NEW.offer IS NOT OLD.offer OR NEW.account_id IS NOT OLD.account_id OR NEW.mode IS NOT OLD.mode OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.period_start IS NOT OLD.period_start OR NEW.period_end IS NOT OLD.period_end OR NEW.paid_at IS NOT OLD.paid_at OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.credited_micros IS NOT OLD.credited_micros OR NEW.checkout_id IS NOT OLD.checkout_id
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  SELECT organization_id,'stripe_payment',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')
  FROM (SELECT OLD.organization_id AS organization_id UNION SELECT NEW.organization_id) ORDER BY organization_id;
END;
CREATE TRIGGER maintenance_notice_stripe_credit_payments_delete AFTER DELETE ON stripe_credit_payments
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  VALUES(OLD.organization_id,'stripe_payment',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_stripe_checkout_requests_insert AFTER INSERT ON stripe_checkout_requests
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  VALUES(NEW.organization_id,'stripe_checkout',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;
CREATE TRIGGER maintenance_notice_stripe_checkout_requests_update AFTER UPDATE OF organization_id, checkout_id, created_at ON stripe_checkout_requests
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.checkout_id IS NOT OLD.checkout_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  SELECT organization_id,'stripe_checkout',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')
  FROM (SELECT OLD.organization_id AS organization_id UNION SELECT NEW.organization_id) ORDER BY organization_id;
END;
CREATE TRIGGER maintenance_notice_stripe_checkout_requests_delete AFTER DELETE ON stripe_checkout_requests
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  VALUES(OLD.organization_id,'stripe_checkout',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_stripe_recharge_attempts_insert AFTER INSERT ON stripe_recharge_attempts
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  VALUES(NEW.organization_id,'stripe_recharge',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;
CREATE TRIGGER maintenance_notice_stripe_recharge_attempts_update AFTER UPDATE OF organization_id, grant_id, created_at ON stripe_recharge_attempts
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.grant_id IS NOT OLD.grant_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  SELECT organization_id,'stripe_recharge',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')
  FROM (SELECT OLD.organization_id AS organization_id UNION SELECT NEW.organization_id) ORDER BY organization_id;
END;
CREATE TRIGGER maintenance_notice_stripe_recharge_attempts_delete AFTER DELETE ON stripe_recharge_attempts
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id,reason,created_at,next_attempt_at)
  VALUES(OLD.organization_id,'stripe_recharge',(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;
