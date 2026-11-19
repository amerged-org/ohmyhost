/** The closed persistence port of organization onboarding; `d1-onboarding-port.ts` implements it over the WorkosRuntime. */
export interface OnboardingRequest {
  readonly initial?: boolean;
  readonly userId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly signupSource: string;
  readonly idempotencyKey: string;
}
export interface OnboardingRequestRow {
  readonly request_id: string;
  readonly request_sha256: Buffer;
  readonly name: string;
  readonly signup_source: string;
  readonly workos_organization_id: string | null;
  readonly organization_id: string | null;
}
export interface OnboardingPrepareInput {
  readonly request: OnboardingRequest;
  readonly proposedRequestId?: string;
  readonly now: string;
}
export interface OnboardingCompleteInput {
  readonly request: OnboardingRequest;
  readonly requestId: string;
  readonly workosOrganizationId: string;
  readonly membershipUpdatedAt: string;
  readonly referralGrantId?: string;
  readonly now: string;
}
export interface OrganizationOnboardingPersistence {
  isSessionEligible(input: {
    sessionId: string;
    workosUserId: string;
    workosOrganizationId: null;
    observedAt: string;
  }): Promise<boolean>;
  prepare(
    input: OnboardingPrepareInput,
  ): Promise<{ request: OnboardingRequest; row: OnboardingRequestRow }>;
  claimOrganization(requestId: string, userId: string): Promise<boolean>;
  recordOrganization(
    requestId: string,
    userId: string,
    workosOrganizationId: string,
  ): Promise<void>;
  claimMembership(requestId: string, userId: string): Promise<boolean>;
  complete(input: OnboardingCompleteInput): Promise<{ id: string; name: string }>;
}
