import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Cloudflare domain-management deployment configuration", () => {
  it("is route-free, disabled by default, and declares no secret value", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(resolve(root, "wrangler.jsonc"), "utf8");
    const parsed = JSON.parse(
      source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n")
        .replace(/,\s*([}\]])/gu, "$1"),
    );

    expect(parsed.workers_dev).toBe(false);
    expect(parsed.preview_urls).toBe(false);
    expect(parsed.compatibility_flags).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
    expect(parsed.vars.RUNTIME_CONFIGURATION_STATE).toBe("disabled");
    expect(parsed.vars.CLOUDFLARE_OAUTH_STATE_FORMAT).toBe("json-v1");
    expect(parsed.routes).toBeUndefined();
    expect(parsed.services).toEqual([
      {
        binding: "NATIVE_AUTH_ADMIN_US",
        service: "ohmyho-native-auth-disabled-us",
        entrypoint: "NativePolicyService",
      },
      {
        binding: "NATIVE_AUTH_ADMIN_EU",
        service: "ohmyho-native-auth-disabled-eu",
        entrypoint: "NativePolicyService",
      },
      ...[
        ["GENERAL_CF_RUNTIME", "CloudflareDomainRuntime"],
        ["SCOPED_DNS_RUNTIME", "ScopedDnsRuntime"],
        ["APPLICATION_IDENTITY_RUNTIME", "ApplicationIdentityRuntime"],
        ["MAIL_DNS_RUNTIME", "MailDnsRuntime"],
      ].map(([binding, entrypoint]) => ({
        binding,
        service: "ohmyho-control-store-disabled",
        entrypoint,
      })),
      {
        binding: "RUNTIME_PROBES",
        service: "ohmyho-control-api-disabled",
        entrypoint: "RuntimeCreditService",
      },
      {
        binding: "DEV_ACCESS",
        service: "ohmyho-control-api-sandbox",
        entrypoint: "DevAccessService",
      },
    ]);
    expect(parsed.vars.CLOUDFLARE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(parsed.vars.CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64).toBeUndefined();
    expect(parsed.vars.CLOUDFLARE_PLATFORM_DOMAIN_API_TOKEN).toBeUndefined();
  });
});
