import {
  parseWorkosSessionStatusRequest,
  parseWorkosSessionStatusResponse,
  type WorkosSessionStatusResponse,
} from "@ohmyhost/workos-auth-contracts";

import type {
  CandidateClock,
  WorkloadIdentitySecretResolver,
  WorkosManagementDatabase,
  WorkosSessionTransport,
} from "./ports.js";

export interface WorkosSessionStatusChecker {
  check(value: unknown): Promise<WorkosSessionStatusResponse>;
}

/** A provider `active: true` answer is reused for this long; local eligibility is read on every check. */
export const WORKOS_SESSION_ANSWER_TTL_MS = 20_000;
export const WORKOS_SESSION_ANSWER_LIMIT = 10_000;

/**
 * Shared by every request of one Worker isolate, so it is created above the per-request runtime. Keyed by the exact
 * session identity and its token expiry; the pending promise is kept too, so concurrent misses share one provider call.
 */
export type WorkosSessionAnswerCache = Map<
  string,
  { readonly expiresAt: number; readonly active: Promise<boolean> }
>;

export function createWorkosSessionStatusChecker(input: {
  readonly clock: CandidateClock;
  readonly database: WorkosManagementDatabase;
  readonly resolver: WorkloadIdentitySecretResolver;
  readonly transport: WorkosSessionTransport;
  readonly answerCache: WorkosSessionAnswerCache;
}): WorkosSessionStatusChecker {
  const providerAnswer = (key: string, now: number, ask: () => Promise<boolean>) => {
    const cached = input.answerCache.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.active;
    // Only a true answer stays: a false or an error leaves the cache as soon as it settles, and nothing is served stale.
    const active = ask().then(
      (answer) => {
        if (!answer) input.answerCache.delete(key);
        return answer;
      },
      (error: unknown) => {
        input.answerCache.delete(key);
        throw error;
      },
    );
    if (input.answerCache.size >= WORKOS_SESSION_ANSWER_LIMIT && !input.answerCache.has(key)) {
      const oldest = input.answerCache.keys().next();
      if (!oldest.done) input.answerCache.delete(oldest.value);
    }
    input.answerCache.set(key, { expiresAt: now + WORKOS_SESSION_ANSWER_TTL_MS, active });
    return active;
  };
  return {
    async check(value) {
      const request = parseWorkosSessionStatusRequest(value);
      const observedAt = input.clock.now();
      const eligible = await input.database.isSessionEligible({
        sessionId: request.sessionId,
        workosUserId: request.userId,
        workosOrganizationId: request.organizationId,
        observedAt: observedAt.toISOString(),
      });
      // The access token that opened this session lives minutes; the session itself lives hours.
      // Reading an expired token as an ended session cut customer flows short while their session
      // was still valid, so the provider decides, and the token expiry stays only as the lower
      // bound the provider check compares the session's own expiry against.
      if (!eligible) {
        return parseWorkosSessionStatusResponse({ active: false });
      }
      const active = await providerAnswer(
        JSON.stringify([
          request.sessionId,
          request.userId,
          request.organizationId,
          request.tokenExpiresAt,
        ]),
        observedAt.getTime(),
        () =>
          input.resolver.withWorkosManagementCredential((credential) =>
            input.transport.isSessionActive(credential, request),
          ),
      );
      return parseWorkosSessionStatusResponse({ active });
    },
  };
}
