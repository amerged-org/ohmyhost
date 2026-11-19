// A running operation had no bound at all. One project admits a single open provider-mutation claim
// and the outbox skips every event of a project holding one, so a workflow that died without
// terminalizing its operation locked that project silently: on 2026-09-18 operation
// 01M2SNS1GBVA11N7WFAE7DEBWQ sat running for about six hours while every later deployment queued
// behind it and nothing errored. The outbox already carries exactly this protection as
// lease_expires_at; operations gain the same field so a dead workflow becomes a visible failure
// rather than a permanent lock.
export function up(pgm) {
  pgm.addColumn("operations", { lease_expires_at: { type: "timestamptz" } });
  pgm.addConstraint("operations", "operations_lease_shape", {
    check: "lease_expires_at IS NULL OR state IN ('queued','running')",
  });
  pgm.createIndex("operations", ["lease_expires_at"], {
    name: "operations_expired_lease_idx",
    where: "lease_expires_at IS NOT NULL",
  });
}

export function down(pgm) {
  pgm.dropIndex("operations", ["lease_expires_at"], { name: "operations_expired_lease_idx" });
  pgm.dropConstraint("operations", "operations_lease_shape");
  pgm.dropColumn("operations", "lease_expires_at");
}
