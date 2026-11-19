import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireSchedulerBindings } from "../src/bindings.js";

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

describe("Functions scheduler Core profile", () => {
  it("binds exactly the Core capability its reader accepts in both deployed profiles", async () => {
    for (const file of ["wrangler.development.jsonc", "wrangler.production.jsonc"]) {
      const { vars, capabilities } = await profile(file);
      expect(Object.keys(capabilities)).toEqual(["CONTROL_FUNCTIONS_RUNTIME"]);
      expect(() =>
        requireSchedulerBindings({ ...vars, ...capabilities, CUSTOMER_DISPATCH: callable }),
      ).not.toThrow();
    }
  });
});
