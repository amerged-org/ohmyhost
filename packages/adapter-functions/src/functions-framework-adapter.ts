import { resolvePackageManager } from "@ohmyhost/contracts";
import { packageManagerDeclaration } from "@ohmyhost/contracts/framework-source-rules";
import {
  aiRequirementFromConfig,
  browserRequirementFromConfig,
  assertFrameworkSource,
  createCustomerAuthRequirement,
  databaseRequirementFromConfig,
  functionsRequirementFromConfig,
  mailRequirementFromConfig,
  requirePackageManifest,
  storageRequirementFromConfig,
  WORKER_MODULE_PATH,
} from "@ohmyhost/platform";
import type {
  DetectionResult,
  FrameworkAdapter,
  FrameworkPlanInput,
  FunctionsFrameworkPlan,
  RepositorySnapshot,
} from "@ohmyhost/platform";

/**
 * The functions runtime hosts one customer Worker module without a framework build.
 * `src/ohmyhost/worker.ts` exports `{ fetch, scheduled? }`; the platform installs
 * dependencies, bundles the module with Wrangler and dispatches declared crons to it.
 */
export const FUNCTIONS_ADAPTER_NAME = "functions" as const;
export const FUNCTIONS_RUNTIME_CONTRACT = Object.freeze({
  schemaVersion: "ohmyhost.functions-runtime/v1" as const,
  workerModule: WORKER_MODULE_PATH,
  artifact: Object.freeze({
    outputDirectory: ".ohmyhost/functions" as const,
    entryPoint: ".ohmyhost/functions/worker.js" as const,
    configPath: ".ohmyhost/functions/wrangler.jsonc" as const,
  }),
  runtime: Object.freeze({
    compatibilityDate: "2025-01-01" as const,
    compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
  }),
});

const PACKAGE_PATH = "package.json";
const LOCK_PATHS = Object.freeze([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

export interface FunctionsFrameworkAdapterDependencies {
  readonly loadPackageJson: (path: "package.json") => Promise<unknown>;
}

export function createFunctionsFrameworkAdapter(
  dependencies: FunctionsFrameworkAdapterDependencies,
): FrameworkAdapter {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    typeof dependencies.loadPackageJson !== "function"
  ) {
    throw new TypeError("Functions adapter package loader is required");
  }
  return Object.freeze({
    detect(repository: RepositorySnapshot): Promise<DetectionResult> {
      return Promise.resolve(detectFunctions(repository));
    },
    async plan(input: FrameworkPlanInput): Promise<FunctionsFrameworkPlan> {
      assertDetectedFunctions(input);
      const config = input.repositoryConfig;
      if (config.runtime.mode !== "functions") {
        throw new TypeError("Functions adapter requires runtime mode functions");
      }
      if (
        input.requestedRuntime !== undefined &&
        input.requestedRuntime !== "auto" &&
        input.requestedRuntime !== "functions"
      ) {
        throw new TypeError(
          `requested runtime ${input.requestedRuntime} conflicts with the functions runtime`,
        );
      }
      const manifest = requirePackageManifest(await dependencies.loadPackageJson(PACKAGE_PATH));
      const packageManager = resolvePackageManager({
        packageManager: packageManagerDeclaration(manifest),
        files: input.application.files,
      });
      // The functions runtime has no framework package, framework config or lockfile rule.
      assertFrameworkSource({
        framework: FUNCTIONS_ADAPTER_NAME,
        files: input.application.files,
        configuration: config,
        manifest,
        packageManager,
        lockfile: null,
        frameworkConfig: null,
      });
      const functions = functionsRequirementFromConfig(config);
      const ai = aiRequirementFromConfig(config);
      const browser = browserRequirementFromConfig(config);
      return Object.freeze({
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: input.application.root,
        adapter: FUNCTIONS_ADAPTER_NAME,
        runtime: "functions",
        installCommand: packageManager.installCommand,
        compatibilityDate: FUNCTIONS_RUNTIME_CONTRACT.runtime.compatibilityDate,
        compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
        runtimePolicy: Object.freeze({
          healthCheckPath: config.runtime.healthcheck,
          egressAllowedOrigins: config.runtime.egress.allow,
          ...(config.runtime.browser === undefined ? {} : { browser: config.runtime.browser }),
        }),
        database: databaseRequirementFromConfig(config),
        auth: createCustomerAuthRequirement(config, "companion"),
        mail: mailRequirementFromConfig(config),
        storage: storageRequirementFromConfig(config),
        ...(functions === undefined ? {} : { functions }),
        ...(ai === undefined ? {} : { ai }),
        ...(browser === undefined ? {} : { browser }),
      });
    },
  });
}

function detectFunctions(repository: RepositorySnapshot): DetectionResult {
  const lockPaths = LOCK_PATHS.filter((path) => repository.files.includes(path));
  if (
    !repository.files.includes(PACKAGE_PATH) ||
    lockPaths.length !== 1 ||
    !repository.files.includes(WORKER_MODULE_PATH)
  ) {
    return Object.freeze({
      adapter: FUNCTIONS_ADAPTER_NAME,
      confidenceBasisPoints: 0,
      evidence: Object.freeze([]),
    });
  }
  return Object.freeze({
    adapter: FUNCTIONS_ADAPTER_NAME,
    confidenceBasisPoints: 10_000,
    evidence: Object.freeze([
      Object.freeze({
        path: PACKAGE_PATH,
        reason: "application package manifest for the functions runtime",
        scope: "application" as const,
      }),
      Object.freeze({
        path: lockPaths[0] as string,
        reason: "frozen package-manager dependency graph",
        scope: "application" as const,
      }),
      Object.freeze({
        path: WORKER_MODULE_PATH,
        reason: "customer Worker module with fetch and optional scheduled handlers",
        scope: "application" as const,
      }),
    ]),
  });
}

function assertDetectedFunctions(input: FrameworkPlanInput): void {
  const evidencePaths = new Set(input.detection.evidence.map(({ path }) => path));
  if (
    input.repositoryConfig.applicationRoot !== input.application.root ||
    input.repositoryConfigEvidence.scope !== "repository" ||
    input.repositoryConfigEvidence.path !== "ohmyhost.yaml" ||
    input.detection.adapter !== FUNCTIONS_ADAPTER_NAME ||
    input.detection.confidenceBasisPoints !== 10_000 ||
    !evidencePaths.has(PACKAGE_PATH) ||
    !evidencePaths.has(WORKER_MODULE_PATH) ||
    !input.application.files.includes(WORKER_MODULE_PATH)
  ) {
    throw new TypeError(
      `repository config, package.json with a lockfile and ${WORKER_MODULE_PATH} are required before functions planning`,
    );
  }
}
