-- Original action_confirmations.confirmation_id is a global primary key.
-- Targets are unserved: reject incomplete prototypes or collisions rather than rewrite any history.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE UNIQUE INDEX action_confirmations_original_global_identity ON action_confirmations(confirmation_id);
