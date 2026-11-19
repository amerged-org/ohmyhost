-- CORE-07: a pending registration reservation of an operation that failed and never registered can never become a receipt:
-- every registration needs the operation's provider mutation claim, and a failed operation's claim is deleted with it. Such a
-- reservation still blocked every later registration of the database. The reservation command now supersedes it once the failure
-- is seven days older than the claim it reserves under (registration.ts). This trigger admits exactly that deletion: a reservation
-- backed by its exact receipt (unchanged), or a reservation of a failed operation whose provider mutation claim is gone. A reservation
-- of an open or succeeded operation still never leaves.
DROP TRIGGER project_database_registration_reservations_delete_after_receipt;
CREATE TRIGGER project_database_registration_reservations_delete_after_receipt BEFORE DELETE ON project_database_registration_reservations
  WHEN NOT (
    EXISTS (SELECT 1 FROM project_database_registration_receipts receipt WHERE receipt.organization_id = OLD.organization_id AND receipt.project_id = OLD.project_id AND receipt.physical_environment_id = OLD.physical_environment_id AND receipt.registration_version = OLD.registration_version AND receipt.metadata = OLD.metadata)
    OR (EXISTS (SELECT 1 FROM operations failed WHERE failed.organization_id = OLD.organization_id AND failed.operation_id = OLD.operation_id AND failed.state = 'failed')
      AND NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims claim WHERE claim.organization_id = OLD.organization_id AND claim.operation_id = OLD.operation_id))
  )
BEGIN SELECT RAISE(ABORT, 'a registration reservation is deleted only after its receipt exists or its failed operation released its claim'); END;
