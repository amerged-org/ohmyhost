export { BrowserSettlementJournal } from "./journal.js";
import {
  createUlidFactory,
  SystemClock,
  SystemEntropy,
  type BrowserGatewayRuntime,
} from "@ohmyhost/platform";
import {
  createBrowserGateway,
  type BrowserBinding,
  type BrowserGateway,
  type Limiter,
  type WaitUntilContext,
} from "./gateway.js";

const ids = createUlidFactory({ clock: new SystemClock(), entropy: new SystemEntropy() });
function field(object: unknown, name: string): unknown {
  return typeof object === "object" && object !== null ? Reflect.get(object, name) : undefined;
}
function hasMethods(object: unknown, names: readonly string[]): boolean {
  return (
    typeof object === "object" &&
    object !== null &&
    names.every((name) => typeof Reflect.get(object, name) === "function")
  );
}
export function gatewayFromEnvironment(env: unknown): BrowserGateway | null {
  const journal = field(env, "BROWSER_SETTLEMENT_JOURNAL");
  const runtime = field(env, "BROWSER_RUNTIME"),
    browser = field(env, "BROWSER"),
    limiter = field(env, "PROJECT_LIMITER"),
    authLimiter = field(env, "AUTH_LIMITER");
  if (
    !hasMethods(runtime, ["authorizeKey", "admit", "settle", "release", "sweep"]) ||
    !hasMethods(browser, ["quickAction"]) ||
    !hasMethods(journal, ["getByName"]) ||
    !hasMethods(limiter, ["limit"]) ||
    !hasMethods(authLimiter, ["limit"])
  )
    return null;
  return createBrowserGateway({
    runtime: runtime as BrowserGatewayRuntime,
    browser: browser as BrowserBinding,
    journal: {
      record: (input) =>
        (journal as { getByName(name: string): { record(value: unknown): Promise<void> } })
          .getByName(input.reservationId)
          .record(input),
    },
    limiter: limiter as Limiter,
    authLimiter: authLimiter as Limiter,
    newReservationId: () => ids.next(),
  });
}
export default {
  async fetch(request: Request, env: unknown, ctx: WaitUntilContext): Promise<Response> {
    const gateway = gatewayFromEnvironment(env);
    return gateway === null
      ? Response.json(
          { error: { code: "browser_unavailable" } },
          { status: 503, headers: { "cache-control": "no-store" } },
        )
      : gateway.fetch(request, ctx);
  },
  async scheduled(_controller: unknown, env: unknown): Promise<void> {
    const gateway = gatewayFromEnvironment(env);
    if (gateway === null) throw new Error("browser_gateway_unconfigured");
    await gateway.scheduled();
  },
};
