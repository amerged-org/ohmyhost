import { describe, expect, it } from "vitest";
import { parseOhmyhostConfig } from "@ohmyhost/contracts";
import { normalizeApplicationRoot } from "@ohmyhost/contracts/application-root";
import { classifyFrameworkFamily } from "@ohmyhost/contracts/framework-family";
import { parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import { createAstroFrameworkAdapter } from "./index.js";

const files = ["package.json", "package-lock.json", "astro.config.mjs", "src/pages/index.astro"];
const staticSource = 'export default { output: "static" };';
const edgeSource =
  'import cloudflare from "@astrojs/cloudflare"; export default { output: "server", adapter: cloudflare({ imageService: "passthrough" }), session: false };';
async function plan(
  mode: "static" | "edge",
  source = mode === "static" ? staticSource : edgeSource,
  extra = {},
) {
  const manifest = {
    packageManager: "npm@11.5.1",
    scripts: { build: "astro build" },
    dependencies: {
      astro: "7.4.0",
      ...(mode === "edge" ? { "@astrojs/cloudflare": "14.4.0" } : {}),
    },
  };
  const adapter = createAstroFrameworkAdapter({
    loadPackageJson: async () => manifest,
    loadAstroConfig: async () => source,
  });
  const application = { root: normalizeApplicationRoot("."), files };
  return adapter.plan({
    repositoryConfig: parseOhmyhostConfig({
      version: 1,
      project: "astro-app",
      build: {
        install: "npm ci --ignore-scripts",
        command: "npm run build",
        output: mode === "static" ? "dist" : "dist/client",
      },
      runtime: { mode },
      ...extra,
    }),
    repositoryConfigEvidence: {
      scope: "repository",
      path: "ohmyhost.yaml",
      reason: "root configuration",
    },
    application,
    detection: await adapter.detect(application),
  });
}

describe("native Astro source admission and deployment plans", () => {
  it("recognizes Astro over its Vite build dependency and creates strict static and edge plans", async () => {
    expect(classifyFrameworkFamily(new Set(["astro", "vite"]))).toBe("astro");
    expect(classifyFrameworkFamily(new Set(["astro", "next"]))).toBe("ambiguous");
    for (const mode of ["static", "edge"] as const) {
      const result = await plan(mode);
      expect(result.adapter).toBe("astro");
      expect(parseNewProductionFrameworkPlan(result)).toEqual(result);
      expect(result.outputDirectory).toBe(mode === "static" ? "dist" : "dist/client");
    }
  });
  it("refuses unsupported provider resources, custom paths and runtime mismatches with actionable diagnostics", async () => {
    for (const source of [
      edgeSource.replace("session: false", "session: {}"),
      edgeSource.replace("passthrough", "cloudflare-binding"),
      edgeSource.replace('output: "server"', 'srcDir: "./app", output: "server"'),
      edgeSource.replace('output: "server"', 'outDir: "./other", output: "server"'),
    ]) {
      await expect(plan("edge", source)).rejects.toMatchObject({
        diagnostic: { code: "astro_config_unsupported", path: "astro.config.mjs" },
      });
    }
    await expect(plan("static", staticSource, { mail: { enabled: true } })).rejects.toMatchObject({
      diagnostic: { code: "runtime_mode_unsupported" },
    });
  });
  it("admits dev-server options outside Astro's build object and refuses build output keys inside it", async () => {
    for (const source of [
      edgeSource.replace(
        'output: "server"',
        'server: { host: true, port: 4321 }, output: "server"',
      ),
      edgeSource.replace(
        'output: "server"',
        'vite: { server: { allowedHosts: true } }, output: "server"',
      ),
      staticSource.replace('output: "static"', 'server: { host: true }, output: "static"'),
    ]) {
      await expect(
        plan(source.includes("@astrojs") ? "edge" : "static", source),
      ).resolves.toMatchObject({
        adapter: "astro",
      });
    }
    for (const source of [
      edgeSource.replace('output: "server"', 'build: { server: "./x" }, output: "server"'),
      edgeSource.replace('output: "server"', 'build: { client: "./y" }, output: "server"'),
      // A dev-server block beside a build object whose keys cannot be read may still hide build output keys.
      edgeSource.replace(
        'output: "server"',
        'server: { host: true }, build: outputs, output: "server"',
      ),
      edgeSource.replace(
        'output: "server"',
        'server: { host: true }, build: { ...outputs }, output: "server"',
      ),
      edgeSource.replace('output: "server"', 'server: { host: true }, build, output: "server"'),
    ]) {
      await expect(plan("edge", source)).rejects.toMatchObject({
        diagnostic: { code: "astro_config_unsupported", path: "astro.config.mjs" },
      });
    }
  });
  it("carries a declared AI gateway into the edge plan only and refuses it on static sites", async () => {
    const edge = await plan("edge", edgeSource, { ai: { enabled: true, jurisdiction: "eu" } });
    expect(edge.ai).toEqual({ enabled: true, jurisdiction: "eu" });
    expect(parseNewProductionFrameworkPlan(edge)).toEqual(edge);
    const disabled = await plan("edge", edgeSource, { ai: { enabled: false } });
    expect(Object.hasOwn(disabled, "ai")).toBe(false);
    expect(Object.hasOwn(await plan("edge"), "ai")).toBe(false);
    await expect(
      plan("static", staticSource, { ai: { enabled: true, jurisdiction: "any" } }),
    ).rejects.toMatchObject({
      diagnostic: { code: "runtime_mode_unsupported" },
    });
  });
  it("rejects tampered persisted plans instead of admitting unsupported static capabilities or stale edge runtime", async () => {
    const edge = await plan("edge");
    for (const field of ["serverEntryPoint", "compatibilityDate"]) {
      const modified = { ...edge };
      Reflect.deleteProperty(modified, field);
      expect(() => parseNewProductionFrameworkPlan(modified)).toThrow();
    }
    expect(() =>
      parseNewProductionFrameworkPlan({ ...edge, compatibilityDate: "2025-04-01" }),
    ).toThrow();
    const stat = await plan("static");
    expect(() => parseNewProductionFrameworkPlan({ ...stat, mail: { enabled: true } })).toThrow();
  });
});
