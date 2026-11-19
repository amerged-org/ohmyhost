import { createHash } from "node:crypto";

/** A dotted quad as its canonical text, or null when the text is not an IPv4 address. */
function ipv4(text: string): string | null {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    ? parts.map(Number).join(".")
    : null;
}

/** The eight 16-bit groups of an IPv6 address, four lowercase hex digits each, or null when the text is not one. */
function ipv6Groups(address: string): string[] | null {
  if (!address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const side = (text: string): string[] | null => {
    const parts = text === "" ? [] : text.split(":");
    const last = parts.at(-1);
    if (last?.includes(".") === true) {
      const octets = ipv4(last)?.split(".").map(Number);
      if (octets === undefined) return null;
      parts.splice(
        -1,
        1,
        ((octets[0] as number) * 256 + (octets[1] as number)).toString(16),
        ((octets[2] as number) * 256 + (octets[3] as number)).toString(16),
      );
    }
    return parts.every((part) => /^[0-9a-f]{1,4}$/u.test(part)) ? parts : null;
  };
  const head = side(halves[0] as string),
    tail = halves.length === 2 ? side(halves[1] as string) : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map(
    (group) => group.padStart(4, "0"),
  );
}

/** What identifies the caller's source: the IPv4 address, or an IPv6 address by its /64, or null for no address. */
function sourceKey(text: string): string | null {
  const groups = ipv6Groups(text);
  if (groups === null) return ipv4(text);
  if (groups.slice(0, 5).every((group) => group === "0000") && groups[5] === "ffff") {
    const high = parseInt(groups[6] as string, 16),
      low = parseInt(groups[7] as string, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return groups.slice(0, 4).join(":");
}

/**
 * The source bucket of an anonymous request, 0 to 255, derived from `cf-connecting-ip` here and passed to the store, never
 * read from a body field. An IPv6 address counts by its /64, which one subscriber holds; an IPv4-mapped IPv6 address
 * counts as the IPv4 address it carries. Only this bucket is stored: it is a digest byte of the address, so it cannot
 * identify a visitor. A missing or unparseable address has no bucket (null); the store then applies the shared pool only.
 */
export function sourceBucket(address: string | null): number | null {
  const key = sourceKey((address ?? "").trim().toLowerCase());
  return key === null
    ? null
    : (createHash("sha256")
        .update("omh-intake-source\0" + key)
        .digest()[0] as number);
}

let lastMissingSourceLine = Number.NEGATIVE_INFINITY;
/** True at most once a minute per isolate, so a header that stays missing writes one log line a minute, not one a request. */
export function shouldLogMissingSource(nowMs: number): boolean {
  if (nowMs - lastMissingSourceLine < 60_000 && nowMs >= lastMissingSourceLine) return false;
  lastMissingSourceLine = nowMs;
  return true;
}
