// A callback that ended the authorization for good left no reason behind: expiry, a dead session,
// an unknown state and an outright denial all became a bare 'failed' row, and the customer read the
// same sentence for each. These reasons are terminal, unlike the four in migration 130 that keep the
// authorization open, so the shape check has to allow them on a failed row as well.
const RESUMABLE =
  "'repository_not_installed','repository_access_required','authorization_code_rejected','provider_unavailable'";
const TERMINAL = "'expired','session_inactive','denied','code_spent'";

export function up(pgm) {
  pgm.dropConstraint(
    "github_source_authorizations",
    "github_source_authorizations_last_failure_shape",
  );
  pgm.addConstraint(
    "github_source_authorizations",
    "github_source_authorizations_last_failure_shape",
    { check: `last_failure IS NULL OR last_failure IN (${RESUMABLE},${TERMINAL})` },
  );
}

export function down(pgm) {
  pgm.sql(
    `UPDATE github_source_authorizations SET last_failure=NULL WHERE last_failure IN (${TERMINAL})`,
  );
  pgm.dropConstraint(
    "github_source_authorizations",
    "github_source_authorizations_last_failure_shape",
  );
  pgm.addConstraint(
    "github_source_authorizations",
    "github_source_authorizations_last_failure_shape",
    { check: `last_failure IS NULL OR last_failure IN (${RESUMABLE})` },
  );
}
