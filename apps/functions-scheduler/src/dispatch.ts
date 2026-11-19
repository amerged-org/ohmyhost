import { buildEgressContext, WFP_DISPATCH_LIMITS } from "@ohmyhost/contracts/wfp-dispatch";
import type { ClaimedFunctionRun } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";

import type { CustomerDispatchBinding } from "./bindings.js";

export const SCHEDULED_ORIGIN = "https://scheduled.ohmyhost.internal";
export const SCHEDULED_PATH = "/.ohmyhost/scheduled";
/** The customer's scheduled handler may run for two minutes before the attempt fails. */
export const SCHEDULED_TIMEOUT_MILLISECONDS = 120_000;

export type DispatchOutcome = Readonly<
  | { readonly outcome: "succeeded"; readonly statusCode: 204 }
  | { readonly outcome: "failed"; readonly statusCode: number | null }
  | { readonly outcome: "rejected"; readonly statusCode: number }
>;

export interface ScheduledDispatchPort {
  execute(run: ClaimedFunctionRun): Promise<DispatchOutcome>;
}

/**
 * Invokes the platform wrapper of the immutable script on its internal scheduler origin.
 * 204 succeeds; 429, 5xx (except the wrapper's 501 "no handler") and transport failures fail
 * with a retry; every other status is rejected without further attempts.
 */
export function createScheduledDispatch(
  dispatch: CustomerDispatchBinding,
  timeoutMilliseconds: number = SCHEDULED_TIMEOUT_MILLISECONDS,
): ScheduledDispatchPort {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new TypeError("Scheduled dispatch timeout is invalid");
  }
  const port: ScheduledDispatchPort = {
    execute: async (run) => {
      let projectId: string;
      let deploymentId: string;
      try {
        projectId = parseUlid(run.projectId).toLowerCase();
        deploymentId = parseUlid(run.deploymentId).toLowerCase();
      } catch {
        return Object.freeze({ outcome: "rejected", statusCode: 400 });
      }
      // The record has no independent environment name; assert the project/deployment pairing
      // and the closed environment label before granting this script the project's egress scope.
      if (
        run.immutableScriptName !== `p-${projectId}-dev-${deploymentId}` &&
        run.immutableScriptName !== `p-${projectId}-prod-${deploymentId}`
      )
        return Object.freeze({ outcome: "rejected", statusCode: 400 });
      const script = dispatch.get(
        run.immutableScriptName,
        {},
        {
          // The limits of the public gateway; CPU is metered by the WFP usage meters.
          limits: WFP_DISPATCH_LIMITS,
          outbound: { EGRESS_CONTEXT: buildEgressContext(run.projectId, run.egressAllowedOrigins) },
        },
      );
      let response: Response;
      try {
        response = await script.fetch(
          new Request(`${SCHEDULED_ORIGIN}${SCHEDULED_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              cron: run.cron,
              scheduledTime: Date.parse(run.scheduledAt),
              immutableScriptName: run.immutableScriptName,
            }),
            signal: AbortSignal.timeout(timeoutMilliseconds),
          }),
        );
      } catch {
        return Object.freeze({ outcome: "failed", statusCode: null });
      }
      if (response.status === 204) return Object.freeze({ outcome: "succeeded", statusCode: 204 });
      if (isRetryable(response.status)) {
        return Object.freeze({ outcome: "failed", statusCode: response.status });
      }
      return Object.freeze({ outcome: "rejected", statusCode: response.status });
    },
  };
  return Object.freeze(port);
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}
