// A checkout is not stored. Its id says what it is, so the request that asks for it again and the status that follows
// it find the same Stripe Checkout Session without any database row:
//   48 bits  the start of the ten-minute window the checkout was asked in; the session expires an hour after it
//    1 bit   the offer (1 = paid plan, 0 = top-up)
//    7 bits  the packs (1..100)
//   72 bits  the first bytes of SHA-256 over the organization, the actor and the idempotency key
// The same request within one window is the same checkout, and Stripe's own idempotency key makes its creation safe to
// repeat. The id is an ordinary ULID to everybody else.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A request repeated within this window is the same checkout. */
export const CHECKOUT_WINDOW_MS = 600_000;
/** How long a Checkout Session stays open, from the start of its window. */
export const CHECKOUT_LIFETIME_MS = 3_600_000;

export interface CheckoutIdentity {
  /** The start of the window, an ISO instant. */
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly offer: "paid" | "topup";
  readonly packs: number;
}

export async function checkoutIdFor(input: {
  organizationId: string;
  actorId: string;
  idempotencyKey: string;
  offer: "paid" | "topup";
  packs: number;
  now: Date;
}): Promise<string> {
  const start = Math.floor(input.now.getTime() / CHECKOUT_WINDOW_MS) * CHECKOUT_WINDOW_MS;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([input.organizationId, input.actorId, input.idempotencyKey]),
      ),
    ),
  );
  let tail = BigInt((input.offer === "paid" ? 0x80 : 0) | input.packs);
  for (const byte of digest.subarray(0, 9)) tail = (tail << 8n) | BigInt(byte);
  let head = "";
  let time = start;
  for (let index = 0; index < 10; index += 1) {
    head = (CROCKFORD[time % 32] as string) + head;
    time = Math.floor(time / 32);
  }
  let random = "";
  for (let index = 0; index < 16; index += 1) {
    random = (CROCKFORD[Number(tail & 31n)] as string) + random;
    tail >>= 5n;
  }
  return head + random;
}

/** What a checkout id says; null for an id that no checkout of this system was ever given. */
export function checkoutIdentity(id: string): CheckoutIdentity | null {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(id)) return null;
  let time = 0;
  for (const character of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(character);
  let tail = 0n;
  for (const character of id.slice(10)) tail = (tail << 5n) | BigInt(CROCKFORD.indexOf(character));
  const head = Number(tail >> 72n);
  const packs = head & 0x7f;
  const offer = head & 0x80 ? "paid" : "topup";
  if (
    time % CHECKOUT_WINDOW_MS !== 0 ||
    packs < 1 ||
    packs > 100 ||
    (offer === "paid" && packs !== 1)
  )
    return null;
  return {
    createdAt: new Date(time).toISOString(),
    expiresAt: new Date(time + CHECKOUT_LIFETIME_MS).toISOString(),
    offer,
    packs,
  };
}
