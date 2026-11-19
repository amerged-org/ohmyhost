-- Original001 composite scope FKs and int4 domains stay active even in historical import mode.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(
  SELECT 1 FROM operation_events event WHERE event.revision>2147483647
    OR NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=event.organization_id
      AND operation.project_id=event.project_id AND operation.operation_id=event.operation_id));
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(
  SELECT 1 FROM outbox_events event WHERE event.attempt_count>2147483647 OR event.max_attempts>2147483647
    OR NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=event.organization_id
      AND operation.project_id=event.project_id AND operation.operation_id=event.operation_id)
    OR NOT EXISTS(SELECT 1 FROM billing_epochs epoch WHERE epoch.organization_id=event.organization_id
      AND epoch.project_id=event.project_id AND epoch.billing_epoch_id=event.billing_epoch_id));
CREATE TRIGGER operation_events_original_scope BEFORE INSERT ON operation_events
WHEN NEW.revision>2147483647 OR NOT EXISTS(SELECT 1 FROM operations operation
  WHERE operation.organization_id=NEW.organization_id AND operation.project_id=NEW.project_id AND operation.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'operation event requires exact original operation scope and int4 revision'); END;
CREATE TRIGGER outbox_events_original_scope BEFORE INSERT ON outbox_events
WHEN NEW.attempt_count>2147483647 OR NEW.max_attempts>2147483647
  OR NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=NEW.organization_id AND operation.project_id=NEW.project_id AND operation.operation_id=NEW.operation_id)
  OR NOT EXISTS(SELECT 1 FROM billing_epochs epoch WHERE epoch.organization_id=NEW.organization_id AND epoch.project_id=NEW.project_id AND epoch.billing_epoch_id=NEW.billing_epoch_id)
BEGIN SELECT RAISE(ABORT,'outbox event requires exact original operation/epoch scope and int4 counters'); END;
CREATE TRIGGER outbox_events_original_scope_update BEFORE UPDATE ON outbox_events
WHEN NEW.attempt_count>2147483647 OR NEW.max_attempts>2147483647
  OR NOT EXISTS(SELECT 1 FROM operations operation WHERE operation.organization_id=NEW.organization_id AND operation.project_id=NEW.project_id AND operation.operation_id=NEW.operation_id)
  OR NOT EXISTS(SELECT 1 FROM billing_epochs epoch WHERE epoch.organization_id=NEW.organization_id AND epoch.project_id=NEW.project_id AND epoch.billing_epoch_id=NEW.billing_epoch_id)
BEGIN SELECT RAISE(ABORT,'outbox event requires exact original operation/epoch scope and int4 counters'); END;
