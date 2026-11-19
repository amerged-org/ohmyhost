import {
  resolveFrameworkConfig,
  resolvePackageManager,
  requireApplicationBuild,
} from "@ohmyhost/contracts";
import {
  packageManagerDeclaration,
  viteCompanionRequired,
} from "@ohmyhost/contracts/framework-source-rules";
import {
  aiRequirementFromConfig,
  browserRequirementFromConfig,
  assertFrameworkSource,
  createCustomerAuthRequirement,
  databaseRequirementFromConfig,
  functionsRequirementFromConfig,
  loadFrameworkLockfile,
  mailRequirementFromConfig,
  requirePackageManifest,
  storageRequirementFromConfig,
} from "@ohmyhost/platform";
import type {
  DetectionResult,
  FrameworkAdapter,
  FrameworkLockfileLoader,
  FrameworkPlan,
  FrameworkPlanInput,
  RepositorySnapshot,
} from "@ohmyhost/platform";

import { VITE_API_COMPANION_CONTRACT } from "./vite-companion-contract.js";

const ADAPTER_NAME = "vite-static";
const PACKAGE_PATH = "package.json";
const LOCK_PATHS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
type ViteConfigPath = "vite.config.js" | "vite.config.mjs" | "vite.config.ts";
export interface ViteFrameworkAdapterDependencies {
  readonly loadPackageJson: (path: "package.json") => Promise<unknown>;
  readonly loadViteConfig?: (path: ViteConfigPath) => Promise<unknown>;
  /** Without it, the declared Vite version is judged and a range is decided by the build. */
  readonly loadLockfile?: FrameworkLockfileLoader;
}

export function createViteFrameworkAdapter(
  dependencies: ViteFrameworkAdapterDependencies,
): FrameworkAdapter {
  validateDependencies(dependencies);
  return Object.freeze({
    async detect(repository: RepositorySnapshot): Promise<DetectionResult> {
      return detectVite(repository);
    },
    async plan(input: FrameworkPlanInput): Promise<FrameworkPlan> {
      assertDetectedVite(input);
      const viteConfigPath = resolveFrameworkConfig(
        "vite.config",
        input.application.files,
      ) as ViteConfigPath | null;
      const manifest = requirePackageManifest(await dependencies.loadPackageJson(PACKAGE_PATH));
      const config = input.repositoryConfig;
      const packageManager = resolvePackageManager({
        packageManager: packageManagerDeclaration(manifest),
        files: input.application.files,
      });
      assertFrameworkSource({
        framework: ADAPTER_NAME,
        files: input.application.files,
        configuration: config,
        manifest,
        packageManager,
        lockfile: await loadFrameworkLockfile(dependencies.loadLockfile, packageManager.lockfile),
        frameworkConfig:
          viteConfigPath === null
            ? null
            : { path: viteConfigPath, text: await loadViteConfig(dependencies, viteConfigPath) },
      });
      const companion = viteCompanionRequired(config) ? VITE_API_COMPANION_CONTRACT : null;
      assertRequestedRuntime(companion === null ? "static" : "edge", input.requestedRuntime);
      const build = requireApplicationBuild(config);
      const storage = storageRequirementFromConfig(config);
      const functions = functionsRequirementFromConfig(config);
      const ai = aiRequirementFromConfig(config);
      const browser = browserRequirementFromConfig(config);
      const base = {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: input.application.root,
        adapter: ADAPTER_NAME,
        installCommand: packageManager.installCommand,
        buildCommand: packageManager.buildCommand,
        outputDirectory: build.output,
        runtimePolicy: runtimePolicy(config),
        database: databaseRequirementFromConfig(config),
        auth: createCustomerAuthRequirement(config, "companion"),
        mail: mailRequirementFromConfig(config),
        storage,
      } as const;
      if (companion === null) return Object.freeze({ ...base, runtime: "static" as const });
      return Object.freeze({
        ...base,
        runtime: "edge" as const,
        serverOutputDirectory: companion.artifact.outputDirectory,
        serverEntryPoint: companion.artifact.entryPoint,
        serverConfigPath: companion.artifact.configPath,
        compatibilityDate: companion.runtime.compatibilityDate,
        compatibilityFlags: companion.runtime.compatibilityFlags,
        ...(functions === undefined ? {} : { functions }),
        ...(ai === undefined ? {} : { ai }),
        ...(browser === undefined ? {} : { browser }),
      });
    },
  });
}

function runtimePolicy(config: FrameworkPlanInput["repositoryConfig"]) {
  return Object.freeze({
    healthCheckPath: config.runtime.healthcheck ?? "/",
    egressAllowedOrigins: config.runtime.egress?.allow ?? Object.freeze([]),
    ...(config.runtime.browser === undefined ? {} : { browser: config.runtime.browser }),
  });
}

function validateDependencies(value: ViteFrameworkAdapterDependencies): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.loadPackageJson !== "function" ||
    (value.loadViteConfig !== undefined && typeof value.loadViteConfig !== "function") ||
    (value.loadLockfile !== undefined && typeof value.loadLockfile !== "function")
  ) {
    throw new TypeError("Vite adapter content loaders are required");
  }
}

function detectVite(repository: RepositorySnapshot): DetectionResult {
  const lockPaths = LOCK_PATHS.filter((path) => repository.files.includes(path));
  const viteConfigPath = resolveFrameworkConfig("vite.config", repository.files);
  if (!repository.files.includes(PACKAGE_PATH) || lockPaths.length !== 1) {
    return freezeDetection(0, []);
  }
  return freezeDetection(10_000, [
    Object.freeze({
      path: PACKAGE_PATH,
      reason: "application package manifest for Vite validation",
      scope: "application",
    }),
    Object.freeze({
      path: lockPaths[0] as string,
      reason: "frozen package-manager dependency graph",
      scope: "application",
    }),
    ...(viteConfigPath === null
      ? []
      : [
          Object.freeze({
            path: viteConfigPath,
            reason: "explicit Vite configuration",
            scope: "application" as const,
          }),
        ]),
  ]);
}

function freezeDetection(
  confidenceBasisPoints: number,
  evidence: DetectionResult["evidence"],
): DetectionResult {
  return Object.freeze({
    adapter: ADAPTER_NAME,
    confidenceBasisPoints,
    evidence: Object.freeze([...evidence]),
  });
}

function assertDetectedVite(input: FrameworkPlanInput): void {
  const evidencePaths = new Set(input.detection.evidence.map(({ path }) => path));
  const lockPaths = LOCK_PATHS.filter((path) => input.application.files.includes(path));
  const viteConfigPath = resolveFrameworkConfig("vite.config", input.application.files);
  if (
    input.repositoryConfig.applicationRoot !== input.application.root ||
    input.repositoryConfigEvidence.scope !== "repository" ||
    input.repositoryConfigEvidence.path !== "ohmyhost.yaml" ||
    !input.application.files.includes(PACKAGE_PATH) ||
    input.detection.adapter !== ADAPTER_NAME ||
    input.detection.confidenceBasisPoints !== 10_000 ||
    !evidencePaths.has(PACKAGE_PATH) ||
    lockPaths.length !== 1 ||
    !evidencePaths.has(lockPaths[0] as string) ||
    (viteConfigPath !== null && !evidencePaths.has(viteConfigPath))
  ) {
    throw new TypeError(
      "repository config and application package.json with a lockfile are required before Vite planning",
    );
  }
}

async function loadViteConfig(
  dependencies: ViteFrameworkAdapterDependencies,
  path: ViteConfigPath,
): Promise<string> {
  if (typeof dependencies.loadViteConfig !== "function") {
    throw new TypeError("Vite config loader is required for an explicit Vite config");
  }
  const text = await dependencies.loadViteConfig(path);
  if (typeof text !== "string") throw new TypeError(`${path} must be text`);
  return text;
}

function assertRequestedRuntime(
  runtime: "edge" | "static",
  requestedRuntime: FrameworkPlanInput["requestedRuntime"],
): void {
  if (
    requestedRuntime !== undefined &&
    requestedRuntime !== "auto" &&
    requestedRuntime !== runtime
  ) {
    throw new TypeError(
      `requested runtime ${requestedRuntime} conflicts with Vite runtime ${runtime}`,
    );
  }
}
