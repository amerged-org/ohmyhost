export type CustomerRuntimeGatewayErrorCode =
  | "gateway_configuration_invalid"
  | "gateway_request_invalid"
  | "gateway_not_enabled"
  | "gateway_route_denied"
  | "gateway_rate_limited"
  | "gateway_response_invalid"
  | "gateway_timeout"
  | "gateway_unavailable"
  | "mail_content_expired"
  | "mail_attachment_too_large"
  | "mail_message_not_found"
  | "mail_rejected"
  | "mail_reputation_suspended"
  | "mail_send_conflict"
  | "mail_send_limit_exceeded"
  | "insufficient_organization_credits"
  | "paid_plan_required"
  | "project_budget_exceeded"
  | "storage_conflict"
  | "data_change_in_progress"
  | "storage_binding_data_changed"
  | "storage_delete_pending"
  | "storage_object_not_found"
  | "storage_quota_exceeded"
  | "storage_upload_expired"
  | "storage_upload_rejected"
  | "unauthorized";

export type CustomerRuntimeErrorCode =
  | CustomerRuntimeGatewayErrorCode
  | "database_binding_missing"
  | "database_query_invalid"
  | "database_response_invalid"
  | "database_rls_identity_invalid"
  | "database_rls_transaction_failed"
  | "database_transaction_outcome_unknown"
  | "database_unavailable"
  | "scheduled_context_invalid";

export class CustomerRuntimeError extends Error {
  /** The message starts with the stable code; a detail names the action, never a secret value. */
  public constructor(
    public readonly code: CustomerRuntimeErrorCode,
    public readonly retryable: boolean,
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "CustomerRuntimeError";
  }
}

/** A verified PostgreSQL statement failure, without SQL, row values or provider diagnostics. */
export class CustomerDatabaseError extends Error {
  public readonly retryable: boolean;

  public constructor(public readonly code: string) {
    super(`database_statement_failed: SQLSTATE ${code}`);
    if (!/^[0-9A-Z]{5}$/u.test(code)) throw new TypeError("Invalid SQLSTATE");
    this.name = "CustomerDatabaseError";
    this.retryable = code === "40001" || code === "40P01";
  }
}

export class CustomerRuntimeGatewayError extends CustomerRuntimeError {
  public constructor(
    code: CustomerRuntimeGatewayErrorCode,
    public readonly status: number | null,
    retryable: boolean,
    detail?: string,
  ) {
    super(code, retryable, detail);
    this.name = "CustomerRuntimeGatewayError";
  }
}
