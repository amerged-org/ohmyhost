-- Source-only convergence after0451 restores the original product intent table.
-- Its table rebuild drops0391's derived wake and lookup index. Restore ONLY those exact objects;
-- no historical notice, allocator state, or financial fact is reconstructed.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM core_authority_activation);
CREATE INDEX product_command_intents_operation_idx ON product_command_intents(organization_id,project_id,operation_id);
CREATE TRIGGER product_command_intents_lifetime_notice AFTER INSERT ON product_command_intents WHEN NEW.binding_refresh_snapshot IS NOT NULL BEGIN INSERT INTO lifetime_dirty_notices(target_kind,reason,from_at,organization_id,project_id,operation_id) VALUES('operation','refresh_intent',NEW.created_at,NEW.organization_id,NEW.project_id,NEW.operation_id); END;
