import { parseUlid } from "@ohmyhost/platform";
import {
  assertBillingCheckout,
  assertBillingPortal,
  assertRecharge,
} from "@ohmyhost/contracts/billing";
import type { createBillingRuntime } from "./runtime.js";

/** The StripeBillingError codes that a repeated request cannot change: Stripe or our check refused the call. */
const STRIPE_REFUSALS = ["stripe_rejected", "stripe_response_invalid", "stripe_scope_conflict"];

/** One structured warning with the Stripe status and code of a refusal; the Stripe request id stays out of logs. */
function logRefusal(code: string, error: unknown): void {
  const provider = (error as { provider?: { status?: unknown; code?: unknown } } | null)?.provider;
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "billing",
      code,
      stripe_status: typeof provider?.status === "number" ? provider.status : null,
      stripe_code: typeof provider?.code === "string" ? provider.code : null,
    }),
  );
}

/** Service-binding only: authorized owner commands or a scope-free platform inbox tick. */
export function createBillingHandler(runtime: ReturnType<typeof createBillingRuntime>) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (
        url.hostname !== "billing.internal" ||
        request.method !== "POST" ||
        url.search ||
        ![
          "/checkouts",
          "/checkout-status",
          "/portal",
          "/sync-webhooks",
          "/recharge",
          "/recharge-configure",
          "/sync-recharge",
        ].includes(url.pathname)
      )
        return new Response(null, { status: 404 });
      try {
        if (!request.body) throw new Error("billing_request_invalid");
        const reader = request.body.getReader();
        let body = "",
          size = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        try {
          while (true) {
            const p = await reader.read();
            if (p.done) break;
            size += p.value.length;
            if (size > 4096) {
              await reader.cancel();
              return new Response(null, { status: 413 });
            }
            body += decoder.decode(p.value, { stream: true });
          }
          body += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        const input: unknown = JSON.parse(body);
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("billing_request_invalid");
        const v = input as Record<string, unknown>;
        if (url.pathname === "/sync-webhooks" || url.pathname === "/sync-recharge") {
          if (Object.keys(v).length !== 0) throw new Error("billing_request_invalid");
          return Response.json(
            url.pathname === "/sync-recharge"
              ? await runtime.syncRechargeBatch()
              : await runtime.syncWebhookBatch(),
            {
              headers: { "cache-control": "no-store" },
            },
          );
        }
        const organizationId = parseUlid(String(v["organizationId"]));
        if (url.pathname === "/recharge" || url.pathname === "/recharge-configure") {
          let result;
          if (url.pathname === "/recharge") {
            if (Object.keys(v).join(",") !== "organizationId")
              throw new Error("billing_request_invalid");
            result = await runtime.getRecharge({ organizationId });
          } else {
            if (
              Object.keys(v).sort().join(",") !==
                "actorId,consent,enabled,idempotencyKey,monthlyLimitMinor,organizationId,revision" ||
              typeof v["actorId"] !== "string" ||
              typeof v["idempotencyKey"] !== "string" ||
              typeof v["enabled"] !== "boolean" ||
              typeof v["monthlyLimitMinor"] !== "number" ||
              typeof v["revision"] !== "number" ||
              (v["consent"] !== null && typeof v["consent"] !== "string")
            )
              throw new Error("billing_request_invalid");
            result = await runtime.configureRecharge({
              organizationId,
              actorId: v["actorId"],
              idempotencyKey: v["idempotencyKey"],
              enabled: v["enabled"],
              monthlyLimitMinor: v["monthlyLimitMinor"],
              revision: v["revision"],
              consent: v["consent"],
            });
          }
          assertRecharge(result);
          return Response.json(result, { headers: { "cache-control": "no-store" } });
        }
        if (url.pathname === "/portal") {
          if (Object.keys(v).join(",") !== "organizationId")
            throw new Error("billing_request_invalid");
          const result = await runtime.createPortal({ organizationId });
          const view = {
            organization_id: organizationId,
            url: result.url,
            created_at: result.createdAt,
          };
          assertBillingPortal(view);
          return Response.json(view);
        }
        let result;
        if (url.pathname === "/checkout-status") {
          if (Object.keys(v).sort().join(",") !== "checkoutId,organizationId")
            throw new Error("billing_request_invalid");
          result = await runtime.syncCheckout({
            organizationId,
            checkoutId: parseUlid(String(v["checkoutId"])),
          });
        } else {
          if (
            Object.keys(v).sort().join(",") !==
              "actorId,idempotencyKey,offer,organizationId,packs" ||
            typeof v["actorId"] !== "string" ||
            typeof v["idempotencyKey"] !== "string" ||
            (v["offer"] !== "topup" && v["offer"] !== "paid") ||
            typeof v["packs"] !== "number"
          )
            throw new Error("billing_request_invalid");
          result = await runtime.createCheckout({
            organizationId,
            actorId: v["actorId"],
            idempotencyKey: v["idempotencyKey"],
            offer: v["offer"],
            packs: v["packs"],
          });
        }
        const view = {
          organization_id: result.organizationId,
          checkout_id: result.checkoutId,
          offer: result.offer,
          state: result.state,
          payment_confirmed: result.paid,
          url: result.url,
          expires_at: result.expiresAt,
          packs: result.packs,
          credited_micros: result.creditedMicros,
          revoked_micros: result.revokedMicros,
          paid_until: result.paidUntil,
          required_action: result.requiredAction,
          billing_issue: result.billingIssue,
        };
        assertBillingCheckout(view);
        return Response.json(view, { status: url.pathname === "/checkouts" ? 201 : 200 });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        // Stripe refused the request itself: the same request gets the same refusal, so it is a conflict, not an outage.
        const refused = STRIPE_REFUSALS.includes(code);
        if (refused) logRefusal(code, error);
        const status =
          code === "billing_checkout_not_found"
            ? 404
            : [
                  "billing_checkout_conflict",
                  "billing_conflict",
                  "billing_paid_purchase_exists",
                  "billing_customer_not_ready",
                  "billing_organization_inactive",
                  "paid_plan_required",
                ].includes(code) || refused
              ? 409
              : [
                    "billing_request_invalid",
                    "billing_checkout_invalid",
                    "billing_actor_invalid",
                  ].includes(code)
                ? 400
                : 503;
        return Response.json(
          {
            code:
              code === "paid_plan_required"
                ? code
                : status === 503
                  ? "billing_unavailable"
                  : status === 409
                    ? "billing_conflict"
                    : status === 404
                      ? "resource_not_found"
                      : "invalid_request",
          },
          { status, headers: { "cache-control": "no-store" } },
        );
      }
    },
  };
}
