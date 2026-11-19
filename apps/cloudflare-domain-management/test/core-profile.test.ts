import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireCloudflareDomainManagementBindings } from "../src/bindings.js";

const root = path.resolve(import.meta.dirname, "..");
const callable = new Proxy({}, { get: () => () => undefined });
async function profile(file: string) {
  const configuration = JSON.parse(
    (await readFile(path.join(root, file), "utf8"))
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/,\s*([}\]])/gu, "$1"),
  ) as {
    vars: Record<string, string>;
    services?: { binding: string; service: string; entrypoint: string }[];
    ratelimits?: { name: string }[];
  };
  return {
    vars: configuration.vars,
    capabilities: Object.fromEntries(
      (configuration.services ?? [])
        .filter(({ service }) => service.startsWith("ohmyho-control-store-"))
        .map(({ binding }) => [binding, callable]),
    ),
    limiters: Object.fromEntries(
      (configuration.ratelimits ?? []).map(({ name }) => [name, callable]),
    ),
  };
}

describe("Cloudflare domain management Core profile", () => {
  it("binds the Core in both deployed profiles with exactly the bindings its reader accepts", async () => {
    for (const file of ["wrangler.development.jsonc", "wrangler.production.jsonc"]) {
      const { vars, capabilities } = await profile(file);
      const configuration = JSON.parse(
        (await readFile(path.join(root, file), "utf8"))
          .replace(/^\s*\/\/.*$/gmu, "")
          .replace(/,\s*([}\]])/gu, "$1"),
      ) as { services: { binding: string }[] };
      expect(Object.keys(capabilities).sort()).toEqual([
        "APPLICATION_IDENTITY_RUNTIME",
        "GENERAL_CF_RUNTIME",
        "MAIL_DNS_RUNTIME",
        "SCOPED_DNS_RUNTIME",
      ]);
      const probes = Object.fromEntries(
        configuration.services
          .filter(({ binding }) =>
            [
              "DEV_ACCESS",
              "RUNTIME_PROBES",
              "NATIVE_AUTH_ADMIN_US",
              "NATIVE_AUTH_ADMIN_EU",
            ].includes(binding),
          )
          .map(({ binding }) => [binding, callable]),
      );
      expect(() =>
        requireCloudflareDomainManagementBindings({
          ...vars,
          ...capabilities,
          ...probes,
          CLOUDFLARE_OAUTH_CLIENT_SECRET: "s".repeat(24),
          CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
          CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "p".repeat(24),
          CLOUDFLARE_SAAS_API_TOKEN: "w".repeat(24),
        }),
      ).not.toThrow();
    }
  });
});
