import { describe, expect, it } from "vitest";

import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";

import { activateInput } from "../../src/catalog/gateway/contracts.js";

// Each origin passes or fails activation exactly as the one shared egress rule decides, so no stage admits what the
// contract refused earlier, and no stage refuses a platform gateway the platform injects itself.
const CORPUS = [
  "https://api.example.com",
  `https://${"a".repeat(63)}.example.com`,
  "https://my_api.example.com",
  "https://example.com.",
  "https://intranet",
  `https://${"a".repeat(64)}.example.com`,
  "https://a.-b.example",
  "https://203.0.113.10",
  "https://service.internal",
  "https://app.localhost",
  "https://api.example.com:8443",
  "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev",
];

describe("egress origin activation parity", () => {
  it.each(CORPUS)("activates %s exactly when the shared rule admits it", (origin) => {
    expect(activateInput.shape.egressAllowedOrigins.safeParse([origin]).success).toBe(
      isDnsEgressOrigin(origin),
    );
  });
});
