/** What Stripe reports of a payment's refunds and disputes, read afresh each time the payment is observed. */
export interface ReversalObservation {
  readonly accountId: string;
  readonly mode: "test" | "live";
  readonly customerId: string;
  readonly paymentIntentId: string;
  readonly currency: string;
  readonly paymentTotalMinor: number;
  readonly items: readonly {
    readonly id: string;
    readonly amountMinor: number;
    readonly status: string;
  }[];
  readonly disputes: readonly {
    readonly id: string;
    readonly amountMinor: number;
    readonly movements: readonly { readonly id: string; readonly direction: string }[];
  }[];
}

/** The payment the observation has to describe. */
export interface ReversalScope {
  readonly accountId: string;
  readonly mode: "test" | "live";
  readonly customerId: string;
  readonly paymentIntentId: string;
  readonly totalMinor: number;
}

const REFUND_STATUSES = ["pending", "requires_action", "succeeded", "failed", "canceled"];
const DIRECTIONS = ["withdrawn", "reinstated"];

function minor(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

/**
 * How much of a payment has been given back, in minor currency units: the refunds that succeeded plus every dispute
 * whose movements withdrew the money more often than they reinstated it, never more than the payment. A refund that is
 * still pending or failed has not left yet. The observation must describe exactly this payment.
 */
export function reversedMinor(scope: ReversalScope, observation: ReversalObservation): number {
  if (
    observation.accountId !== scope.accountId ||
    observation.mode !== scope.mode ||
    observation.customerId !== scope.customerId ||
    observation.paymentIntentId !== scope.paymentIntentId ||
    observation.currency !== "usd" ||
    observation.paymentTotalMinor !== scope.totalMinor ||
    observation.items.length > 1000 ||
    observation.disputes.length > 100
  )
    throw new Error("billing_refund_scope_conflict");
  const refunds = new Set<string>();
  let refunded = 0;
  for (const item of observation.items) {
    if (
      !/^re_[A-Za-z0-9_]{1,253}$/u.test(item.id) ||
      refunds.has(item.id) ||
      !REFUND_STATUSES.includes(item.status) ||
      minor(item.amountMinor, "billing_refund_invalid") > scope.totalMinor
    )
      throw new Error("billing_refund_invalid");
    refunds.add(item.id);
    if (item.status === "succeeded") refunded += item.amountMinor;
  }
  if (refunded > scope.totalMinor) throw new Error("billing_refund_exceeds_payment");
  const disputes = new Set<string>();
  const transactions = new Set<string>();
  let disputed = 0;
  for (const dispute of observation.disputes) {
    if (
      !/^du_[A-Za-z0-9_]{1,253}$/u.test(dispute.id) ||
      disputes.has(dispute.id) ||
      dispute.movements.length > 10
    )
      throw new Error("billing_dispute_invalid");
    minor(dispute.amountMinor, "billing_dispute_invalid");
    disputes.add(dispute.id);
    let net = 0;
    for (const movement of dispute.movements) {
      if (
        !/^txn_[A-Za-z0-9_]{1,252}$/u.test(movement.id) ||
        transactions.has(movement.id) ||
        !DIRECTIONS.includes(movement.direction)
      )
        throw new Error("billing_dispute_invalid");
      transactions.add(movement.id);
      net += movement.direction === "withdrawn" ? 1 : -1;
    }
    if (net > 0) disputed += dispute.amountMinor;
  }
  return Math.min(refunded + disputed, scope.totalMinor);
}
