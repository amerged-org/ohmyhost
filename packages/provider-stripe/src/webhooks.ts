import Stripe from "stripe";

export interface StripeWebhookEvent {
  id: string;
  type: string;
  objectId: string;
}
const events = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.updated",
  "invoice.finalization_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "charge.dispute.updated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "refund.created",
  "refund.updated",
  "refund.failed",
]);

/** Signature-only entrypoint: no API client, network request or management credential. */
export async function verifyStripeWebhook(input: {
  payload: string;
  signature: string;
  secret: string;
  mode: "test" | "live";
  accountId: string;
}): Promise<StripeWebhookEvent> {
  if (
    !["test", "live"].includes(input.mode) ||
    !/^acct_[A-Za-z0-9_]{1,128}$/u.test(input.accountId) ||
    new TextEncoder().encode(input.payload).byteLength > 256 * 1024 ||
    input.signature.length > 4096 ||
    !input.secret.startsWith("whsec_")
  )
    throw new Error("stripe_webhook_invalid");
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(
      input.payload,
      input.signature,
      input.secret,
      300,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    throw new Error("stripe_webhook_invalid");
  }
  const object = event.data?.object;
  if (
    !/^evt_[A-Za-z0-9_]{1,128}$/u.test(event.id) ||
    event.livemode !== (input.mode === "live") ||
    (event.account !== undefined && event.account !== input.accountId) ||
    !events.has(event.type) ||
    !object ||
    !("id" in object) ||
    typeof object.id !== "string" ||
    !/^[A-Za-z0-9_]{1,256}$/u.test(object.id)
  )
    throw new Error("stripe_webhook_invalid");
  return { id: event.id, type: event.type, objectId: object.id };
}
