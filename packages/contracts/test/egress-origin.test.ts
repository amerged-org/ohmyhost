import { describe, expect, it } from "vitest";

import { isCustomerEgressOrigin, isDnsEgressOrigin } from "../src/egress-origin.js";

const LONGEST_LABEL = `https://${"a".repeat(63)}.example.com`;
const OVERLONG_LABEL = `https://${"a".repeat(64)}.example.com`;

describe("egress origin rule", () => {
  it.each([
    "https://api.example.com",
    "https://a.b",
    "https://xn--bcher-kva.example",
    LONGEST_LABEL,
  ])("admits the public DNS origin %s", (origin) => {
    expect(isDnsEgressOrigin(origin)).toBe(true);
    expect(isCustomerEgressOrigin(origin)).toBe(true);
  });

  it.each([
    "https://my_api.example.com",
    "https://example.com.",
    "https://intranet",
    OVERLONG_LABEL,
    "https://a.-b.example",
    "https://b-.example",
    "https://a..example",
    "https://API.example.com",
    "https://api.example.com:8443",
    "https://api.example.com/",
    "https://user@api.example.com",
    "http://api.example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://app.localhost",
    "https://service.internal",
    "https://device.local",
    "https://printer.lan",
    "https://nas.home.arpa",
    "https://laptop.localdomain",
    "https://intranet.corp",
  ])("refuses %s under the DNS rule", (origin) => {
    expect(isDnsEgressOrigin(origin)).toBe(false);
    expect(isCustomerEgressOrigin(origin)).toBe(false);
  });

  it.each([
    "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev",
    "https://connect.ohmyho.st",
    "https://dev.connect.ohmyho.st",
  ])("reserves the platform origin %s for platform use", (gateway) => {
    expect(isDnsEgressOrigin(gateway)).toBe(true);
    expect(isCustomerEgressOrigin(gateway)).toBe(false);
  });

  it("refuses values that are not strings", () => {
    expect(isDnsEgressOrigin(undefined)).toBe(false);
    expect(isDnsEgressOrigin(new URL("https://api.example.com"))).toBe(false);
    expect(isCustomerEgressOrigin(null)).toBe(false);
  });
});
