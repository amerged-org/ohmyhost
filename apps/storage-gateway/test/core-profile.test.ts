import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireStorageGatewayBindings } from "../src/bindings.js";

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

describe("storage gateway Core profile", () => {
  it("binds the Core capabilities in both deployed profiles with exactly the bindings its reader accepts", async () => {
    for (const file of ["wrangler.development.jsonc", "wrangler.production.jsonc"]) {
      const { vars, capabilities, limiters } = await profile(file);
      expect(Object.keys(capabilities).sort()).toEqual([
        "STORAGE_DATA_RUNTIME",
        "STORAGE_GATEWAY_RUNTIME",
      ]);
      expect(() =>
        requireStorageGatewayBindings({
          ...vars,
          ...capabilities,
          ...limiters,
          CLOUDFLARE_R2_API_TOKEN: "t".repeat(24),
          CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "A".repeat(20),
        }),
      ).not.toThrow();
    }
  });
});
