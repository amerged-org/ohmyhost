import { expect, it } from "vitest";
import { assertBillingCheckout, assertBillingPortal } from "../src/billing.js";

it("preserves purchase and refund amounts while accepting only Stripe customer handoff links", () => {
  const checkout = {
    organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    checkout_id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    offer: "topup",
    state: "open",
    payment_confirmed: false,
    url: "https://checkout.stripe.com/c/pay/cs_test_acceptance",
    expires_at: "2026-09-10T00:00:00.000Z",
    packs: 1,
    credited_micros: "0",
    revoked_micros: "0",
    paid_until: null,
    required_action: "complete_checkout",
    billing_issue: null,
  };
  const paid = {
    ...checkout,
    state: "complete",
    payment_confirmed: true,
    url: null,
    credited_micros: "1000000000",
    required_action: "none",
  };
  for (const result of [
    checkout,
    paid,
    { ...paid, revoked_micros: "1000000000" },
    { ...paid, offer: "paid", paid_until: "2026-10-09T00:00:00.000Z" },
  ]) {
    const before = structuredClone(result);
    expect(() => assertBillingCheckout(result)).not.toThrow();
    expect(result).toEqual(before);
  }
  const portal = {
    organization_id: checkout.organization_id,
    url: "https://billing.stripe.com/p/session/test_acceptance",
    created_at: "2026-09-09T00:00:00.000Z",
  };
  expect(() => assertBillingPortal(portal)).not.toThrow();
  for (const url of [
    "https://checkout.stripe.com.attacker.example/pay",
    "http://checkout.stripe.com/pay",
    "https://secret@checkout.stripe.com/pay",
    "not-a-url",
  ]) {
    expect(() => assertBillingCheckout({ ...checkout, url })).toThrow("billing_response_invalid");
    expect(() => assertBillingPortal({ ...portal, url })).toThrow("billing_response_invalid");
  }
  for (const invalid of [
    null,
    [],
    { ...paid, credited_micros: 1000000000 },
    { ...paid, revoked_micros: "-1" },
    { ...checkout, expires_at: "tomorrow" },
    { ...checkout, provider_secret: "must-not-cross-the-boundary" },
  ])
    expect(() => assertBillingCheckout(invalid)).toThrow("billing_response_invalid");
  expect(() => assertBillingPortal({ ...portal, created_at: "yesterday" })).toThrow(
    "billing_response_invalid",
  );
});
