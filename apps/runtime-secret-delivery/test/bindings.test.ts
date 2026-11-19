import { describe, expect, it, vi } from "vitest";

import { requireRuntimeSecretDeliveryBindings } from "../src/bindings.js";

const core = new Proxy({}, { get: () => () => undefined });
const bindings = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured",
  RUNTIME_SECRET_RUNTIME: core,
  ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x41).toString("base64"),
  ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: JSON.stringify({
    2: Buffer.alloc(32, 0x42).toString("base64"),
  }),
  ENVIRONMENT_SECRET_KEY_VERSION: "2",
  WFP_MANAGEMENT: {
    stageVerifiedArtifact: vi.fn(),
    prepareExistingCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    compensateGatewayActivation: vi.fn(),
    compensateActivation: vi.fn(),
    removeCandidate: vi.fn(),
    observeActivation: vi.fn(),
    syncRuntimeSecrets: vi.fn(),
  },
});

describe("runtime secret delivery bindings", () => {
  it("accepts only the least-privilege private binding inventory", () => {
    const value = bindings();

    expect(requireRuntimeSecretDeliveryBindings(value)).toEqual(value);
    const initialKeyring = {
      ...value,
      ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: "{}",
      ENVIRONMENT_SECRET_KEY_VERSION: "1",
    };
    expect(requireRuntimeSecretDeliveryBindings(initialKeyring)).toEqual(initialKeyring);
    const qa = {
      ...value,
      RUNTIME_QA_PREVIEW_MAIL_ENABLED: "development-only-v1",
      QA_MAIL_KEY_AUTHORITY: { read: vi.fn() },
    };
    expect(requireRuntimeSecretDeliveryBindings(qa)).toEqual(qa);
    expect(Object.keys(requireRuntimeSecretDeliveryBindings(value)).sort()).toEqual([
      "ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON",
      "ENVIRONMENT_SECRET_KEY_BASE64",
      "ENVIRONMENT_SECRET_KEY_VERSION",
      "RUNTIME_CONFIGURATION_STATE",
      "RUNTIME_SECRET_RUNTIME",
      "WFP_MANAGEMENT",
    ]);
  });

  it.each([
    { ...bindings(), RUNTIME_CONFIGURATION_STATE: "disabled" },
    { ...bindings(), ENVIRONMENT_SECRET_KEY_BASE64: "not-a-key" },
    { ...bindings(), ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: "not-json" },
    (() => {
      const value = { ...bindings() } as Record<string, unknown>;
      Reflect.deleteProperty(value, "ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON");
      return value;
    })(),
    { ...bindings(), ENVIRONMENT_SECRET_KEY_VERSION: "0" },
    { ...bindings(), SOURCE_FETCHER: {} },
    { ...bindings(), CONTROL_CORE: {} },
    { ...bindings(), RUNTIME_QA_PREVIEW_MAIL_ENABLED: "development-only-v1" },
    { ...bindings(), QA_MAIL_KEY_AUTHORITY: { read: vi.fn() } },
    {
      ...bindings(),
      RUNTIME_QA_PREVIEW_MAIL_ENABLED: "production",
      QA_MAIL_KEY_AUTHORITY: { read: vi.fn() },
    },
    {
      ...bindings(),
      RUNTIME_QA_PREVIEW_MAIL_ENABLED: "development-only-v1",
      QA_MAIL_KEY_AUTHORITY: {},
    },
    { ...bindings(), RUNTIME_SECRET_RUNTIME: {} },
    (() => {
      const value = { ...bindings() } as Record<string, unknown>;
      Reflect.deleteProperty(value, "RUNTIME_SECRET_RUNTIME");
      return value;
    })(),
    { ...bindings(), WFP_MANAGEMENT: { stageVerifiedArtifact: vi.fn() } },
  ])("rejects missing, widened, or invalid authority %#", (value) => {
    expect(() => requireRuntimeSecretDeliveryBindings(value)).toThrow(TypeError);
  });
});
