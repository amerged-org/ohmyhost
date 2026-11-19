import { ManagedMailPortError } from "./managed-mail.js";

/** Authorized public management calls; every implementation rechecks live persistence scope. */
export interface SharedMailPort {
  listWorkspaceMailDomains(input: SharedMailScope): Promise<unknown>;
  createWorkspaceMailDomain(
    input: SharedMailScope & SharedMailMutation & { domain: string; sending: true },
  ): Promise<unknown>;
  readWorkspaceMailDomain(input: SharedMailScope & { mailDomainId: string }): Promise<unknown>;
  retireWorkspaceMailDomain(
    input: SharedMailScope &
      SharedMailMutation & { mailDomainId: string; expectedRevision: number },
  ): Promise<unknown>;
  readProjectMailDomainBinding(input: SharedMailProjectScope): Promise<unknown>;
  putProjectMailDomainBinding(
    input: SharedMailProjectScope &
      SharedMailMutation & {
        mailDomainId: string;
        expectedRevision: number;
        sending: boolean;
        senderAddresses: readonly string[];
        defaultFrom: string;
        defaultReplyTo: string | null;
      },
  ): Promise<unknown>;
  detachProjectMailDomainBinding(
    input: SharedMailProjectScope & SharedMailMutation & { expectedRevision: number },
  ): Promise<unknown>;
}
export interface SharedMailIdentityPort {
  readApplicationDomainIdentity(input: SharedMailScope & { projectId: string }): Promise<unknown>;
  declareApplicationDomainIdentity(
    input: SharedMailScope & SharedMailMutation & { projectId: string; hostname: string },
  ): Promise<unknown>;
  verifyApplicationDomainIdentity(
    input: SharedMailScope & SharedMailMutation & { projectId: string; expectedRevision: number },
  ): Promise<unknown>;
  revokeApplicationDomainIdentity(
    input: SharedMailScope & SharedMailMutation & { projectId: string; expectedRevision: number },
  ): Promise<unknown>;
  beginApplicationIdentityAuthorization(
    input: SharedMailScope &
      SharedMailMutation & { projectId: string; expectedRevision: number; zone: string },
  ): Promise<unknown>;
  revokeApplicationIdentityAuthorization(
    input: SharedMailScope & SharedMailMutation & { projectId: string; expectedRevision: number },
  ): Promise<unknown>;
  revokeWorkspaceMailAuthorization(
    input: SharedMailScope &
      SharedMailMutation & { mailDomainId: string; expectedRevision: number },
  ): Promise<unknown>;
  getApplicationIdentityAuthorizationStatus(
    input: SharedMailScope & { projectId: string },
  ): Promise<unknown>;
  beginWorkspaceMailAuthorization(
    input: SharedMailScope &
      SharedMailMutation & { mailDomainId: string; expectedRevision: number; zone: string },
  ): Promise<unknown>;
  getWorkspaceMailAuthorizationStatus(
    input: SharedMailScope & { mailDomainId: string },
  ): Promise<unknown>;
}
export interface SharedMailScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly delegation?: {
    readonly grantId: string;
    readonly clientId: string;
    readonly consentHash: string;
    readonly grantRevision?: number;
  };
}
export interface SharedMailProjectScope extends SharedMailScope {
  readonly projectId: string;
  readonly environmentId: string;
}
export interface SharedMailMutation {
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
}

/** Only reviewed problem codes can cross the private service boundary. */
export function sharedMailError(error: unknown): ManagedMailPortError {
  if (error instanceof ManagedMailPortError) return error;
  const message = error instanceof Error ? error.message : "";
  if (
    message === "paid_plan_required" ||
    message === "insufficient_organization_credits" ||
    message === "project_budget_exceeded"
  )
    return new ManagedMailPortError(
      402,
      message,
      "Managed mail requires Paid access and sufficient project credits.",
    );
  if (message === "mail_dns_authorization_required")
    return new ManagedMailPortError(
      409,
      "mail_domain_conflict",
      "Domain removal is waiting for authorization to remove its recorded Cloudflare DNS records. Request DNS authorization for this workspace sender and repeat the original retirement request with the same idempotency key.",
    );
  if (message === "mail_dns_receipt_changed")
    return new ManagedMailPortError(
      409,
      "mail_domain_conflict",
      "The recorded mail DNS records changed. Domain removal remains pending; read the sender's DNS state and reconcile its exact ownership receipts before retrying.",
    );
  if (message === "mail_provider_capacity_reached")
    return new ManagedMailPortError(
      503,
      "mail_capacity_unavailable",
      "Mail setup is stored but the provider currently has no capacity. Retain the original idempotency key and read mail status.",
      true,
    );
  if (
    [
      "mail_scope_unavailable",
      "mail_domain_not_found",
      "application_identity_not_found",
      "dns_resource_unavailable",
      "dns_authority_revoked",
    ].includes(message)
  )
    return new ManagedMailPortError(404, "resource_not_found", "Resource not found.");
  if (message === "mail_domain_pending_limit")
    return new ManagedMailPortError(
      409,
      "mail_domain_pending_limit",
      "This organization already holds the maximum number of unverified workspace mail domains. Verify or retire one before adding another.",
    );
  // Retirement waits for the bindings to be detached and for the sends of the last 24 hours to settle.
  if (message === "mail_domain_in_use")
    return new ManagedMailPortError(
      409,
      "mail_domain_conflict",
      "This workspace mail domain still has bindings, receiving or sends that can still settle. Detach the bindings, then retire it once the sends of the last 24 hours have settled.",
    );
  if (
    [
      "mail_domain_mismatch",
      "application_identity_required",
      "application_identity_stale",
      "mail_domain_conflict",
      "mail_binding_revision_conflict",
      "mail_resource_revision_conflict",
      "application_identity_revision_conflict",
      "mail_identity_revision_conflict",
      "application_identity_dns_pending",
      "dns_resource_stale",
      "authorization_closed",
      "authorization_pending",
    ].includes(message)
  )
    return new ManagedMailPortError(
      409,
      "mail_domain_conflict",
      message === "mail_domain_mismatch"
        ? "The sender and verified application must have the same registrable main domain."
        : "The mail resource, binding or current application-domain proof changed. Read its current state before a new request.",
    );
  if (message === "idempotency_key_reused" || message === "idempotency_conflict")
    return new ManagedMailPortError(
      409,
      "idempotency_key_reused",
      "This key already identifies another request.",
    );
  // The Core's schema refused a field or the key of the request: the caller must change it, a retry cannot succeed.
  if (message === "Invalid mail input")
    return new ManagedMailPortError(
      400,
      "invalid_request",
      "The mail request fields or Idempotency-Key do not match the documented format.",
    );
  if (
    [
      "Invalid mail configuration",
      "A customer mail domain is required",
      "Invalid domain configuration",
      "invalid_sender_address",
      "invalid_application_hostname",
      "invalid_sender_settings",
      "Invalid mail domain identity",
      "Mail domain requires a registrable public domain",
      "A customer application domain is required",
      "Sender addresses must use the exact verified mail domain",
      "Invalid sender local part",
      "Default sender must be allowed",
      "Invalid mail address",
    ].includes(message)
  )
    return new ManagedMailPortError(
      400,
      "invalid_request",
      "Use a canonical domain, exact sender addresses and a valid Reply-To mailbox.",
    );
  return new ManagedMailPortError(
    503,
    "service_unavailable",
    "Mail management is temporarily unavailable. Retain the same request and idempotency key.",
    true,
  );
}
