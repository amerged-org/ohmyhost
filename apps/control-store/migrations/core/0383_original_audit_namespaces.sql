-- Original001 project and002 organization audits have INDEPENDENT global IDs. The unserved prototype merged them.
-- Admit only its unambiguous original organization shape. Never relabel an overlapping old export or drop extra scope.
INSERT INTO guard_fail(code) SELECT 'precondition_changed'
WHERE EXISTS(SELECT 1 FROM core_authority_activation)
  OR (SELECT count(*) FROM pragma_table_info('audit_events')) <> 10
  OR EXISTS(SELECT 1 FROM audit_events WHERE project_id IS NULL AND (operation_id IS NOT NULL OR billing_epoch_id IS NOT NULL))
  OR EXISTS(SELECT 1 FROM audit_events a JOIN evidence_exports e ON e.organization_id=a.organization_id
    AND e.table_name='audit_events' AND e.period_start<=a.occurred_at AND a.occurred_at<e.period_end WHERE a.project_id IS NULL)
  OR EXISTS(SELECT 1 FROM audit_events a JOIN retention_horizon h ON h.table_name='audit_events'
    AND a.occurred_at<=h.exported_through WHERE a.project_id IS NULL);

CREATE TABLE organization_audit_events (
  organization_id TEXT NOT NULL CHECK(length(organization_id)=26 AND organization_id GLOB '[0-7]*' AND organization_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  audit_event_id TEXT NOT NULL PRIMARY KEY CHECK(length(audit_event_id)=26 AND audit_event_id GLOB '[0-7]*' AND audit_event_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  event_type TEXT NOT NULL CHECK(event_type=trim(event_type) AND length(event_type) BETWEEN 1 AND 128),
  actor_type TEXT NOT NULL CHECK(actor_type=trim(actor_type) AND length(actor_type) BETWEEN 1 AND 64),
  actor_id TEXT NOT NULL CHECK(actor_id=trim(actor_id) AND length(actor_id) BETWEEN 1 AND 256),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  occurred_at TEXT NOT NULL CHECK(occurred_at GLOB '????-??-??T??:??:??.??????Z')
) STRICT, WITHOUT ROWID;
CREATE INDEX organization_audit_events_scope ON organization_audit_events(organization_id,occurred_at,audit_event_id);
INSERT INTO organization_audit_events(organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at)
  SELECT organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at FROM audit_events WHERE project_id IS NULL;
DROP TRIGGER audit_events_delete_below_horizon;
DELETE FROM audit_events WHERE project_id IS NULL;

-- Existing prototype export metadata is retained verbatim and cannot become original namespace/deletion proof.
ALTER TABLE evidence_exports ADD COLUMN source_format TEXT NOT NULL DEFAULT 'unqualified-prototype-v1';

CREATE TRIGGER organization_audit_events_no_update BEFORE UPDATE ON organization_audit_events
BEGIN SELECT RAISE(ABORT,'organization_audit_events is append-only'); END;
CREATE TRIGGER organization_audit_events_no_delete BEFORE DELETE ON organization_audit_events
BEGIN SELECT RAISE(ABORT,'organization_audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
DROP TRIGGER operation_events_delete_below_horizon;
CREATE TRIGGER operation_events_no_delete BEFORE DELETE ON operation_events
BEGIN SELECT RAISE(ABORT,'operation_events is append-only'); END;

-- Exact static Original001 project/epoch/operation relationships, even during historical loading.
CREATE TRIGGER audit_events_original_scope BEFORE INSERT ON audit_events
WHEN NEW.project_id IS NULL OR NEW.billing_epoch_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM billing_epochs e WHERE e.organization_id=NEW.organization_id AND e.project_id=NEW.project_id AND e.billing_epoch_id=NEW.billing_epoch_id)
  OR (NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.organization_id=NEW.organization_id AND o.project_id=NEW.project_id AND o.operation_id=NEW.operation_id))
BEGIN SELECT RAISE(ABORT,'project audit requires its exact original epoch and operation scope'); END;
