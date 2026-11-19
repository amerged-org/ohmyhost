-- Original106 uuid[] values: every non-NULL element is a canonical stored UUID, cardinality at most16.
-- Preserve duplicate/NULL elements and array structure. No historical value is normalized, flattened or repaired.
-- Independent source integrity remains enabled during historical import; immutable0337 and its wake SQL stay intact.
INSERT INTO guard_fail(code) SELECT 'precondition_changed'
WHERE EXISTS(SELECT 1 FROM project_database_compute_changes stored
  WHERE stored.provider_operation_ids IS NOT NULL AND (
  (SELECT count(*) FROM json_tree(stored.provider_operation_ids) element WHERE element.type<>'array')>16
  OR EXISTS(SELECT 1 FROM json_tree(stored.provider_operation_ids) element WHERE element.type NOT IN ('array','null')
    AND (element.type<>'text' OR length(element.value)<>36
      OR element.value NOT GLOB '????????-????-????-????-????????????'
      OR length(replace(element.value,'-',''))<>32
      OR replace(element.value,'-','') GLOB '*[^0-9a-f]*'))
));

CREATE TRIGGER project_database_compute_operation_ids_insert BEFORE INSERT ON project_database_compute_changes
WHEN NEW.provider_operation_ids IS NOT NULL AND (
  (SELECT count(*) FROM json_tree(NEW.provider_operation_ids) element WHERE element.type<>'array')>16
  OR EXISTS(SELECT 1 FROM json_tree(NEW.provider_operation_ids) element WHERE element.type NOT IN ('array','null')
    AND (element.type<>'text' OR length(element.value)<>36
      OR element.value NOT GLOB '????????-????-????-????-????????????'
      OR length(replace(element.value,'-',''))<>32
      OR replace(element.value,'-','') GLOB '*[^0-9a-f]*'))
)
BEGIN SELECT RAISE(ABORT,'Compute provider operation IDs must retain native UUID elements'); END;

CREATE TRIGGER project_database_compute_operation_ids_update BEFORE UPDATE ON project_database_compute_changes
WHEN NEW.provider_operation_ids IS NOT NULL AND (
  (SELECT count(*) FROM json_tree(NEW.provider_operation_ids) element WHERE element.type<>'array')>16
  OR EXISTS(SELECT 1 FROM json_tree(NEW.provider_operation_ids) element WHERE element.type NOT IN ('array','null')
    AND (element.type<>'text' OR length(element.value)<>36
      OR element.value NOT GLOB '????????-????-????-????-????????????'
      OR length(replace(element.value,'-',''))<>32
      OR replace(element.value,'-','') GLOB '*[^0-9a-f]*'))
)
BEGIN SELECT RAISE(ABORT,'Compute provider operation IDs must retain native UUID elements'); END;
