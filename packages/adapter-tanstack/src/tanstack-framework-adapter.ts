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
  DetectionResult,
  FrameworkAdapter,
  FrameworkLockfileLoader,
  FrameworkPlan,
  FrameworkPlanInput,
  RepositorySnapshot,
} from "@ohmyhost/platform";

const ADAPTER_NAME = "tanstack-start";
const PACKAGE_PATH = "package.json";
const PLATFORM_COMPATIBILITY_DATE = "2026-08-21";
const LOCK_PATHS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
type ViteConfigPath = "vite.config.js" | "vite.config.mjs" | "vite.config.ts";

export interface TanStackFrameworkAdapterDependencies {
  readonly loadPackageJson: (path: "package.json") => Promise<unknown>;
  readonly loadViteConfig: (path: ViteConfigPath) => Promise<unknown>;
  /** Without it, the declared versions are judged and a range is decided by the build. */
  readonly loadLockfile?: FrameworkLockfileLoader;
}

export function createTanStackFrameworkAdapter(
  dependencies: TanStackFrameworkAdapterDependencies,
): FrameworkAdapter {
  validateDependencies(dependencies);
  return Object.freeze({
    async detect(repository: RepositorySnapshot): Promise<DetectionResult> {
      return detectTanStack(repository);
    },
    async plan(input: FrameworkPlanInput): Promise<FrameworkPlan> {
      assertDetectedTanStack(input);
      const viteConfigPath = resolveFrameworkConfig(
        "vite.config",
        input.application.files,
      ) as ViteConfigPath;
      const [packageValue, viteConfigValue] = await Promise.all([
        dependencies.loadPackageJson(PACKAGE_PATH),
        dependencies.loadViteConfig(viteConfigPath),
      ]);
      const config = input.repositoryConfig;
      const manifest = requirePackageManifest(packageValue);
      const packageManager = resolvePackageManager({
        packageManager: packageManagerDeclaration(manifest),
        files: input.application.files,
      });
      if (typeof viteConfigValue !== "string") {
        throw new TypeError(`${viteConfigPath} must be text`);
      }
      assertFrameworkSource({
        framework: ADAPTER_NAME,
        files: input.application.files,
        configuration: config,
        manifest,
        packageManager,
        lockfile: await loadFrameworkLockfile(dependencies.loadLockfile, packageManager.lockfile),
        frameworkConfig: { path: viteConfigPath, text: viteConfigValue },
      });
      const functions = functionsRequirementFromConfig(config);
      const ai = aiRequirementFromConfig(config);
      const browser = browserRequirementFromConfig(config);
      const build = requireApplicationBuild(config);
      if (config.runtime.mode === "static") {
        assertRequestedRuntime("static", input.requestedRuntime);
        const storage = storageRequirementFromConfig(config);
        return Object.freeze({
          schemaVersion: "ohmyhost.framework-plan/v5",
          applicationRoot: input.application.root,
          adapter: ADAPTER_NAME,
          runtime: "static",
          installCommand: packageManager.installCommand,
          buildCommand: packageManager.buildCommand,
          outputDirectory: build.output,
          runtimePolicy: runtimePolicy(config),
          database: databaseRequirementFromConfig(config),
          auth: createCustomerAuthRequirement(config, "companion"),
          mail: mailRequirementFromConfig(config),
          storage,
        });
      }
      if (config.runtime.mode === "edge") {
        assertRequestedRuntime("edge", input.requestedRuntime);
        return Object.freeze({
          schemaVersion: "ohmyhost.framework-plan/v5",
          applicationRoot: input.application.root,
          adapter: ADAPTER_NAME,
          runtime: "edge",
          installCommand: packageManager.installCommand,
          buildCommand: packageManager.buildCommand,
          outputDirectory: build.output,
          serverOutputDirectory: "dist/server",
          serverEntryPoint: "dist/server/index.js",
          serverConfigPath: "dist/server/wrangler.json",
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
      }
      throw new TypeError("TanStack adapter supports only runtime static or edge");
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

function validateDependencies(value: TanStackFrameworkAdapterDependencies): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.loadPackageJson !== "function" ||
    typeof value.loadViteConfig !== "function" ||
    (value.loadLockfile !== undefined && typeof value.loadLockfile !== "function")
  ) {
    throw new TypeError("TanStack adapter content loaders are required");
  }
}

function detectTanStack(repository: RepositorySnapshot): DetectionResult {
  const lockPaths = LOCK_PATHS.filter((path) => repository.files.includes(path));
  const viteConfigPath = resolveFrameworkConfig("vite.config", repository.files);
  if (
    !repository.files.includes(PACKAGE_PATH) ||
    viteConfigPath === null ||
    lockPaths.length !== 1 ||
    lockPaths[0] === undefined
  ) {
    return freezeDetection(0, []);
  }
  return freezeDetection(10_000, [
    Object.freeze({
      path: PACKAGE_PATH,
      reason: "application package manifest for TanStack validation",
      scope: "application",
    }),
    Object.freeze({
      path: lockPaths[0],
      reason: "frozen package-manager dependency graph",
      scope: "application",
    }),
    Object.freeze({
      path: viteConfigPath,
      reason: "explicit TanStack Start Vite configuration",
      scope: "application",
    }),
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

function assertDetectedTanStack(input: FrameworkPlanInput): void {
  const evidencePaths = new Set(input.detection.evidence.map(({ path }) => path));
  const lockPaths = LOCK_PATHS.filter((path) => input.application.files.includes(path));
  const viteConfigPath = resolveFrameworkConfig("vite.config", input.application.files);
  if (
    input.repositoryConfig.applicationRoot !== input.application.root ||
    input.repositoryConfigEvidence.scope !== "repository" ||
    input.repositoryConfigEvidence.path !== "ohmyhost.yaml" ||
    !input.application.files.includes(PACKAGE_PATH) ||
    viteConfigPath === null ||
    input.detection.adapter !== ADAPTER_NAME ||
    input.detection.confidenceBasisPoints !== 10_000 ||
    !evidencePaths.has(PACKAGE_PATH) ||
    !evidencePaths.has(viteConfigPath) ||
    lockPaths.length !== 1 ||
    !evidencePaths.has(lockPaths[0] as string)
  ) {
    throw new TypeError(
      "repository config and application package.json, one vite.config.{js,mjs,ts}, and one matching lockfile are required before TanStack planning",
    );
  }
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
      `requested runtime ${requestedRuntime} conflicts with TanStack runtime ${runtime}`,
    );
  }
}
