import { describe, expect, it } from "vitest";
import { parseSharedGatewayReceipt } from "./shared-gateway.js";

const receipt = {
  provider: "ohmyhost-shared-gateway",
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  environmentId: "00000000000000000000000003",
  environmentName: "prod",
  handle: "project-one",
  hostname: "project-one.check.omh.st",
  publicOrigin: "https://project-one.check.omh.st",
  targetDeploymentId: "00000000000000000000000004",
  targetScriptName: "p-00000000000000000000000002-prod-00000000000000000000000004",
  targetArtifactDigest: `sha256:${"a".repeat(64)}`,
  targetProviderTag: "candidate-version",
  egressPolicyDigest: `sha256:${"b".repeat(64)}`,
  egressAllowedOrigins: ["https://api.example.com"],
  candidateReceiptId: "00000000000000000000000005",
  revision: 1,
  predecessorRevision: null,
  operationId: "00000000000000000000000006",
  active: true,
  observedAt: "2026-09-22T12:00:00.000Z",
};

describe("shared gateway receipt contract", () => {
  it("normalizes the exact current wire shape and rejects malformed or legacy routing authority", () => {
    const parsed = parseSharedGatewayReceipt(receipt);
    expect(parsed).toEqual({ ...receipt, observedAt: new Date(receipt.observedAt) });
    expect(parseSharedGatewayReceipt(parsed)).toEqual(parsed);
    expect(Object.isFrozen(parsed.egressAllowedOrigins)).toBe(true);
    // A first deployment after failed history starts a new root at a later revision.
    expect(parseSharedGatewayReceipt({ ...receipt, revision: 3 })).toMatchObject({
      revision: 3,
      predecessorRevision: null,
    });
    for (const change of [
      { provider: "cloudflare-project-gateway" },
      { scriptName: "legacy" },
      { projectId: "bad" },
      { environmentName: "stage" },
      { handle: "-invalid" },
      { hostname: "other.example.com" },
      { publicOrigin: "https://project-one.check.omh.st/" },
      { publicOrigin: "not-a-url" },
      { targetScriptName: "other-tenant" },
      { targetArtifactDigest: "unknown" },
      { targetProviderTag: "secret\n" },
      { revision: 0 },
      { predecessorRevision: 1 },
      { revision: 2, predecessorRevision: 2 },
      { revision: 3, predecessorRevision: 0 },
      { active: "true" },
      { egressAllowedOrigins: ["http://api.example.com"] },
      { egressAllowedOrigins: ["https://b.example.com", "https://a.example.com"] },
      { egressAllowedOrigins: ["https://127.0.0.1"] },
      { egressAllowedOrigins: ["https://api.example.lan"] },
      { hostname: "project-one.corp", publicOrigin: "https://project-one.corp" },
      { observedAt: "2026-09-22T12:00:00Z" },
      { observedAt: "bad" },
    ])
      expect(() => parseSharedGatewayReceipt({ ...receipt, ...change })).toThrow();
    for (const value of [null, [], {}, { ...receipt, observedAt: null }])
      expect(() => parseSharedGatewayReceipt(value)).toThrow();
  });
});
