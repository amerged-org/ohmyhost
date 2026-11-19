import { expect, it } from "vitest";
import { nativeClientRateKey } from "../src/client-rate-key.js";

it("keys an IPv6 client by its /64 prefix, an IPv4-mapped address as its IPv4 address and any other value unchanged", () => {
  expect(nativeClientRateKey("192.0.2.1")).toBe("192.0.2.1");
  expect(nativeClientRateKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
  expect(nativeClientRateKey("::FFFF:C000:201")).toBe("192.0.2.1");
  expect(nativeClientRateKey("2001:DB8:0:1:FFFF:FFFF:FFFF:FFFF")).toBe(
    nativeClientRateKey("2001:db8:0:1::1"),
  );
  expect(nativeClientRateKey("2001:db8:0:2::1")).not.toBe(nativeClientRateKey("2001:db8:0:1::1"));
  expect(nativeClientRateKey("private-session:0a1b:2c3d")).toBe("private-session:0a1b:2c3d");
});
