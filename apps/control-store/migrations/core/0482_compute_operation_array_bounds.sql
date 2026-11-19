-- Original106 UUID-array structure and bounds. Native empty arrays are zero-dimensional; SQLNULL stays NULL.
-- Additional metadata records captured nondefault lower bounds; NULL means ordinary native all-one bounds.
-- No flattening, inferred historical bounds or source-column/proof-format changes.
INSERT INTO guard_fail(code) SELECT 'precondition_changed'
WHERE NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='project_database_compute_operation_ids_insert')
  OR EXISTS(SELECT 1 FROM project_database_compute_changes stored WHERE stored.provider_operation_ids IS NOT NULL AND (
  EXISTS(SELECT 1 FROM json_tree(stored.provider_operation_ids) array_node WHERE array_node.type='array'
    AND ((length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')))>=6
      OR (array_node.parent IS NOT NULL AND json_array_length(array_node.value)=0)
      OR (EXISTS(SELECT 1 FROM json_each(array_node.value) child WHERE child.type='array')
        AND EXISTS(SELECT 1 FROM json_each(array_node.value) child WHERE child.type<>'array'))))
  OR EXISTS(SELECT 1 FROM json_tree(stored.provider_operation_ids) array_node WHERE array_node.type='array'
    GROUP BY length(array_node.fullkey)-length(replace(array_node.fullkey,'[',''))
    HAVING min(json_array_length(array_node.value))<>max(json_array_length(array_node.value)))
));

ALTER TABLE project_database_compute_changes ADD COLUMN provider_operation_ids_bounds TEXT CHECK(provider_operation_ids_bounds IS NULL OR (json_valid(provider_operation_ids_bounds) AND json_type(provider_operation_ids_bounds)='array'));

CREATE TRIGGER project_database_compute_operation_array_insert BEFORE INSERT ON project_database_compute_changes
WHEN (
  EXISTS(SELECT 1 FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array'
    AND ((length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')))>=6
      OR (array_node.parent IS NOT NULL AND json_array_length(array_node.value)=0)
      OR (EXISTS(SELECT 1 FROM json_each(array_node.value) child WHERE child.type='array')
        AND EXISTS(SELECT 1 FROM json_each(array_node.value) child WHERE child.type<>'array'))))
  OR EXISTS(SELECT 1 FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array'
    GROUP BY length(array_node.fullkey)-length(replace(array_node.fullkey,'[',''))
    HAVING min(json_array_length(array_node.value))<>max(json_array_length(array_node.value)))
) OR (NEW.provider_operation_ids_bounds IS NOT NULL AND (
  NEW.provider_operation_ids IS NULL OR json_array_length(NEW.provider_operation_ids)=0
  OR json_array_length(NEW.provider_operation_ids_bounds)<>(SELECT max(length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')))+1 FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array')
  OR NOT EXISTS(SELECT 1 FROM json_each(NEW.provider_operation_ids_bounds) bound WHERE bound.value<>1)
  OR EXISTS(SELECT 1 FROM json_each(NEW.provider_operation_ids_bounds) bound
    LEFT JOIN (SELECT length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')) AS depth,min(json_array_length(array_node.value)) AS extent FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array' GROUP BY depth) dimension ON dimension.depth=CAST(bound.key AS INTEGER)
    WHERE bound.type<>'integer' OR bound.value < -2147483648 OR bound.value>2147483647
      OR dimension.extent IS NULL OR bound.value+dimension.extent-1>=2147483647)
))
BEGIN SELECT RAISE(ABORT,'Compute operation IDs must retain native UUID array shape and immutable bounds'); END;

CREATE TRIGGER project_database_compute_operation_array_update BEFORE UPDATE ON project_database_compute_changes
WHEN (
  EXISTS(SELECT 1 FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array'
    AND ((length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')))>=6
      OR (array_node.parent IS NOT NULL AND json_array_length(array_node.value)=0)
      OR (EXISTS(SELECT 1 FROM json_each(array_node.value) child WHERE child.type='array')
        AND EXISTS(SELECT 1 FROM json_each(array_node.value) child WHERE child.type<>'array'))))
  OR EXISTS(SELECT 1 FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array'
    GROUP BY length(array_node.fullkey)-length(replace(array_node.fullkey,'[',''))
    HAVING min(json_array_length(array_node.value))<>max(json_array_length(array_node.value)))
) OR (NEW.provider_operation_ids_bounds IS NOT NULL AND (
  NEW.provider_operation_ids IS NULL OR json_array_length(NEW.provider_operation_ids)=0
  OR json_array_length(NEW.provider_operation_ids_bounds)<>(SELECT max(length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')))+1 FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array')
  OR NOT EXISTS(SELECT 1 FROM json_each(NEW.provider_operation_ids_bounds) bound WHERE bound.value<>1)
  OR EXISTS(SELECT 1 FROM json_each(NEW.provider_operation_ids_bounds) bound
    LEFT JOIN (SELECT length(array_node.fullkey)-length(replace(array_node.fullkey,'[','')) AS depth,min(json_array_length(array_node.value)) AS extent FROM json_tree(NEW.provider_operation_ids) array_node WHERE array_node.type='array' GROUP BY depth) dimension ON dimension.depth=CAST(bound.key AS INTEGER)
    WHERE bound.type<>'integer' OR bound.value < -2147483648 OR bound.value>2147483647
      OR dimension.extent IS NULL OR bound.value+dimension.extent-1>=2147483647)
)) OR (OLD.provider_operation_ids IS NOT NULL AND NEW.provider_operation_ids_bounds IS NOT OLD.provider_operation_ids_bounds)
BEGIN SELECT RAISE(ABORT,'Compute operation IDs must retain native UUID array shape and immutable bounds'); END;
