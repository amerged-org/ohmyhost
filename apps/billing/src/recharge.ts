import type { createStripeBillingProvider, RechargeInvoice } from "@ohmyhost/provider-stripe";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { RechargeView } from "@ohmyhost/contracts/billing";
import type { BillingPersistence } from "./d1-persistence.js";
import type { RechargePersistence } from "./d1-recharge-persistence.js";
import type { BillingConfiguration, RechargePolicy } from "./types.js";

type Provider = Pick<
  Awaited<ReturnType<typeof createStripeBillingProvider>>,
  | "rechargeSetup"
  | "createRechargeInvoice"
  | "finalizeRechargeInvoice"
  | "observeRechargeInvoice"
  | "findRechargeInvoices"
  | "findPaidRechargeInvoices"
  | "payRechargeInvoice"
  | "voidRechargeInvoice"
  | "observePaymentReversals"
  | "closeCustomer"
>;
type InFlight = RechargeInvoice & { rechargeId: string };
/** A payment collected within this long is looked for before another recharge starts: its credit may not have landed. */
const HEAL_MS = 14 * 86_400_000;
/** Stripe's idempotency window: no setup session is created again under a setup id this old. */
const SETUP_IDEMPOTENCY_MS = 86_400_000;

/**
 * Automatic recharge. The policy (on or off, the card, the monthly limit) lives in the Core; the recharge itself is the
 * draft or open invoice at Stripe, found by listing the customer's invoices, and its money is the credit grant keyed by
 * the payment. Nothing else is kept, so every step can be repeated: a lost response finds its invoice again, a
 * payment that was collected is credited once, and one look at an organization at a time is leased in the Core.
 */
export function createRechargeRuntime(d: {
  persistence: BillingPersistence;
  rechargePersistence: RechargePersistence;
  provider: Provider;
  configuration: BillingConfiguration;
  clock: Clock;
  ids: UlidFactory;
  ensureCustomer: (organizationId: string, actorId: string) => Promise<string>;
}) {
  const { persistence, rechargePersistence: store, provider } = d;
  async function customer(organizationId: string) {
    const id = await persistence.readStripeBillingCustomer({
      organizationId,
      configuration: d.configuration,
    });
    if (!id) throw new Error("billing_customer_not_ready");
    return id;
  }
  const issueView = (invoice: InFlight) =>
    invoice.taxIssue === null
      ? null
      : {
          code: invoice.taxIssue,
          invoice_id: invoice.invoiceId,
          observed_at: d.clock.now().toISOString(),
          required_action:
            invoice.taxIssue === "billing_tax_location_required"
              ? ("open_billing_portal" as const)
              : ("contact_support" as const),
        };
  async function inFlight(organizationId: string): Promise<InFlight[]> {
    return provider.findRechargeInvoices({
      organizationId,
      customerId: await customer(organizationId),
    });
  }
  /** Turning recharge off withdraws its invoices that are not paid; one whose payment is under way stays. */
  async function discard(organizationId: string) {
    const customerId = await persistence.readStripeBillingCustomer({
      organizationId,
      configuration: d.configuration,
    });
    if (customerId === null) return;
    for (const invoice of await provider.findRechargeInvoices({ organizationId, customerId }))
      await provider
        .voidRechargeInvoice({
          organizationId,
          customerId,
          id: invoice.rechargeId,
          invoiceId: invoice.invoiceId,
        })
        .catch(() => undefined);
  }
  async function getRecharge(input: { organizationId: string }): Promise<RechargeView> {
    const organizationId = input.organizationId;
    const policy = await store.readPolicy(organizationId);
    const view = await store.readView(organizationId);
    if (
      policy?.enabled &&
      policy.status === "setup_required" &&
      (await persistence.readOrganizationPaid({ organizationId }))
    ) {
      // A waiting policy without a session that has waited a day first gets a fresh setup id, as an expired session does:
      // Stripe's idempotency window no longer covers its old one.
      let waiting = policy;
      if (
        waiting.setup_session_id === null &&
        d.clock.now().getTime() - waiting.updated_at.getTime() >= SETUP_IDEMPOTENCY_MS
      ) {
        await store.saveSetup(organizationId, waiting.revision, {
          sessionId: null,
          paymentMethodId: null,
          expired: true,
        });
        waiting = (await store.readPolicy(organizationId)) ?? waiting;
      }
      // A waiting policy without a session gets one; an expired session is replaced by a new one under a fresh setup id
      // (Stripe answers a repeated idempotency key with the expired session), so the customer gets a link either way.
      let setup = await provider.rechargeSetup({
        organizationId,
        customerId: await customer(organizationId),
        id: waiting.setup_id,
        sessionId: waiting.setup_session_id,
        createdAt: waiting.updated_at.toISOString(),
      });
      await store.saveSetup(organizationId, waiting.revision, setup);
      if (setup.expired) {
        const renewed = await store.readPolicy(organizationId);
        if (renewed?.status === "setup_required" && renewed.setup_session_id === null) {
          setup = await provider.rechargeSetup({
            organizationId,
            customerId: await customer(organizationId),
            id: renewed.setup_id,
            sessionId: null,
            createdAt: renewed.updated_at.toISOString(),
          });
          await store.saveSetup(organizationId, renewed.revision, setup);
        }
      }
      const updated = await store.readView(organizationId);
      return { ...updated, setup_url: updated.status === "setup_required" ? setup.url : null };
    }
    if (policy?.enabled && ["payment_required", "tax_required"].includes(policy.status)) {
      // the invoice that waits: its link for a payment that is due, its issue for a tax problem
      const waiting = (await inFlight(organizationId))[0];
      if (waiting) return { ...view, invoice_url: waiting.url, billing_issue: issueView(waiting) };
    }
    return view;
  }
  /**
   * What Stripe collected for a recharge invoice becomes credit, once, and its refunds and disputes take it back. True
   * when this call is the one that credited the payment. `reverse: false` looks at refunds only for a payment that was
   * credited just now.
   */
  async function settle(organizationId: string, invoice: RechargeInvoice, reverse = true) {
    if (invoice.state !== "paid" || invoice.paymentIntentId === null) return false;
    const granted = await persistence.grantPayment({
      organizationId,
      payment: {
        kind: "recharge",
        invoiceId: invoice.invoiceId,
        paymentIntentId: invoice.paymentIntentId,
        total: invoice.totalMinor,
      },
    });
    if (reverse || granted.granted)
      await persistence.reversePayment({
        organizationId,
        payment: { kind: "recharge", paymentIntentId: invoice.paymentIntentId },
        observation: await provider.observePaymentReversals({
          organizationId,
          customerId: await customer(organizationId),
          paymentIntentId: invoice.paymentIntentId,
          amountTotal: invoice.totalMinor,
        }),
      });
    return granted.granted;
  }
  /**
   * Credits the recharge invoices Stripe collected that the credit does not know yet, because the response of the
   * payment, its event or the credit itself was lost. Nothing new is bought before this has found nothing.
   */
  async function creditCollected(organizationId: string) {
    const customerId = await customer(organizationId);
    const since = new Date(d.clock.now().getTime() - HEAL_MS);
    let credited = false;
    for (const paid of await provider.findPaidRechargeInvoices({
      organizationId,
      customerId,
      paidSince: since,
    }))
      credited =
        (await settle(
          organizationId,
          await provider.observeRechargeInvoice({
            organizationId,
            customerId,
            id: paid.rechargeId,
            invoiceId: paid.invoiceId,
          }),
          false,
        )) || credited;
    return credited;
  }
  /** Takes one recharge invoice a step further: finalize, then pay once, then credit what was collected. */
  async function advance(
    organizationId: string,
    policy: RechargePolicy,
    found: InFlight,
    remainingMinor: number,
  ) {
    const paymentMethodId = policy.payment_method_id;
    const target = {
      organizationId,
      customerId: await customer(organizationId),
      id: found.rechargeId,
      invoiceId: found.invoiceId,
    };
    let invoice: RechargeInvoice = found;
    if (invoice.state === "paid" || invoice.state === "void") {
      await settle(organizationId, invoice);
      return;
    }
    // a payment that is due waits for the customer, who pays it from the invoice page
    if (policy.status === "payment_required") return;
    const allowed =
      policy.enabled &&
      paymentMethodId !== null &&
      ["on", "monthly_limit", "tax_required"].includes(policy.status) &&
      (await persistence.readOrganizationPaid({ organizationId })) !== null;
    if (!allowed) {
      await provider.voidRechargeInvoice(target);
      return;
    }
    if (invoice.state === "draft")
      invoice = await provider.finalizeRechargeInvoice({
        ...target,
        retryAfterTaxCorrection: policy.status === "tax_required",
      });
    if (invoice.state === "paid" || invoice.state === "void") {
      await settle(organizationId, invoice);
      return;
    }
    if (invoice.taxIssue !== null) {
      // only further initiation is blocked; the invoice is never discarded
      await store.transitionPolicy(organizationId, "tax_required", policy.revision);
      return;
    }
    if (policy.status === "tax_required")
      await store.transitionPolicy(organizationId, "on", policy.revision);
    if (invoice.state !== "open") return;
    if (invoice.totalMinor > remainingMinor) {
      // with tax the invoice is more than the limit leaves for this month
      await provider.voidRechargeInvoice(target);
      await store.transitionPolicy(organizationId, "monthly_limit", policy.revision);
      return;
    }
    // Initiating the payment is safe to repeat: an invoice is paid once, and Stripe answers the same key the same way.
    invoice = await provider.payRechargeInvoice({
      ...target,
      paymentMethodId: paymentMethodId as string,
      maximumMinor: remainingMinor,
    });
    if (invoice.state === "open") await store.transitionPolicy(organizationId, "payment_required");
    else await settle(organizationId, invoice);
  }
  /** An event about a recharge invoice: what was collected is credited, what was refunded is taken back. */
  async function reconcileRecharge(input: {
    organizationId: string;
    rechargeId: string;
    invoiceId: string;
  }) {
    const invoice = await provider.observeRechargeInvoice({
      organizationId: input.organizationId,
      customerId: await customer(input.organizationId),
      id: input.rechargeId,
      invoiceId: input.invoiceId,
    });
    await settle(input.organizationId, invoice);
  }
  async function processOrganization(organizationId: string) {
    const claimed = await store.claim(organizationId);
    if (!claimed) return;
    // a card that was saved meanwhile, a session that expired
    await getRecharge({ organizationId });
    const invoices = await inFlight(organizationId);
    if (invoices.length > 1) {
      // two recharges at once is never right: nothing moves until somebody has looked
      await store.transitionPolicy(organizationId, "reconciliation", claimed.policy.revision);
      return;
    }
    let found = invoices[0];
    if (
      !found &&
      (claimed.create || claimed.policy.status === "payment_required") &&
      (await creditCollected(organizationId))
    )
      // a payment that was never credited changes what is due: look again next time
      return;
    if (!found) {
      if (!claimed.create || claimed.policy.payment_method_id === null) return;
      const rechargeId = d.ids.next();
      const created = await provider.createRechargeInvoice({
        organizationId,
        customerId: await customer(organizationId),
        id: rechargeId,
        paymentMethodId: claimed.policy.payment_method_id,
        createdAt: d.clock.now().toISOString(),
      });
      found = { ...created, rechargeId };
    }
    await advance(
      organizationId,
      (await store.readPolicy(organizationId)) ?? claimed.policy,
      found,
      claimed.remainingMinor,
    );
  }
  /**
   * Ends the Stripe billing of one deleted organization, at most a bounded number of Stripe changes per pass. A closure
   * that is not finished stays open and continues once its lease runs out. A failure of any step, the claim included,
   * counts as failed and never stops the other organizations of the pass; a failed closure keeps its lease in the same way.
   */
  async function closeOneDeletedCustomer(): Promise<"none" | "closed" | "open" | "failed"> {
    let closing: { organizationId: string; customerId: string } | null = null;
    try {
      closing = await persistence.claimStripeBillingClosure({ configuration: d.configuration });
      if (closing === null) return "none";
      if (!(await provider.closeCustomer(closing)).closed) return "open";
      await persistence.finishStripeBillingClosure({ organizationId: closing.organizationId });
      return "closed";
    } catch {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "billing",
          code: "stripe_closure_failed",
          organization_id: closing?.organizationId ?? null,
        }),
      );
      return "failed";
    }
  }
  return {
    getRecharge,
    reconcileRecharge,
    async configureRecharge(input: {
      organizationId: string;
      actorId: string;
      idempotencyKey: string;
      enabled: boolean;
      monthlyLimitMinor: number;
      consent: string | null;
      revision: number;
    }) {
      await store.configure({ ...input, id: d.ids.next() });
      if (input.enabled) await d.ensureCustomer(input.organizationId, input.actorId);
      else await discard(input.organizationId);
      return getRecharge(input);
    },
    async syncRechargeBatch() {
      // A closure of a deleted organization takes one of the pass's three places; the candidates it leaves wait a pass.
      const closure = await closeOneDeletedCustomer();
      const candidates = (await store.candidates()).slice(0, closure === "none" ? 3 : 2);
      const results = await Promise.allSettled(
        candidates.map((row) => processOrganization(row.organization_id)),
      );
      // a closure that is still open made progress, so it counts as processed; the sync caller allows three in all
      const closing = closure === "closed" || closure === "open" ? 1 : 0;
      return {
        processed: results.filter((r) => r.status === "fulfilled").length + closing,
        failed:
          results.filter((r) => r.status === "rejected").length + (closure === "failed" ? 1 : 0),
      };
    },
  };
}
