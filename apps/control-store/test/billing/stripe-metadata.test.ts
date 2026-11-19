import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { all, newOrganization } from "../credit/support.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { makePaid } from "../support/credit-fixtures.js";
import { ulidOf } from "../support/platform-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control.dispose());

const NOW = "2026-10-30T10:00:00.000Z";
const configuration = {
  accountId: "acct_customers",
  mode: "test" as const,
  paidPriceId: "price_paid",
  topupPriceId: "price_topup",
};
const prepare = (organizationId: string, extra: Record<string, unknown> = {}) => ({
  organizationId,
  configuration,
  requestId: newUlid(),
  actorId: "user:owner",
  now: NOW,
  ...extra,
});

describe("the Stripe customer of an organization", () => {
  it("is prepared once, confirmed with the id Stripe gave it and read back", async () => {
    const org = (await newOrganization(control)).organizationId;
    const input = prepare(org);
    expect(await store.stripeBilling.prepareStripeCustomer(input)).toEqual({
      organizationId: org,
      requestId: input.requestId,
      customerId: null,
      createdAt: NOW,
    });
    expect(
      await store.stripeBilling.readStripeBillingCustomer({ organizationId: org, configuration }),
    ).toBe(null);
    // a repeat, even with a new request id, answers with the intent that exists
    expect(await store.stripeBilling.prepareStripeCustomer(prepare(org))).toMatchObject({
      requestId: input.requestId,
    });
    const confirm = {
      organizationId: org,
      requestId: input.requestId,
      customerId: `cus_${org}`,
      now: NOW,
    };
    expect(await store.stripeBilling.confirmStripeCustomer(confirm)).toEqual({
      organizationId: org,
      requestId: input.requestId,
      customerId: `cus_${org}`,
    });
    // confirming the same id again is a replay; another id is a conflict
    await store.stripeBilling.confirmStripeCustomer(confirm);
    await expect(
      store.stripeBilling.confirmStripeCustomer({ ...confirm, customerId: "cus_other" }),
    ).rejects.toThrow("billing_customer_conflict");
    expect(await store.stripeBilling.prepareStripeCustomer(prepare(org))).toMatchObject({
      customerId: `cus_${org}`,
    });
    expect(
      await store.stripeBilling.readStripeBillingCustomer({ organizationId: org, configuration }),
    ).toBe(`cus_${org}`);
    // for another account the organization has no customer
    expect(
      await store.stripeBilling.readStripeBillingCustomer({
        organizationId: org,
        configuration: { ...configuration, accountId: "acct_elsewhere" },
      }),
    ).toBe(null);
    await expect(
      store.stripeBilling.prepareStripeCustomer(
        prepare(org, { configuration: { ...configuration, mode: "live" } }),
      ),
    ).rejects.toThrow("billing_customer_conflict");
  });

  it("starts a new attempt for a day-old intent without a provider identity, and only then", async () => {
    const org = (await newOrganization(control)).organizationId;
    await store.stripeBilling.prepareStripeCustomer(
      prepare(org, { now: "2026-10-29T09:59:59.000Z" }),
    );
    const attempt = newUlid();
    expect(
      await store.stripeBilling.renewStripeCustomerIntent({
        organizationId: org,
        configuration,
        requestId: attempt,
        now: NOW,
      }),
    ).toEqual({ organizationId: org, requestId: attempt, customerId: null, createdAt: NOW });
    // the new attempt is a day old at the earliest, so a second renewal changes nothing
    expect(
      await store.stripeBilling.renewStripeCustomerIntent({
        organizationId: org,
        configuration,
        requestId: newUlid(),
        now: NOW,
      }),
    ).toMatchObject({ requestId: attempt, customerId: null });
    // the creation instant only moves forward, and only while no provider identity exists
    await expect(
      control.core
        .prepare("UPDATE stripe_billing_customers SET created_at = ? WHERE organization_id = ?")
        .bind("2026-10-01T00:00:00.000000Z", org)
        .run(),
    ).rejects.toThrow("Billing intent may only");
    await store.stripeBilling.confirmStripeCustomer({
      organizationId: org,
      requestId: attempt,
      customerId: `cus_${org}`,
      now: NOW,
    });
    expect(
      await store.stripeBilling.renewStripeCustomerIntent({
        organizationId: org,
        configuration,
        requestId: newUlid(),
        now: "2026-11-30T10:00:00.000Z",
      }),
    ).toMatchObject({ requestId: attempt, customerId: `cus_${org}` });
  });

  it("is refused for an organization that is not active, a request id of another organization and a taken id", async () => {
    const [a, b, c] = [
      (await newOrganization(control)).organizationId,
      (await newOrganization(control)).organizationId,
      (await newOrganization(control)).organizationId,
    ];
    const first = prepare(a);
    await store.stripeBilling.prepareStripeCustomer(first);
    await expect(
      store.stripeBilling.prepareStripeCustomer(prepare(b, { requestId: first.requestId })),
    ).rejects.toThrow("billing_customer_conflict");
    await control.core
      .prepare("UPDATE organizations SET state = 'suspended' WHERE organization_id = ?")
      .bind(c)
      .run();
    await expect(store.stripeBilling.prepareStripeCustomer(prepare(c))).rejects.toThrow(
      "billing_customer_conflict",
    );
    await expect(
      store.stripeBilling.prepareStripeCustomer(prepare(ulidOf("ghost", 61))),
    ).rejects.toThrow(/billing_customer_conflict|route/u);
    // one Stripe customer belongs to one organization
    await store.stripeBilling.confirmStripeCustomer({
      organizationId: a,
      requestId: first.requestId,
      customerId: "cus_shared",
      now: NOW,
    });
    const second = prepare(b);
    await control.core
      .prepare("UPDATE organizations SET state = 'active' WHERE organization_id = ?")
      .bind(b)
      .run();
    await store.stripeBilling.prepareStripeCustomer(second);
    await expect(
      store.stripeBilling.confirmStripeCustomer({
        organizationId: b,
        requestId: second.requestId,
        customerId: "cus_shared",
        now: NOW,
      }),
    ).rejects.toThrow("billing_customer_conflict");
    await expect(
      store.stripeBilling.confirmStripeCustomer({
        organizationId: b,
        requestId: newUlid(),
        customerId: "cus_unrelated",
        now: NOW,
      }),
    ).rejects.toThrow("billing_customer_conflict");
    await expect(store.stripeBilling.prepareStripeCustomer({})).rejects.toThrow(
      "billing_request_invalid",
    );
    expect(
      await all(
        control.core,
        "SELECT 1 FROM stripe_billing_customers WHERE provider_id = 'cus_shared'",
      ),
    ).toHaveLength(1);
  });
});

describe("Paid, as billing asks for it", () => {
  it("is the end of the coverage and its source while the organization is Paid, and null otherwise", async () => {
    const org = (await newOrganization(control)).organizationId;
    expect(await store.stripeBilling.readOrganizationPaid({ organizationId: org, now: NOW })).toBe(
      null,
    );
    await makePaid(control.core, org, "2026-11-15T00:00:00.000Z", NOW, "granted");
    expect(
      await store.stripeBilling.readOrganizationPaid({ organizationId: org, now: NOW }),
    ).toEqual({
      paidUntil: "2026-11-15T00:00:00.000Z",
      source: "granted",
    });
    expect(
      await store.stripeBilling.readOrganizationPaid({
        organizationId: org,
        now: "2026-11-15T00:00:00.000Z",
      }),
    ).toBe(null);
  });
});
