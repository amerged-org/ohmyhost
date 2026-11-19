import { FrameworkAdmissionError, parseOhmyhostConfig } from "@ohmyhost/contracts";
import { parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createNextFrameworkAdapter,
  NextWorkersIncompatibleError,
  type NextFrameworkAdapterDependencies,
} from "./index.js";

const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts"] as const;
const PACKAGE_MANAGERS = [
  ["npm@10.9.3", "package-lock.json", "npm ci --ignore-scripts", "npm run build"],
  [
    "pnpm@10.28.2",
    "pnpm-lock.yaml",
    "pnpm install --frozen-lockfile --ignore-scripts",
    "pnpm run build",
  ],
  ["yarn@4.9.4", "yarn.lock", "yarn install --immutable --mode=skip-build", "yarn run build"],
  ["bun@1.2.22", "bun.lock", "bun install --frozen-lockfile --ignore-scripts", "bun run build"],
  ["bun@1.2.22", "bun.lockb", "bun install --frozen-lockfile --ignore-scripts", "bun run build"],
] as const;

const CONFIG = {
  version: 1,
  project: "next-app",
  build: {
    install: "customer supplied command is not executed",
    command: "customer supplied command is not executed",
    output: ".next",
  },
  runtime: { mode: "edge" },
};
const PACKAGE = {
  packageManager: "pnpm@10.28.2",
  scripts: { build: "next build" },
  dependencies: { next: "16.4.5", react: "19.2.4", "react-dom": "19.2.4" },
};
const NEXT_CONFIG = `
const nextConfig = { reactStrictMode: true };
export default nextConfig;
`;
const TAILWIND_TURBOPACK_CONFIG =
  "module.exports = { turbopack: { rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } } } };";

function packageJson(overrides: Record<string, unknown> = {}) {
  return { ...PACKAGE, ...overrides };
}

function harness(
  input: {
    readonly config?: unknown;
    readonly files?: readonly string[];
    readonly nextConfig?: unknown;
    readonly packageJson?: unknown;
    readonly runtimeSources?: Readonly<Record<string, string>>;
    readonly loadLockfile?: NextFrameworkAdapterDependencies["loadLockfile"];
  } = {},
) {
  const files = input.files ?? [
    "package.json",
    "pnpm-lock.yaml",
    "next.config.ts",
    "src/app/page.tsx",
  ];
  const loadNextConfig = vi.fn(async () => input.nextConfig ?? NEXT_CONFIG);
  const production = createNextFrameworkAdapter({
    loadPackageJson: async () => input.packageJson ?? PACKAGE,
    loadNextConfig,
    loadRuntimeSources: async (paths) =>
      paths.map((path) => ({
        path,
        source: input.runtimeSources?.[path] ?? 'export const runtime = "nodejs";',
      })),
    ...(input.loadLockfile === undefined ? {} : { loadLockfile: input.loadLockfile }),
  });
  const config = parseOhmyhostConfig(input.config ?? CONFIG);
  const application = { root: config.applicationRoot, files };
  return {
    loadNextConfig,
    async detect() {
      return production.detect(application);
    },
    async plan(requestedRuntime?: "auto" | "static" | "edge") {
      return production.plan({
        repositoryConfig: config,
        repositoryConfigEvidence: {
          scope: "repository",
          path: "ohmyhost.yaml",
          reason: "authoritative repository configuration",
        },
        application,
        detection: await production.detect(application),
        ...(requestedRuntime === undefined ? {} : { requestedRuntime }),
      });
    },
  };
}

describe("Next.js source admission", () => {
  it("plans CommonJS Next configuration without evaluating it", async () => {
    for (const nextConfig of [
      "module.exports = { reactStrictMode: true };",
      "const nextConfig = { reactStrictMode: true }; module.exports = nextConfig;",
      'module["exports"] = { reactStrictMode: true };',
      "module.exports = { cacheComponents: true, partialPrefetching: true };",
      // Webpack loads Tailwind CSS through the postcss.config.mjs beside the Turbopack rule.
      TAILWIND_TURBOPACK_CONFIG,
    ]) {
      await expect(
        harness({
          files: ["package.json", "pnpm-lock.yaml", "next.config.js", "postcss.config.mjs"],
          nextConfig,
        }).plan(),
      ).resolves.toMatchObject({ adapter: "nextjs", runtime: "edge" });
    }
  });

  it("keeps unsupported settings and missing exports blocked in CommonJS config", async () => {
    const files = ["package.json", "pnpm-lock.yaml", "next.config.js"];
    for (const [nextConfig, code] of [
      ["module.exports = { basePath: '/customer' };", "next_base_path_unsupported"],
      ["module.exports = { output: 'export' };", "next_output_unsupported"],
      ["module.exports = { output: 'standalone' };", "next_output_unsupported"],
      [TAILWIND_TURBOPACK_CONFIG, "next_tailwind_turbopack_only"],
      ["// module.exports = {}; const config = {};", "framework_config_default_export_required"],
    ] as const) {
      await expect(harness({ files, nextConfig }).plan()).rejects.toMatchObject({
        name: "FrameworkConversionDiagnosticError",
        diagnostic: { code, path: "next.config.js" },
      });
    }
  });

  it("rejects a Bun version that the sandbox does not execute", async () => {
    for (const packageManager of ["bun@1.2.21", "bun@1.3.0"]) {
      await expect(
        harness({
          files: ["package.json", "bun.lock", "next.config.ts"],
          packageJson: { ...PACKAGE, packageManager },
        }).plan(),
      ).rejects.toMatchObject({
        name: "FrameworkAdmissionError",
        reason: "package_manager_version_unsupported",
      });
    }
  });

  it.each(NEXT_CONFIGS)("resolves %s without customer OpenNext or Wrangler files", async (path) => {
    const subject = harness({ files: ["package.json", "pnpm-lock.yaml", path] });

    await expect(subject.detect()).resolves.toEqual({
      adapter: "nextjs",
      confidenceBasisPoints: 10_000,
      evidence: [
        {
          path: "package.json",
          reason: "application package manifest for Next.js validation",
          scope: "application",
        },
        {
          path: "pnpm-lock.yaml",
          reason: "frozen pnpm dependency graph",
          scope: "application",
        },
        {
          path,
          reason: "Next.js framework configuration",
          scope: "application",
        },
      ],
    });
    await expect(subject.plan()).resolves.toMatchObject({ runtime: "edge" });
    expect(subject.loadNextConfig).toHaveBeenCalledWith(path);
  });

  it.each(PACKAGE_MANAGERS)(
    "emits secure %s install and build commands for its matching lockfile",
    async (manager, lockfile, installCommand, buildCommand) => {
      const subject = harness({
        files: ["package.json", lockfile, "next.config.ts"],
        packageJson: packageJson({ packageManager: manager }),
      });

      await expect(subject.plan()).resolves.toEqual({
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "nextjs",
        runtime: "edge",
        installCommand,
        buildCommand,
        outputDirectory: ".open-next/assets",
        ssgCacheMaxBytes: 32 * 1024 * 1024,
        serverOutputDirectory: ".ohmyhost-worker",
        serverEntryPoint: ".ohmyhost-worker/worker.js",
        serverConfigPath: "wrangler.jsonc",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      });
      for (const capacity of [1, 64]) {
        await expect(
          harness({
            config: { ...CONFIG, build: { ...CONFIG.build, ssg_cache_max_mib: capacity } },
          }).plan(),
        ).resolves.toMatchObject({ ssgCacheMaxBytes: capacity * 1024 * 1024 });
      }
      await expect(
        harness({
          config: { ...CONFIG, build: { ...CONFIG.build, next_revalidate_path: true } },
        }).plan(),
      ).resolves.toMatchObject({ nextRevalidatePath: true });
    },
  );

  it.each(["16.4.5", "16.4.6", "17.0.0", "^16.4.5", "^16.3.0"])(
    "admits Next.js %s at or above its security minimum",
    async (next) => {
      await expect(
        harness({
          packageJson: packageJson({ dependencies: { ...PACKAGE.dependencies, next } }),
        }).plan(),
      ).resolves.toMatchObject({ adapter: "nextjs", runtime: "edge" });
    },
  );

  it.each([
    ["14.2.33", "16.4.5"],
    ["15.4.9", "16.4.5"],
    ["15.5.26", "16.4.5"],
    ["15.5.27", "16.4.5"],
    ["15.5.28", "16.4.5"],
    ["15.6.0", "16.4.5"],
    ["16.2.4", "16.4.5"],
    ["16.3.7", "16.4.5"],
    ["16.3.8", "16.4.5"],
    ["16.4.0", "16.4.5"],
    ["16.5.0-canary.5", "16.4.5"],
    ["~16.2.0", "16.4.5"],
  ])("refuses Next.js %s below its security minimum", async (next, minimum) => {
    await expect(
      harness({
        packageJson: packageJson({ dependencies: { ...PACKAGE.dependencies, next } }),
      }).plan(),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: {
        code: "framework_version_unsupported",
        path: "package.json",
        package: "next",
        version: next,
        minimum,
      },
    });
  });

  it("judges the Next.js version that the loaded lockfile resolves", async () => {
    const files = ["package.json", "package-lock.json", "next.config.ts"];
    const declared = packageJson({
      packageManager: "npm@11.5.1",
      dependencies: { ...PACKAGE.dependencies, next: "^16.3.0" },
    });
    const lockfile = (version: string) =>
      JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/next": { version } } });
    const loaded: string[] = [];
    await expect(
      harness({
        files,
        packageJson: declared,
        loadLockfile: async (path) => {
          loaded.push(path);
          return lockfile("16.4.0");
        },
      }).plan(),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: {
        code: "framework_version_unsupported",
        path: "package-lock.json",
        package: "next",
        version: "16.4.0",
        minimum: "16.4.5",
      },
    });
    expect(loaded).toEqual(["package-lock.json"]);
    for (const loadLockfile of [async () => lockfile("16.4.5"), async () => undefined])
      await expect(
        harness({ files, packageJson: declared, loadLockfile }).plan(),
      ).resolves.toMatchObject({ adapter: "nextjs", installCommand: "npm ci --ignore-scripts" });
    expect(() =>
      createNextFrameworkAdapter({
        loadPackageJson: async () => PACKAGE,
        loadNextConfig: async () => NEXT_CONFIG,
        loadRuntimeSources: async () => [],
        loadLockfile: "package-lock.json" as never,
      }),
    ).toThrow("Next.js adapter content loaders are required");
  });

  it("does not detect ambiguous configs, lockfiles, or Windows-spelled lookalikes", async () => {
    await expect(
      harness({
        files: ["package.json", "pnpm-lock.yaml", "next.config.js", "next.config.ts"],
      }).detect(),
    ).resolves.toMatchObject({ confidenceBasisPoints: 0, evidence: [] });
    await expect(
      harness({
        files: ["package.json", "pnpm-lock.yaml", "package-lock.json", "next.config.ts"],
      }).detect(),
    ).resolves.toMatchObject({ confidenceBasisPoints: 0, evidence: [] });
    await expect(
      harness({
        files: ["package.json", "pnpm-lock.yaml", "next.config.ts", "app\\package-lock.json"],
      }).detect(),
    ).resolves.toMatchObject({ confidenceBasisPoints: 10_000 });
  });

  it.each([
    [undefined, ["package.json", "pnpm-lock.yaml", "next.config.ts"], "missing_package_manager"],
    [
      "npm@10.9.3",
      ["package.json", "pnpm-lock.yaml", "next.config.ts"],
      "package_manager_lockfile_mismatch",
    ],
    [
      "npm@10.9.3 && calc.exe",
      ["package.json", "package-lock.json", "next.config.ts"],
      "invalid_package_manager",
    ],
  ] as const)("rejects unsafe package-manager metadata", async (manager, files, reason) => {
    await expect(
      harness({ files, packageJson: packageJson({ packageManager: manager }) }).plan(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<FrameworkAdmissionError>>({
        code: "framework_admission_failed",
        reason,
      }),
    );
  });
});

describe("Next.js runtime planning", () => {
  it.each([
    "basePath: '/customer'",
    "assetPrefix: '/cdn'",
    "basePath: process.env.NEXT_PUBLIC_BASE_PATH",
    "assetPrefix: `https://cdn.example.com`",
    "basePath",
    "['basePath']: '/computed'",
  ])("rejects non-root or unresolved framework prefix %s", async (property) => {
    const nextConfig = `const basePath = process.env.NEXT_PUBLIC_BASE_PATH; export default { ${property}, reactStrictMode: true };`;

    await expect(harness({ nextConfig }).plan()).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "next_base_path_unsupported", path: "next.config.ts" },
    });
  });

  it.each([
    "export default { reactStrictMode: true };",
    "export default { basePath: '/', assetPrefix: '/', reactStrictMode: true };",
    "export default { basePath: '', assetPrefix: '', reactStrictMode: true };",
    "export default { basePath: undefined, assetPrefix: undefined, reactStrictMode: true };",
    "export default { label: 'basePath', note: 'assetPrefix', reactStrictMode: true };",
  ])("accepts a root-origin Next.js config", async (nextConfig) => {
    await expect(harness({ nextConfig }).plan()).resolves.toMatchObject({
      adapter: "nextjs",
      runtime: "edge",
    });
  });

  it("preserves database, Better Auth, mail, storage, and egress requirements", async () => {
    const config = {
      ...CONFIG,
      runtime: { mode: "edge", egress: { allow: ["https://api.example.com"] } },
      database: { enabled: true, migrations: "migrations" },
      auth: { provider: "better-auth" },
      mail: { enabled: true },
      storage: { provider: "r2", jurisdiction: "us", public: false },
    };
    const subject = harness({
      config,
      packageJson: packageJson({
        dependencies: { ...PACKAGE.dependencies, "better-auth": "1.7.7" },
      }),
    });

    await expect(subject.plan()).resolves.toMatchObject({
      runtimePolicy: { egressAllowedOrigins: ["https://api.example.com"] },
      database: { enabled: true, migrations: "migrations" },
      auth: { provider: "better-auth", version: "1.7.7", deployment: "embedded" },
      mail: { enabled: true },
      storage: { enabled: true, provider: "r2", jurisdiction: "us", public: false },
    });
    await expect(harness({ config }).plan()).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "better_auth_version_required", path: "package.json" },
    });
  });

  it("binds a declared AI gateway to the edge plan and omits it when disabled", async () => {
    const subject = harness({ config: { ...CONFIG, ai: { enabled: true, jurisdiction: "any" } } });
    const plan = await subject.plan();

    expect(plan.ai).toEqual({ enabled: true, jurisdiction: "any" });
    expect(parseNewProductionFrameworkPlan(plan)).toEqual(plan);
    const disabled = await harness({ config: { ...CONFIG, ai: { enabled: false } } }).plan();
    expect(Object.hasOwn(disabled, "ai")).toBe(false);
    expect(Object.hasOwn(await harness().plan(), "ai")).toBe(false);
  });

  it("allows the direct webpack build variant without a build:cloudflare script", async () => {
    await expect(
      harness({ packageJson: packageJson({ scripts: { build: "next build --webpack" } }) }).plan(),
    ).resolves.toMatchObject({ buildCommand: "pnpm run build" });
  });

  it.each(["next build --turbopack", "opennextjs-cloudflare build", "wrangler deploy"])(
    "rejects non-direct customer build script %s",
    async (build) => {
      await expect(
        harness({ packageJson: packageJson({ scripts: { build } }) }).plan(),
      ).rejects.toMatchObject({
        name: "FrameworkConversionDiagnosticError",
        diagnostic: { code: "build_script_unsupported", path: "package.json", framework: "nextjs" },
      });
    },
  );

  it("plans declared crons with the Worker module and rejects a missing module", async () => {
    const config = { ...CONFIG, functions: { crons: ["*/5 * * * *"] } };
    const plan = await harness({
      config,
      files: [
        "package.json",
        "pnpm-lock.yaml",
        "next.config.ts",
        "src/app/page.tsx",
        "src/ohmyhost/worker.ts",
      ],
    }).plan();
    expect(plan.functions).toEqual({ crons: ["*/5 * * * *"] });
    expect(Object.isFrozen(plan.functions)).toBe(true);
    expect((await harness().plan()).functions).toBeUndefined();
    await expect(harness({ config }).plan()).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "worker_module_required", path: "src/ohmyhost/worker.ts" },
    });
  });

  it("rejects unsafe Next config and conflicting runtime requests", async () => {
    for (const [nextConfig, code] of [
      [NEXT_CONFIG.replace("reactStrictMode: true", 'output: "export"'), "next_output_unsupported"],
      [
        NEXT_CONFIG.replace("reactStrictMode: true", 'output: "standalone"'),
        "next_output_unsupported",
      ],
      [`${NEXT_CONFIG}${" ".repeat(256 * 1024)}`, "framework_config_too_large"],
      ["export default { title: 'unterminated };", "source_syntax_invalid"],
    ] as const)
      await expect(harness({ nextConfig }).plan()).rejects.toMatchObject({
        name: "FrameworkConversionDiagnosticError",
        diagnostic: { code, path: "next.config.ts" },
      });
    await expect(harness({ nextConfig: 42 }).plan()).rejects.toThrow("next.config.ts must be text");
    await expect(
      harness({ config: { ...CONFIG, runtime: { mode: "static" } } }).plan(),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "runtime_mode_unsupported", path: "ohmyhost.yaml", framework: "nextjs" },
    });
    await expect(harness().plan("static")).rejects.toThrow("conflicts with Next.js runtime edge");
  });

  it("ignores line and block comments while inspecting Next config", async () => {
    const commented = `
// output: "export" must not count
/* loaders: ["@tailwindcss/turbopack"] must not count */
${NEXT_CONFIG}`;
    await expect(harness({ nextConfig: commented }).plan()).resolves.toMatchObject({
      adapter: "nextjs",
      runtime: "edge",
    });
  });

  it("admits Node Proxy while preserving unsupported Node module findings", async () => {
    const proxy = harness({
      files: ["package.json", "pnpm-lock.yaml", "next.config.ts", "proxy.ts"],
    });
    await expect(proxy.plan()).resolves.toMatchObject({
      adapter: "nextjs",
      runtime: "edge",
      compatibilityFlags: ["nodejs_compat"],
    });
    const module = harness({
      files: ["package.json", "pnpm-lock.yaml", "next.config.ts", "src/app/page.tsx"],
      runtimeSources: { "src/app/page.tsx": 'import "node:child_process";' },
    });
    await expect(module.plan()).rejects.toBeInstanceOf(NextWorkersIncompatibleError);
    const nativeAddon = harness({
      files: ["package.json", "pnpm-lock.yaml", "next.config.ts", "src/app/page.tsx"],
      runtimeSources: { "src/app/page.tsx": 'import addon from "./build/addon.node"; void addon;' },
    });
    await expect(nativeAddon.plan()).rejects.toMatchObject({
      code: "next_workers_runtime_incompatible",
      findings: [
        {
          code: "native_addon_unsupported",
          path: "src/app/page.tsx",
          module: "./build/addon.node",
        },
      ],
    });
  });

  it("rejects malformed manifests and invalid dependencies", async () => {
    expect(() => createNextFrameworkAdapter(undefined as never)).toThrow("content loaders");
    for (const [manifest, diagnostic] of [
      ["{bad", { code: "package_manifest_invalid", path: "package.json" }],
      [
        packageJson({ dependencies: { next: "16.4.1" } }),
        { code: "framework_dependency_required", path: "package.json", package: "react" },
      ],
      [
        packageJson({ dependencies: { ...PACKAGE.dependencies, react: "^19.2.4" } }),
        { code: "react_version_exact_required", path: "package.json", package: "react" },
      ],
      [
        packageJson({
          dependencies: { react: "19.2.4", "react-dom": "19.2.4" },
          devDependencies: { next: "16.4.1" },
        }),
        { code: "framework_dependency_required", path: "package.json", package: "next" },
      ],
      [
        packageJson({ dependencies: { ...PACKAGE.dependencies, next: "latest" } }),
        {
          code: "framework_version_declaration_unsupported",
          path: "package.json",
          package: "next",
        },
      ],
    ] as const)
      await expect(harness({ packageJson: manifest }).plan()).rejects.toMatchObject({
        name: "FrameworkConversionDiagnosticError",
        diagnostic,
      });
  });
});
