/** One initial request and three retries; the original provider receipt owns the deadline. */
export const MAIL_ACCESS_WINDOW_MS = 72 * 60 * 60 * 1000;
export const MAIL_MAX_DELIVERY_ATTEMPTS = 4;
export const MAIL_RETRY_DELAYS_MS = [0, 1, 24, 71].map((hours) => hours * 3600000);
export const MAIL_RATE_CARD_ID = "resend-2026-09-22-v1";
export function mailPrice(quantity: bigint) {
  if (quantity < 0n) throw new TypeError("Invalid mail quantity");
  return { providerCostMicros: quantity * 900n, chargeMicros: quantity * 180000n };
}
export function mailDeliveryDecision(input: {
  receivedAt: number;
  firstAttemptAt: number | null;
  attempts: number;
  delivered: boolean;
  now: number;
}):
  | { state: "expired" | "delivered" | "delivery_failed" | "due" }
  | { state: "waiting"; nextAttemptAt: number } {
  if (
    !Number.isFinite(input.receivedAt) ||
    !Number.isFinite(input.now) ||
    (input.firstAttemptAt !== null && !Number.isFinite(input.firstAttemptAt)) ||
    !Number.isInteger(input.attempts) ||
    input.attempts < 0 ||
    input.attempts > MAIL_MAX_DELIVERY_ATTEMPTS ||
    (input.attempts > 0 && input.firstAttemptAt === null)
  )
    throw new TypeError("Invalid mail delivery state");
  if (input.now >= input.receivedAt + MAIL_ACCESS_WINDOW_MS) return { state: "expired" };
  if (input.delivered) return { state: "delivered" };
  if (input.attempts >= MAIL_MAX_DELIVERY_ATTEMPTS) return { state: "delivery_failed" };
  if (input.attempts === 0)
    return input.now >= input.receivedAt
      ? { state: "due" }
      : { state: "waiting", nextAttemptAt: input.receivedAt };
  const delay = MAIL_RETRY_DELAYS_MS[input.attempts];
  if (input.firstAttemptAt === null || delay === undefined)
    throw new TypeError("Invalid mail delivery state");
  const nextAttemptAt = input.firstAttemptAt + delay;
  return input.now >= nextAttemptAt ? { state: "due" } : { state: "waiting", nextAttemptAt };
}
