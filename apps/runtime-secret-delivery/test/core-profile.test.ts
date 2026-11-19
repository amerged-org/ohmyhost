import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { requireRuntimeSecretDeliveryBindings } from "../src/bindings.js";

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
    services: Object.fromEntries(
      (configuration.services ?? []).map(({ binding }) => [binding, callable]),
    ),
    limiters: Object.fromEntries(
      (configuration.ratelimits ?? []).map(({ name }) => [name, callable]),
    ),
  };
}

describe("runtime secret delivery Core profile", () => {
  it("binds Core in both deployed profiles with exactly the bindings its reader accepts", async () => {
    for (const file of ["wrangler.development.jsonc", "wrangler.production.jsonc"]) {
      const { vars, capabilities, services } = await profile(file);
      expect(Object.keys(capabilities)).toEqual([
        "PROJECT_PREVIEW_AUTHORITY",
        "PREVIEW_SECRET_AUTHORITY",
        "RUNTIME_SECRET_RUNTIME",
      ]);
      const bindings = {
        ...vars,
        ...services,
        ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
        ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: JSON.stringify({
          20261106: Buffer.alloc(32, 2).toString("base64"),
        }),
      };
      expect(() => requireRuntimeSecretDeliveryBindings(bindings)).not.toThrow();
      for (const name of [
        "PROJECT_PREVIEW_AUTHORITY",
        "PREVIEW_SECRET_AUTHORITY",
        "PREVIEW_MAIL_GATEWAY",
        "PREVIEW_STORAGE_GATEWAY",
        "PREVIEW_AI_GATEWAY",
      ]) {
        const partial = { ...bindings };
        Reflect.deleteProperty(partial, name);
        expect(() => requireRuntimeSecretDeliveryBindings(partial)).toThrow();
      }
    }
  });
});
