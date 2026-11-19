import { describe, expect, it } from "vitest";
import {
  classifyPlatformGatewayHostname,
  createPinnedStorageGatewayOrigin,
  parsePinnedStorageGatewayOrigin,
} from "../src/platform-origins.js";

const base = "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev";
const scope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  dataEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
};
const pinned = `https://s1-${scope.organizationId.toLowerCase()}.${scope.environmentId.toLowerCase()}-${scope.dataEnvironmentId.toLowerCase()}.${new URL(base).hostname}`;

describe("deployment-bound storage gateway origin", () => {
  it("round-trips the complete pinned data scope with canonical bounded DNS labels", () => {
    expect(createPinnedStorageGatewayOrigin(base, scope)).toBe(pinned);
    expect(parsePinnedStorageGatewayOrigin(pinned)).toEqual({ baseOrigin: base, ...scope });
    const labels = new URL(pinned).hostname.split(".");
    expect(labels.slice(0, 2).map((label) => label.length)).toEqual([29, 53]);
    expect(labels.every((label) => label.length <= 63)).toBe(true);
    expect(new URL(pinned).hostname.length).toBeLessThanOrEqual(253);
    expect(Object.isFrozen(parsePinnedStorageGatewayOrigin(pinned))).toBe(true);
    for (const invalid of [
      null,
      "",
      base,
      pinned.toUpperCase(),
      `${pinned}/`,
      `${pinned}:443`,
      `${pinned}?query=x`,
      `${pinned}#fragment`,
      pinned.replace("https:", "http:"),
      pinned.replace("https://", "https://user:pass@"),
      pinned.replace("s1-", "s2-"),
      pinned.replace(scope.organizationId.toLowerCase(), "8".repeat(26)),
      pinned.replace(scope.environmentId.toLowerCase(), "bad"),
      pinned.replace(".your-omh-account.", "." + "a".repeat(64) + "."),
      pinned.replace("storage-gateway", "mail-gateway"),
    ])
      expect(parsePinnedStorageGatewayOrigin(invalid), String(invalid)).toBeNull();
    for (const invalid of [
      null,
      {},
      { ...scope, organizationId: scope.organizationId.toLowerCase() },
      { ...scope, environmentId: `${scope.environmentId}\n` },
      { ...scope, dataEnvironmentId: "8".repeat(26) },
    ])
      expect(() => createPinnedStorageGatewayOrigin(base, invalid)).toThrow(TypeError);
    for (const invalid of [
      base + "/",
      base + ":443",
      base + "?x=1",
      base.replace("storage", "mail"),
      pinned,
    ])
      expect(() => createPinnedStorageGatewayOrigin(invalid, scope)).toThrow(TypeError);
  });

  it("keeps every prefixed platform gateway family private even when its pin is malformed", () => {
    for (const [host, gateway] of [
      [new URL(base).hostname, "storage"],
      [new URL(pinned).hostname, "storage"],
      [`broken.${new URL(base).hostname}`, "storage"],
      [`s2-bad.scope.${new URL(base).hostname}`, "storage"],
      [`${new URL(base).hostname}.`, "storage"],
      [new URL(base.replace("storage", "mail")).hostname, "mail"],
      [`bad.${new URL(base.replace("storage", "mail")).hostname}`, "mail"],
      [`${new URL(base).hostname}.evil.example`, null],
      [`evil-${new URL(base).hostname}`, null],
      ["example.test", null],
      [null, null],
    ] as const)
      expect(classifyPlatformGatewayHostname(host), String(host)).toBe(gateway);
  });
});
