import {
  resolveFrameworkConfig,
  resolvePackageManager,
  requireApplicationBuild,
} from "@ohmyhost/contracts";
import { packageManagerDeclaration } from "@ohmyhost/contracts/framework-source-rules";
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
  ApplicationDetectionEvidence,
  DetectionResult,
  FrameworkAdapter,
  FrameworkLockfileLoader,
  FrameworkPlan,
  FrameworkPlanInput,
  RepositorySnapshot,
} from "@ohmyhost/platform";

import {
  assertNextWorkersCompatibility,
  nextRuntimeSourcePaths,
  type NextRuntimeSource,
} from "./next-workers-compatibility.js";

const ADAPTER_NAME = "nextjs";
const PACKAGE_PATH = "package.json";
const NEXT_CONFIG_BASENAME = "next.config";
const LOCK_PATHS = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;
const PLATFORM_WRANGLER_CONFIG_PATH = "wrangler.jsonc";
const PLATFORM_COMPATIBILITY_DATE = "2026-08-21";

type NextConfigPath = "next.config.js" | "next.config.mjs" | "next.config.ts";

export interface NextFrameworkAdapterDependencies {
  readonly loadPackageJson: (path: "package.json") => Promise<unknown>;
  readonly loadNextConfig: (path: NextConfigPath) => Promise<unknown>;
  readonly loadRuntimeSources: (paths: readonly string[]) => Promise<readonly NextRuntimeSource[]>;
  /** Without it, the declared Next.js version is judged and a range is decided by the build. */
  readonly loadLockfile?: FrameworkLockfileLoader;
}

export function createNextFrameworkAdapter(
  dependencies: NextFrameworkAdapterDependencies,
): FrameworkAdapter {
  validateDependencies(dependencies);
  return Object.freeze({
    detect(repository: RepositorySnapshot): Promise<DetectionResult> {
      return Promise.resolve(detectNext(repository));
    },
    async plan(input: FrameworkPlanInput): Promise<FrameworkPlan> {
      const nextConfigPath = assertDetectedNext(input);
      const runtimePaths = nextRuntimeSourcePaths(input.application.files);
      const [packageValue, nextConfig, runtimeSources] = await Promise.all([
        dependencies.loadPackageJson(PACKAGE_PATH),
        dependencies.loadNextConfig(nextConfigPath),
        dependencies.loadRuntimeSources(runtimePaths),
      ]);
      const config = input.repositoryConfig;
      const manifest = requirePackageManifest(packageValue);
      const packageManager = resolvePackageManager({
        packageManager: packageManagerDeclaration(manifest),
        files: input.application.files,
      });
      if (typeof nextConfig !== "string") throw new TypeError(`${nextConfigPath} must be text`);
      assertFrameworkSource({
        framework: ADAPTER_NAME,
        files: input.application.files,
        configuration: config,
        manifest,
        packageManager,
        lockfile: await loadFrameworkLockfile(dependencies.loadLockfile, packageManager.lockfile),
        frameworkConfig: { path: nextConfigPath, text: nextConfig },
      });
      assertRuntimeSources(runtimePaths, runtimeSources);
      assertNextWorkersCompatibility(runtimeSources);
      assertRequestedRuntime(input.requestedRuntime);
      const functions = functionsRequirementFromConfig(config);
      const ai = aiRequirementFromConfig(config);
      const browser = browserRequirementFromConfig(config);
      return Object.freeze({
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: input.application.root,
        adapter: ADAPTER_NAME,
        runtime: "edge",
        installCommand: packageManager.installCommand,
        buildCommand: packageManager.buildCommand,
        outputDirectory: ".open-next/assets",
        ssgCacheMaxBytes: (requireApplicationBuild(config).ssg_cache_max_mib ?? 32) * 1024 * 1024,
        ...(requireApplicationBuild(config).next_revalidate_path === true
          ? { nextRevalidatePath: true as const }
          : {}),
        serverOutputDirectory: ".ohmyhost-worker",
        serverEntryPoint: ".ohmyhost-worker/worker.js",
        serverConfigPath: PLATFORM_WRANGLER_CONFIG_PATH,
        compatibilityDate: PLATFORM_COMPATIBILITY_DATE,
        compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
        runtimePolicy: runtimePolicy(config),
        database: databaseRequirementFromConfig(config),
        auth: createCustomerAuthRequirement(config, "embedded"),
        mail: mailRequirementFromConfig(config),
        storage: storageRequirementFromConfig(config),
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

function validateDependencies(value: NextFrameworkAdapterDependencies): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.loadPackageJson !== "function" ||
    typeof value.loadNextConfig !== "function" ||
    typeof value.loadRuntimeSources !== "function" ||
    (value.loadLockfile !== undefined && typeof value.loadLockfile !== "function")
  ) {
    throw new TypeError("Next.js adapter content loaders are required");
  }
}

function assertRuntimeSources(
  expectedPaths: readonly string[],
  sources: readonly NextRuntimeSource[],
): void {
  if (!Array.isArray(sources)) throw new TypeError("Next.js runtime sources are required");
  const actualPaths = sources.map(({ path }) => path).sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new TypeError("Next.js runtime sources are incomplete");
  }
}

function detectNext(repository: RepositorySnapshot): DetectionResult {
  const lockPaths = LOCK_PATHS.filter((path) => repository.files.includes(path));
  let nextConfigPath: string | null;
  try {
    nextConfigPath = resolveFrameworkConfig(NEXT_CONFIG_BASENAME, repository.files);
  } catch {
    return freezeDetection(0, []);
  }
  if (
    !repository.files.includes(PACKAGE_PATH) ||
    lockPaths.length !== 1 ||
    nextConfigPath === null
  ) {
    return freezeDetection(0, []);
  }
  const evidence: ApplicationDetectionEvidence[] = [
    Object.freeze({
      path: PACKAGE_PATH,
      reason: "application package manifest for Next.js validation",
      scope: "application",
    }),
    Object.freeze({
      path: lockPaths[0] as string,
      reason: `frozen ${packageManagerForLockfile(lockPaths[0] as string)} dependency graph`,
      scope: "application",
    }),
    Object.freeze({
      path: nextConfigPath,
      reason: "Next.js framework configuration",
      scope: "application",
    }),
  ];
  return freezeDetection(10_000, evidence);
}

function packageManagerForLockfile(lockfile: string): "bun" | "npm" | "pnpm" | "yarn" {
  if (lockfile.startsWith("bun.")) return "bun";
  if (lockfile === "package-lock.json") return "npm";
  if (lockfile === "pnpm-lock.yaml") return "pnpm";
  return "yarn";
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

function assertDetectedNext(input: FrameworkPlanInput): NextConfigPath {
  const evidencePaths = new Set(input.detection.evidence.map(({ path }) => path));
  const lockPaths = LOCK_PATHS.filter((path) => input.application.files.includes(path));
  let nextConfigPath: string | null;
  try {
    nextConfigPath = resolveFrameworkConfig(NEXT_CONFIG_BASENAME, input.application.files);
  } catch {
    nextConfigPath = null;
  }
  if (
    input.repositoryConfig.applicationRoot !== input.application.root ||
    input.repositoryConfigEvidence.scope !== "repository" ||
    input.repositoryConfigEvidence.path !== "ohmyhost.yaml" ||
    input.detection.adapter !== ADAPTER_NAME ||
    input.detection.confidenceBasisPoints !== 10_000 ||
    !input.application.files.includes(PACKAGE_PATH) ||
    !evidencePaths.has(PACKAGE_PATH) ||
    lockPaths.length !== 1 ||
    !evidencePaths.has(lockPaths[0] as string) ||
    nextConfigPath === null ||
    !evidencePaths.has(nextConfigPath)
  ) {
    throw new TypeError(
      "repository config and application package.json, one matching lockfile, and one Next.js config are required before Next.js planning",
    );
  }
  return nextConfigPath as NextConfigPath;
}

function assertRequestedRuntime(requested: FrameworkPlanInput["requestedRuntime"]): void {
  if (requested !== undefined && requested !== "auto" && requested !== "edge") {
    throw new TypeError(`requested runtime ${requested} conflicts with Next.js runtime edge`);
  }
}
