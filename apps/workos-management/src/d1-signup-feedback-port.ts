import { requireControlRuntimeBinding } from "./d1-identity-port.js";
import type { SignupFeedbackClaimReader } from "./signup-feedback-recipient.js";

interface SignupFeedbackBinding {
  isSignupFeedbackClaim(input: { userId: string; claimToken: string }): Promise<boolean>;
}

/** Only a live, exact claim permits reading its WorkOS recipient. */
export function createD1SignupFeedbackClaimReader(runtime: unknown): SignupFeedbackClaimReader {
  const binding = requireControlRuntimeBinding(runtime) as unknown as SignupFeedbackBinding;
  return { isCurrent: (input) => binding.isSignupFeedbackClaim(input) };
}
