import { parseOhmyhostConfig } from "@ohmyhost/contracts";
import { parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import {
  createTanStackFrameworkAdapter,
  type TanStackFrameworkAdapterDependencies,
} from "./index.js";

const FILES = [
  "ohmyhost.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "src/routes/__root.tsx",
  "src/routes/index.tsx",
];
const CONFIG = {
  version: 1,
  project: "tanstack-app",
  build: {
    install: "pnpm install --frozen-lockfile --ignore-scripts",
    command: "pnpm run build",
    output: "dist/client",
  },
  runtime: { mode: "static" },
};
const PACKAGE = {
  packageManager: "pnpm@10.28.2",
  scripts: { build: "vite build && tsc --noEmit" },
  dependencies: {
    "@tanstack/react-router": "1.170.31",
    "@tanstack/react-start": "1.168.60",
    react: "19.2.0",
    "react-dom": "19.2.0",
  },
  devDependencies: {
    "@vitejs/plugin-react": "6.0.1",
    vite: "8.0.16",
  },
};
const STATIC_VITE_CONFIG = `
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    tanstackStart({ prerender: { enabled: true, failOnError: true } }),
    viteReact(),
  ],
})
`;
const EDGE_CONFIG = {
  ...CONFIG,
  runtime: { mode: "edge" },
};
const EDGE_PACKAGE = {
  ...PACKAGE,
  devDependencies: {
    ...PACKAGE.devDependencies,
    "@cloudflare/vite-plugin": "1.53.1",
  },
};
const EDGE_VITE_CONFIG = `
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    viteReact(),
  ],
})
`;
const diagnosticError = (diagnostic: Readonly<Record<string, string>>) => ({
  name: "FrameworkConversionDiagnosticError",
  diagnostic,
});

function adapter(
  config: unknown = CONFIG,
  packageJson: unknown = PACKAGE,
  viteConfig: unknown = STATIC_VITE_CONFIG,
  loadLockfile?: TanStackFrameworkAdapterDependencies["loadLockfile"],
) {
  const production = createTanStackFrameworkAdapter({
    loadPackageJson: async () => packageJson,
    loadViteConfig: async () => viteConfig,
    ...(loadLockfile === undefined ? {} : { loadLockfile }),
  });
  const application = (repository: { readonly files: readonly string[] }) => ({
    root: parseOhmyhostConfig(config).applicationRoot,
    files: repository.files.filter((path) => path !== "ohmyhost.yaml"),
  });
  return {
    detect(repository: { readonly files: readonly string[] }) {
      return production.detect(application(repository));
    },
    plan(input: {
      readonly repository: { readonly files: readonly string[] };
      readonly detection: Awaited<ReturnType<typeof production.detect>>;
      readonly requestedRuntime?: "auto" | "static" | "edge";
    }) {
      return production.plan({
        repositoryConfig: parseOhmyhostConfig(config),
        repositoryConfigEvidence: {
          scope: "repository",
          path: "ohmyhost.yaml",
          reason: "authoritative repository configuration",
        },
        application: application(input.repository),
        detection: input.detection,
        ...(input.requestedRuntime === undefined
          ? {}
          : { requestedRuntime: input.requestedRuntime }),
      });
    },
  };
}

describe("production TanStack Start adapter", () => {
  it.each([
    STATIC_VITE_CONFIG.replace("plugins:", "base: '/customer', plugins:"),
    STATIC_VITE_CONFIG.replace("plugins:", "base: process.env.PUBLIC_BASE, plugins:"),
    STATIC_VITE_CONFIG.replace(
      "export default defineConfig({",
      "const base = '/nested/'; export default defineConfig({ base,",
    ),
    STATIC_VITE_CONFIG.replace("plugins:", "['base']: '/computed', plugins:"),
  ])("rejects a non-root or unresolved TanStack Vite base", async (viteConfig) => {
    const subject = adapter(CONFIG, PACKAGE, viteConfig);
    const repository = { files: FILES };

    await expect(
      subject.plan({ repository, detection: await subject.detect(repository) }),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "framework_base_path_unsupported", path: "vite.config.ts" },
    });
  });

  it.each([
    STATIC_VITE_CONFIG,
    STATIC_VITE_CONFIG.replace("plugins:", "base: '/', plugins:"),
    STATIC_VITE_CONFIG.replace("plugins:", "base: undefined, plugins:"),
    STATIC_VITE_CONFIG.replace("plugins:", "label: 'base', plugins:"),
  ])("accepts a root-origin TanStack Vite config", async (viteConfig) => {
    const subject = adapter(CONFIG, PACKAGE, viteConfig);
    const repository = { files: FILES };

    await expect(
      subject.plan({ repository, detection: await subject.detect(repository) }),
    ).resolves.toMatchObject({ adapter: "tanstack-start", runtime: "static" });
  });

  it("returns one frozen deterministic static plan", async () => {
    const subject = adapter(
      CONFIG,
      PACKAGE,
      `/* @cloudflare/vite-plugin and tanstackStart() in comments are inert */\n${STATIC_VITE_CONFIG}`,
    );
    const repository = { files: FILES };
    const detection = await subject.detect(repository);
    const plan = await subject.plan({ repository, detection });

    expect(detection).toEqual({
      adapter: "tanstack-start",
      confidenceBasisPoints: 10_000,
      evidence: [
        {
          path: "package.json",
          reason: "application package manifest for TanStack validation",
          scope: "application",
        },
        {
          path: "pnpm-lock.yaml",
          reason: "frozen package-manager dependency graph",
          scope: "application",
        },
        {
          path: "vite.config.ts",
          reason: "explicit TanStack Start Vite configuration",
          scope: "application",
        },
      ],
    });
    expect(plan).toEqual({
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
    expect(Object.isFrozen(detection)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("returns the complete frozen Cloudflare edge plan", async () => {
    const subject = adapter(EDGE_CONFIG, EDGE_PACKAGE, EDGE_VITE_CONFIG);
    const repository = { files: FILES };
    const detection = await subject.detect(repository);

    const plan = await subject.plan({ repository, detection, requestedRuntime: "edge" });

    expect(plan).toEqual({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "tanstack-start",
      runtime: "edge",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: "dist/client",
      serverOutputDirectory: "dist/server",
      serverEntryPoint: "dist/server/index.js",
      serverConfigPath: "dist/server/wrangler.json",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.compatibilityFlags)).toBe(true);
    // Managed auth and Mail remain independent; the actual managed database is still required.
    for (const mail of [undefined, { enabled: false }]) {
      const auth = adapter(
        {
          ...EDGE_CONFIG,
          database: { enabled: true, migrations: "migrations" },
          auth: { provider: "better-auth" },
          ...(mail === undefined ? {} : { mail }),
        },
        { ...EDGE_PACKAGE, dependencies: { ...EDGE_PACKAGE.dependencies, "better-auth": "1.7.7" } },
        EDGE_VITE_CONFIG,
      );
      await expect(
        auth.plan({
          repository,
          detection: await auth.detect(repository),
          requestedRuntime: "edge",
        }),
      ).resolves.toMatchObject({
        auth: { provider: "better-auth" },
        database: { enabled: true },
        mail: { enabled: false },
      });
    }
  });

  it("binds declared crons to the edge plan with the Worker module and rejects them for static output", async () => {
    const crons = { crons: ["15 * * * *"] };
    const files = [...FILES, "src/ohmyhost/worker.ts"];
    const subject = adapter({ ...EDGE_CONFIG, functions: crons }, EDGE_PACKAGE, EDGE_VITE_CONFIG);
    const repository = { files };
    const plan = await subject.plan({
      repository,
      detection: await subject.detect(repository),
      requestedRuntime: "edge",
    });
    expect(plan.functions).toEqual(crons);
    expect(Object.isFrozen(plan.functions)).toBe(true);
    const missing = adapter({ ...EDGE_CONFIG, functions: crons }, EDGE_PACKAGE, EDGE_VITE_CONFIG);
    await expect(
      missing.plan({
        repository: { files: FILES },
        detection: await missing.detect({ files: FILES }),
        requestedRuntime: "edge",
      }),
    ).rejects.toMatchObject(
      diagnosticError({ code: "worker_module_required", path: "src/ohmyhost/worker.ts" }),
    );
    const fixed = adapter({ ...CONFIG, functions: crons });
    await expect(
      fixed.plan({
        repository,
        detection: await fixed.detect(repository),
        requestedRuntime: "static",
      }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      }),
    );
  });

  it("binds a declared AI gateway only to the edge plan and rejects it for static output", async () => {
    const ai = { enabled: true, jurisdiction: "eu" };
    const subject = adapter({ ...EDGE_CONFIG, ai }, EDGE_PACKAGE, EDGE_VITE_CONFIG);
    const repository = { files: FILES };
    const plan = await subject.plan({
      repository,
      detection: await subject.detect(repository),
      requestedRuntime: "edge",
    });
    expect(plan.ai).toEqual(ai);
    expect(Object.isFrozen(plan.ai)).toBe(true);
    expect(parseNewProductionFrameworkPlan(plan)).toEqual(plan);
    const disabled = adapter(
      { ...EDGE_CONFIG, ai: { enabled: false } },
      EDGE_PACKAGE,
      EDGE_VITE_CONFIG,
    );
    const disabledPlan = await disabled.plan({
      repository,
      detection: await disabled.detect(repository),
      requestedRuntime: "edge",
    });
    expect(Object.hasOwn(disabledPlan, "ai")).toBe(false);
    const fixed = adapter({ ...CONFIG, ai });
    await expect(
      fixed.plan({
        repository,
        detection: await fixed.detect(repository),
        requestedRuntime: "static",
      }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      }),
    );
  });

  it("binds private US project storage only to the edge plan", async () => {
    const subject = adapter(
      {
        ...EDGE_CONFIG,
        storage: { provider: "r2", jurisdiction: "us", public: false },
      },
      EDGE_PACKAGE,
      EDGE_VITE_CONFIG,
    );
    const repository = { files: FILES };

    await expect(
      subject.plan({ repository, detection: await subject.detect(repository) }),
    ).resolves.toMatchObject({
      schemaVersion: "ohmyhost.framework-plan/v5",
      runtime: "edge",
      storage: { enabled: true, provider: "r2", jurisdiction: "us", public: false },
    });

    const staticSubject = adapter({
      ...CONFIG,
      storage: { provider: "r2", jurisdiction: "us", public: false },
    });
    const staticRepository = { files: FILES };
    await expect(
      staticSubject.plan({
        repository: staticRepository,
        detection: await staticSubject.detect(staticRepository),
      }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      }),
    );
  });

  it.each([
    [
      EDGE_VITE_CONFIG.replace(
        "cloudflare({ viteEnvironment: { name: 'ssr' } }),\n    tanstackStart(),",
        "tanstackStart(),\n    cloudflare({ viteEnvironment: { name: 'ssr' } }),",
      ),
      "tanstack_vite_plugins_required",
    ],
    [
      EDGE_VITE_CONFIG.replace("{ viteEnvironment: { name: 'ssr' } }", "{}"),
      "tanstack_vite_plugins_required",
    ],
  ])("rejects incomplete edge configuration", async (vite, code) => {
    const subject = adapter(EDGE_CONFIG, EDGE_PACKAGE, vite);
    const repository = { files: FILES };
    await expect(
      subject.plan({ repository, detection: await subject.detect(repository) }),
    ).rejects.toMatchObject({ diagnostic: { code, path: "vite.config.ts" } });
  });

  it("requires explicit content loaders", () => {
    expect(() => createTanStackFrameworkAdapter(undefined as never)).toThrow(
      "TanStack adapter content loaders are required",
    );
  });

  it.each([
    [
      "pnpm@10.28.2",
      "pnpm-lock.yaml",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build",
    ],
    ["npm@11.5.2", "package-lock.json", "npm ci --ignore-scripts", "npm run build"],
    ["yarn@4.9.2", "yarn.lock", "yarn install --immutable --mode=skip-build", "yarn run build"],
    ["bun@1.2.22", "bun.lock", "bun install --frozen-lockfile --ignore-scripts", "bun run build"],
  ] as const)(
    "emits secure descriptor commands for %s",
    async (packageManager, lockfile, installCommand, buildCommand) => {
      const config = {
        ...CONFIG,
        build: { ...CONFIG.build, install: installCommand, command: buildCommand },
      };
      const subject = adapter(config, { ...PACKAGE, packageManager });
      const repository = {
        files: ["ohmyhost.yaml", "package.json", lockfile, "vite.config.ts"],
      };
      const detection = await subject.detect(repository);

      await expect(subject.plan({ repository, detection })).resolves.toMatchObject({
        installCommand,
        buildCommand,
      });
      expect(detection.evidence).toContainEqual(expect.objectContaining({ path: lockfile }));
    },
  );

  it.each(["vite.config.js", "vite.config.mjs", "vite.config.ts"] as const)(
    "loads the resolved %s",
    async (configPath) => {
      const loaded: string[] = [];
      const production = createTanStackFrameworkAdapter({
        loadPackageJson: async () => PACKAGE,
        loadViteConfig: async (path) => {
          loaded.push(path);
          return STATIC_VITE_CONFIG;
        },
      });
      const application = {
        root: parseOhmyhostConfig(CONFIG).applicationRoot,
        files: FILES.filter((path) => path !== "ohmyhost.yaml" && path !== "vite.config.ts").concat(
          configPath,
        ),
      };
      const detection = await production.detect(application);

      await expect(
        production.plan({
          repositoryConfig: parseOhmyhostConfig(CONFIG),
          repositoryConfigEvidence: {
            scope: "repository",
            path: "ohmyhost.yaml",
            reason: "authoritative repository configuration",
          },
          application,
          detection,
        }),
      ).resolves.toMatchObject({ runtime: "static" });
      expect(loaded).toEqual([configPath]);
    },
  );

  it("rejects ambiguous Vite configuration before TanStack planning", async () => {
    await expect(adapter().detect({ files: [...FILES, "vite.config.mjs"] })).rejects.toMatchObject({
      code: "framework_admission_failed",
      reason: "ambiguous_config",
    });
  });

  it.each([
    ["1.168.60", "8.2.2"],
    ["1.168.61", "8.3.4"],
    ["1.169.0", "9.0.0"],
    ["2.0.0", "5.4.6"],
    ["^1.168.26", "^5.4.0"],
  ])(
    "admits TanStack %s with Vite %s at or above their security minimums",
    async (startVersion, viteVersion) => {
      const subject = adapter(CONFIG, {
        ...PACKAGE,
        dependencies: { ...PACKAGE.dependencies, "@tanstack/react-start": startVersion },
        devDependencies: { ...PACKAGE.devDependencies, vite: viteVersion },
      });
      const repository = { files: FILES };
      await expect(
        subject.plan({ repository, detection: await subject.detect(repository) }),
      ).resolves.toMatchObject({ adapter: "tanstack-start" });
    },
  );

  it.each([
    ["1.168.59", "8.2.2", "@tanstack/react-start", "1.168.59", "1.168.60"],
    ["1.168.26", "9.0.0", "@tanstack/react-start", "1.168.26", "1.168.60"],
    ["~1.167.0", "8.2.2", "@tanstack/react-start", "~1.167.0", "1.168.60"],
    ["1.168.60", "5.4.5", "vite", "5.4.5", "5.4.6"],
  ])(
    "refuses TanStack %s with Vite %s below a security minimum",
    async (startVersion, viteVersion, packageName, version, minimum) => {
      const subject = adapter(CONFIG, {
        ...PACKAGE,
        dependencies: { ...PACKAGE.dependencies, "@tanstack/react-start": startVersion },
        devDependencies: { ...PACKAGE.devDependencies, vite: viteVersion },
      });
      const repository = { files: FILES };
      await expect(
        subject.plan({ repository, detection: await subject.detect(repository) }),
      ).rejects.toMatchObject(
        diagnosticError({
          code: "framework_version_unsupported",
          path: "package.json",
          package: packageName,
          version,
          minimum,
        }),
      );
    },
  );

  it("judges the TanStack Start version that the loaded lockfile resolves", async () => {
    const lockfile = (version: string) =>
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@tanstack/react-start':",
        "        specifier: ^1.168.0",
        `        version: ${version}(react-dom@19.2.0(react@19.2.0))(react@19.2.0)(vite@8.0.16)`,
        "",
      ].join("\n");
    const packageJson = {
      ...PACKAGE,
      dependencies: { ...PACKAGE.dependencies, "@tanstack/react-start": "^1.168.0" },
    };
    const repository = { files: FILES };
    const refused = adapter(CONFIG, packageJson, STATIC_VITE_CONFIG, async () =>
      lockfile("1.168.59"),
    );
    await expect(
      refused.plan({ repository, detection: await refused.detect(repository) }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "framework_version_unsupported",
        path: "pnpm-lock.yaml",
        package: "@tanstack/react-start",
        version: "1.168.59",
        minimum: "1.168.60",
      }),
    );
    const admitted = adapter(CONFIG, packageJson, STATIC_VITE_CONFIG, async () =>
      lockfile("1.168.61"),
    );
    await expect(
      admitted.plan({ repository, detection: await admitted.detect(repository) }),
    ).resolves.toMatchObject({ adapter: "tanstack-start", runtime: "static" });
    expect(() =>
      createTanStackFrameworkAdapter({
        loadPackageJson: async () => PACKAGE,
        loadViteConfig: async () => STATIC_VITE_CONFIG,
        loadLockfile: {} as never,
      }),
    ).toThrow("TanStack adapter content loaders are required");
  });

  it.each([
    [["ohmyhost.yaml", "package.json", "vite.config.ts"], "missing lock"],
    [[...FILES, "package-lock.json"], "multiple locks"],
    [["ohmyhost.yaml", "package.json", "pnpm-lock.yaml"], "missing Vite config"],
  ])("does not detect %s (%s)", async (files) => {
    await expect(adapter().detect({ files })).resolves.toMatchObject({
      confidenceBasisPoints: 0,
      evidence: [],
    });
  });

  it.each([
    [
      { ...PACKAGE, packageManager: "npm@11.5.2" },
      { code: "framework_admission_failed", reason: "package_manager_lockfile_mismatch" },
    ],
    [
      { ...PACKAGE, scripts: { build: "node marker.mjs" } },
      diagnosticError({
        code: "build_script_unsupported",
        path: "package.json",
        framework: "tanstack-start",
      }),
    ],
    [
      { ...PACKAGE, dependencies: { ...PACKAGE.dependencies, "@tanstack/react-start": "" } },
      diagnosticError({
        code: "framework_dependency_required",
        path: "package.json",
        package: "@tanstack/react-start",
      }),
    ],
    [
      { ...PACKAGE, devDependencies: { ...PACKAGE.devDependencies, vite: undefined } },
      diagnosticError({
        code: "framework_dependency_required",
        path: "package.json",
        package: "vite",
      }),
    ],
    [
      {
        ...PACKAGE,
        dependencies: { ...PACKAGE.dependencies, react: undefined },
        devDependencies: { ...PACKAGE.devDependencies, react: "19.2.0" },
      },
      diagnosticError({
        code: "framework_dependency_required",
        path: "package.json",
        package: "react",
      }),
    ],
  ])("rejects unsafe package metadata", async (packageJson, error) => {
    const subject = adapter(CONFIG, packageJson);
    const repository = { files: FILES };
    await expect(
      subject.plan({ repository, detection: await subject.detect(repository) }),
    ).rejects.toMatchObject(error);
  });

  it.each([
    [
      `import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [tanstackStart()] }`,
      "tanstack_prerender_required",
    ],
    [
      `import { cloudflare } from '@cloudflare/vite-plugin'; import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [cloudflare(), tanstackStart({ prerender: { enabled: true } })] }`,
      "tanstack_vite_plugins_required",
    ],
    ["// tanstackStart({ prerender: { enabled: true } })", "tanstack_vite_plugins_required"],
  ])("rejects non-static Vite configuration", async (viteConfig, code) => {
    const subject = adapter(CONFIG, PACKAGE, viteConfig);
    const repository = { files: FILES };
    await expect(
      subject.plan({ repository, detection: await subject.detect(repository) }),
    ).rejects.toMatchObject({ diagnostic: { code, path: "vite.config.ts" } });
  });

  it("rejects runtime, output, malformed JSON, and forged detection", async () => {
    const repository = { files: FILES };
    const runtime = adapter({ ...CONFIG, runtime: { mode: "edge" } });
    await expect(
      runtime.plan({ repository, detection: await runtime.detect(repository) }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "framework_dependency_required",
        path: "package.json",
        package: "@cloudflare/vite-plugin",
      }),
    );
    const automatic = adapter({ ...CONFIG, runtime: { mode: "auto" } });
    await expect(
      automatic.plan({ repository, detection: await automatic.detect(repository) }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      }),
    );
    const output = adapter({ ...CONFIG, build: { ...CONFIG.build, output: "dist" } });
    const cache = adapter({ ...CONFIG, build: { ...CONFIG.build, ssg_cache_max_mib: 32 } });
    await expect(
      cache.plan({ repository, detection: await cache.detect(repository) }),
    ).rejects.toMatchObject(
      diagnosticError({ code: "build_option_unsupported", path: "ohmyhost.yaml" }),
    );
    await expect(
      output.plan({ repository, detection: await output.detect(repository) }),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "build_output_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      }),
    );
    const binary = adapter(CONFIG, PACKAGE, 42);
    await expect(
      binary.plan({ repository, detection: await binary.detect(repository) }),
    ).rejects.toThrow("vite.config.ts must be text");
    const requestedEdge = adapter();
    await expect(
      requestedEdge.plan({
        repository,
        detection: await requestedEdge.detect(repository),
        requestedRuntime: "edge",
      }),
    ).rejects.toThrow("conflicts with TanStack runtime static");
    const malformed = adapter(CONFIG, "{not-json");
    await expect(
      malformed.plan({ repository, detection: await malformed.detect(repository) }),
    ).rejects.toMatchObject(
      diagnosticError({ code: "package_manifest_invalid", path: "package.json" }),
    );
    await expect(
      adapter().plan({
        repository,
        detection: { adapter: "vite-static", confidenceBasisPoints: 10_000, evidence: [] },
      }),
    ).rejects.toThrow("before TanStack planning");
  });
});
