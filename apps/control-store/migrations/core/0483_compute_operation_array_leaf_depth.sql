-- Original PostgreSQL multidimensional arrays have one common scalar/NULL leaf depth.
-- Per-level extents alone cannot reject uniformly sized sibling subtrees with different leaf ranks.
-- Empty root[] has no leaves and remains native zero-dimensional. Original0337/0481/0482 remain immutable.
INSERT INTO guard_fail(code) SELECT 'precondition_changed'
WHERE NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='project_database_compute_operation_array_insert')
  OR EXISTS(SELECT 1 FROM project_database_compute_changes stored WHERE stored.provider_operation_ids IS NOT NULL AND (SELECT min(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))<>max(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))
  FROM json_tree(stored.provider_operation_ids) leaf WHERE leaf.type<>'array'));

CREATE TRIGGER project_database_compute_operation_leaf_depth_insert BEFORE INSERT ON project_database_compute_changes
WHEN NEW.provider_operation_ids IS NOT NULL AND (SELECT min(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))<>max(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))
  FROM json_tree(NEW.provider_operation_ids) leaf WHERE leaf.type<>'array')
BEGIN SELECT RAISE(ABORT,'Compute operation IDs must retain native UUID array leaf depth'); END;

CREATE TRIGGER project_database_compute_operation_leaf_depth_update BEFORE UPDATE ON project_database_compute_changes
WHEN NEW.provider_operation_ids IS NOT NULL AND (SELECT min(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))<>max(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))
  FROM json_tree(NEW.provider_operation_ids) leaf WHERE leaf.type<>'array')
BEGIN SELECT RAISE(ABORT,'Compute operation IDs must retain native UUID array leaf depth'); END;
