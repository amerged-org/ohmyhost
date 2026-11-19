import { parseOhmyhostConfig } from "@ohmyhost/contracts";
import { parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import { createFunctionsFrameworkAdapter, FUNCTIONS_RUNTIME_CONTRACT } from "./index.js";

const FILES = ["ohmyhost.yaml", "package.json", "pnpm-lock.yaml", "src/ohmyhost/worker.ts"];
const CONFIG = {
  version: 1,
  project: "jobs",
  build: { install: "pnpm install --frozen-lockfile --ignore-scripts" },
  runtime: { mode: "functions", healthcheck: "/health" },
  functions: { crons: ["0 3 * * *", "*/15 * * * *"] },
};
const PACKAGE = { packageManager: "pnpm@10.28.2", dependencies: {} };
const ROOT = parseOhmyhostConfig(CONFIG).applicationRoot;
const repositoryConfigEvidence = {
  scope: "repository" as const,
  path: "ohmyhost.yaml" as const,
  reason: "authoritative repository configuration",
};

function adapter(packageJson: unknown = PACKAGE) {
  return createFunctionsFrameworkAdapter({ loadPackageJson: async () => packageJson });
}

async function plan(
  config: unknown = CONFIG,
  files: readonly string[] = FILES,
  packageJson: unknown = PACKAGE,
  requestedRuntime?: "auto" | "static" | "edge" | "functions",
) {
  const subject = adapter(packageJson);
  const repositoryConfig = parseOhmyhostConfig(config);
  const application = { root: repositoryConfig.applicationRoot, files };
  return subject.plan({
    repositoryConfig,
    repositoryConfigEvidence,
    application,
    detection: await subject.detect(application),
    ...(requestedRuntime === undefined ? {} : { requestedRuntime }),
  });
}

describe("functions framework adapter", () => {
  it("detects a Worker module with a pinned package manager and no framework", async () => {
    const detection = await adapter().detect({ root: ROOT, files: FILES });
    expect(detection).toEqual({
      adapter: "functions",
      confidenceBasisPoints: 10_000,
      evidence: [
        expect.objectContaining({ path: "package.json" }),
        expect.objectContaining({ path: "pnpm-lock.yaml" }),
        expect.objectContaining({ path: "src/ohmyhost/worker.ts" }),
      ],
    });
    expect(
      await adapter().detect({
        root: ROOT,
        files: FILES.filter((f) => f !== "src/ohmyhost/worker.ts"),
      }),
    ).toMatchObject({ confidenceBasisPoints: 0 });
    expect(await adapter().detect({ root: ROOT, files: [...FILES, "yarn.lock"] })).toMatchObject({
      confidenceBasisPoints: 0,
    });
  });

  it("returns one frozen functions plan with declared crons and companion-style auth", async () => {
    const result = await plan(
      {
        ...CONFIG,
        database: { enabled: true, migrations: "migrations" },
        auth: { provider: "better-auth" },
        mail: { enabled: true },
      },
      FILES,
      { ...PACKAGE, dependencies: { "better-auth": "1.7.7" } },
      "auto",
    );
    expect(result).toEqual({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "functions",
      runtime: "functions",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: { healthCheckPath: "/health", egressAllowedOrigins: [] },
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
      storage: { enabled: false },
      functions: { crons: ["*/15 * * * *", "0 3 * * *"] },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.functions)).toBe(true);
    expect("buildCommand" in result).toBe(false);
    expect(FUNCTIONS_RUNTIME_CONTRACT.artifact.entryPoint).toBe(".ohmyhost/functions/worker.js");
  });

  it("binds a declared AI gateway to the functions plan and omits it when disabled", async () => {
    const result = await plan({ ...CONFIG, ai: { enabled: true, jurisdiction: "eu" } });
    expect(result.ai).toEqual({ enabled: true, jurisdiction: "eu" });
    expect(Object.isFrozen(result.ai)).toBe(true);
    expect(parseNewProductionFrameworkPlan(result)).toEqual(result);
    expect(Object.hasOwn(await plan({ ...CONFIG, ai: { enabled: false } }), "ai")).toBe(false);
    expect(Object.hasOwn(await plan(CONFIG), "ai")).toBe(false);
  });

  it("omits functions without crons and rejects conflicting runtimes, builds and package managers", async () => {
    const withoutCrons = Object.fromEntries(
      Object.entries(CONFIG).filter(([key]) => key !== "functions"),
    );
    expect((await plan(withoutCrons)).functions).toBeUndefined();
    await expect(plan(CONFIG, FILES, PACKAGE, "edge")).rejects.toThrow(
      "requested runtime edge conflicts with the functions runtime",
    );
    await expect(
      plan({ ...CONFIG, build: { install: "npm ci --ignore-scripts" } }),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "build_command_mismatch", path: "ohmyhost.yaml" },
    });
    await expect(plan(CONFIG, FILES, { dependencies: {} })).rejects.toMatchObject({
      code: "framework_admission_failed",
      reason: "missing_package_manager",
    });
    await expect(plan(CONFIG, FILES, "[]")).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "package_manifest_invalid", path: "package.json" },
    });
    await expect(
      plan({
        ...CONFIG,
        database: { enabled: true, migrations: "migrations" },
        auth: { provider: "better-auth" },
      }),
    ).rejects.toMatchObject({
      name: "FrameworkConversionDiagnosticError",
      diagnostic: { code: "better_auth_version_required", path: "package.json" },
    });
    await expect(
      plan({
        ...CONFIG,
        runtime: { mode: "edge" },
        build: { ...CONFIG.build, command: "pnpm run build", output: "dist" },
      }),
    ).rejects.toThrow();
    await expect(
      plan(
        CONFIG,
        FILES.filter((f) => f !== "src/ohmyhost/worker.ts"),
      ),
    ).rejects.toThrow("src/ohmyhost/worker.ts are required before functions planning");
  });
});
