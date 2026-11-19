import { createHmac, timingSafeEqual } from "node:crypto";

export async function verifyResendWebhook(
  body: string,
  headers: Headers,
  secret: string,
  now: Date,
): Promise<string> {
  const id = headers.get("svix-id"),
    timestamp = headers.get("svix-timestamp"),
    signatures = headers.get("svix-signature");
  if (
    !id ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(id) ||
    !timestamp ||
    !/^\d{1,12}$/u.test(timestamp) ||
    !Number.isFinite(now.getTime()) ||
    Math.abs(now.getTime() - Number(timestamp) * 1000) > 300000 ||
    !signatures ||
    !/^whsec_[A-Za-z0-9+/]+=*$/u.test(secret)
  )
    throw new TypeError("Invalid webhook signature");
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16) throw new TypeError("Invalid webhook secret");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of signatures.split(" ")) {
    if (!part.startsWith("v1,")) continue;
    const actual = Buffer.from(part.slice(3), "base64");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return id;
  }
  throw new TypeError("Invalid webhook signature");
}
