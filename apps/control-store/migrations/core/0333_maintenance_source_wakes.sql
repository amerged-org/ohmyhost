-- Original 193 mutation completeness on the Core's actual financial facts. Measured signed movements/resolutions
-- retain original granularity; generic hold allocations/resolutions cover the other writers. No clock poll invents facts.

CREATE TRIGGER maintenance_wake_credit_lots AFTER INSERT ON credit_lots
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES (NEW.organization_id, 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_wake_credit_lot_adjustments AFTER INSERT ON credit_lot_adjustments
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES (NEW.organization_id, 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_wake_measured_credit_movements AFTER INSERT ON measured_credit_movements
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES (NEW.organization_id, 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_wake_measured_resolution AFTER INSERT ON measured_credit_resolutions
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES ((SELECT organization_id FROM measured_credit_reservations WHERE reservation_id = NEW.reservation_id), 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_wake_hold_allocation_insert AFTER INSERT ON credit_hold_lots
  WHEN NOT EXISTS (SELECT 1 FROM credit_holds h WHERE h.organization_id = NEW.organization_id AND h.hold_id = NEW.hold_id AND h.kind = 'metered_usage')
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES (NEW.organization_id, 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_wake_hold_allocation_update AFTER UPDATE OF held_micros, spent_micros, restored_micros ON credit_hold_lots
  WHEN NOT EXISTS (SELECT 1 FROM credit_holds h WHERE h.organization_id = NEW.organization_id AND h.hold_id = NEW.hold_id AND h.kind = 'metered_usage') AND (NEW.held_micros IS NOT OLD.held_micros OR NEW.spent_micros IS NOT OLD.spent_micros OR NEW.restored_micros IS NOT OLD.restored_micros)
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES (NEW.organization_id, 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_wake_hold_resolution AFTER UPDATE OF state ON credit_holds
  WHEN NEW.kind <> 'metered_usage' AND OLD.state = 'open' AND NEW.state IN ('settled','released')
BEGIN
  INSERT INTO credit_maintenance_due(organization_id, source_revision, due_at) VALUES (NEW.organization_id, 1, (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')) ON CONFLICT (organization_id) DO UPDATE SET source_revision = credit_maintenance_due.source_revision + 1, due_at = CASE WHEN credit_maintenance_due.due_at IS NULL THEN NULL WHEN credit_maintenance_due.due_at > (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') THEN (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z') ELSE credit_maintenance_due.due_at END;
END;

CREATE TRIGGER maintenance_notice_organizations_insert AFTER INSERT ON organizations
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'mapping_state', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_organizations_update AFTER UPDATE OF state ON organizations
  WHEN NEW.state IS NOT OLD.state
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'mapping_state', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_projects_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'project_ownership', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_projects_update AFTER UPDATE OF organization_id, owner_state ON projects
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.owner_state IS NOT OLD.owner_state
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at)
    SELECT organization_id, 'project_ownership', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')
    FROM (SELECT OLD.organization_id AS organization_id UNION SELECT NEW.organization_id) ORDER BY organization_id;
END;

CREATE TRIGGER maintenance_notice_credit_lot_expirations_insert AFTER INSERT ON credit_lot_expirations
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'credit_expiration', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_lot_expirations_update AFTER UPDATE OF expires_at ON credit_lot_expirations
  WHEN NEW.expires_at IS NOT OLD.expires_at
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'credit_expiration', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_topup_origins_insert AFTER INSERT ON credit_topup_origins
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, (CASE WHEN (SELECT kind FROM credit_lots WHERE organization_id=NEW.organization_id AND grant_id=NEW.grant_id)='stripe_recharge' THEN 'stripe_recharge' ELSE 'stripe_checkout' END), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_topup_origins_update AFTER UPDATE OF started_at ON credit_topup_origins
  WHEN NEW.started_at IS NOT OLD.started_at
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, (CASE WHEN (SELECT kind FROM credit_lots WHERE organization_id=NEW.organization_id AND grant_id=NEW.grant_id)='stripe_recharge' THEN 'stripe_recharge' ELSE 'stripe_checkout' END), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_periods_insert AFTER INSERT ON credit_paid_periods
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'stripe_payment', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_periods_update AFTER UPDATE OF period_start, period_end, paid_at, confirmed_at ON credit_paid_periods
  WHEN NEW.period_start IS NOT OLD.period_start OR NEW.period_end IS NOT OLD.period_end OR NEW.paid_at IS NOT OLD.paid_at OR NEW.confirmed_at IS NOT OLD.confirmed_at
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'stripe_payment', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_subscription_ends_insert AFTER INSERT ON credit_subscription_ends
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'stripe_subscription_end', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_subscription_ends_update AFTER UPDATE OF ended_at ON credit_subscription_ends
  WHEN NEW.ended_at IS NOT OLD.ended_at
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'stripe_subscription_end', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_access_events_insert AFTER INSERT ON credit_paid_access_events
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'paid_access_event', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_access_events_update AFTER UPDATE OF enabled, source, occurred_at, paid_until ON credit_paid_access_events
  WHEN NEW.enabled IS NOT OLD.enabled OR NEW.source IS NOT OLD.source OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.paid_until IS NOT OLD.paid_until
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'paid_access_event', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_access_insert AFTER INSERT ON credit_paid_access
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'paid_access', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_access_update AFTER UPDATE OF enabled, source, updated_at, paid_until ON credit_paid_access
  WHEN NEW.enabled IS NOT OLD.enabled OR NEW.source IS NOT OLD.source OR NEW.updated_at IS NOT OLD.updated_at OR NEW.paid_until IS NOT OLD.paid_until
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (NEW.organization_id, 'paid_access', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_due_monotone BEFORE UPDATE ON credit_maintenance_due
  WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.source_revision < OLD.source_revision OR NEW.evaluated_revision < OLD.evaluated_revision
BEGIN
  SELECT RAISE(ABORT, 'credit maintenance identity and revisions only move forward');
END;

CREATE TRIGGER maintenance_notice_identity BEFORE UPDATE ON credit_maintenance_notices
  WHEN OLD.processed_at IS NOT NULL OR NEW.notice_id IS NOT OLD.notice_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'credit maintenance notice identity is immutable and processed is terminal');
END;

CREATE TRIGGER maintenance_notice_organizations_delete AFTER DELETE ON organizations
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'mapping_state', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_projects_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'project_ownership', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_lot_expirations_delete AFTER DELETE ON credit_lot_expirations
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'credit_expiration', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_topup_origins_delete AFTER DELETE ON credit_topup_origins
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, (CASE WHEN (SELECT kind FROM credit_lots WHERE organization_id=OLD.organization_id AND grant_id=OLD.grant_id)='stripe_recharge' THEN 'stripe_recharge' ELSE 'stripe_checkout' END), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_periods_delete AFTER DELETE ON credit_paid_periods
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'stripe_payment', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_subscription_ends_delete AFTER DELETE ON credit_subscription_ends
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'stripe_subscription_end', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_access_events_delete AFTER DELETE ON credit_paid_access_events
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'paid_access_event', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;

CREATE TRIGGER maintenance_notice_credit_paid_access_delete AFTER DELETE ON credit_paid_access
BEGIN
  INSERT INTO credit_maintenance_notices(organization_id, reason, created_at, next_attempt_at) VALUES (OLD.organization_id, 'paid_access', (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'), (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'));
END;
