import { CommandConflictError } from "../../run-command.js";

/** The job conflicts with its stored scope or state (the PostgreSQL `ProjectRecoveryConflictError`). */
export class ProjectRecoveryConflictError extends CommandConflictError {
  constructor() {
    super("project_recovery_conflict", "Project recovery conflicts with its stored scope or state");
    this.name = "ProjectRecoveryConflictError";
  }
}

/** One export per project in a rolling 24-hour period. */
export class ProjectRecoveryDailyLimitError extends CommandConflictError {
  constructor(readonly retryAt: string) {
    super(
      "project_recovery_daily_limit",
      "One export per project is allowed in a rolling 24-hour period",
    );
    this.name = "ProjectRecoveryDailyLimitError";
  }
}

/** Another live holder owns the project's capture fence. Nothing was changed. */
export class RecoverySourceBusyError extends CommandConflictError {
  constructor() {
    super("recovery_source_busy", "Another recovery capture holds this project");
    this.name = "RecoverySourceBusyError";
  }
}

/** The project is no longer an active, owned project of the organization. */
export class RecoveryScopeUnavailableError extends CommandConflictError {
  constructor() {
    super("recovery_scope_unavailable", "The project is no longer available for recovery");
    this.name = "RecoveryScopeUnavailableError";
  }
}

/** The caller's fence epoch, holder or lease is no longer the project's current one: its work must stop. */
export class RecoveryFenceLostError extends CommandConflictError {
  constructor() {
    super("recovery_fence_lost", "The recovery fence lease was lost or its source changed");
    this.name = "RecoveryFenceLostError";
  }
}
