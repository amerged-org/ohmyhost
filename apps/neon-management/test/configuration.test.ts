import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const parse = async (file: string) => {
  const source = await readFile(resolve(import.meta.dirname, "..", file), "utf8");
  return {
    source,
    config: JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1")),
  };
};

describe("database management deployment configuration", () => {
  it("has no public route, SQL binding, Hyperdrive origin or provider credential in any profile", async () => {
    const base = await parse("wrangler.jsonc"),
      development = await parse("wrangler.development.jsonc"),
      production = await parse("wrangler.production.jsonc"),
      pgcfProduction = await parse("wrangler.pgcf.production.jsonc");
    expect(base.config).toMatchObject({
      main: "src/worker-main.ts",
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: false },
      vars: { RUNTIME_CONFIGURATION_STATE: "disabled" },
    });
    expect(development.config).toMatchObject({
      name: "ohmyho-neon-management-poc-private-fullstack",
      workers_dev: false,
      preview_urls: false,
      vars: { RUNTIME_CONFIGURATION_STATE: "configured" },
    });
    expect(pgcfProduction.config).toMatchObject({
      name: "ohmyho-neon-management-production",
      main: "src/pgcf-worker-main.ts",
      workers_dev: false,
      preview_urls: false,
    });
    for (const { config, source } of [base, development, production, pgcfProduction]) {
      expect(config.routes).toBeUndefined();
      expect(config.hyperdrive).toBeUndefined();
      expect(config.d1_databases).toBeUndefined();
      expect(config.vars).toEqual(
        config === base.config
          ? { RUNTIME_CONFIGURATION_STATE: "disabled" }
          : { RUNTIME_CONFIGURATION_STATE: "configured", DATABASE_WEBHOOK_SECRET_KEY_VERSION: "1" },
      );
      expect(config.secrets).toEqual(
        config === base.config ? undefined : { required: ["DATABASE_WEBHOOK_SECRET_KEY_BASE64"] },
      );
      expect(source).not.toMatch(/NEON_|CONTROL_DATABASE_URL|CONTROL_STORAGE_PROVIDER/u);
      expect(config.services).toEqual(
        expect.arrayContaining(
          ["DATABASE_MANAGEMENT_RUNTIME", "DATABASE_PRODUCT_RUNTIME"].map((binding) =>
            expect.objectContaining({ binding, entrypoint: expect.stringMatching(/Runtime$/u) }),
          ),
        ),
      );
      // Usage is read on demand by the credit service; this Worker keeps nothing in the Core.
      expect(config.services).not.toContainEqual(
        expect.objectContaining({ binding: "PGCF_COLLECTION_RUNTIME" }),
      );
      expect(config.services).toEqual(
        expect.arrayContaining(
          ["PROJECT_DATABASE_ADMIN_US", "PROJECT_DATABASE_ADMIN_EU"].map((binding) =>
            expect.objectContaining({ binding, entrypoint: "ProjectDatabaseAdmin" }),
          ),
        ),
      );
    }
    expect(development.config.services).toEqual(
      expect.arrayContaining(
        ["DATABASE_MANAGEMENT_RUNTIME", "DATABASE_PRODUCT_RUNTIME"].map((binding) =>
          expect.objectContaining({
            binding,
            service: "ohmyho-control-store-poc-private-fullstack",
          }),
        ),
      ),
    );
  });
});
