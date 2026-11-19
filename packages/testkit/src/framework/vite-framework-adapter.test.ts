import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { FrameworkPlan } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import { createViteFrameworkAdapter } from "./vite-framework-adapter.js";

const REPOSITORY_FILES = [
  "ohmyhost.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "index.html",
  "src/main.ts",
];
const FIXTURES = resolve(import.meta.dirname, "../../../../fixtures");

function digestPlan(plan: FrameworkPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

describe("Vite framework adapter", () => {
  it.each(["vite-static", "lovable-export"])(
    "plans the %s fixture as deterministic static Vite",
    async (fixture) => {
      const lockfiles: string[] = [];
      const adapter = createViteFrameworkAdapter({
        rootDirectory: resolve(FIXTURES, fixture),
        loadConfig: async () => validConfig(),
        loadLockfile: (path) => {
          lockfiles.push(path);
          return readFile(resolve(FIXTURES, fixture, path), "utf8");
        },
      });
      const repository = { files: REPOSITORY_FILES };
      const detection = await adapter.detect(repository);

      const first = await adapter.plan({ repository, detection });
      const second = await adapter.plan({ repository, detection, requestedRuntime: "static" });

      expect(detection).toEqual({
        adapter: "vite-static",
        confidenceBasisPoints: 10_000,
        evidence: [
          {
            path: "package.json",
            reason: "application package manifest for Vite validation",
            scope: "application",
          },
          {
            path: "pnpm-lock.yaml",
            reason: "frozen package-manager dependency graph",
            scope: "application",
          },
        ],
      });
      expect(first).toEqual({
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "vite-static",
        runtime: "static",
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputDirectory: "dist",
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      });
      expect(second).toEqual(first);
      expect(Object.isFrozen(detection)).toBe(true);
      expect(Object.isFrozen(detection.evidence)).toBe(true);
      expect(detection.evidence.every(Object.isFrozen)).toBe(true);
      expect(Object.isFrozen(first)).toBe(true);
      expect(digestPlan(first)).toBe(digestPlan(second));
      expect(lockfiles).toEqual(["pnpm-lock.yaml", "pnpm-lock.yaml"]);
      await expect(readFile(resolve(FIXTURES, fixture, "pnpm-lock.yaml"), "utf8")).resolves.toMatch(
        /lockfileVersion: ['"]9\.0['"]/,
      );
    },
  );

  it("changes the deterministic plan digest when a safe runtime policy changes", async () => {
    const config = validConfig();
    const packageJson = {
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.3.6" },
    };
    const repository = { files: REPOSITORY_FILES };
    const firstAdapter = createViteFrameworkAdapter({
      loadConfig: async () => config,
      loadPackageJson: async () => packageJson,
    });
    const secondAdapter = createViteFrameworkAdapter({
      loadConfig: async () => ({
        ...config,
        runtime: { ...config.runtime, healthcheck: "/health" },
      }),
      loadPackageJson: async () => packageJson,
    });
    const detection = await firstAdapter.detect(repository);

    const first = await firstAdapter.plan({ repository, detection });
    const second = await secondAdapter.plan({ repository, detection });

    expect(first.runtimePolicy.healthCheckPath).toBe("/");
    expect(second.runtimePolicy.healthCheckPath).toBe("/health");
    expect(digestPlan(first)).not.toBe(digestPlan(second));
  });

  it("fails closed for missing roots and detection mismatches", async () => {
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => {
        throw new Error("must not load");
      },
      loadPackageJson: async () => {
        throw new Error("must not load");
      },
    });
    const missingConfig = { files: ["package.json"] };
    const missingPackage = { files: ["ohmyhost.yaml"] };
    const missingLock = { files: ["ohmyhost.yaml", "package.json"] };

    await expect(adapter.detect(missingConfig)).resolves.toEqual({
      adapter: "vite-static",
      confidenceBasisPoints: 0,
      evidence: [],
    });
    await expect(adapter.detect(missingPackage)).resolves.toEqual({
      adapter: "vite-static",
      confidenceBasisPoints: 0,
      evidence: [],
    });
    await expect(adapter.detect(missingLock)).resolves.toEqual({
      adapter: "vite-static",
      confidenceBasisPoints: 0,
      evidence: [],
    });
    await expect(
      adapter.plan({ repository: missingConfig, detection: await adapter.detect(missingConfig) }),
    ).rejects.toThrow("root ohmyhost.yaml is required before Vite planning");

    const repository = { files: REPOSITORY_FILES };
    const mismatchAdapter = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => {
        throw new Error("must not load package.json for invalid detection");
      },
    });
    const validDetection = await mismatchAdapter.detect(repository);
    await expect(
      mismatchAdapter.plan({
        repository,
        detection: { ...validDetection, adapter: "another-adapter" },
      }),
    ).rejects.toThrow(
      "repository config and application package.json with a lockfile are required",
    );
  });

  it("requires the lockfile matching the pinned package manager", async () => {
    const repository = {
      files: REPOSITORY_FILES.map((path) =>
        path === "pnpm-lock.yaml" ? "package-lock.json" : path,
      ),
    };
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => validPackageJson(),
    });
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection })).rejects.toThrow(
      "Framework source is not admitted",
    );
  });

  it.each([
    ["npm", "npm@11.5.2", "package-lock.json", "npm ci --ignore-scripts", "npm run build"],
    [
      "pnpm",
      "pnpm@10.28.2",
      "pnpm-lock.yaml",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build",
    ],
    [
      "yarn",
      "yarn@4.9.2",
      "yarn.lock",
      "yarn install --immutable --mode=skip-build",
      "yarn run build",
    ],
    [
      "bun",
      "bun@1.2.22",
      "bun.lock",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run build",
    ],
  ])(
    "delegates %s admission and commands to the shared production contract",
    async (_manager, packageManager, lockfile, install, command) => {
      const repository = {
        files: REPOSITORY_FILES.map((path) => (path === "pnpm-lock.yaml" ? lockfile : path)),
      };
      const adapter = createViteFrameworkAdapter({
        loadConfig: async () => ({
          ...validConfig(),
          build: { install, command, output: "dist" },
        }),
        loadPackageJson: async () => ({ ...validPackageJson(), packageManager }),
      });
      const detection = await adapter.detect(repository);

      await expect(adapter.plan({ repository, detection })).resolves.toMatchObject({
        installCommand: install,
        buildCommand: command,
      });
      expect(detection.evidence.map(({ path }) => path)).toContain(lockfile);
    },
  );

  it("rejects a package-manager declaration that does not match its only lockfile", async () => {
    const repository = { files: REPOSITORY_FILES };
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => ({ ...validPackageJson(), packageManager: "npm@11.5.2" }),
    });
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection })).rejects.toThrow(
      "Framework source is not admitted",
    );
  });

  it("preserves non-TypeScript Vite config evidence from the production detector", async () => {
    const repository = { files: [...REPOSITORY_FILES, "vite.config.mjs"] };
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => validPackageJson(),
      loadViteConfig: async (path) => {
        expect(path).toBe("vite.config.mjs");
        return "export default { base: '/' };\n";
      },
    });

    const detection = await adapter.detect(repository);

    expect(detection.evidence.map(({ path }) => path)).toContain("vite.config.mjs");
    await expect(adapter.plan({ repository, detection })).resolves.toMatchObject({
      adapter: "vite-static",
      runtime: "static",
    });
  });

  it("keeps the local wrapper scoped to repository-root fixtures", async () => {
    const repository = { files: REPOSITORY_FILES };
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => ({ ...validConfig(), applicationRoot: "site" }),
      loadPackageJson: async () => validPackageJson(),
    });
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection })).rejects.toThrow(
      "Testkit Vite wrapper supports only repository-root fixtures",
    );
  });

  it("rejects repositories with more than one root lockfile", async () => {
    const repository = { files: [...REPOSITORY_FILES, "package-lock.json"] };
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => validPackageJson(),
    });

    await expect(adapter.detect(repository)).resolves.toEqual({
      adapter: "vite-static",
      confidenceBasisPoints: 0,
      evidence: [],
    });
  });

  it.each([
    ["malformed config", { version: 1 }, validPackageJson(), "ohmyhost.yaml is invalid"],
    [
      "malformed package",
      validConfig(),
      [],
      { code: "package_manifest_invalid", path: "package.json" },
    ],
    [
      "missing build script",
      validConfig(),
      { ...validPackageJson(), scripts: {} },
      { code: "build_script_unsupported", path: "package.json", framework: "vite-static" },
    ],
    [
      "non-Vite package",
      validConfig(),
      { ...validPackageJson(), devDependencies: {} },
      { code: "framework_dependency_required", path: "package.json", package: "vite" },
    ],
    [
      "unsafe build script",
      validConfig(),
      { ...validPackageJson(), scripts: { build: "node marker.mjs && vite build" } },
      { code: "build_script_unsupported", path: "package.json", framework: "vite-static" },
    ],
    [
      "runtime mismatch",
      { ...validConfig(), runtime: { mode: "edge" } },
      validPackageJson(),
      { code: "companion_entry_required", path: "src/ohmyhost/companion.ts" },
    ],
    [
      "output mismatch",
      { ...validConfig(), build: { ...validConfig().build, output: "build" } },
      validPackageJson(),
      { code: "build_output_unsupported", path: "ohmyhost.yaml", framework: "vite-static" },
    ],
    [
      "package manager mismatch",
      { ...validConfig(), build: { ...validConfig().build, command: "npm run build" } },
      validPackageJson(),
      { code: "build_command_mismatch", path: "ohmyhost.yaml" },
    ],
    [
      "install command mismatch",
      { ...validConfig(), build: { ...validConfig().build, install: "pnpm install" } },
      validPackageJson(),
      { code: "build_command_mismatch", path: "ohmyhost.yaml" },
    ],
    [
      "missing package manager pin",
      validConfig(),
      { ...validPackageJson(), packageManager: undefined },
      "Framework source is not admitted",
    ],
    [
      "unsupported package manager pin",
      validConfig(),
      { ...validPackageJson(), packageManager: "deno@2.0.0" },
      "Framework source is not admitted",
    ],
  ])("rejects %s", async (_case, config, packageJson, expected) => {
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => config,
      loadPackageJson: async () => packageJson,
    });
    const repository = { files: REPOSITORY_FILES };
    const detection = await adapter.detect(repository);

    if (typeof expected === "string") {
      await expect(adapter.plan({ repository, detection })).rejects.toThrow(expected);
    } else {
      await expect(adapter.plan({ repository, detection })).rejects.toMatchObject({
        name: "FrameworkConversionDiagnosticError",
        diagnostic: expected,
      });
    }
  });

  it("rejects the hostile fixture without executing marker scripts or network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const marker = resolve(FIXTURES, "hostile-builds/SHOULD_NOT_EXIST");
    const adapter = createViteFrameworkAdapter({
      rootDirectory: resolve(FIXTURES, "hostile-builds"),
    });
    const repository = { files: REPOSITORY_FILES };
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection })).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: {
        code: "build_script_unsupported",
        path: "package.json",
        framework: "vite-static",
      },
    });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects non-static requested runtimes and malformed package JSON source", async () => {
    const repository = { files: REPOSITORY_FILES };
    const adapter = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => validPackageJson(),
    });
    const detection = await adapter.detect(repository);

    await expect(adapter.plan({ repository, detection, requestedRuntime: "edge" })).rejects.toThrow(
      "requested runtime edge conflicts with Vite runtime static",
    );

    const malformed = createViteFrameworkAdapter({
      loadConfig: async () => validConfig(),
      loadPackageJson: async () => "{not-json",
    });
    await expect(malformed.plan({ repository, detection })).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "package_manifest_invalid", path: "package.json" },
    });
  });
});

function validConfig() {
  return {
    version: 1,
    project: "valid-vite",
    build: {
      install: "pnpm install --frozen-lockfile --ignore-scripts",
      command: "pnpm run build",
      output: "dist",
    },
    runtime: { mode: "static" },
  };
}

function validPackageJson() {
  return {
    packageManager: "pnpm@10.28.2",
    scripts: { build: "vite build" },
    devDependencies: { vite: "7.3.6" },
  };
}
