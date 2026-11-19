import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readD1PgcfConfiguration } from "../src/d1-bindings.js";
import { readD1PgcfManagementBindings } from "../src/d1-pgcf-management.js";
import { readD1ProductDatabaseBindings } from "../src/d1-product-database.js";

const root = path.resolve(import.meta.dirname, "..");
const callable = new Proxy({}, { get: () => () => undefined });
async function profile(file: string) {
  const configuration = JSON.parse(
    (await readFile(path.join(root, file), "utf8"))
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/,\s*([}\]])/gu, "$1"),
  ) as {
    vars: Record<string, string>;
    secrets?: { required: string[] };
    services?: { binding: string; service: string; entrypoint: string }[];
    ratelimits?: { name: string }[];
  };
  return {
    vars: configuration.vars,
    secrets: configuration.secrets,
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

describe("database management Core profile", () => {
  it("binds the Core in every deployed profile with exactly the bindings its readers accept", async () => {
    for (const file of [
      "wrangler.development.jsonc",
      "wrangler.production.jsonc",
      "wrangler.pgcf.production.jsonc",
    ]) {
      const { vars, secrets, capabilities } = await profile(file);
      const configuration = JSON.parse(
        (await readFile(path.join(root, file), "utf8"))
          .replace(/^\s*\/\/.*$/gmu, "")
          .replace(/,\s*([}\]])/gu, "$1"),
      ) as { services: { binding: string }[] };
      // No mode flag and no provider identifier remains; Control is always the Core.
      expect(vars).toEqual({
        RUNTIME_CONFIGURATION_STATE: "configured",
        DATABASE_WEBHOOK_SECRET_KEY_VERSION: "1",
      });
      expect(secrets).toEqual({ required: ["DATABASE_WEBHOOK_SECRET_KEY_BASE64"] });
      const registries = Object.fromEntries(
        configuration.services
          .filter(({ binding }) => binding.startsWith("PROJECT_DATABASE_ADMIN_"))
          .map(({ binding }) => [binding, callable]),
      );
      // The remaining names are Worker secrets installed outside the repository.
      const environment = {
        ...vars,
        ...capabilities,
        ...registries,
        PGCF_API_URL: "https://pgcf.example",
        PGCF_APPS_PROJECT_ID: "prj_abcdefghij0123456789",
        PGCF_APPS_API_KEY: "k".repeat(24),
        DATABASE_WEBHOOK_SECRET_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
      };
      expect(() => readD1PgcfManagementBindings(environment)).not.toThrow();
      expect(() => readD1PgcfConfiguration(environment)).not.toThrow();
      expect(() => readD1ProductDatabaseBindings(environment)).not.toThrow();
      expect(() =>
        readD1PgcfManagementBindings({ ...environment, DATABASE_MANAGEMENT_RUNTIME: undefined }),
      ).toThrow();
      expect(() =>
        readD1ProductDatabaseBindings({ ...environment, DATABASE_PRODUCT_RUNTIME: undefined }),
      ).toThrow();
      expect(() => readD1PgcfConfiguration({ ...environment, CONTROL_CORE: {} })).toThrow();
    }
  });
});
