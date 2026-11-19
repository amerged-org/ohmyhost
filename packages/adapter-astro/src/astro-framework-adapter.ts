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

const ADAPTER_NAME = "astro";
const PACKAGE_PATH = "package.json";
const PLATFORM_COMPATIBILITY_DATE = "2026-10-12";
const LOCK_PATHS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
type AstroConfigPath = "astro.config.js" | "astro.config.mjs" | "astro.config.ts";

export interface AstroFrameworkAdapterDependencies {
  readonly loadPackageJson: (path: "package.json") => Promise<unknown>;
  readonly loadAstroConfig: (path: AstroConfigPath) => Promise<unknown>;
  /** Without it, the declared versions are judged and a range is decided by the build. */
  readonly loadLockfile?: FrameworkLockfileLoader;
}

export function createAstroFrameworkAdapter(
  dependencies: AstroFrameworkAdapterDependencies,
): FrameworkAdapter {
  validateDependencies(dependencies);
  return Object.freeze({
    async detect(repository: RepositorySnapshot): Promise<DetectionResult> {
      return detectAstro(repository);
    },
    async plan(input: FrameworkPlanInput): Promise<FrameworkPlan> {
      assertDetectedAstro(input);
      const astroConfigPath = resolveFrameworkConfig(
        "astro.config",
        input.application.files,
      ) as AstroConfigPath;
      const [packageValue, astroConfigValue] = await Promise.all([
        dependencies.loadPackageJson(PACKAGE_PATH),
        dependencies.loadAstroConfig(astroConfigPath),
      ]);
      const config = input.repositoryConfig;
      const manifest = requirePackageManifest(packageValue);
      const packageManager = resolvePackageManager({
        packageManager: packageManagerDeclaration(manifest),
        files: input.application.files,
      });
      if (typeof astroConfigValue !== "string") {
        throw new TypeError(`${astroConfigPath} must be text`);
      }
      assertFrameworkSource({
        framework: ADAPTER_NAME,
        files: input.application.files,
        configuration: config,
        manifest,
        packageManager,
        lockfile: await loadFrameworkLockfile(dependencies.loadLockfile, packageManager.lockfile),
        frameworkConfig: { path: astroConfigPath, text: astroConfigValue },
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
          serverEntryPoint: "dist/server/entry.mjs",
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
      throw new TypeError("Astro adapter supports only runtime static or edge");
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

function validateDependencies(value: AstroFrameworkAdapterDependencies): void {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.loadPackageJson !== "function" ||
    typeof value.loadAstroConfig !== "function" ||
    (value.loadLockfile !== undefined && typeof value.loadLockfile !== "function")
  ) {
    throw new TypeError("Astro adapter content loaders are required");
  }
}

function detectAstro(repository: RepositorySnapshot): DetectionResult {
  const lockPaths = LOCK_PATHS.filter((path) => repository.files.includes(path));
  const astroConfigPath = resolveFrameworkConfig("astro.config", repository.files);
  if (
    !repository.files.includes(PACKAGE_PATH) ||
    astroConfigPath === null ||
    lockPaths.length !== 1 ||
    lockPaths[0] === undefined
  ) {
    return freezeDetection(0, []);
  }
  return freezeDetection(10_000, [
    Object.freeze({
      path: PACKAGE_PATH,
      reason: "application package manifest for Astro validation",
      scope: "application",
    }),
    Object.freeze({
      path: lockPaths[0],
      reason: "frozen package-manager dependency graph",
      scope: "application",
    }),
    Object.freeze({
      path: astroConfigPath,
      reason: "explicit Astro configuration",
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

function assertDetectedAstro(input: FrameworkPlanInput): void {
  const evidencePaths = new Set(input.detection.evidence.map(({ path }) => path));
  const lockPaths = LOCK_PATHS.filter((path) => input.application.files.includes(path));
  const astroConfigPath = resolveFrameworkConfig("astro.config", input.application.files);
  if (
    input.repositoryConfig.applicationRoot !== input.application.root ||
    input.repositoryConfigEvidence.scope !== "repository" ||
    input.repositoryConfigEvidence.path !== "ohmyhost.yaml" ||
    !input.application.files.includes(PACKAGE_PATH) ||
    astroConfigPath === null ||
    input.detection.adapter !== ADAPTER_NAME ||
    input.detection.confidenceBasisPoints !== 10_000 ||
    !evidencePaths.has(PACKAGE_PATH) ||
    !evidencePaths.has(astroConfigPath) ||
    lockPaths.length !== 1 ||
    !evidencePaths.has(lockPaths[0] as string)
  ) {
    throw new TypeError(
      "repository config and application package.json, one astro.config.{js,mjs,ts}, and one matching lockfile are required before Astro planning",
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
      `requested runtime ${requestedRuntime} conflicts with Astro runtime ${runtime}`,
    );
  }
}
