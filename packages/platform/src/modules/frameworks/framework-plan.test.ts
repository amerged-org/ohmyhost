import {
  APPLICATION_ROOT_CONFORMANCE_CORPUS,
  normalizeApplicationRoot,
  parseOhmyhostConfig,
  resolvePackageManager,
} from "@ohmyhost/contracts";
import { describe, expect, it } from "vitest";

import {
  assertFrameworkSource,
  databaseRequirementFromConfig,
  loadFrameworkLockfile,
  requirePackageManifest,
  WORKER_MODULE_PATH,
  mailRequirementFromConfig,
  storageRequirementFromConfig,
  functionsRequirementFromConfig,
  aiRequirementFromConfig,
  parseNewProductionFrameworkPlan,
  parseProductionStaticFrameworkPlan,
  parseStaticFrameworkPlan,
  serializeNewProductionFrameworkPlanPreimage,
} from "./index.js";

const runtimePolicy = {
  healthCheckPath: "/health",
  egressAllowedOrigins: ["https://api.example.com"],
} as const;

const packageManagerCommands = [
  {
    manager: "bun",
    installCommand: "bun install --frozen-lockfile --ignore-scripts",
    buildCommand: "bun run build",
  },
  {
    manager: "npm",
    installCommand: "npm ci --ignore-scripts",
    buildCommand: "npm run build",
  },
  {
    manager: "pnpm",
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
  },
  {
    manager: "yarn",
    installCommand: "yarn install --immutable --mode=skip-build",
    buildCommand: "yarn run build",
  },
] as const;

const currentStaticPlans = [
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: "site",
    adapter: "vite-static",
    runtime: "static",
    installCommand: "npm ci --ignore-scripts",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    runtimePolicy,
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  },
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "tanstack-start",
    runtime: "static",
    installCommand: "bun install --frozen-lockfile --ignore-scripts",
    buildCommand: "bun run build",
    outputDirectory: "dist/client",
    runtimePolicy,
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: true },
    storage: { enabled: false },
  },
] as const;

const currentEdgePlans = [
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "vite-static",
    runtime: "edge",
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputDirectory: "dist",
    serverOutputDirectory: ".ohmyhost/vite-companion",
    serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
    serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy,
    database: { enabled: true, migrations: "migrations" },
    auth: {
      provider: "better-auth",
      version: "1.7.7",
      deployment: "companion",
      routePath: "/api/auth",
      databaseSchema: "auth",
      databaseBindingName: "OHMYHOST_DATABASE",
      authSecretName: "BETTER_AUTH_SECRET",
    },
    mail: { enabled: true },
    storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false },
    functions: { crons: ["*/5 * * * *", "15 * * * *"] },
  },
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: "apps/web",
    adapter: "tanstack-start",
    runtime: "edge",
    installCommand: "yarn install --immutable --mode=skip-build",
    buildCommand: "yarn run build",
    outputDirectory: "dist/client",
    serverOutputDirectory: "dist/server",
    serverEntryPoint: "dist/server/index.js",
    serverConfigPath: "dist/server/wrangler.json",
    compatibilityDate: "2026-08-21",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy,
    database: { enabled: true, migrations: "supabase/migrations" },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  },
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: "site",
    adapter: "nextjs",
    runtime: "edge",
    installCommand: "bun install --frozen-lockfile --ignore-scripts",
    buildCommand: "bun run build",
    outputDirectory: ".open-next/assets",
    serverOutputDirectory: ".ohmyhost-worker",
    serverEntryPoint: ".ohmyhost-worker/worker.js",
    serverConfigPath: "wrangler.jsonc",
    compatibilityDate: "2024-09-23",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy,
    database: { enabled: true, migrations: "migrations" },
    auth: {
      provider: "better-auth",
      version: "1.7.7",
      deployment: "embedded",
      routePath: "/api/auth",
      databaseSchema: "auth",
      databaseBindingName: "OHMYHOST_DATABASE",
      authSecretName: "BETTER_AUTH_SECRET",
    },
    mail: { enabled: true },
    storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false },
  },
] as const;

const currentFunctionsPlans = [
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "functions",
    runtime: "functions",
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy,
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  },
  {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: "workers/jobs",
    adapter: "functions",
    runtime: "functions",
    installCommand: "npm ci --ignore-scripts",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy,
    database: { enabled: true, migrations: "migrations" },
    auth: {
      provider: "better-auth",
      version: "1.7.7",
      deployment: "companion",
      routePath: "/api/auth",
      databaseSchema: "auth",
      databaseBindingName: "OHMYHOST_DATABASE",
      authSecretName: "BETTER_AUTH_SECRET",
    },
    mail: { enabled: true },
    storage: { enabled: true, provider: "r2", jurisdiction: "us", public: false },
    functions: { crons: ["0 3 * * *"] },
  },
] as const;

describe("Native Auth framework plans", () => {
  it("admits static and server plans without a business database and rejects altered bindings", () => {
    const auth = {
      provider: "omh-native",
      routePath: "/api/auth/v1",
      bindingName: "OHMYHOST_AUTH",
    };
    for (const adapter of ["vite-static", "astro"] as const) {
      const plan = { ...currentStaticPlans[0], adapter, auth };
      expect(parseStaticFrameworkPlan(plan).auth).toEqual(auth);
      expect(() =>
        parseStaticFrameworkPlan({ ...plan, auth: { ...auth, bindingName: "OTHER" } }),
      ).toThrow();
    }
    const edge = { ...currentEdgePlans[2], database: { enabled: false }, auth };
    expect(parseNewProductionFrameworkPlan(edge).auth).toEqual(auth);
  });
});

const obsoletePlans = [
  {
    ...Object.fromEntries(
      Object.entries(currentStaticPlans[0]).filter(([key]) => key !== "storage"),
    ),
    schemaVersion: "ohmyhost.framework-plan/v4",
  },
  {
    ...Object.fromEntries(
      Object.entries(currentEdgePlans[0]).filter(
        ([key]) => key !== "auth" && key !== "mail" && key !== "storage",
      ),
    ),
    schemaVersion: "ohmyhost.framework-plan/v2",
  },
  Object.fromEntries(
    Object.entries(currentEdgePlans[1]).filter(
      ([key]) =>
        key !== "schemaVersion" &&
        key !== "applicationRoot" &&
        key !== "runtimePolicy" &&
        key !== "database" &&
        key !== "auth" &&
        key !== "mail" &&
        key !== "storage",
    ),
  ),
] as const;

describe("static framework plan contract", () => {
  it("normalizes repository database configuration without retaining mutable input", () => {
    expect(databaseRequirementFromConfig({ database: undefined } as never)).toEqual({
      enabled: false,
    });
    const config = {
      database: { enabled: true, migrations: "supabase/migrations" },
    } as never;
    const requirement = databaseRequirementFromConfig(config);
    expect(requirement).toEqual({ enabled: true, migrations: "supabase/migrations" });
    expect(Object.isFrozen(requirement)).toBe(true);
  });
  it("normalizes independent repository mail configuration", () => {
    expect(mailRequirementFromConfig({ mail: undefined } as never)).toEqual({ enabled: false });
    expect(mailRequirementFromConfig({ mail: { enabled: true } } as never)).toEqual({
      enabled: true,
    });
  });
  it("normalizes the private EU repository storage contract", () => {
    expect(storageRequirementFromConfig({ storage: undefined } as never)).toEqual({
      enabled: false,
    });
    expect(
      storageRequirementFromConfig({
        storage: { provider: "r2", jurisdiction: "eu", public: false },
      } as never),
    ).toEqual({
      enabled: true,
      provider: "r2",
      jurisdiction: "eu",
      public: false,
    });
  });
  it("derives declared crons as one immutable requirement and nothing without schedules", () => {
    const requirement = functionsRequirementFromConfig({
      functions: { crons: ["*/5 * * * *", "15 * * * *"] },
    } as never);
    expect(requirement).toEqual({ crons: ["*/5 * * * *", "15 * * * *"] });
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(Object.isFrozen(requirement?.crons)).toBe(true);
    expect(functionsRequirementFromConfig({} as never)).toBeUndefined();
    expect(functionsRequirementFromConfig({ functions: { crons: [] } } as never)).toBeUndefined();
  });
  it.each(currentStaticPlans)("accepts and freezes the v5 $adapter plan", (value) => {
    const plan = parseStaticFrameworkPlan(value);

    expect(plan).toEqual(value);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("keeps the generic config adapter local-only while requiring v5 provenance", () => {
    const local = {
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "ohmyhost-config",
      runtime: "static",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: "public",
      runtimePolicy,
      database: { enabled: false as const },
      auth: { provider: "none" as const },
      mail: { enabled: false as const },
      storage: { enabled: false as const },
    };

    expect(parseStaticFrameworkPlan(local)).toEqual(local);
    expect(() => parseProductionStaticFrameworkPlan(local)).toThrow(
      "Static framework plan is invalid",
    );
    expect(parseProductionStaticFrameworkPlan(currentStaticPlans[0])).toEqual(
      currentStaticPlans[0],
    );
  });
});

describe("production framework plan version boundary", () => {
  it.each([...currentStaticPlans, ...currentEdgePlans])(
    "accepts and deeply freezes the current $adapter/$runtime plan",
    (value) => {
      const parsed = parseNewProductionFrameworkPlan(value);

      expect(parsed).toEqual(value);
      expect(Object.isFrozen(parsed)).toBe(true);
      if (parsed.runtime === "edge") expect(Object.isFrozen(parsed.compatibilityFlags)).toBe(true);
      if (value.adapter === "nextjs") {
        const revalidating = { ...value, nextRevalidatePath: true };
        expect(parseNewProductionFrameworkPlan(revalidating)).toEqual(revalidating);
        expect(JSON.parse(serializeNewProductionFrameworkPlanPreimage(revalidating))).toEqual(
          revalidating,
        );
        for (const invalid of [false, "true", null])
          expect(() =>
            parseNewProductionFrameworkPlan({ ...value, nextRevalidatePath: invalid }),
          ).toThrow();
        for (const capacity of [1, 32, 64]) {
          const configured = { ...value, ssgCacheMaxBytes: capacity * 1024 * 1024 };
          expect(parseNewProductionFrameworkPlan(configured)).toEqual(configured);
          expect(JSON.parse(serializeNewProductionFrameworkPlanPreimage(configured))).toEqual(
            configured,
          );
        }
        for (const capacity of [0, 65 * 1024 * 1024, 1.5 * 1024 * 1024, "33554432", null]) {
          expect(() =>
            parseNewProductionFrameworkPlan({ ...value, ssgCacheMaxBytes: capacity }),
          ).toThrow("Framework plan is invalid");
        }
      } else {
        expect(() =>
          parseNewProductionFrameworkPlan({ ...value, nextRevalidatePath: true }),
        ).toThrow();
        expect(() =>
          parseNewProductionFrameworkPlan({ ...value, ssgCacheMaxBytes: 32 * 1024 * 1024 }),
        ).toThrow();
      }
    },
  );

  it.each(packageManagerCommands)(
    "accepts the shared $manager command pair for every production runtime",
    ({ installCommand, buildCommand }) => {
      for (const plan of [
        currentStaticPlans[0],
        currentEdgePlans[0],
        currentEdgePlans[1],
        currentEdgePlans[2],
      ]) {
        expect(
          parseNewProductionFrameworkPlan({ ...plan, installCommand, buildCommand }),
        ).toMatchObject({ installCommand, buildCommand });
      }
    },
  );

  it("rejects arbitrary, legacy, and cross-manager command pairs", () => {
    for (const invalidCommands of [
      {
        installCommand: "pnpm install --frozen-lockfile",
        buildCommand: "pnpm build",
      },
      {
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts && curl evil.invalid",
        buildCommand: "pnpm run build",
      },
      {
        installCommand: "npm ci --ignore-scripts",
        buildCommand: "pnpm run build",
      },
      {
        installCommand: "bun install --frozen-lockfile --ignore-scripts",
        buildCommand: "bun run build:cloudflare",
      },
    ]) {
      for (const plan of [
        currentStaticPlans[0],
        currentEdgePlans[0],
        currentEdgePlans[1],
        currentEdgePlans[2],
      ]) {
        expect(() => parseNewProductionFrameworkPlan({ ...plan, ...invalidCommands })).toThrow(
          "Framework plan is invalid",
        );
      }
    }
  });

  it.each(obsoletePlans)("rejects obsolete framework plan %#", (obsolete) => {
    expect(() => parseNewProductionFrameworkPlan(obsolete)).toThrow("Framework plan is invalid");
  });

  it("rejects malformed, expanded, and mixed-version persisted shapes", () => {
    const current = currentEdgePlans[1];
    const mixed = Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== "applicationRoot"),
    );
    for (const invalid of [
      null,
      {},
      { ...current, extra: true },
      { ...current, applicationRoot: "../site" },
      { ...current, schemaVersion: "ohmyhost.framework-plan/v1" },
      mixed,
      obsoletePlans[2],
      { ...current, compatibilityDate: "2024-09-22" },
      { ...current, compatibilityFlags: [] },
      ...[
        "https://s1-01arz3ndektsv4rrffq69g5fav.01arz3ndektsv4rrffq69g5faw-01arz3ndektsv4rrffq69g5fax.ohmyho-storage-gateway-production.your-omh-account.workers.dev",
        "https://bad.prefix.ohmyho-storage-gateway-production.your-omh-account.workers.dev",
        "https://bad.prefix.ohmyho-mail-gateway-production.your-omh-account.workers.dev",
        "https://my_api.example.com",
        "https://example.com.",
        "https://intranet",
        `https://${"a".repeat(64)}.example.com`,
        "https://a.-b.example",
      ].map((origin) => ({
        ...current,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [origin] },
      })),
      {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: "site",
        adapter: "nextjs",
        runtime: "container",
        installCommand: packageManagerCommands[0].installCommand,
        buildCommand: packageManagerCommands[0].buildCommand,
        outputDirectory: ".next/standalone",
        serverOutputDirectory: ".next/standalone",
        serverEntryPoint: ".next/standalone/server.js",
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      },
      {
        ...current,
        storage: { enabled: true, provider: "r2", jurisdiction: "default", public: false },
      },
      {
        ...currentStaticPlans[0],
        storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false },
      },
      {
        ...currentEdgePlans[2],
        auth: { ...currentEdgePlans[2].auth, databaseBindingName: "HYPERDRIVE" },
      },
      { ...currentEdgePlans[0], functions: undefined },
      { ...currentEdgePlans[0], functions: { crons: [] } },
      { ...currentEdgePlans[0], functions: { crons: ["* * * * *"] } },
      { ...currentEdgePlans[0], functions: { crons: ["15 * * * *", "*/5 * * * *"] } },
      {
        ...currentEdgePlans[0],
        functions: {
          delivery: "at-least-once",
          timeoutSeconds: 120,
          maxAttempts: 3,
          scheduled: [
            { id: "sync", cron: "*/5 * * * *", handler: "src/ohmyhost/functions/sync.ts" },
          ],
        },
      },
      { ...currentFunctionsPlans[0], buildCommand: "pnpm run build" },
      { ...currentFunctionsPlans[0], outputDirectory: "dist" },
      { ...currentFunctionsPlans[0], compatibilityDate: "2024-12-31" },
      { ...currentFunctionsPlans[0], installCommand: "pnpm install" },
      { ...currentFunctionsPlans[1], functions: { crons: [] } },
    ]) {
      expect(() => parseNewProductionFrameworkPlan(invalid)).toThrow("Framework plan is invalid");
    }
  });

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)(
    "uses the shared root corpus for $name",
    ({ value }) => {
      const plan = parseNewProductionFrameworkPlan({
        ...currentStaticPlans[0],
        applicationRoot: value,
      });
      expect(plan.applicationRoot).toBe(normalizeApplicationRoot(value));
    },
  );

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)(
    "rejects the shared invalid root $name",
    ({ value }) => {
      expect(() =>
        parseNewProductionFrameworkPlan({
          ...currentStaticPlans[0],
          applicationRoot: value,
        }),
      ).toThrow("Framework plan is invalid");
    },
  );
});

describe("framework source admission helpers", () => {
  it("refuses a customer source with its first typed finding and reads only a loaded lockfile", async () => {
    expect(WORKER_MODULE_PATH).toBe("src/ohmyhost/worker.ts");
    expect(requirePackageManifest('{"name":"website"}')).toEqual({ name: "website" });
    for (const invalid of ["{bad", "[]", 7])
      expect(() => requirePackageManifest(invalid)).toThrow(
        expect.objectContaining({
          name: "FrameworkConversionDiagnosticError",
          diagnostic: { code: "package_manifest_invalid", path: "package.json" },
        }),
      );
    const files = ["package.json", "pnpm-lock.yaml"] as const;
    const input = {
      framework: "vite-static",
      files,
      configuration: parseOhmyhostConfig({
        version: 1,
        project: "website",
        build: {
          install: "pnpm install --frozen-lockfile --ignore-scripts",
          command: "pnpm run build",
          output: "dist",
        },
        runtime: { mode: "static" },
      }),
      manifest: {
        packageManager: "pnpm@10.28.2",
        scripts: { build: "vite build" },
        devDependencies: { vite: "^5.4.0" },
      },
      packageManager: resolvePackageManager({ packageManager: "pnpm@10.28.2", files }),
      lockfile: null,
      frameworkConfig: null,
    } as const;
    expect(() => assertFrameworkSource(input)).not.toThrow();
    const lockfile = await loadFrameworkLockfile(
      async () =>
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      vite:\n        specifier: ^5.4.0\n        version: 5.4.5\n",
      "pnpm-lock.yaml",
    );
    expect(lockfile).toEqual({ name: "pnpm-lock.yaml", text: expect.stringContaining("5.4.5") });
    expect(Object.isFrozen(lockfile)).toBe(true);
    expect(() => assertFrameworkSource({ ...input, lockfile })).toThrow(
      expect.objectContaining({
        name: "FrameworkConversionDiagnosticError",
        diagnostic: {
          code: "framework_version_unsupported",
          path: "pnpm-lock.yaml",
          package: "vite",
          version: "5.4.5",
          minimum: "5.4.6",
        },
      }),
    );
    expect(await loadFrameworkLockfile(undefined, "pnpm-lock.yaml")).toBeNull();
    expect(await loadFrameworkLockfile(async () => undefined, "bun.lockb")).toBeNull();
    await expect(
      loadFrameworkLockfile(async () => 7 as never, "package-lock.json"),
    ).rejects.toThrow("Framework lockfile loader returned no text");
  });
});

describe("functions framework plan contract", () => {
  it.each(currentFunctionsPlans)(
    "accepts and freezes the v5 functions plan at $applicationRoot",
    (value) => {
      const plan = parseNewProductionFrameworkPlan(value);

      expect(plan).toEqual(value);
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.compatibilityFlags)).toBe(true);
      if ("functions" in value) expect(Object.isFrozen(plan.functions?.crons)).toBe(true);
    },
  );

  it("serializes the functions plan with a fixed field order", () => {
    const plan = currentFunctionsPlans[1];
    const canonical = serializeNewProductionFrameworkPlanPreimage(plan);
    expect(JSON.parse(canonical)).toEqual(plan);
    expect(Object.keys(JSON.parse(canonical) as object)).toEqual([
      "schemaVersion",
      "applicationRoot",
      "adapter",
      "runtime",
      "installCommand",
      "compatibilityDate",
      "compatibilityFlags",
      "runtimePolicy",
      "database",
      "auth",
      "mail",
      "storage",
      "functions",
    ]);
    expect(
      serializeNewProductionFrameworkPlanPreimage(
        Object.fromEntries(Object.entries(plan).reverse()),
      ),
    ).toBe(canonical);
  });
});

describe("AI framework plan contract", () => {
  const aiFunctionsPlan = {
    ...currentFunctionsPlans[1],
    ai: { enabled: true, jurisdiction: "eu" },
  } as const;
  const aiEdgePlan = {
    ...currentEdgePlans[0],
    ai: { enabled: true, jurisdiction: "any" },
  } as const;

  it.each([
    aiFunctionsPlan,
    ...currentEdgePlans.map((plan) => ({
      ...plan,
      ai: { enabled: true, jurisdiction: "any" },
    })),
  ])("accepts and freezes an optional ai requirement on the $adapter/$runtime plan", (value) => {
    const parsed = parseNewProductionFrameworkPlan(value);

    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.ai)).toBe(true);
    expect(JSON.parse(serializeNewProductionFrameworkPlanPreimage(value))).toEqual(value);
  });

  it("serializes ai after functions and keeps a plan without ai byte-identical", () => {
    expect(serializeNewProductionFrameworkPlanPreimage(aiFunctionsPlan)).toMatch(
      /,"functions":\{"crons":\["0 3 \* \* \*"\]\},"ai":\{"enabled":true,"jurisdiction":"eu"\}\}$/u,
    );
    expect(serializeNewProductionFrameworkPlanPreimage(aiEdgePlan)).toMatch(
      /"functions":\{"crons":\["\*\/5 \* \* \* \*","15 \* \* \* \*"\]\},"ai":\{"enabled":true,"jurisdiction":"any"\}\}$/u,
    );
    expect(serializeNewProductionFrameworkPlanPreimage(currentFunctionsPlans[0])).toBe(
      '{"schemaVersion":"ohmyhost.framework-plan/v5","applicationRoot":".","adapter":"functions","runtime":"functions","installCommand":"pnpm install --frozen-lockfile --ignore-scripts","compatibilityDate":"2025-01-01","compatibilityFlags":["nodejs_compat"],"runtimePolicy":{"healthCheckPath":"/health","egressAllowedOrigins":["https://api.example.com"]},"database":{"enabled":false},"auth":{"provider":"none"},"mail":{"enabled":false},"storage":{"enabled":false}}',
    );
  });

  it("refuses ai on a static plan, which has no Worker to receive the key", () => {
    expect(() =>
      parseNewProductionFrameworkPlan({
        ...currentStaticPlans[0],
        ai: { enabled: true, jurisdiction: "eu" },
      }),
    ).toThrow("Framework plan is invalid");
  });

  it.each([
    { enabled: true, jurisdiction: "eu", extra: true },
    { enabled: false, jurisdiction: "eu" },
    { enabled: true, jurisdiction: "us" },
    { enabled: true },
    null,
    [],
  ])("refuses the malformed ai requirement %j", (ai) => {
    for (const plan of [aiFunctionsPlan, aiEdgePlan]) {
      expect(() => parseNewProductionFrameworkPlan({ ...plan, ai })).toThrow(
        "Framework plan is invalid",
      );
    }
  });

  it("derives the requirement from the config only when ai is enabled", () => {
    expect(aiRequirementFromConfig({} as never)).toBeUndefined();
    expect(aiRequirementFromConfig({ ai: { enabled: false } } as never)).toBeUndefined();
    const requirement = aiRequirementFromConfig({
      ai: { enabled: true, jurisdiction: "eu" },
    } as never);
    expect(requirement).toEqual({ enabled: true, jurisdiction: "eu" });
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(() => aiRequirementFromConfig({ ai: { enabled: true } } as never)).toThrow(
      "Framework plan is invalid",
    );
  });
});

describe("canonical v5 framework-plan preimage", () => {
  it.each([...currentStaticPlans, ...currentEdgePlans])(
    "serializes $adapter/$runtime with a fixed field order",
    (plan) => {
      const reordered = Object.fromEntries(Object.entries(plan).reverse());
      const canonical = serializeNewProductionFrameworkPlanPreimage(plan);

      expect(serializeNewProductionFrameworkPlanPreimage(reordered)).toBe(canonical);
      expect(JSON.parse(canonical)).toEqual(plan);
      expect(Object.keys(JSON.parse(canonical) as object)).toEqual(
        plan.runtime === "static"
          ? [
              "schemaVersion",
              "applicationRoot",
              "adapter",
              "runtime",
              "installCommand",
              "buildCommand",
              "outputDirectory",
              "runtimePolicy",
              "database",
              "auth",
              "mail",
              "storage",
            ]
          : [
              "schemaVersion",
              "applicationRoot",
              "adapter",
              "runtime",
              "installCommand",
              "buildCommand",
              "outputDirectory",
              "serverOutputDirectory",
              "serverEntryPoint",
              "serverConfigPath",
              "compatibilityDate",
              "compatibilityFlags",
              "runtimePolicy",
              "database",
              "auth",
              "mail",
              "storage",
              ...("functions" in plan ? ["functions"] : []),
            ],
      );
    },
  );

  it("changes when only the normalized application root changes and rejects legacy input", () => {
    const root = serializeNewProductionFrameworkPlanPreimage(currentStaticPlans[0]);
    const nested = serializeNewProductionFrameworkPlanPreimage({
      ...currentStaticPlans[0],
      applicationRoot: "other",
    });

    expect(nested).not.toBe(root);
    expect(() => serializeNewProductionFrameworkPlanPreimage(obsoletePlans[0])).toThrow(
      "Framework plan is invalid",
    );
  });
});

describe("Browser rendering plan", () => {
  it("round trips enabled browser access on every edge and functions plan, while rejecting static or malformed requirements", () => {
    for (const plan of [...currentEdgePlans, ...currentFunctionsPlans]) {
      const enabled = { ...plan, browser: { enabled: true } };
      expect(parseNewProductionFrameworkPlan(enabled)).toEqual(enabled);
      expect(JSON.parse(serializeNewProductionFrameworkPlanPreimage(enabled))).toEqual(enabled);
      for (const browser of [
        { enabled: false },
        { enabled: true, url: "https://example.com" },
        null,
      ])
        expect(() => parseNewProductionFrameworkPlan({ ...plan, browser })).toThrow(
          "Framework plan is invalid",
        );
    }
    expect(() =>
      parseNewProductionFrameworkPlan({ ...currentStaticPlans[0], browser: { enabled: true } }),
    ).toThrow("Framework plan is invalid");
  });
});
