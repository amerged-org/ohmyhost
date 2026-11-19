export type GithubProviderErrorCode =
  | "archive_content_length_invalid"
  | "archive_content_length_mismatch"
  | "archive_stream_too_large"
  | "commit_sha_mismatch"
  | "github_authentication_failed"
  | "github_archive_commit_reconciliation_required"
  | "github_provider_contract_invalid"
  | "github_rate_limited"
  | "github_request_failed"
  | "github_request_timeout"
  | "github_result_uncertain"
  | "invalid_app_client_id"
  | "invalid_app_private_key"
  | "invalid_archive_limit"
  | "invalid_archive_timeout"
  | "invalid_clock"
  | "invalid_installation_id"
  | "invalid_installation_token"
  | "invalid_repository_id"
  | "invalid_repository_name"
  | "invalid_repository_owner"
  | "invalid_requested_sha"
  | "requested_commit_not_found"
  | "invalid_user_agent"
  | "invalid_user_authorization"
  | "invalid_webhook_body"
  | "invalid_webhook_delivery_id"
  | "invalid_webhook_event"
  | "invalid_webhook_configuration_timeout"
  | "invalid_webhook_payload"
  | "invalid_webhook_secret"
  | "invalid_webhook_signature"
  | "unsafe_archive_redirect"
  | "webhook_body_too_large";

export class GithubProviderInputError extends Error {
  public constructor(public readonly code: GithubProviderErrorCode) {
    super("GitHub provider input is invalid");
    this.name = "GithubProviderInputError";
  }
}

export class GithubProviderAuthenticationError extends Error {
  public constructor(
    public readonly code: GithubProviderErrorCode = "github_authentication_failed",
  ) {
    super("GitHub provider authentication failed");
    this.name = "GithubProviderAuthenticationError";
  }
}

/** GitHub answered 404 for the installation itself: the App is no longer installed there. */
export class GithubInstallationNotFoundError extends Error {
  public constructor() {
    super("GitHub installation was not found");
    this.name = "GithubInstallationNotFoundError";
  }
}

export class GithubProviderRateLimitError extends Error {
  public constructor(
    public readonly retryAfterSeconds?: number,
    public readonly code: GithubProviderErrorCode = "github_rate_limited",
  ) {
    super("GitHub provider rate limit reached");
    this.name = "GithubProviderRateLimitError";
  }
}

export class GithubProviderContractError extends Error {
  public constructor(
    public readonly code: GithubProviderErrorCode = "github_provider_contract_invalid",
  ) {
    super("GitHub provider response is invalid");
    this.name = "GithubProviderContractError";
  }
}

export class GithubProviderTransportError extends Error {
  public constructor(public readonly code: GithubProviderErrorCode = "github_request_failed") {
    super("GitHub provider request failed");
    this.name = "GithubProviderTransportError";
  }
}

export class GithubProviderUncertainError extends Error {
  public constructor(public readonly code: GithubProviderErrorCode = "github_result_uncertain") {
    super("GitHub provider operation result is uncertain");
    this.name = "GithubProviderUncertainError";
  }
}

export function classifyGithubResponse(response: Response, mutation: boolean): never {
  const retryAfter = response.headers.get("Retry-After");
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0")
  ) {
    const retryAfterSeconds =
      retryAfter !== null && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : undefined;
    throw new GithubProviderRateLimitError(
      retryAfterSeconds !== undefined && Number.isSafeInteger(retryAfterSeconds)
        ? retryAfterSeconds
        : undefined,
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new GithubProviderAuthenticationError();
  }
  if (mutation && response.status >= 500) {
    throw new GithubProviderUncertainError();
  }
  if (response.status >= 500) {
    throw new GithubProviderTransportError();
  }
  throw new GithubProviderContractError();
}
