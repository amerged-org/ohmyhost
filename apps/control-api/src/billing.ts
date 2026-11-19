import {
  assertBillingCheckout,
  assertBillingPortal,
  assertRecharge,
  type RechargeView,
  type BillingCheckoutView,
  type BillingPortalView,
} from "@ohmyhost/contracts/billing";
import { readBoundedText } from "./workos-session-status.js";

export class BillingServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: "paid_plan_required" | null = null,
  ) {
    super("billing_service_error");
  }
}

/** The existing Control scheduler wakes the private account-bound inbox consumer. */
export async function syncBillingWebhookBatch(binding: {
  fetch(request: Request): Promise<Response>;
}): Promise<{ acknowledged: number; failed: number }> {
  const response = await binding.fetch(
    new Request("https://billing.internal/sync-webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(45000),
    }),
  );
  if (!response.ok) throw new BillingServiceError(503);
  const value: unknown = JSON.parse(await readBoundedText(response, 1024));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BillingServiceError(503);
  const { acknowledged, failed } = value as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "acknowledged,failed" ||
    typeof acknowledged !== "number" ||
    typeof failed !== "number" ||
    !Number.isSafeInteger(acknowledged) ||
    !Number.isSafeInteger(failed) ||
    acknowledged < 0 ||
    failed < 0 ||
    acknowledged + failed > 10
  )
    throw new BillingServiceError(503);
  return { acknowledged, failed };
}
export interface BillingManagementPort {
  getRecharge(input: { organizationId: string }): Promise<RechargeView>;
  configureRecharge(input: {
    organizationId: string;
    actorId: string;
    idempotencyKey: string;
    enabled: boolean;
    monthlyLimitMinor: number;
    consent: string | null;
    revision: number;
  }): Promise<RechargeView>;
  createCheckout(input: {
    organizationId: string;
    actorId: string;
    idempotencyKey: string;
    offer: "topup" | "paid";
    packs: number;
  }): Promise<BillingCheckoutView>;
  getCheckout(input: { organizationId: string; checkoutId: string }): Promise<BillingCheckoutView>;
  createPortal(input: { organizationId: string }): Promise<BillingPortalView>;
}
export function createBillingManagementPort(binding: {
  fetch(request: Request): Promise<Response>;
}): BillingManagementPort {
  async function call(path: string, input: Record<string, unknown>) {
    try {
      const response = await binding.fetch(
        new Request(`https://billing.internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(45000),
        }),
      );
      const value: unknown = JSON.parse(await readBoundedText(response, 16384));
      if (!response.ok)
        throw new BillingServiceError(
          response.status === 400
            ? 400
            : response.status === 404
              ? 404
              : response.status === 409
                ? 409
                : 503,
          response.status === 409 &&
          value !== null &&
          typeof value === "object" &&
          "code" in value &&
          value.code === "paid_plan_required"
            ? "paid_plan_required"
            : null,
        );
      if (path.startsWith("/recharge")) assertRecharge(value);
      else if (path === "/portal") assertBillingPortal(value);
      else assertBillingCheckout(value);
      if (
        value.organization_id !== input["organizationId"] ||
        (path === "/checkout-status" &&
          "checkout_id" in value &&
          value.checkout_id !== input["checkoutId"])
      )
        throw new Error("scope_mismatch");
      return value;
    } catch (error) {
      if (error instanceof BillingServiceError) throw error;
      throw new BillingServiceError(503);
    }
  }
  return {
    async getRecharge(input) {
      const value = await call("/recharge", input);
      assertRecharge(value);
      return value;
    },
    async configureRecharge(input) {
      const value = await call("/recharge-configure", input);
      assertRecharge(value);
      return value;
    },
    async createCheckout(input) {
      const value = await call("/checkouts", input);
      assertBillingCheckout(value);
      return value;
    },
    async getCheckout(input) {
      const value = await call("/checkout-status", input);
      assertBillingCheckout(value);
      return value;
    },
    async createPortal(input) {
      const value = await call("/portal", input);
      assertBillingPortal(value);
      return value;
    },
  };
}

export async function syncBillingRechargeBatch(binding: {
  fetch(request: Request): Promise<Response>;
}) {
  const response = await binding.fetch(
    new Request("https://billing.internal/sync-recharge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(45000),
    }),
  );
  if (!response.ok) throw new BillingServiceError(503);
  const value: unknown = JSON.parse(await readBoundedText(response, 1024));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BillingServiceError(503);
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "failed,processed" ||
    !Number.isSafeInteger(v["processed"]) ||
    !Number.isSafeInteger(v["failed"]) ||
    Number(v["processed"]) < 0 ||
    Number(v["failed"]) < 0 ||
    Number(v["processed"]) + Number(v["failed"]) > 3
  )
    throw new BillingServiceError(503);
  return { processed: Number(v["processed"]), failed: Number(v["failed"]) };
}
