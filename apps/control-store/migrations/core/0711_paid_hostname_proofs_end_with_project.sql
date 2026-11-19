-- A project that changes owner or leaves its active lifecycle ends its Paid hostname proofs, as its mail identity was
-- revoked by the same change: a later connection of any of its hostnames needs a new proof. Expand-only: one trigger.
CREATE TRIGGER IF NOT EXISTS paid_hostname_proofs_end_with_project AFTER UPDATE OF owner_state,lifecycle_state ON projects
WHEN NEW.owner_state<>'active' OR NEW.lifecycle_state<>'active'
BEGIN
  DELETE FROM paid_hostname_proofs WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id;
END;
