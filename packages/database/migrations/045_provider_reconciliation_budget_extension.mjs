import {
  replaceAttemptConstraint,
  replaceObservationConstraint,
} from "./043_provider_reconciliation_attempt_budget.mjs";

const PREVIOUS_ATTEMPTS = 20;
const PREVIOUS_MAXIMUM = 24;
const CURRENT_ATTEMPTS = 32;
const HISTORICAL_INCIDENT_CUTOFF = "2026-08-23T08:00:00.000Z";

export function up(pgm) {
  replaceObservationConstraint(pgm, CURRENT_ATTEMPTS);
  replaceAttemptConstraint(pgm, CURRENT_ATTEMPTS);
}

export function down(pgm) {
  pgm.sql(`DO $$ BEGIN IF EXISTS (
    SELECT 1 FROM product_provider_reconciliation_attempts
      WHERE attempt_number>${PREVIOUS_ATTEMPTS}
        AND created_at>='${HISTORICAL_INCIDENT_CUTOFF}'::timestamptz
    UNION ALL
    SELECT 1 FROM product_provider_mutation_observations
      WHERE attempt_number>${PREVIOUS_ATTEMPTS}
        AND created_at>='${HISTORICAL_INCIDENT_CUTOFF}'::timestamptz
  ) THEN RAISE EXCEPTION 'extended provider reconciliation evidence prevents a lossless migration downgrade'
    USING ERRCODE='23514'; END IF; END $$`);
  const historicalCheck = `AND (attempt_number<=${PREVIOUS_ATTEMPTS}
          OR created_at<'${HISTORICAL_INCIDENT_CUTOFF}'::timestamptz)`;
  replaceObservationConstraint(pgm, PREVIOUS_MAXIMUM, historicalCheck);
  replaceAttemptConstraint(pgm, PREVIOUS_MAXIMUM, historicalCheck);
}
