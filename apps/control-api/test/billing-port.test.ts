import { describe, expect, it } from "vitest";
import { BillingServiceError, createBillingManagementPort } from "../src/billing.js";

type Port = ReturnType<typeof createBillingManagementPort>;

const organizationId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const checkoutId = "01K2F3G4H5J6K7M8N9P0QRSTVX";
const now = "2026-10-30T10:00:00.000Z";
const recharge = {
  organization_id: organizationId,
  portal_available: true,
  enabled: true,
  revision: 3,
  status: "on",
  monthly_limit_minor: 5000,
  spent_minor: 900,
  currency: "usd",
  amount_minor: 900,
  credits: 1000,
  threshold_credits: 100,
  setup_url: null,
  invoice_url: null,
  billing_issue: null,
};
const checkout = {
  organization_id: organizationId,
  checkout_id: checkoutId,
  offer: "topup",
  state: "open",
  payment_confirmed: false,
  url: "https://checkout.stripe.com/c/pay/cs_test",
  expires_at: now,
  packs: 2,
  credited_micros: "0",
  revoked_micros: "0",
  paid_until: null,
  required_action: "complete_checkout",
  billing_issue: null,
};
const portal = {
  organization_id: organizationId,
  url: "https://billing.stripe.com/p/session/test_portal",
  created_at: now,
};

function fixture(status: number, body: unknown) {
  const requests: { url: string; method: string; body: unknown; contentType: string | null }[] = [];
  const port = createBillingManagementPort({
    async fetch(request) {
      requests.push({
        url: request.url,
        method: request.method,
        body: JSON.parse(await request.text()),
        contentType: request.headers.get("content-type"),
      });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  });
  return { port, requests };
}

describe("billing management port", () => {
  it("posts each operation to its private path and returns the validated view", async () => {
    const configure = {
      organizationId,
      actorId: "user:user_owner",
      idempotencyKey: "recharge-1",
      enabled: true,
      monthlyLimitMinor: 5000,
      consent: "I agree",
      revision: 2,
    };
    const buy = {
      organizationId,
      actorId: "user:user_owner",
      idempotencyKey: "checkout-1",
      offer: "topup" as const,
      packs: 2,
    };
    const cases = [
      ["/recharge", { organizationId }, recharge, (p: Port) => p.getRecharge({ organizationId })],
      ["/recharge-configure", configure, recharge, (p: Port) => p.configureRecharge(configure)],
      ["/checkouts", buy, checkout, (p: Port) => p.createCheckout(buy)],
      [
        "/checkout-status",
        { organizationId, checkoutId },
        checkout,
        (p: Port) => p.getCheckout({ organizationId, checkoutId }),
      ],
      ["/portal", { organizationId }, portal, (p: Port) => p.createPortal({ organizationId })],
    ] as const;
    for (const [path, sent, reply, run] of cases) {
      const { port, requests } = fixture(200, reply);
      expect(await run(port)).toEqual(reply);
      expect(requests).toEqual([
        {
          url: `https://billing.internal${path}`,
          method: "POST",
          body: sent,
          contentType: "application/json",
        },
      ]);
    }
  });

  it("maps service statuses to typed errors and keeps the paid-plan code only on 409", async () => {
    const failing = async (status: number, body: unknown) => {
      const { port } = fixture(status, body);
      return port.createPortal({ organizationId }).catch((error: unknown) => error);
    };
    for (const status of [400, 404, 409] as const) {
      const error = await failing(status, {});
      expect(error).toBeInstanceOf(BillingServiceError);
      expect(error).toMatchObject({ status, code: null, message: "billing_service_error" });
    }
    expect(await failing(409, { code: "paid_plan_required" })).toMatchObject({
      status: 409,
      code: "paid_plan_required",
    });
    expect(await failing(409, { code: "something_else" })).toMatchObject({
      status: 409,
      code: null,
    });
    expect(await failing(400, { code: "paid_plan_required" })).toMatchObject({
      status: 400,
      code: null,
    });
    expect(await failing(500, {})).toMatchObject({ status: 503, code: null });
  });

  it("answers unavailable for a malformed, foreign or transport-failed reply", async () => {
    const unavailable = { status: 503, code: null };
    const wrongShape = fixture(200, { ...portal, extra: true }).port;
    await expect(wrongShape.createPortal({ organizationId })).rejects.toMatchObject(unavailable);
    const foreign = fixture(200, { ...portal, organization_id: "01K2F3G4H5J6K7M8N9P0QRSTVY" }).port;
    await expect(foreign.createPortal({ organizationId })).rejects.toMatchObject(unavailable);
    const wrongCheckout = fixture(200, {
      ...checkout,
      checkout_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
    }).port;
    await expect(wrongCheckout.getCheckout({ organizationId, checkoutId })).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      fixture(200, "not json").port.getRecharge({ organizationId }),
    ).rejects.toMatchObject(unavailable);
    const broken = createBillingManagementPort({
      fetch: async () => {
        throw new Error("network");
      },
    });
    await expect(broken.getRecharge({ organizationId })).rejects.toMatchObject(unavailable);
  });
});
