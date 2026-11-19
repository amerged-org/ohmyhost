/** The closed onboarding error set; its own module so the private handler can map it without importing the flow. */
export class OrganizationOnboardingError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "idempotency_key_reused"
      | "forbidden"
      | "service_unavailable",
  ) {
    super(code);
    this.name = "OrganizationOnboardingError";
  }
}
