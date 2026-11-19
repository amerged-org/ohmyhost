import { isIP } from "node:net";

/**
 * The client a Native Auth rate bucket counts, with the per-source rule of D536: IPv4 as it is, an IPv4-mapped IPv6
 * address as its IPv4 address, and any other IPv6 address by its /64 prefix, so one client that rotates addresses
 * inside its prefix shares one bucket. A value that is not an IP address, such as a private-session identity, is
 * returned unchanged.
 */
export function nativeClientRateKey(value: string): string {
  if (isIP(value) === 0) return value;
  const address = value.toLowerCase();
  if (isIP(address) === 4) return address;
  const groups = ipv6Groups(address);
  if (groups === null) return value;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join(".");
  }
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(":")}::/64`;
}

function ipv6Groups(address: string): number[] | null {
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const embedded = text.slice(lastColon + 1);
  if (embedded.includes(".")) {
    const octets = embedded.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === undefined || halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}
