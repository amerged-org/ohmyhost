import type { WorkosManagementDatabase } from "./ports.js";
import type { WorkosSessionEligibilityPort } from "./identity-port.js";
import type { createD1WorkosPollerPort } from "./d1-poller-port.js";

/**
 * The management database: session eligibility and the inbox poller (claim, snapshot and
 * deletion apply with their exact acknowledgement, failure, recovery and the uncertain-snapshot revocation) are
 * typed WorkosRuntime commands. Onboarding and warning recipients use their own closed ports over that same
 * authority.
 */
export function createD1WorkosManagementDatabase(
  identity: WorkosSessionEligibilityPort,
  poller: ReturnType<typeof createD1WorkosPollerPort>,
): WorkosManagementDatabase {
  return {
    isSessionEligible: (input) => identity.isSessionEligible(input),
    ...poller,
  };
}
