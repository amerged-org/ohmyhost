import { parseOhmyhostConfig } from "@ohmyhost/contracts";
import { describe, expect, it } from "vitest";

import { createViteFrameworkAdapter, type ViteFrameworkAdapterDependencies } from "./index.js";

const FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "index.html",
  "src/ohmyhost/companion.ts",
];
const CONFIG = parseOhmyhostConfig({
  version: 1,
  project: "vite-app",
  build: {
    install: "pnpm install --frozen-lockfile --ignore-scripts",
    command: "pnpm run build",
    output: "dist",
  },
  runtime: { mode: "static" },
});
const PACKAGE = {
  packageManager: "pnpm@10.28.2",
  scripts: { build: "vite build" },
  devDependencies: { vite: "8.2.2" },
};
function adapter(
  packageJson: unknown = PACKAGE,
  viteConfig: unknown = "export default { base: '/' };",
  loadLockfile?: ViteFrameworkAdapterDependencies["loadLockfile"],
) {
  return createViteFrameworkAdapter({
    loadPackageJson: async () => packageJson,
    loadViteConfig: async () => viteConfig,
    ...(loadLockfile === undefined ? {} : { loadLockfile }),
  });
}

const diagnosticError = (diagnostic: Readonly<Record<string, string>>) => ({
  name: "FrameworkConversionDiagnosticError",
  diagnostic,
});
const COMPANION_REQUIRED = diagnosticError({
  code: "companion_entry_required",
  path: "src/ohmyhost/companion.ts",
});

const repositoryConfigEvidence = {
  scope: "repository" as const,
  path: "ohmyhost.yaml" as const,
  reason: "authoritative repository configuration",
};

function planInput(
  application: { readonly root: typeof CONFIG.applicationRoot; readonly files: readonly string[] },
  detection: Awaited<ReturnType<ReturnType<typeof adapter>["detect"]>>,
  repositoryConfig = CONFIG,
) {
  return { repositoryConfig, repositoryConfigEvidence, application, detection };
}

describe("production Vite adapter", () => {
  it("admits direct Vite builds with one TypeScript build stage", async () => {
    for (const build of [
      "vite build && tsc --noEmit",
      "tsc --noEmit && vite build",
      "tsc -b && vite build",
      "tsc --build && vite build",
      "tsc && vite build",
    ]) {
      const subject = adapter({ ...PACKAGE, scripts: { build } });
      const application = { root: CONFIG.applicationRoot, files: FILES };
      await expect(
        subject.plan(planInput(application, await subject.detect(application))),
      ).resolves.toMatchObject({ buildCommand: "pnpm run build", runtime: "static" });
    }
    for (const build of [
      "tsc -b && vite build && node deploy.mjs",
      "cd app && vite build",
      "tsc ../other/tsconfig.json && vite build",
      "vite build; node deploy.mjs",
      "vite build && echo done",
      "vite build && tsc --noEmit && tsc -b",
    ]) {
      const subject = adapter({ ...PACKAGE, scripts: { build } });
      const application = { root: CONFIG.applicationRoot, files: FILES };
      await expect(
        subject.plan(planInput(application, await subject.detect(application))),
      ).rejects.toMatchObject(
        diagnosticError({
          code: "build_script_unsupported",
          path: "package.json",
          framework: "vite-static",
        }),
      );
    }
  });

  it("plans an HTTP-only Vite companion without managed capabilities", async () => {
    const subject = adapter();
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge", egress: { allow: ["https://api.example.com"] } },
    });
    const application = { root: CONFIG.applicationRoot, files: FILES };
    await expect(
      subject.plan(planInput(application, await subject.detect(application), config)),
    ).resolves.toMatchObject({
      runtime: "edge",
      serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
      runtimePolicy: { egressAllowedOrigins: ["https://api.example.com"] },
    });
    const missing = {
      ...application,
      files: FILES.filter((path) => path !== "src/ohmyhost/companion.ts"),
    };
    await expect(
      subject.plan(planInput(missing, await subject.detect(missing), config)),
    ).rejects.toMatchObject(COMPANION_REQUIRED);
  });

  it.each([
    "export default { base: '/customer' };",
    "export default { base: process.env.PUBLIC_BASE };",
    "const base = '/nested/'; export default { base };",
    "export default { ['base']: '/computed' };",
  ])("rejects non-root or unresolved Vite base %s", async (viteConfig) => {
    const subject = adapter(PACKAGE, viteConfig);
    const application = { root: CONFIG.applicationRoot, files: FILES };

    await expect(
      subject.plan(planInput(application, await subject.detect(application))),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "framework_base_path_unsupported", path: "vite.config.ts" },
    });
  });

  it.each([
    "export default { plugins: [] };",
    "export default { base: '/', plugins: [] };",
    "export default { base: undefined, plugins: [] };",
    "export default { label: 'base', plugins: [] };",
  ])("accepts a root-origin Vite config", async (viteConfig) => {
    const subject = adapter(PACKAGE, viteConfig);
    const application = { root: CONFIG.applicationRoot, files: FILES };

    await expect(
      subject.plan(planInput(application, await subject.detect(application))),
    ).resolves.toMatchObject({ adapter: "vite-static", runtime: "static" });
  });

  it("returns one frozen deterministic static plan", async () => {
    const subject = adapter();
    const application = { root: CONFIG.applicationRoot, files: FILES };
    const detection = await subject.detect(application);
    const plan = await subject.plan(planInput(application, detection));
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
        {
          path: "vite.config.ts",
          reason: "explicit Vite configuration",
          scope: "application",
        },
      ],
    });
    expect(plan).toEqual({
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
    expect(Object.isFrozen(detection)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("binds a normalized nested application root without treating repository config as application evidence", async () => {
    const subject = adapter();
    const repositoryConfig = parseOhmyhostConfig({ ...CONFIG, applicationRoot: "site" });
    const application = { root: repositoryConfig.applicationRoot, files: FILES };
    const detection = await subject.detect(application);

    await expect(
      subject.plan({
        repositoryConfig,
        repositoryConfigEvidence,
        application,
        detection,
      }),
    ).resolves.toMatchObject({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: "site",
      adapter: "vite-static",
    });
    expect(detection.evidence).not.toContainEqual(
      expect.objectContaining({ path: "ohmyhost.yaml" }),
    );
  });

  it("plans pinned Better Auth behind the same-origin Vite companion", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      auth: { provider: "better-auth" },
      database: { enabled: true, migrations: "migrations" },
      mail: { enabled: true },
    });
    const subject = adapter({
      ...PACKAGE,
      dependencies: { "better-auth": "1.7.7" },
      devDependencies: PACKAGE.devDependencies,
    });
    const application = { root: config.applicationRoot, files: FILES };
    const detection = await subject.detect(application);

    await expect(subject.plan(planInput(application, detection, config))).resolves.toMatchObject({
      schemaVersion: "ohmyhost.framework-plan/v5",
      adapter: "vite-static",
      runtime: "edge",
      outputDirectory: "dist",
      serverOutputDirectory: ".ohmyhost/vite-companion",
      serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
      serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      auth: { provider: "better-auth", version: "1.7.7", deployment: "companion" },
    });
    await expect(
      subject.plan(planInput(application, detection, config)).then((plan) => plan.functions),
    ).resolves.toBeUndefined();
  });

  it("binds declared crons to the Vite edge plan without inventing runtime triggers", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      functions: { crons: ["*/5 * * * *"] },
    });
    const subject = adapter({
      ...PACKAGE,
      devDependencies: PACKAGE.devDependencies,
    });
    const application = { root: config.applicationRoot, files: FILES };
    const plan = await subject.plan(
      planInput(application, await subject.detect(application), config),
    );

    expect(plan).toMatchObject({ runtime: "edge", functions: { crons: ["*/5 * * * *"] } });
    expect(Object.isFrozen(plan.functions)).toBe(true);
  });

  it("rejects declared crons without the API companion that runs them", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      functions: { crons: ["*/5 * * * *"] },
    });
    const subject = adapter(PACKAGE);
    const files = FILES.filter((path) => path !== "src/ohmyhost/companion.ts");
    const application = { root: config.applicationRoot, files };
    await expect(
      subject.plan(planInput(application, await subject.detect(application), config)),
    ).rejects.toMatchObject(COMPANION_REQUIRED);
  });

  it("accepts an ordinary root-origin Vite edge companion config", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      database: { enabled: true, migrations: "migrations" },
    });
    const subject = adapter({
      ...PACKAGE,
      devDependencies: PACKAGE.devDependencies,
    });
    const application = { root: config.applicationRoot, files: FILES };
    const detection = await subject.detect(application);

    await expect(subject.plan(planInput(application, detection, config))).resolves.toMatchObject({
      runtime: "edge",
    });
  });

  it("rejects server capabilities when the fixed Vite companion entry is absent", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      auth: { provider: "better-auth" },
      database: { enabled: true, migrations: "migrations" },
      mail: { enabled: true },
    });
    const subject = adapter({
      ...PACKAGE,
      dependencies: { "better-auth": "1.7.7" },
      devDependencies: PACKAGE.devDependencies,
    });
    const application = {
      root: config.applicationRoot,
      files: FILES.filter((path) => path !== "src/ohmyhost/companion.ts"),
    };
    const detection = await subject.detect(application);

    await expect(subject.plan(planInput(application, detection, config))).rejects.toMatchObject(
      COMPANION_REQUIRED,
    );
  });

  it("binds a declared AI gateway to the Vite companion plan and requires the companion for it", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      ai: { enabled: true, jurisdiction: "eu" },
    });
    const subject = adapter(PACKAGE);
    const application = { root: config.applicationRoot, files: FILES };
    const plan = await subject.plan(
      planInput(application, await subject.detect(application), config),
    );

    expect(plan).toMatchObject({ runtime: "edge", ai: { enabled: true, jurisdiction: "eu" } });
    expect(Object.isFrozen(plan.ai)).toBe(true);
    const missing = {
      root: config.applicationRoot,
      files: FILES.filter((path) => path !== "src/ohmyhost/companion.ts"),
    };
    await expect(
      subject.plan(planInput(missing, await subject.detect(missing), config)),
    ).rejects.toMatchObject(COMPANION_REQUIRED);
    const disabled = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      ai: { enabled: false },
    });
    const disabledPlan = await subject.plan(
      planInput(application, await subject.detect(application), disabled),
    );
    expect(Object.hasOwn(disabledPlan, "ai")).toBe(false);
  });

  it("rejects project storage when the selected Vite runtime is static", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      storage: { provider: "r2", jurisdiction: "us", public: false },
    });
    const subject = adapter({
      ...PACKAGE,
      devDependencies: { ...PACKAGE.devDependencies, wrangler: "4.125.0" },
    });
    const application = { root: config.applicationRoot, files: FILES };
    const detection = await subject.detect(application);

    await expect(subject.plan(planInput(application, detection, config))).rejects.toMatchObject(
      diagnosticError({
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "vite-static",
      }),
    );
  });

  it("does not require customer repositories to declare the platform-pinned Wrangler builder", async () => {
    const config = parseOhmyhostConfig({
      ...CONFIG,
      runtime: { mode: "edge" },
      database: { enabled: true, migrations: "migrations" },
    });
    const subject = adapter(PACKAGE);
    const application = { root: config.applicationRoot, files: FILES };

    await expect(
      subject.plan(planInput(application, await subject.detect(application), config)),
    ).resolves.toMatchObject({ runtime: "edge" });
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
      const config = parseOhmyhostConfig({
        ...CONFIG,
        build: { ...CONFIG.build, install: installCommand, command: buildCommand },
      });
      const subject = adapter({ ...PACKAGE, packageManager });
      const application = { root: config.applicationRoot, files: ["package.json", lockfile] };
      const detection = await subject.detect(application);

      await expect(subject.plan(planInput(application, detection, config))).resolves.toMatchObject({
        installCommand,
        buildCommand,
      });
      expect(detection.evidence).toContainEqual(expect.objectContaining({ path: lockfile }));
    },
  );

  it("rejects ambiguous Vite configuration before planning", async () => {
    await expect(
      adapter().detect({
        root: CONFIG.applicationRoot,
        files: [...FILES, "vite.config.mjs"],
      }),
    ).rejects.toMatchObject({
      code: "framework_admission_failed",
      reason: "ambiguous_config",
    });
  });

  it.each(["5.4.6", "7.3.6", "8.2.2", "8.2.3", "8.3.4", "9.0.0", "^8.2.2", "^5.4.0"])(
    "admits Vite %s at or above its security minimum",
    async (version) => {
      const subject = adapter({ ...PACKAGE, devDependencies: { vite: version } });
      const application = { root: CONFIG.applicationRoot, files: FILES };
      await expect(
        subject.plan(planInput(application, await subject.detect(application))),
      ).resolves.toMatchObject({ adapter: "vite-static" });
    },
  );

  it.each(["4.5.14", "5.3.99", "5.4.5", "8.3.0-beta.1", "~5.3.0"])(
    "refuses Vite %s below its security minimum",
    async (version) => {
      const subject = adapter({ ...PACKAGE, devDependencies: { vite: version } });
      const application = { root: CONFIG.applicationRoot, files: FILES };
      await expect(
        subject.plan(planInput(application, await subject.detect(application))),
      ).rejects.toMatchObject(
        diagnosticError({
          code: "framework_version_unsupported",
          path: "package.json",
          package: "vite",
          version,
          minimum: "5.4.6",
        }),
      );
    },
  );

  it("judges the Vite version that the loaded lockfile resolves", async () => {
    const lockfile = (version: string) =>
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      vite:\n        specifier: ^5.4.0\n        version: ${version}\n`;
    const packageJson = { ...PACKAGE, devDependencies: { vite: "^5.4.0" } };
    const application = { root: CONFIG.applicationRoot, files: FILES };
    const refused = adapter(packageJson, undefined, async (path) =>
      path === "pnpm-lock.yaml" ? lockfile("5.4.5") : undefined,
    );
    await expect(
      refused.plan(planInput(application, await refused.detect(application))),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "framework_version_unsupported",
        path: "pnpm-lock.yaml",
        package: "vite",
        version: "5.4.5",
        minimum: "5.4.6",
      }),
    );
    const admitted = adapter(packageJson, undefined, async () => lockfile("5.4.21"));
    await expect(
      admitted.plan(planInput(application, await admitted.detect(application))),
    ).resolves.toMatchObject({ adapter: "vite-static" });
    const invalid = adapter(packageJson, undefined, async () => 7 as never);
    await expect(
      invalid.plan(planInput(application, await invalid.detect(application))),
    ).rejects.toThrow("Framework lockfile loader returned no text");
    expect(() =>
      createViteFrameworkAdapter({
        loadPackageJson: async () => PACKAGE,
        loadLockfile: 1 as never,
      }),
    ).toThrow("Vite adapter content loaders are required");
  });

  it("requires explicit content loaders", () => {
    expect(() => createViteFrameworkAdapter(undefined as never)).toThrow(
      "Vite adapter content loaders are required",
    );
  });

  it("requires a config loader only when an explicit Vite config exists", async () => {
    const subject = createViteFrameworkAdapter({ loadPackageJson: async () => PACKAGE });
    const withoutConfig = {
      root: CONFIG.applicationRoot,
      files: FILES.filter((file) => file !== "vite.config.ts"),
    };
    await expect(
      subject.plan(planInput(withoutConfig, await subject.detect(withoutConfig))),
    ).resolves.toMatchObject({ adapter: "vite-static", runtime: "static" });

    const withConfig = { root: CONFIG.applicationRoot, files: FILES };
    await expect(
      subject.plan(planInput(withConfig, await subject.detect(withConfig))),
    ).rejects.toThrow("Vite config loader is required");
  });

  it.each([
    [["package.json"], "missing lock"],
    [[...FILES, "package-lock.json"], "multiple locks"],
  ])("does not detect %s (%s)", async (files) => {
    await expect(adapter().detect({ root: CONFIG.applicationRoot, files })).resolves.toMatchObject({
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
        framework: "vite-static",
      }),
    ],
    [
      { ...PACKAGE, devDependencies: {} },
      diagnosticError({
        code: "framework_dependency_required",
        path: "package.json",
        package: "vite",
      }),
    ],
    [
      { ...PACKAGE, devDependencies: {}, optionalDependencies: { vite: "8.2.2" } },
      diagnosticError({
        code: "framework_dependency_required",
        path: "package.json",
        package: "vite",
      }),
    ],
  ])("rejects unsafe package metadata", async (packageJson, error) => {
    const subject = adapter(packageJson);
    const application = { root: CONFIG.applicationRoot, files: FILES };
    await expect(
      subject.plan(planInput(application, await subject.detect(application))),
    ).rejects.toMatchObject(error);
  });

  it("rejects output, malformed package JSON, and forged detection", async () => {
    const application = { root: CONFIG.applicationRoot, files: FILES };
    const output = adapter();
    await expect(
      output.plan(
        planInput(application, await output.detect(application), {
          ...CONFIG,
          build: { ...CONFIG.build, ssg_cache_max_mib: 32 },
        } as never),
      ),
    ).rejects.toMatchObject(
      diagnosticError({ code: "build_option_unsupported", path: "ohmyhost.yaml" }),
    );
    await expect(
      output.plan(
        planInput(application, await output.detect(application), {
          ...CONFIG,
          build: { ...CONFIG.build, output: "build" },
        } as never),
      ),
    ).rejects.toMatchObject(
      diagnosticError({
        code: "build_output_unsupported",
        path: "ohmyhost.yaml",
        framework: "vite-static",
      }),
    );
    const malformed = adapter("{not-json");
    await expect(
      malformed.plan(planInput(application, await malformed.detect(application))),
    ).rejects.toMatchObject(
      diagnosticError({ code: "package_manifest_invalid", path: "package.json" }),
    );
    const binary = adapter(PACKAGE, new Uint8Array([1]));
    await expect(
      binary.plan(planInput(application, await binary.detect(application))),
    ).rejects.toThrow("vite.config.ts must be text");
    await expect(
      adapter().plan({
        repositoryConfig: CONFIG,
        repositoryConfigEvidence,
        application,
        detection: { adapter: "other", confidenceBasisPoints: 10_000, evidence: [] },
      }),
    ).rejects.toThrow("with a lockfile");
    const subject = adapter();
    const detection = await subject.detect(application);
    await expect(
      subject.plan({
        ...planInput(application, detection),
        repositoryConfigEvidence: {
          scope: "application",
          path: "ohmyhost.yaml",
          reason: "forged",
        } as never,
      }),
    ).rejects.toThrow("with a lockfile");
    await expect(
      subject.plan({
        ...planInput(application, detection),
        repositoryConfig: parseOhmyhostConfig({ ...CONFIG, applicationRoot: "site" }),
      }),
    ).rejects.toThrow("with a lockfile");
  });
});
