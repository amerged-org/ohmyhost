/** Private services are called only after Control API organization/project/environment authorization. */
export interface ManagedMailDomainsBinding {
  configureMailDomain(input: unknown): Promise<unknown>;
  readMailDomain(input: unknown): Promise<unknown>;
  prepareMailWebhook(input: unknown): Promise<unknown>;
  verifyMailWebhook(input: unknown): Promise<unknown>;
  rotateMailWebhook(input: unknown): Promise<unknown>;
  disableMailReceiving(input: unknown): Promise<unknown>;
  deleteMailDomain(input: unknown): Promise<unknown>;
}
export interface ManagedMailDeliveryBinding {
  listMailMessages(input: unknown): Promise<unknown>;
  getMailMessage(input: unknown): Promise<unknown>;
  getMailAttachment(input: unknown): Promise<unknown>;
  retryMailMessage(input: unknown): Promise<unknown>;
}
export interface ManagedMailPort extends ManagedMailDomainsBinding, ManagedMailDeliveryBinding {}
export function createManagedMailPort(
  domains: ManagedMailDomainsBinding,
  delivery: ManagedMailDeliveryBinding,
): ManagedMailPort {
  return {
    configureMailDomain: (input) => safeCall(() => domains.configureMailDomain(input)),
    readMailDomain: (input) => safeCall(() => domains.readMailDomain(input)),
    prepareMailWebhook: (input) => safeCall(() => domains.prepareMailWebhook(input)),
    verifyMailWebhook: (input) => safeCall(() => domains.verifyMailWebhook(input)),
    rotateMailWebhook: (input) => safeCall(() => domains.rotateMailWebhook(input)),
    disableMailReceiving: (input) => safeCall(() => domains.disableMailReceiving(input)),
    deleteMailDomain: (input) => safeCall(() => domains.deleteMailDomain(input)),
    listMailMessages: (input) => safeCall(() => delivery.listMailMessages(input)),
    getMailMessage: (input) => safeCall(() => delivery.getMailMessage(input)),
    getMailAttachment: (input) => safeCall(() => delivery.getMailAttachment(input)),
    retryMailMessage: (input) => safeCall(() => delivery.retryMailMessage(input)),
  };
}

export class ManagedMailPortError extends Error {
  public constructor(
    public readonly status: 400 | 402 | 404 | 409 | 413 | 503,
    public readonly code:
      | "invalid_request"
      | "paid_plan_required"
      | "insufficient_organization_credits"
      | "project_budget_exceeded"
      | "resource_not_found"
      | "idempotency_key_reused"
      | "mail_domain_conflict"
      | "mail_domain_pending_limit"
      | "mail_capacity_unavailable"
      | "payload_too_large"
      | "service_unavailable",
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
async function safeCall(work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "mail_webhook_required")
      throw new ManagedMailPortError(
        400,
        "invalid_request",
        "Configure the customer webhook, install its signing secret and verify the endpoint before enabling receiving.",
      );
    if (message === "mail_webhook_verification_failed")
      throw new ManagedMailPortError(
        400,
        "invalid_request",
        "The webhook did not accept its signed test. Check the application route and signing secret, then verify again.",
      );
    // The mail runtime stores a key only in this charset; the general configuration text would misdirect the caller.
    if (message === "Invalid mail idempotency key")
      throw new ManagedMailPortError(
        400,
        "invalid_request",
        "The Idempotency-Key must be 1 to 128 characters of A-Z, a-z, 0-9, '.', '_', ':' or '-'.",
      );
    if (
      [
        "A customer mail domain is required",
        "Invalid domain configuration",
        "Invalid mail configuration",
        "Invalid mail input",
        "Invalid mail webhook",
        "Invalid webhook URL",
        "Invalid retry idempotency key",
      ].includes(message)
    )
      throw new ManagedMailPortError(
        400,
        "invalid_request",
        "The mail configuration is invalid. Use a canonical domain and a public HTTPS webhook.",
      );
    if (
      message === "paid_plan_required" ||
      message === "insufficient_organization_credits" ||
      message === "project_budget_exceeded"
    )
      throw new ManagedMailPortError(
        402,
        message,
        "Managed mail requires Paid access and sufficient project credits.",
      );
    if (message === "mail_retirement_pending")
      throw new ManagedMailPortError(
        409,
        "mail_domain_conflict",
        "A previous mail domain of this project or with this name is still being removed. Repeat the project's mail domain deletion, then set up mail again.",
        true,
      );
    if (message === "mail_domain_conflict" || message === "idempotency_key_reused")
      throw new ManagedMailPortError(
        409,
        message,
        "The mail request conflicts with the stored configuration or idempotency key.",
      );
    if (message === "mail_scope_unavailable")
      throw new ManagedMailPortError(404, "resource_not_found", "Resource not found.");
    if (message === "mail_attachment_too_large")
      throw new ManagedMailPortError(
        413,
        "payload_too_large",
        "This mail attachment exceeds the 50 MiB download limit.",
      );
    if (message === "mail_provider_capacity_reached")
      throw new ManagedMailPortError(
        503,
        "mail_capacity_unavailable",
        "Mail setup is blocked: ohmyho.st cannot register the domain with its mail provider right now. The setup is stored and continues automatically once capacity exists; no provider account is needed on your side.",
        true,
      );
    if (message === "mail_retirement_unverified")
      throw new ManagedMailPortError(
        503,
        "service_unavailable",
        "Mail is already off for this project, but removing its provider domain and sending key is not confirmed yet. Repeat the same request with the same idempotency key.",
        true,
      );
    if (message === "mail_operation_pending" || message === "mail_domain_creation_unresolved")
      throw new ManagedMailPortError(
        503,
        "service_unavailable",
        "Mail setup is still unresolved. Read mail status and retain the original idempotency key; do not create another domain.",
        true,
      );
    throw new ManagedMailPortError(
      503,
      "service_unavailable",
      "Mail is temporarily unavailable. Retry with the same request identity.",
      true,
    );
  }
}
