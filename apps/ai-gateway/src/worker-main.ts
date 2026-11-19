import {
  createUlidFactory,
  SystemClock,
  SystemEntropy,
  type AiGatewayRuntime,
} from "@ohmyhost/platform";
import { createAiGateway, type AiGateway, type Limiter, type WaitUntilContext } from "./gateway.js";
import { warnLine } from "./log.js";
import { aiError } from "./responses.js";

/*
 * The Worker only wires its environment into the gateway: the Core binding AI_RUNTIME, the project limiter, the
 * address limiter, the orq key (the Worker secret ORQ_API_KEY) and the orq address. A missing binding or secret
 * answers 503 ai_unavailable on every request and fails the sweep, so a half-configured Worker never calls orq.
 */

const RUNTIME_METHODS = ["authorizeKey", "admit", "settle", "release", "sweep"] as const;
const ids = createUlidFactory({ clock: new SystemClock(), entropy: new SystemEntropy() });

function field(raw: unknown, name: string): unknown {
  return typeof raw === "object" && raw !== null ? Reflect.get(raw, name) : undefined;
}

function hasMethods(binding: unknown, methods: readonly string[]): boolean {
  return (
    typeof binding === "object" &&
    binding !== null &&
    methods.every((method) => typeof Reflect.get(binding, method) === "function")
  );
}

function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The gateway for this environment, or `null` when a binding, the secret or the orq address is missing or inconsistent. */
export function gatewayFromEnvironment(env: unknown): AiGateway | null {
  const runtime = field(env, "AI_RUNTIME");
  const limiter = field(env, "PROJECT_LIMITER");
  const authLimiter = field(env, "AUTH_LIMITER");
  const apiKey = field(env, "ORQ_API_KEY");
  const baseUrl = field(env, "ORQ_BASE_URL");
  const baseOrigin = originOf(baseUrl);
  if (
    !hasMethods(runtime, RUNTIME_METHODS) ||
    !hasMethods(limiter, ["limit"]) ||
    !hasMethods(authLimiter, ["limit"]) ||
    typeof apiKey !== "string" ||
    apiKey.length === 0 ||
    typeof baseUrl !== "string" ||
    baseOrigin === null ||
    baseOrigin !== originOf(field(env, "ORQ_ORIGIN"))
  )
    return null;
  return createAiGateway({
    runtime: runtime as AiGatewayRuntime,
    orq: { fetch: (url, init) => fetch(url, init), apiKey, baseUrl },
    limiter: limiter as Limiter,
    authLimiter: authLimiter as Limiter,
    newReservationId: () => ids.next(),
    wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: WaitUntilContext): Promise<Response> {
    const gateway = gatewayFromEnvironment(env);
    if (gateway === null) {
      warnLine("ai_gateway_outcome", { outcome: "unconfigured" });
      return aiError("ai_unavailable", "The AI gateway is unavailable right now.");
    }
    return gateway.fetch(request, ctx);
  },
  async scheduled(_controller: unknown, env: unknown): Promise<void> {
    const gateway = gatewayFromEnvironment(env);
    if (gateway === null) {
      warnLine("ai_gateway_sweep", { outcome: "sweep_failed" });
      throw new Error("ai_gateway_unconfigured");
    }
    await gateway.scheduled();
  },
};
