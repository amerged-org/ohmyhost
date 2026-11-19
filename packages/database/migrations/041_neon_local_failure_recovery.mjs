const FIXED_NEON_WORKER_VERSION = "a94eddd1-6d98-4f97-bae9-41b78a214578";
const FIXED_NEON_WORKER_DEPLOYED_AT = "2026-08-23T05:59:14.9508Z";

export function up(pgm) {
  pgm.createTable("neon_project_placement_local_failure_repairs", {
    organization_id: { type: "ulid", notNull: true },
    project_id: { type: "ulid", notNull: true },
    claim_id: { type: "ulid", notNull: true },
    previous_create_started_at: { type: "timestamptz", notNull: true },
    fixed_worker_version: { type: "uuid", notNull: true },
    repaired_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint(
    "neon_project_placement_local_failure_repairs",
    "neon_project_placement_local_failure_repairs_pkey",
    { primaryKey: ["organization_id", "project_id"] },
  );
  pgm.addConstraint(
    "neon_project_placement_local_failure_repairs",
    "neon_project_placement_local_failure_repairs_shape",
    {
      check: `fixed_worker_version='${FIXED_NEON_WORKER_VERSION}'::uuid
        AND repaired_at>=previous_create_started_at`,
    },
  );
  pgm.createTrigger(
    "neon_project_placement_local_failure_repairs",
    "neon_project_placement_local_failure_repairs_append_only",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "reject_append_only_change",
    },
  );
  pgm.sql(`INSERT INTO neon_project_placement_local_failure_repairs(
      organization_id,project_id,claim_id,previous_create_started_at,fixed_worker_version)
    SELECT reservation.organization_id,reservation.project_id,reservation.claim_id,
      reservation.create_started_at,'${FIXED_NEON_WORKER_VERSION}'::uuid
    FROM neon_project_placement_reservations reservation
    WHERE reservation.create_started_at IS NOT NULL
      AND reservation.create_started_at<'${FIXED_NEON_WORKER_DEPLOYED_AT}'::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM neon_project_placement_receipts receipt
        WHERE receipt.organization_id=reservation.organization_id
          AND receipt.project_id=reservation.project_id
      )`);
  replaceReservationGuardForRepair(pgm, true);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM neon_project_placement_local_failure_repairs repair
      LEFT JOIN neon_project_placement_reservations reservation
        ON reservation.organization_id=repair.organization_id
       AND reservation.project_id=repair.project_id
      LEFT JOIN neon_project_placement_receipts receipt
        ON receipt.organization_id=repair.organization_id AND receipt.project_id=repair.project_id
      WHERE reservation.create_started_at IS NOT NULL OR receipt.project_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'consumed Neon local-failure repair evidence prevents a lossless migration downgrade'
        USING ERRCODE='23514';
    END IF;
  END $$`);
  replaceReservationGuardForRepair(pgm, false);
  pgm.dropTable("neon_project_placement_local_failure_repairs");
}

function replaceReservationGuardForRepair(pgm, repairing) {
  pgm.dropTrigger(
    "neon_project_placement_reservations",
    "neon_project_placement_reservations_change_guard",
  );
  if (repairing) {
    pgm.sql(`UPDATE neon_project_placement_reservations reservation
      SET create_started_at=NULL
      FROM neon_project_placement_local_failure_repairs repair
      WHERE repair.organization_id=reservation.organization_id
        AND repair.project_id=reservation.project_id
        AND repair.claim_id=reservation.claim_id
        AND reservation.create_started_at=repair.previous_create_started_at`);
  } else {
    pgm.sql(`UPDATE neon_project_placement_reservations reservation
      SET create_started_at=repair.previous_create_started_at
      FROM neon_project_placement_local_failure_repairs repair
      WHERE repair.organization_id=reservation.organization_id
        AND repair.project_id=reservation.project_id
        AND repair.claim_id=reservation.claim_id
        AND reservation.create_started_at IS NULL`);
  }
  pgm.createTrigger(
    "neon_project_placement_reservations",
    "neon_project_placement_reservations_change_guard",
    {
      when: "BEFORE",
      operation: ["UPDATE", "DELETE"],
      level: "ROW",
      function: "guard_neon_project_placement_reservation_change",
    },
  );
}
