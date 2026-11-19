import type { WfpEgressContext } from "@ohmyhost/contracts/wfp-dispatch";

import type { FunctionsSchedulerRuntimeBinding } from "./persistence.js";

/** Dynamic Dispatch to the customer script that owns the declared crons. */
export interface CustomerDispatchBinding {
  get(
    scriptName: string,
    args: Record<string, never>,
    options: Readonly<{
      limits: Readonly<{ cpuMs: number; subRequests: number }>;
      outbound: Readonly<{ EGRESS_CONTEXT: WfpEgressContext }>;
    }>,
  ): { fetch(request: Request): Promise<Response> };
}

export interface SchedulerBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly CUSTOMER_DISPATCH: CustomerDispatchBinding;
  readonly CONTROL_FUNCTIONS_RUNTIME: FunctionsSchedulerRuntimeBinding;
}

export function requireSchedulerBindings(value: unknown): SchedulerBindings {
  if (!isRecord(value) || value["RUNTIME_CONFIGURATION_STATE"] !== "configured") {
    throw new TypeError("Functions scheduler runtime is not configured");
  }
  // A direct Core database binding next to the capability would be a second authority.
  if (
    Object.getOwnPropertyNames(value).some(
      (name) =>
        name === "CONTROL_CORE" ||
        name === "CONTROL_GLOBAL" ||
        name === "CONTROL_DIRECTORY" ||
        /^CONTROL_SHARD_/u.test(name),
    )
  )
    throw new TypeError("Functions scheduler authority is ambiguous");
  const dispatch = value["CUSTOMER_DISPATCH"];
  if (!isRecord(dispatch) || typeof dispatch["get"] !== "function") {
    throw new TypeError("Functions scheduler requires Dynamic Dispatch");
  }
  const runtime = value["CONTROL_FUNCTIONS_RUNTIME"];
  if (
    !isRecord(runtime) ||
    ["readSchedules", "insertDueRuns", "claimRuns", "finishRun", "purgeFinishedRuns"].some(
      (method) => typeof runtime[method] !== "function",
    )
  )
    throw new TypeError("Functions scheduler Core capability is unavailable");
  return Object.freeze({
    RUNTIME_CONFIGURATION_STATE: "configured",
    CUSTOMER_DISPATCH: dispatch as unknown as CustomerDispatchBinding,
    CONTROL_FUNCTIONS_RUNTIME: runtime as unknown as FunctionsSchedulerRuntimeBinding,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
