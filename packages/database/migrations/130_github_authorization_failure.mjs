// A callback that failed for a reason the customer can still fix used to burn the authorization:
// the row went to 'failed', the browser was told to retry, and the link command then refused with
// github_authorization_required and demanded a new key. The reason is recorded here and such a row
// returns to 'pending', so reopening the same authorization link is the whole recovery.
const FAILURES =
  "'repository_not_installed','repository_access_required','authorization_code_rejected','provider_unavailable'";

export function up(pgm) {
  pgm.addColumn("github_source_authorizations", { last_failure: { type: "text" } });
  pgm.addConstraint(
    "github_source_authorizations",
    "github_source_authorizations_last_failure_shape",
    { check: `last_failure IS NULL OR last_failure IN (${FAILURES})` },
  );
}

export function down(pgm) {
  pgm.dropConstraint(
    "github_source_authorizations",
    "github_source_authorizations_last_failure_shape",
  );
  pgm.dropColumn("github_source_authorizations", "last_failure");
}
