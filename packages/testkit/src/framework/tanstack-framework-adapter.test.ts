import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createTanStackFrameworkAdapter } from "./tanstack-framework-adapter.js";

const ROOT = resolve(import.meta.dirname, "../../../../fixtures/tanstack-static");
const EDGE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/tanstack-edge");
const FILES = [
  "ohmyhost.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "src/router.tsx",
  "src/routes/__root.tsx",
  "src/routes/index.tsx",
];

describe("TanStack Start fixture adapter", () => {
  it("plans the frozen real fixture as a static client artifact", async () => {
    const adapter = createTanStackFrameworkAdapter({
      rootDirectory: ROOT,
      loadConfig: async () => acceptedConfig("static"),
      loadLockfile: (path) => readFile(resolve(ROOT, path), "utf8"),
    });
    const repository = { files: FILES };
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection })).resolves.toEqual({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "tanstack-start",
      runtime: "static",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: "dist/client",
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
    });
    await expect(readFile(resolve(ROOT, "pnpm-lock.yaml"), "utf8")).resolves.toMatch(
      /lockfileVersion: ['"]9\.0['"]/u,
    );
  });

  it("plans the frozen real fixture as a Cloudflare edge artifact", async () => {
    const adapter = createTanStackFrameworkAdapter({
      rootDirectory: EDGE_ROOT,
      loadConfig: async () => acceptedConfig("edge"),
      loadLockfile: (path) => readFile(resolve(EDGE_ROOT, path), "utf8"),
    });
    const repository = { files: FILES };
    const detection = await adapter.detect(repository);

    await expect(
      adapter.plan({ repository, detection, requestedRuntime: "edge" }),
    ).resolves.toMatchObject({
      adapter: "tanstack-start",
      runtime: "edge",
      outputDirectory: "dist/client",
      serverOutputDirectory: "dist/server",
      serverEntryPoint: "dist/server/index.js",
      serverConfigPath: "dist/server/wrangler.json",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
    });
    await expect(readFile(resolve(EDGE_ROOT, "pnpm-lock.yaml"), "utf8")).resolves.toMatch(
      /lockfileVersion: ['"]9\.0['"]/u,
    );
  });

  it("loads a supported JavaScript Vite config and never requires customer Wrangler config", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-testkit-tanstack-"));
    const repository = {
      files: FILES.map((path) =>
        path === "pnpm-lock.yaml"
          ? "package-lock.json"
          : path === "vite.config.ts"
            ? "vite.config.js"
            : path,
      ),
    };
    const config = {
      ...acceptedConfig("static"),
      build: {
        install: "npm ci --ignore-scripts",
        command: "npm run build",
        output: "dist/client",
      },
    };
    const packageJson = {
      packageManager: "npm@11.5.2",
      scripts: { build: "vite build" },
      dependencies: {
        "@tanstack/react-router": "1.170.31",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: {
        "@vitejs/plugin-react": "6.1.0",
        vite: "8.2.2",
      },
    };
    const viteConfig = `
          import { tanstackStart } from "@tanstack/react-start/plugin/vite";
          import { defineConfig } from "vite";
          export default defineConfig({
            plugins: [tanstackStart({ prerender: { enabled: true } })],
          });
        `;
    try {
      await Promise.all([
        writeFile(join(rootDirectory, "ohmyhost.yaml"), JSON.stringify(config), "utf8"),
        writeFile(join(rootDirectory, "package.json"), JSON.stringify(packageJson), "utf8"),
        writeFile(join(rootDirectory, "vite.config.js"), viteConfig, "utf8"),
      ]);
      const adapter = createTanStackFrameworkAdapter({ rootDirectory });
      const detection = await adapter.detect(repository);

      await expect(adapter.plan({ repository, detection })).resolves.toMatchObject({
        installCommand: "npm ci --ignore-scripts",
        buildCommand: "npm run build",
        runtime: "static",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the local wrapper scoped to repository-root fixtures", async () => {
    const adapter = createTanStackFrameworkAdapter({
      loadConfig: async () => ({ ...acceptedConfig("static"), applicationRoot: "site" }),
      loadPackageJson: async () => {
        throw new Error("must not load package.json for a nested testkit fixture");
      },
      loadViteConfig: async () => {
        throw new Error("must not load Vite config for a nested testkit fixture");
      },
    });
    const repository = { files: FILES };
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection })).rejects.toThrow(
      "Testkit TanStack wrapper supports only repository-root fixtures",
    );
  });
});

function acceptedConfig(mode: "edge" | "static") {
  return {
    version: 1,
    project: `tanstack-${mode}`,
    build: {
      install: "pnpm install --frozen-lockfile --ignore-scripts",
      command: "pnpm run build",
      output: "dist/client",
    },
    runtime: { mode },
    database: { enabled: false },
    mail: { enabled: false },
  };
}
