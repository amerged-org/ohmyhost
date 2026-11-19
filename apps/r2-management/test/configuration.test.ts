import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("R2 management Worker configuration", () => {
  it("keeps both bundles private and the sandbox credential outside checked-in config", async () => {
    const [disabledSource, sandboxSource] = await Promise.all([
      readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
      readFile(new URL("../wrangler.sandbox.jsonc", import.meta.url), "utf8"),
    ]);
    const parse = (source: string) =>
      JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1")) as Record<
        string,
        unknown
      >;
    const disabled = parse(disabledSource);
    const sandbox = parse(sandboxSource);

    expect(disabled).toMatchObject({
      name: "ohmyho-r2-management",
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: false },
      vars: {
        RUNTIME_CONFIGURATION_STATE: "disabled",
        CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      },
    });
    expect(sandbox).toMatchObject({
      name: "ohmyho-r2-management-sandbox",
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: false },
      vars: {
        RUNTIME_CONFIGURATION_STATE: "configured",
        CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000001",
      },
    });
    for (const configuration of [disabled, sandbox]) {
      expect(configuration).not.toHaveProperty("routes");
      expect(configuration).not.toHaveProperty("d1_databases");
    }
    expect(disabled).not.toHaveProperty("services");
    expect(sandbox["services"]).toEqual([
      {
        binding: "R2_MANAGEMENT_RUNTIME",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "R2ManagementRuntime",
      },
    ]);
    expect(disabledSource).not.toContain('CLOUDFLARE_R2_API_TOKEN":');
    expect(sandboxSource).not.toContain('CLOUDFLARE_R2_API_TOKEN":');

    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["deploy:sandbox:dry-run"]).toMatch(/^pnpm sandbox:preflight && /u);
  });
});
