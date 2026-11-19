import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function configuration(file: string): Promise<Record<string, unknown>> {
  const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  return JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
}

describe("functions scheduler deployable configuration", () => {
  it("binds the Worker bundle evidence beneath dist", async () => {
    const tsconfig = await configuration("tsconfig.build.json");
    const manifest = await configuration("package.json");
    expect(tsconfig["compilerOptions"]).toMatchObject({
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
    });
    expect(manifest["ohmyhost"]).toEqual({
      deployment: "production",
      fakeProviderBoundary: {
        typescriptProject: "tsconfig.build.json",
        artifactRoot: "dist",
        entrypoints: ["src/worker-main.ts"],
        bundles: [
          { entrypoint: "src/worker-main.ts", metafile: "dist/worker-bundle/metafile.json" },
        ],
      },
    });
  });

  it.each([
    [
      "wrangler.jsonc",
      "ohmyho-functions-scheduler",
      "disabled",
      "disabled",
      "ohmyho-wfp-egress-disabled",
    ],
    [
      "wrangler.development.jsonc",
      "ohmyho-functions-scheduler-poc-private-fullstack",
      "configured",
      "ohmyho-poc-private-fullstack",
      "ohmyho-wfp-egress-v3-poc-private-fullstack",
    ],
    [
      "wrangler.production.jsonc",
      "ohmyho-functions-scheduler-production",
      "configured",
      "ohmyho-production",
      "ohmyho-wfp-egress-production",
    ],
  ])(
    "%s runs the minute cron against its own dispatch namespace",
    async (file, name, state, namespace, egress) => {
      const config = await configuration(file);
      expect(config).toMatchObject({
        name,
        main: "src/worker-main.ts",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: false,
        preview_urls: false,
        triggers: { crons: ["* * * * *"] },
        vars: { RUNTIME_CONFIGURATION_STATE: state },
        dispatch_namespaces: [
          {
            binding: "CUSTOMER_DISPATCH",
            namespace,
            outbound: { service: egress, parameters: ["EGRESS_CONTEXT"] },
          },
        ],
      });
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("queues");
      expect(config).not.toHaveProperty("workflows");
      expect(JSON.stringify(config)).not.toMatch(/authorization|secret/iu);
    },
  );
});
