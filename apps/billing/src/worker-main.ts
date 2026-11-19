import { WorkerEntrypoint } from "cloudflare:workers";
import { createGrowthPaymentReader } from "./growth-payment.js";
import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";
import { createStripeBillingProviderFromKey } from "@ohmyhost/provider-stripe";
import { BILLING_RUNTIME_METHODS, createD1BillingPersistence } from "./d1-persistence.js";
import {
  RECHARGE_RUNTIME_METHODS,
  createD1RechargePersistence,
  type RechargeRuntimeBinding,
} from "./d1-recharge-persistence.js";
import { createBillingRuntime } from "./runtime.js";
import { createBillingHandler } from "./http.js";

interface BillingBindings {
  readonly CONTROL_RUNTIME?: RechargeRuntimeBinding;
  readonly GROWTH_STRIPE_CUSTOMER_RUNTIME?: {
    resolveGrowthStripeCustomer(input: {
      customer_id: string;
    }): Promise<{ organization_id: string } | null>;
  };
  STRIPE_SECRET_KEY: string;
  STRIPE_ACCOUNT_ID: string;
  STRIPE_MODE: "test" | "live";
  STRIPE_PAID_PRICE_ID: string;
  STRIPE_TOPUP_PRICE_ID: string;
  STRIPE_PORTAL_CONFIGURATION_ID: string;
  BILLING_RETURN_ORIGIN: string;
}

/**
 * The Billing Worker has exactly one capability: the closed `BillingRuntime` of the Core. A binding that is missing, that
 * lacks a method, or that sits next to any other Control authority (a SQL URI, a database, a pool) is a misconfiguration
 * and fails before any Stripe call.
 */
async function withRuntime<T>(
  env: BillingBindings,
  execute: (billing: ReturnType<typeof createBillingRuntime>) => Promise<T>,
): Promise<T> {
  const runtime = env.CONTROL_RUNTIME;
  if (
    !runtime ||
    [...BILLING_RUNTIME_METHODS, ...RECHARGE_RUNTIME_METHODS].some(
      (method) => typeof runtime[method] !== "function",
    ) ||
    typeof env.STRIPE_SECRET_KEY !== "string" ||
    !["test", "live"].includes(env.STRIPE_MODE) ||
    !env.STRIPE_SECRET_KEY.startsWith(env.STRIPE_MODE === "test" ? "sk_test_" : "sk_live_") ||
    !env.STRIPE_PORTAL_CONFIGURATION_ID ||
    ["CONTROL_CORE", "CONTROL_GLOBAL"].some((name) => name in env) ||
    Object.keys(env).some((name) => /^CONTROL_SHARD_[0-9]+$/u.test(name))
  )
    throw new Error("billing_configuration_invalid");
  const configuration = {
    accountId: env.STRIPE_ACCOUNT_ID,
    mode: env.STRIPE_MODE,
    paidPriceId: env.STRIPE_PAID_PRICE_ID,
    topupPriceId: env.STRIPE_TOPUP_PRICE_ID,
  };
  const clock = new SystemClock();
  const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const persistence = createD1BillingPersistence(runtime, clock, ids);
  const rechargePersistence = createD1RechargePersistence(runtime, configuration, clock);
  // RPC stubs make absent remote methods look callable. This existing fixed-account read proves the
  // fixed Billing domain read and its exact receipt before provider catalog I/O; it mutates nothing.
  await rechargePersistence.candidates();
  const provider = await createStripeBillingProviderFromKey(env.STRIPE_SECRET_KEY, {
    ...configuration,
    returnOrigin: env.BILLING_RETURN_ORIGIN,
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID,
  });
  return execute(
    createBillingRuntime({ persistence, rechargePersistence, provider, configuration, clock, ids }),
  );
}

export function createBillingWorker() {
  return Object.freeze({
    async fetch(request: Request, env: BillingBindings) {
      if (new URL(request.url).hostname !== "billing.internal")
        return new Response(null, { status: 404 });
      try {
        return await withRuntime(env, (billing) => createBillingHandler(billing).fetch(request));
      } catch {
        return Response.json(
          { code: "billing_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    },
  });
}

/** Only the private Growth service receives this fixed provider read capability. */
export class GrowthPaymentService extends WorkerEntrypoint<BillingBindings> {
  async readGrowthOpenDisputePage(page: { cursor: string | null; limit: number }) {
    const mapping = this.env.GROWTH_STRIPE_CUSTOMER_RUNTIME;
    if (!mapping) throw new Error("stripe_growth_mapping_unavailable");
    return createGrowthPaymentReader({
      credential: this.env.STRIPE_SECRET_KEY,
      accountId: this.env.STRIPE_ACCOUNT_ID,
      mode: this.env.STRIPE_MODE,
      fetcher: (request) => globalThis.fetch(request),
      resolveCustomer: async (customer) =>
        (await mapping.resolveGrowthStripeCustomer({ customer_id: customer }))?.organization_id ??
        null,
    }).readGrowthOpenDisputePage(page);
  }
  async readGrowthPaymentPage(page: { cursor: string | null; limit: number }) {
    const mapping = this.env.GROWTH_STRIPE_CUSTOMER_RUNTIME;
    if (!mapping) throw new Error("stripe_growth_mapping_unavailable");
    return createGrowthPaymentReader({
      credential: this.env.STRIPE_SECRET_KEY,
      accountId: this.env.STRIPE_ACCOUNT_ID,
      mode: this.env.STRIPE_MODE,
      fetcher: (request) => globalThis.fetch(request),
      resolveCustomer: async (customer) =>
        (await mapping.resolveGrowthStripeCustomer({ customer_id: customer }))?.organization_id ??
        null,
    }).readGrowthPaymentPage(page);
  }
}

export default createBillingWorker();
