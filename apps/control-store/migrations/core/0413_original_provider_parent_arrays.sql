-- Original023 historical placement UUID-array type/cardinality/bounds. No Source column or row/proof rewrite.
-- Empty root[] is zero-dimensional; SQLNULL remains forbidden by the original NOTNULL column.
-- Existing invalid prototypes refuse this one atomic migration; no value is flattened, reset or repaired.
INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(
 SELECT 1 FROM neon_project_placement_receipts stored WHERE EXISTS(SELECT 1 FROM json_tree(stored.operation_ids) node WHERE node.type='array'
 AND ((length(node.fullkey)-length(replace(node.fullkey,'[','')))>=6
  OR (node.parent IS NOT NULL AND json_array_length(node.value)=0)
  OR (EXISTS(SELECT 1 FROM json_each(node.value) child WHERE child.type='array')
   AND EXISTS(SELECT 1 FROM json_each(node.value) child WHERE child.type<>'array'))))
 OR EXISTS(SELECT 1 FROM json_tree(stored.operation_ids) node WHERE node.type='array'
 GROUP BY length(node.fullkey)-length(replace(node.fullkey,'[',''))
 HAVING min(json_array_length(node.value))<>max(json_array_length(node.value)))
 OR (SELECT min(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))<>max(length(leaf.fullkey)-length(replace(leaf.fullkey,'[',''))) FROM json_tree(stored.operation_ids) leaf WHERE leaf.type<>'array')
 OR (SELECT count(*) FROM json_tree(stored.operation_ids) leaf WHERE leaf.type<>'array')>128
 OR EXISTS(SELECT 1 FROM json_tree(stored.operation_ids) leaf WHERE leaf.type<>'array' AND leaf.type<>'null'
 AND (leaf.type<>'text' OR length(leaf.value)<>36 OR length(CAST(leaf.value AS BLOB))<>36 OR length(replace(leaf.value,'-',''))<>32
  OR replace(leaf.value,'-','') GLOB '*[^0-9a-f]*' OR substr(leaf.value,9,1)<>'-'
  OR substr(leaf.value,14,1)<>'-' OR substr(leaf.value,19,1)<>'-' OR substr(leaf.value,24,1)<>'-')));
ALTER TABLE neon_project_placement_receipts ADD COLUMN operation_ids_bounds TEXT
 CHECK(operation_ids_bounds IS NULL OR (json_valid(operation_ids_bounds) AND json_type(operation_ids_bounds)='array'));
CREATE TRIGGER neon_project_placement_operation_ids_insert BEFORE INSERT ON neon_project_placement_receipts
 WHEN (EXISTS(SELECT 1 FROM json_tree(NEW.operation_ids) node WHERE node.type='array'
 AND ((length(node.fullkey)-length(replace(node.fullkey,'[','')))>=6
  OR (node.parent IS NOT NULL AND json_array_length(node.value)=0)
  OR (EXISTS(SELECT 1 FROM json_each(node.value) child WHERE child.type='array')
   AND EXISTS(SELECT 1 FROM json_each(node.value) child WHERE child.type<>'array'))))
 OR EXISTS(SELECT 1 FROM json_tree(NEW.operation_ids) node WHERE node.type='array'
 GROUP BY length(node.fullkey)-length(replace(node.fullkey,'[',''))
 HAVING min(json_array_length(node.value))<>max(json_array_length(node.value)))
 OR (SELECT min(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))<>max(length(leaf.fullkey)-length(replace(leaf.fullkey,'[',''))) FROM json_tree(NEW.operation_ids) leaf WHERE leaf.type<>'array')
 OR (SELECT count(*) FROM json_tree(NEW.operation_ids) leaf WHERE leaf.type<>'array')>128
 OR EXISTS(SELECT 1 FROM json_tree(NEW.operation_ids) leaf WHERE leaf.type<>'array' AND leaf.type<>'null'
 AND (leaf.type<>'text' OR length(leaf.value)<>36 OR length(CAST(leaf.value AS BLOB))<>36 OR length(replace(leaf.value,'-',''))<>32
  OR replace(leaf.value,'-','') GLOB '*[^0-9a-f]*' OR substr(leaf.value,9,1)<>'-'
  OR substr(leaf.value,14,1)<>'-' OR substr(leaf.value,19,1)<>'-' OR substr(leaf.value,24,1)<>'-'))) OR (NEW.operation_ids_bounds IS NOT NULL AND (
 json_array_length(NEW.operation_ids)=0
 OR json_array_length(NEW.operation_ids_bounds)<>(SELECT max(length(node.fullkey)-length(replace(node.fullkey,'[','')))+1 FROM json_tree(NEW.operation_ids) node WHERE node.type='array')
 OR NOT EXISTS(SELECT 1 FROM json_each(NEW.operation_ids_bounds) bound WHERE bound.value<>1)
 OR EXISTS(SELECT 1 FROM json_each(NEW.operation_ids_bounds) bound LEFT JOIN
  (SELECT length(node.fullkey)-length(replace(node.fullkey,'[','')) AS depth,min(json_array_length(node.value)) AS extent FROM json_tree(NEW.operation_ids) node WHERE node.type='array' GROUP BY depth) dimension
  ON dimension.depth=CAST(bound.key AS INTEGER)
  WHERE bound.type<>'integer' OR bound.value < -2147483648 OR bound.value>2147483647
   OR dimension.extent IS NULL OR bound.value+dimension.extent-1>=2147483647)))
BEGIN SELECT RAISE(ABORT,'Placement operation IDs must retain native UUID array type/cardinality/shape/bounds'); END;
CREATE TRIGGER neon_project_placement_operation_ids_update BEFORE UPDATE ON neon_project_placement_receipts
 WHEN (EXISTS(SELECT 1 FROM json_tree(NEW.operation_ids) node WHERE node.type='array'
 AND ((length(node.fullkey)-length(replace(node.fullkey,'[','')))>=6
  OR (node.parent IS NOT NULL AND json_array_length(node.value)=0)
  OR (EXISTS(SELECT 1 FROM json_each(node.value) child WHERE child.type='array')
   AND EXISTS(SELECT 1 FROM json_each(node.value) child WHERE child.type<>'array'))))
 OR EXISTS(SELECT 1 FROM json_tree(NEW.operation_ids) node WHERE node.type='array'
 GROUP BY length(node.fullkey)-length(replace(node.fullkey,'[',''))
 HAVING min(json_array_length(node.value))<>max(json_array_length(node.value)))
 OR (SELECT min(length(leaf.fullkey)-length(replace(leaf.fullkey,'[','')))<>max(length(leaf.fullkey)-length(replace(leaf.fullkey,'[',''))) FROM json_tree(NEW.operation_ids) leaf WHERE leaf.type<>'array')
 OR (SELECT count(*) FROM json_tree(NEW.operation_ids) leaf WHERE leaf.type<>'array')>128
 OR EXISTS(SELECT 1 FROM json_tree(NEW.operation_ids) leaf WHERE leaf.type<>'array' AND leaf.type<>'null'
 AND (leaf.type<>'text' OR length(leaf.value)<>36 OR length(CAST(leaf.value AS BLOB))<>36 OR length(replace(leaf.value,'-',''))<>32
  OR replace(leaf.value,'-','') GLOB '*[^0-9a-f]*' OR substr(leaf.value,9,1)<>'-'
  OR substr(leaf.value,14,1)<>'-' OR substr(leaf.value,19,1)<>'-' OR substr(leaf.value,24,1)<>'-'))) OR (NEW.operation_ids_bounds IS NOT NULL AND (
 json_array_length(NEW.operation_ids)=0
 OR json_array_length(NEW.operation_ids_bounds)<>(SELECT max(length(node.fullkey)-length(replace(node.fullkey,'[','')))+1 FROM json_tree(NEW.operation_ids) node WHERE node.type='array')
 OR NOT EXISTS(SELECT 1 FROM json_each(NEW.operation_ids_bounds) bound WHERE bound.value<>1)
 OR EXISTS(SELECT 1 FROM json_each(NEW.operation_ids_bounds) bound LEFT JOIN
  (SELECT length(node.fullkey)-length(replace(node.fullkey,'[','')) AS depth,min(json_array_length(node.value)) AS extent FROM json_tree(NEW.operation_ids) node WHERE node.type='array' GROUP BY depth) dimension
  ON dimension.depth=CAST(bound.key AS INTEGER)
  WHERE bound.type<>'integer' OR bound.value < -2147483648 OR bound.value>2147483647
   OR dimension.extent IS NULL OR bound.value+dimension.extent-1>=2147483647)))
BEGIN SELECT RAISE(ABORT,'Placement operation IDs must retain native UUID array type/cardinality/shape/bounds'); END;
