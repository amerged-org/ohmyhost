import { describe, expect, it } from "vitest";
import {
  StorageGatewayReadinessError,
  requireStorageGatewayBindings,
  readStorageGatewayScope,
} from "../src/bindings.js";

const valid = {
  RUNTIME_CONFIGURATION_STATE: "configured",
  CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000001",
  CLOUDFLARE_R2_API_TOKEN: `token-${"x".repeat(32)}`,
  CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "a".repeat(32),
};

describe("storage gateway bindings", () => {
  it("requires a complete immutable deployment scope instead of accepting caller-chosen data identity", () => {
    const scope = {
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      dataEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    };
    expect(readStorageGatewayScope(scope)).toEqual(scope);
    for (const value of [
      undefined,
      null,
      [],
      {},
      { ...scope, extra: true },
      { ...scope, dataEnvironmentId: "bad" },
    ])
      expect(readStorageGatewayScope(value)).toBeNull();
  });
  it("accepts only the exact credential-separated inventory", () => {
    expect(requireStorageGatewayBindings(valid)).toEqual(valid);
    for (const input of [
      {},
      { ...valid, EXTRA: true },
      { ...valid, CLOUDFLARE_R2_API_TOKEN: "short" },
    ]) {
      expect(() => requireStorageGatewayBindings(input)).toThrow(StorageGatewayReadinessError);
    }
  });

  it("rejects a direct Core database binding next to the capability", () => {
    for (const name of ["CONTROL_CORE", "CONTROL_GLOBAL", "CONTROL_DIRECTORY", "CONTROL_SHARD_1"])
      expect(() => requireStorageGatewayBindings({ ...valid, [name]: {} })).toThrow(
        "mixed Control authority",
      );
  });

  it("reports missing parent capability metadata without exposing its value", () => {
    const secret = `must-not-leak-${"x".repeat(32)}`;
    try {
      requireStorageGatewayBindings({
        ...valid,
        CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: secret.slice(0, 8),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageGatewayReadinessError);
      expect(error).toMatchObject({
        code: "storage_gateway_provider_not_ready",
        binding: "CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID",
      });
      expect(String(error)).not.toContain(secret);
    }
  });
});
