import { describe, expect, it } from "vitest";

import {
  reversedMinor,
  type ReversalObservation,
  type ReversalScope,
} from "../../src/catalog/billing/payment-reversal-plan.js";

const scope: ReversalScope = {
  accountId: "acct_1",
  mode: "test",
  customerId: "cus_1",
  paymentIntentId: "pi_1",
  totalMinor: 1100,
};
const observe = (extra: Partial<ReversalObservation> = {}): ReversalObservation => ({
  accountId: "acct_1",
  mode: "test",
  customerId: "cus_1",
  paymentIntentId: "pi_1",
  currency: "usd",
  paymentTotalMinor: 1100,
  items: [],
  disputes: [],
  ...extra,
});
const refund = (id: string, amountMinor: number, status = "succeeded") => ({
  id,
  amountMinor,
  status,
});
const dispute = (id: string, amountMinor: number, ...directions: string[]) => ({
  id,
  amountMinor,
  movements: directions.map((direction, index) => ({ id: `txn_${id}_${index}`, direction })),
});

describe("what was given back of a payment", () => {
  it("counts the refunds that succeeded and nothing else", () => {
    expect(reversedMinor(scope, observe())).toBe(0);
    expect(
      reversedMinor(
        scope,
        observe({
          items: [
            refund("re_1", 100),
            refund("re_2", 200),
            refund("re_3", 400, "pending"),
            refund("re_4", 500, "requires_action"),
            refund("re_5", 600, "failed"),
            refund("re_6", 700, "canceled"),
          ],
        }),
      ),
    ).toBe(300);
  });

  it("counts a dispute while its money is withdrawn and not once it was reinstated", () => {
    expect(reversedMinor(scope, observe({ disputes: [dispute("du_1", 200, "withdrawn")] }))).toBe(
      200,
    );
    expect(
      reversedMinor(
        scope,
        observe({ disputes: [dispute("du_1", 200, "withdrawn", "reinstated")] }),
      ),
    ).toBe(0);
    expect(
      reversedMinor(
        scope,
        observe({
          items: [refund("re_1", 300)],
          disputes: [dispute("du_1", 200, "withdrawn"), dispute("du_2", 100, "withdrawn")],
        }),
      ),
    ).toBe(600);
    expect(reversedMinor(scope, observe({ disputes: [dispute("du_1", 200)] }))).toBe(0);
  });

  it("never exceeds the payment", () => {
    expect(
      reversedMinor(
        scope,
        observe({
          items: [refund("re_1", 800)],
          disputes: [dispute("du_1", 900, "withdrawn")],
        }),
      ),
    ).toBe(1100);
  });

  it("refuses an observation of another payment", () => {
    for (const other of [
      { accountId: "acct_2" },
      { mode: "live" as const },
      { customerId: "cus_2" },
      { paymentIntentId: "pi_2" },
      { currency: "eur" },
      { paymentTotalMinor: 1000 },
    ])
      expect(() => reversedMinor(scope, observe(other))).toThrow("billing_refund_scope_conflict");
    expect(() =>
      reversedMinor(
        scope,
        observe({ items: Array.from({ length: 1001 }, (_, i) => refund(`re_${i}`, 1)) }),
      ),
    ).toThrow("billing_refund_scope_conflict");
    expect(() =>
      reversedMinor(
        scope,
        observe({
          disputes: Array.from({ length: 101 }, (_, i) => dispute(`du_${i}`, 1, "withdrawn")),
        }),
      ),
    ).toThrow("billing_refund_scope_conflict");
  });

  it("refuses refunds that cannot be real", () => {
    for (const items of [
      [refund("refund_1", 100)],
      [refund("re_1", 100), refund("re_1", 100)],
      [refund("re_1", 100, "bogus")],
      [refund("re_1", 0)],
      [refund("re_1", 1.5)],
      [refund("re_1", 1101)],
    ])
      expect(() => reversedMinor(scope, observe({ items }))).toThrow("billing_refund_invalid");
    expect(() =>
      reversedMinor(scope, observe({ items: [refund("re_1", 700), refund("re_2", 700)] })),
    ).toThrow("billing_refund_exceeds_payment");
  });

  it("refuses disputes that cannot be real", () => {
    for (const disputes of [
      [dispute("dispute_1", 100, "withdrawn")],
      [dispute("du_1", 100, "withdrawn"), dispute("du_1", 100, "withdrawn")],
      [dispute("du_1", 0, "withdrawn")],
      [dispute("du_1", 100, "sideways")],
      [dispute("du_1", 100, ...Array.from({ length: 11 }, () => "withdrawn"))],
      [{ id: "du_1", amountMinor: 100, movements: [{ id: "tx_1", direction: "withdrawn" }] }],
      [
        {
          id: "du_1",
          amountMinor: 100,
          movements: [
            { id: "txn_1", direction: "withdrawn" },
            { id: "txn_1", direction: "reinstated" },
          ],
        },
      ],
    ])
      expect(() => reversedMinor(scope, observe({ disputes }))).toThrow("billing_dispute_invalid");
  });
});
