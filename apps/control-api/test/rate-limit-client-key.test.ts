import { describe, expect, it } from "vitest";

import { rateLimitClientKey } from "../src/rate-limit-client-key.js";

describe("rate-limit client keys", () => {
  it("keeps IPv4 addresses exact and maps IPv4-mapped IPv6 to the IPv4 address", () => {
    expect(rateLimitClientKey("192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitClientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitClientKey("::FFFF:C000:201")).toBe("192.0.2.1");
  });

  it("aggregates every IPv6 address of one /64 into one key", () => {
    const first = rateLimitClientKey("2001:db8::1");
    expect(rateLimitClientKey("2001:db8:0:0:ffff:ffff:ffff:ffff")).toBe(first);
    expect(rateLimitClientKey("2001:DB8::abcd")).toBe(first);
    expect(rateLimitClientKey("2001:db8:0:1::1")).not.toBe(first);
  });

  it("treats missing and malformed addresses as one unknown bucket", () => {
    expect(rateLimitClientKey(undefined)).toBe("unknown");
    expect(rateLimitClientKey("not-an-address")).toBe("unknown");
    expect(rateLimitClientKey(`${"1".repeat(65)}`)).toBe("unknown");
  });
});
