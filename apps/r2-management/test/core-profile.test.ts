import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireR2ManagementBindings } from "../src/bindings.js";

const root = path.resolve(import.meta.dirname, "..");
const callable = new Proxy({}, { get: () => () => undefined });
async function profile(file: string) {
  const configuration = JSON.parse(
    (await readFile(path.join(root, file), "utf8"))
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/,\s*([}\]])/gu, "$1"),
  ) as {
    vars: Record<string, string>;
    triggers?: unknown;
    services?: { binding: string; service: string; entrypoint: string }[];
    ratelimits?: { name: string }[];
  };
  return {
    vars: configuration.vars,
    triggers: configuration.triggers,
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

describe("R2 management Core profile", () => {
  it("binds Core in every configured profile with exactly the bindings its reader accepts", async () => {
    for (const file of [
      "wrangler.development.jsonc",
      "wrangler.production.jsonc",
      "wrangler.sandbox.jsonc",
    ]) {
      const { vars, capabilities, triggers } = await profile(file);
      // Usage is read on demand over the service binding; this Worker has no schedule of its own.
      expect(triggers).toBeUndefined();
      expect(Object.keys(capabilities)).toEqual(["R2_MANAGEMENT_RUNTIME"]);
      expect(() =>
        requireR2ManagementBindings({
          ...vars,
          ...capabilities,
          CLOUDFLARE_R2_API_TOKEN: "t".repeat(24),
          CLOUDFLARE_R2_ANALYTICS_TOKEN: "a".repeat(24),
        }),
      ).not.toThrow();
    }
  });
});
