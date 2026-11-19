import { createHmac } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
/**
 * The signing secret of one webhook generation of a domain. Generation zero is the original v1 derivation, so receivers
 * configured before generations existed keep their secret; every URL change and every rotation advances the generation,
 * and the earlier secret then fails verification.
 */
export function mailWebhookSecret(root: string, domainId: string, generation = 0): string {
  if (
    !/^[A-Za-z0-9+/]{43}=$/u.test(root) ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(domainId) ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation > 2147483647
  )
    throw new TypeError("Invalid webhook signing configuration");
  const label =
    generation === 0
      ? `ohmyhost.mail-webhook/v1:${domainId}`
      : `ohmyhost.mail-webhook/v2:${domainId}:${generation}`;
  return `whsec_${createHmac("sha256", Buffer.from(root, "base64")).update(label).digest("base64")}`;
}
export function mailWebhookHeaders(
  body: string,
  eventId: string,
  secret: string,
  now: Date,
): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    "content-type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${eventId}.${timestamp}.${body}`)
      .digest("base64")}`,
  };
}
export function validateMailWebhookUrl(value: string): URL {
  const url = new URL(value);
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname.replace(/^\[|\]$/gu, "")) ||
    !url.hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(url.hostname) ||
    url.hostname.endsWith(".home.arpa")
  )
    throw new TypeError("Invalid webhook URL");
  return url;
}
export function isPublicMailAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const a = address.split(".").map(Number),
      x = a[0] ?? -1,
      y = a[1] ?? -1;
    return !(
      x === 0 ||
      x === 10 ||
      x === 127 ||
      x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || y === 0 || y === 2)) ||
      (x === 198 && (y === 18 || y === 19 || y === 51)) ||
      (x === 203 && y === 0)
    );
  }
  // Restrict IPv6 to global unicast; mapped IPv4, local, multicast and link-local cannot pass.
  return (
    isIP(address) === 6 && /^[23]/u.test(address) && !/^2001:(?:0:|db8:|10:|20:|2:)/iu.test(address)
  );
}
/** Resolve before every attempt; the Cloudflare public fetch transport also denies private destinations. */
export async function requirePublicMailWebhook(
  value: string,
  resolver: { v4: typeof resolve4; v6: typeof resolve6 } = { v4: resolve4, v6: resolve6 },
): Promise<URL> {
  const url = validateMailWebhookUrl(value);
  const addresses = await Promise.allSettled([
    resolver.v4(url.hostname),
    resolver.v6(url.hostname),
  ]);
  const found: string[] = [];
  for (const result of addresses) {
    if (result.status === "fulfilled")
      for (const address of result.value) {
        if (typeof address !== "string") throw new TypeError("Invalid DNS response");
        found.push(address);
      }
    else if (!(result.reason && ["ENODATA", "ENOTFOUND"].includes(result.reason.code)))
      throw new Error("Webhook DNS unavailable");
  }
  if (!found.length || found.some((address) => !isPublicMailAddress(address)))
    throw new TypeError("Webhook destination is not public");
  return url;
}
