import { describe, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import {
  BILLING_RUNTIME_METHODS,
  createD1BillingPersistence,
  type BillingRuntimeBinding,
} from "../src/d1-persistence.js";
import {
  RECHARGE_RUNTIME_METHODS,
  createD1RechargePersistence,
  type RechargeRuntimeBinding,
} from "../src/d1-recharge-persistence.js";

// The Worker trusts nothing the private binding answers: every answer is parsed to the exact shape, and anything else
// (or any failure that is not one of the Core's own codes) is "billing_unavailable". The real Core's answers are covered
// by billing-worker.test.ts; here the binding answers wrongly on purpose.

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const clock = { now: () => new Date("2026-10-30T10:00:00.000Z") };
const ids = { next: () => parseUlid(REQUEST) };
const configuration = {
  accountId: "acct_1",
  mode: "test" as const,
  paidPriceId: "price_paid",
  topupPriceId: "price_topup",
};

function binding<T extends BillingRuntimeBinding>(
  methods: readonly string[],
  answer: (method: string, input: unknown) => unknown,
): T {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      async (input: unknown) => {
        const value = answer(method, input);
        if (value instanceof Error) throw value;
        return value;
      },
    ]),
  ) as unknown as T;
}
const billing = (answer: (method: string, input: unknown) => unknown) =>
  createD1BillingPersistence(
    binding<BillingRuntimeBinding>(BILLING_RUNTIME_METHODS, answer),
    clock,
    ids,
  );
const recharge = (answer: (method: string, input: unknown) => unknown) =>
  createD1RechargePersistence(
    binding<RechargeRuntimeBinding>(
      [...BILLING_RUNTIME_METHODS, ...RECHARGE_RUNTIME_METHODS],
      answer,
    ),
    configuration,
    clock,
  );
const unavailable = "billing_unavailable";

describe("the Stripe inbox parking alert", () => {
  const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const warnings = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown);

  it("logs one warning with the event id only for each row the Core parks for an operator", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const port = billing(
        (method) =>
          ({
            finishStripeInboxEvent: { finished: true, parked: true },
            recoverExpiredStripeInboxClaims: { count: 2, parkedIds: [REQUEST, OTHER] },
          })[method],
      );
      expect(
        await port.finishStripeInboxEvent({
          inboxEventId: REQUEST,
          claimId: REQUEST,
          errorCode: "STRIPE_REJECTED",
        }),
      ).toEqual({ finished: true, parked: true });
      expect(
        await port.recoverExpiredStripeInboxClaims({ accountId: "acct_1", mode: "test" }),
      ).toBe(2);
      expect(warnings(warn)).toEqual([
        { level: "warn", service: "billing", code: "stripe_inbox_parked", inbox_event_id: REQUEST },
        { level: "warn", service: "billing", code: "stripe_inbox_parked", inbox_event_id: REQUEST },
        { level: "warn", service: "billing", code: "stripe_inbox_parked", inbox_event_id: OTHER },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs nothing for a finish that is not a first parking, or for a recovery that parks nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const port = billing(
        (method) =>
          ({
            finishStripeInboxEvent: { finished: true, parked: false },
            recoverExpiredStripeInboxClaims: { count: 0, parkedIds: [] },
          })[method],
      );
      await port.finishStripeInboxEvent({
        inboxEventId: REQUEST,
        claimId: REQUEST,
        errorCode: "STRIPE_REJECTED",
      });
      await port.recoverExpiredStripeInboxClaims({ accountId: "acct_1", mode: "test" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the Core's answers to the Billing Worker", () => {
  it("are parsed to the exact shape and the instant of the Core's clock is never the caller's", async () => {
    const seen: unknown[] = [];
    const port = billing((method, input) => {
      seen.push([method, input]);
      return {
        prepareStripeCustomer: {
          organizationId: ORG,
          requestId: REQUEST,
          customerId: null,
          createdAt: "2026-10-30T10:00:00.000Z",
        },
        readOrganizationPaid: { paidUntil: "2026-12-01T00:00:00.000Z", source: "granted" },
        recoverExpiredStripeInboxClaims: { count: 2, parkedIds: [REQUEST] },
        finishStripeInboxEvent: { finished: true, parked: false },
        claimStripeInboxEvent: { inbox_event_id: REQUEST, payload: { id: "evt_1" } },
      }[method];
    });
    expect(
      await port.prepareStripeCustomer({ organizationId: ORG, actorId: "user:1", configuration }),
    ).toMatchObject({ requestId: REQUEST, customerId: null });
    expect(await port.readOrganizationPaid({ organizationId: ORG })).toEqual({
      paidUntil: "2026-12-01T00:00:00.000Z",
      source: "granted",
    });
    expect(await port.recoverExpiredStripeInboxClaims({ accountId: "acct_1", mode: "test" })).toBe(
      2,
    );
    expect(
      await port.finishStripeInboxEvent({
        inboxEventId: REQUEST,
        claimId: REQUEST,
        errorCode: null,
      }),
    ).toEqual({ finished: true, parked: false });
    expect(
      await port.claimStripeInboxEvent({ accountId: "acct_1", mode: "test", claimId: REQUEST }),
    ).toMatchObject({ inbox_event_id: REQUEST });
    expect(seen[0]).toEqual([
      "prepareStripeCustomer",
      {
        organizationId: ORG,
        actorId: "user:1",
        configuration,
        requestId: REQUEST,
        now: "2026-10-30T10:00:00.000Z",
      },
    ]);
  });

  it("are refused when they are not exactly what was asked", async () => {
    const wrong = (value: unknown) => billing(() => value);
    for (const value of [undefined, 1, [], {}, { organizationId: ORG }])
      await expect(
        wrong(value).prepareStripeCustomer({ organizationId: ORG, actorId: "u", configuration }),
      ).rejects.toThrow(unavailable);
    await expect(
      wrong({
        organizationId: "x",
        requestId: REQUEST,
        customerId: null,
        createdAt: "2026-10-30T10:00:00.000Z",
      }).prepareStripeCustomer({ organizationId: ORG, actorId: "u", configuration }),
    ).rejects.toThrow();
    await expect(
      wrong({
        organizationId: ORG,
        requestId: REQUEST,
        customerId: "",
        createdAt: "2026-10-30T10:00:00.000Z",
      }).confirmStripeCustomer({ organizationId: ORG, requestId: REQUEST, customerId: "cus_1" }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({
        organizationId: ORG,
        requestId: REQUEST,
        customerId: "cus_1",
        createdAt: "2026-10-30 10:00",
      }).prepareStripeCustomer({ organizationId: ORG, actorId: "u", configuration }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({ paidUntil: "2026-12-01T00:00:00.000Z", source: "nobody" }).readOrganizationPaid({
        organizationId: ORG,
      }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong(-1).recoverExpiredStripeInboxClaims({ accountId: "a", mode: "test" }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong("yes").finishStripeInboxEvent({
        inboxEventId: REQUEST,
        claimId: REQUEST,
        errorCode: null,
      }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({ finished: true, parked: "yes" }).finishStripeInboxEvent({
        inboxEventId: REQUEST,
        claimId: REQUEST,
        errorCode: null,
      }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({ count: 1, parkedIds: ["not-a-ulid"] }).recoverExpiredStripeInboxClaims({
        accountId: "a",
        mode: "test",
      }),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({ recorded: false }).recordStripeSubscriptionEnd({
        organizationId: ORG,
        subscriptionId: "sub_1",
        endedAt: "2026-10-30T10:00:00.000Z",
      }),
    ).rejects.toThrow(unavailable);
    const payment = {
      organizationId: ORG,
      payment: {
        kind: "topup" as const,
        paymentIntentId: "pi_1",
        packs: 1,
        subtotal: 1000,
        total: 1000,
      },
    };
    await expect(
      wrong({
        grantKey: "topup:pi_1",
        granted: "yes",
        creditedMicros: "1",
        paidUntil: null,
      }).grantPayment(payment),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({
        grantKey: "topup:pi_1",
        granted: true,
        creditedMicros: 1,
        paidUntil: null,
      }).grantPayment(payment),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({
        grantKey: "topup:pi_1",
        granted: true,
        creditedMicros: "01",
        paidUntil: null,
      }).grantPayment(payment),
    ).rejects.toThrow(unavailable);
    await expect(
      wrong({ revokedMicros: "0" }).reversePayment({
        organizationId: ORG,
        payment: { kind: "topup", paymentIntentId: "pi_1" },
        observation: {
          accountId: "a",
          mode: "test",
          customerId: "c",
          paymentIntentId: "pi_1",
          currency: "usd",
          paymentTotalMinor: 1,
          items: [],
          disputes: [],
        },
      }),
    ).rejects.toThrow(unavailable);
  });

  it("pass on the Core's own refusals and nothing else", async () => {
    const fail = (message: string) => billing(() => new Error(message));
    await expect(
      fail("Error: paid_plan_required").readOrganizationPaid({ organizationId: ORG }),
    ).rejects.toThrow("paid_plan_required");
    await expect(
      fail("billing_conflict").readOrganizationPaid({ organizationId: ORG }),
    ).rejects.toThrow("billing_conflict");
    for (const message of ["boom", "SQLITE_ERROR: no such table: credit_lots", ""])
      await expect(fail(message).readOrganizationPaid({ organizationId: ORG })).rejects.toThrow(
        unavailable,
      );
    await expect(
      billing(() => "not an Error").readOrganizationPaid({ organizationId: ORG }),
    ).rejects.toThrow();
  });
});

describe("the recharge policy as the Core answers it", () => {
  const policy = {
    organization_id: ORG,
    account_id: "acct_1",
    mode: "test",
    enabled: true,
    revision: 1,
    monthly_limit_minor: 3000,
    status: "on",
    setup_id: REQUEST,
    setup_session_id: null,
    payment_method_id: "pm_1",
    updated_at: "2026-10-30T10:00:00.000Z",
    checked_at: null,
  };
  it("is read to a typed policy, a claim, the candidates and the receipts", async () => {
    const port = recharge((method) =>
      method === "readRechargePolicy"
        ? policy
        : method === "claimRecharge"
          ? { policy, create: true, remainingMinor: 3000 }
          : method === "listRechargeCandidates"
            ? [{ organization_id: ORG }]
            : { recorded: true },
    );
    expect(await port.readPolicy(ORG)).toMatchObject({
      status: "on",
      updated_at: new Date("2026-10-30T10:00:00.000Z"),
      checked_at: null,
    });
    expect(await port.claim(ORG)).toMatchObject({ create: true, remainingMinor: 3000 });
    expect(await port.candidates()).toEqual([{ organization_id: ORG }]);
    await port.saveSetup(ORG, 1, { sessionId: "cs_1", paymentMethodId: null, expired: false });
    await port.transitionPolicy(ORG, "on");
    await port.transitionPolicy(ORG, "reconciliation", 1);
    expect(await recharge(() => null).readPolicy(ORG)).toBe(null);
    expect(await recharge(() => null).claim(ORG)).toBe(null);
    expect(
      (
        await recharge(() => ({ ...policy, checked_at: "2026-10-30T10:00:01.000Z" })).readPolicy(
          ORG,
        )
      )?.checked_at,
    ).toEqual(new Date("2026-10-30T10:00:01.000Z"));
  });

  it("is refused when it is not exactly a policy, a claim, a list or a receipt", async () => {
    for (const value of [
      { ...policy, status: "paused" },
      { ...policy, mode: "staging" },
      { ...policy, enabled: 1 },
      { ...policy, updated_at: "yesterday" },
      { ...policy, extra: true },
      "policy",
    ])
      await expect(recharge(() => value).readPolicy(ORG)).rejects.toThrow(unavailable);
    await expect(
      recharge(() => ({ policy: null, create: true, remainingMinor: 1 })).claim(ORG),
    ).rejects.toThrow(unavailable);
    await expect(
      recharge(() => ({ policy, create: "yes", remainingMinor: 1 })).claim(ORG),
    ).rejects.toThrow(unavailable);
    await expect(recharge(() => ({ policy })).claim(ORG)).rejects.toThrow(unavailable);
    await expect(recharge(() => ({ recorded: false })).transitionPolicy(ORG, "on")).rejects.toThrow(
      unavailable,
    );
    await expect(
      recharge(() => ({})).saveSetup(ORG, 1, {
        sessionId: "cs",
        paymentMethodId: null,
        expired: true,
      }),
    ).rejects.toThrow(unavailable);
    await expect(recharge(() => ({ organization_id: ORG })).candidates()).rejects.toThrow(
      unavailable,
    );
    await expect(recharge(() => [{ organization_id: ORG, extra: 1 }]).candidates()).rejects.toThrow(
      unavailable,
    );
    await expect(recharge(() => ({ status: "on" })).readView(ORG)).rejects.toThrow();
    await expect(
      recharge(() => ({ status: "on" })).configure({
        organizationId: ORG,
        actorId: "u",
        idempotencyKey: "k",
        enabled: true,
        monthlyLimitMinor: 3000,
        consent: "off_session_v1",
        revision: 0,
        id: REQUEST,
      }),
    ).rejects.toThrow();
  });
});
