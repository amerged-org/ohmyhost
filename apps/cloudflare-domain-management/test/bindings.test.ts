import { describe, expect, it } from "vitest";

import { requireCloudflareDomainManagementBindings } from "../src/bindings.js";

const valid = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
  CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st",
  CLOUDFLARE_SAAS_API_TOKEN: "saas-domain-token-value",
  CLOUDFLARE_OAUTH_CLIENT_ID: "oauth-client-id",
  CLOUDFLARE_OAUTH_CLIENT_SECRET: "oauth-client-secret-value",
  CLOUDFLARE_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback",
  CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1",
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 0x41).toString("base64"),
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "1",
  CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "platform-web-domain-token-value",
  DEV_ACCESS: { issueRuntimeProbe: async () => ({}) },
  RUNTIME_PROBES: { beginProbe: async () => ({}) },
  GENERAL_CF_RUNTIME: {},
  NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: async () => ({ outcome: "applied" }) },
  NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: async () => ({ outcome: "applied" }) },
  SCOPED_DNS_RUNTIME: {},
  APPLICATION_IDENTITY_RUNTIME: {},
  MAIL_DNS_RUNTIME: {},
});

describe("Cloudflare domain-management Worker bindings", () => {
  it("accepts only the exact configured credential and provider inventory", () => {
    const input = valid();
    expect(requireCloudflareDomainManagementBindings(input)).toBe(input);
    const historicalReaders = {
      ...input,
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "20261106",
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON: JSON.stringify({
        1: input.CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64,
      }),
    };
    expect(requireCloudflareDomainManagementBindings(historicalReaders)).toBe(historicalReaders);
    const production = {
      ...input,
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://app.ohmyho.st/v1/cloudflare/oauth/callback",
      CLOUDFLARE_SAAS_CNAME_TARGET: "customers.ohmyho.st",
    };
    expect(requireCloudflareDomainManagementBindings(production)).toBe(production);
    expect(() =>
      requireCloudflareDomainManagementBindings({
        ...production,
        CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st",
      }),
    ).toThrow("bindings are invalid");
    expect(() =>
      requireCloudflareDomainManagementBindings({
        ...input,
        CLOUDFLARE_SAAS_CNAME_TARGET: "customers.poc.aixyte.com",
      }),
    ).toThrow("bindings are invalid");
    expect(() =>
      requireCloudflareDomainManagementBindings({ ...input, CLOUDFLARE_SAAS_API_TOKEN: undefined }),
    ).toThrow("bindings are invalid");
    expect(() =>
      requireCloudflareDomainManagementBindings({
        ...input,
        CLOUDFLARE_OAUTH_REDIRECT_URI:
          "https://ohmyho-control-api-sandbox.your-omh-account.workers.dev/v1/cloudflare/oauth/callback",
      }),
    ).toThrow("bindings are invalid");
  });

  it.each([
    ["disabled state", { RUNTIME_CONFIGURATION_STATE: "disabled" }],
    ["unknown account", { CLOUDFLARE_ACCOUNT_ID: "not-an-id" }],
    ["wrong customer CNAME", { CLOUDFLARE_SAAS_CNAME_TARGET: "attacker.example" }],
    ["wrong callback", { CLOUDFLARE_OAUTH_REDIRECT_URI: "https://attacker.example/callback" }],
    ["wrong state format", { CLOUDFLARE_OAUTH_STATE_FORMAT: "legacy" }],
    ["short OAuth secret", { CLOUDFLARE_OAUTH_CLIENT_SECRET: "short" }],
    ["malformed cipher key", { CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: "not-base64" }],
    ["missing platform token", { CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: undefined }],
    ["missing runtime-probe issuer", { DEV_ACCESS: undefined }],
    ["missing Core capability", { GENERAL_CF_RUNTIME: undefined }],
    ["Core capability that is no object", { MAIL_DNS_RUNTIME: "not-a-service" }],
  ])("rejects %s", (_name, override) => {
    expect(() => requireCloudflareDomainManagementBindings({ ...valid(), ...override })).toThrow(
      "bindings are invalid",
    );
  });

  it("rejects an undeclared capability even when every required binding is present", () => {
    for (const value of [
      undefined,
      "{",
      "[]",
      "null",
      JSON.stringify({ 1: Buffer.alloc(32).toString("base64") }),
      JSON.stringify({ 2: true }),
    ]) {
      expect(() =>
        requireCloudflareDomainManagementBindings({
          ...valid(),
          CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON: value,
        }),
      ).toThrow("bindings are invalid");
    }
    expect(() =>
      requireCloudflareDomainManagementBindings({ ...valid(), EXTRA_PROVIDER_TOKEN: "secret" }),
    ).toThrow("bindings are invalid");
  });
});
