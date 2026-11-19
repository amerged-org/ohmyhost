export type DiagnosticSource = "build" | "control" | "runtime" | "function";
export const DEPLOYMENT_DIAGNOSTIC_CATALOG = Object.freeze({
  BUILD_NOT_STARTED: "PLATFORM_BUILD_NOT_STARTED",
  BUILD_FAILED: "CUSTOMER_BUILD_FAILED",
  CONTROL_FAILED: "CONTROL_OPERATION_FAILED",
  WFP_CANDIDATE_OUTDATED: "FINISH_CANDIDATE_RECONCILIATION_THEN_REDEPLOY_CURRENT_SOURCE",
  // The item carries no cause of its own; the failed operation's error names it and its fix.
  DEPLOYMENT_FAILED: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
  FUNCTION_FAILED: "CUSTOMER_FUNCTION_FAILED",
  HEALTH_CHECK_FAILED: "CUSTOMER_HEALTH_CHECK_FAILED",
  RUNTIME_EXCEPTION: "CUSTOMER_RUNTIME_FAILED",
  RUNTIME_FAILED: "CUSTOMER_RUNTIME_FAILED",
} as const);
export type DeploymentDiagnosticCode = keyof typeof DEPLOYMENT_DIAGNOSTIC_CATALOG;
/** Why the migrations of a deployment were refused; the executor names the file where it can. */
export type DatabaseMigrationFailureReason =
  | "catalog_changed"
  | "execution_failed"
  | "ledger_conflict"
  | "not_admitted";
// A DATABASE_MIGRATION_FAILED item has one message per reason and names the file in `file`.
const DATABASE_MIGRATION_DIAGNOSTIC_MESSAGES: Readonly<
  Record<DatabaseMigrationFailureReason, string>
> = Object.freeze({
  catalog_changed: "MIGRATION_CHANGED_EXISTING_SCHEMA",
  execution_failed: "MIGRATION_EXECUTION_FAILED",
  ledger_conflict: "APPLIED_MIGRATION_CHANGED",
  not_admitted: "MIGRATION_SQL_NOT_ADMITTED",
});
/** Whether `message` is the catalog message of `code`; every reader and writer checks this. */
export function isDeploymentDiagnosticCatalogEntry(code: string, message: string): boolean {
  if (code === "DATABASE_MIGRATION_FAILED") {
    return Object.values(DATABASE_MIGRATION_DIAGNOSTIC_MESSAGES).includes(message);
  }
  return (
    Object.hasOwn(DEPLOYMENT_DIAGNOSTIC_CATALOG, code) &&
    DEPLOYMENT_DIAGNOSTIC_CATALOG[code as DeploymentDiagnosticCode] === message
  );
}
