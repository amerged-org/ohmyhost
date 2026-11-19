import { join } from "node:path";

import { parseOhmyhostConfig, requireApplicationBuild } from "@ohmyhost/contracts";
import {
  createCustomerAuthRequirement,
  databaseRequirementFromConfig,
  mailRequirementFromConfig,
  storageRequirementFromConfig,
} from "@ohmyhost/platform";
import type { DetectionResult, FrameworkPlan, RepositorySnapshot } from "@ohmyhost/platform";

const CONFIG_PATH = "ohmyhost.yaml";
const ADAPTER_NAME = "ohmyhost-config";

export interface ConfigFrameworkAdapterDependencies {
  readonly rootDirectory?: string;
  readonly loadConfig: (path: string) => Promise<unknown>;
}

export function createConfigFrameworkAdapter({
  rootDirectory = ".",
  loadConfig,
}: ConfigFrameworkAdapterDependencies) {
  return {
    detect(
      repository: RepositorySnapshot | { readonly files: readonly string[] },
    ): Promise<DetectionResult> {
      return Promise.resolve(detectConfig(repository));
    },
    async plan(input: {
      readonly repository: RepositorySnapshot | { readonly files: readonly string[] };
      readonly detection: DetectionResult;
      readonly requestedRuntime?: "auto" | "static" | "edge";
    }): Promise<FrameworkPlan> {
      assertDetectedConfig(input);
      const config = parseOhmyhostConfig(await loadConfig(join(rootDirectory, CONFIG_PATH)));
      const configuredRuntime = config.runtime.mode;
      const requestedRuntime = input.requestedRuntime;
      if (
        configuredRuntime === "auto" &&
        (requestedRuntime === undefined || requestedRuntime === "auto")
      ) {
        throw new TypeError("configured runtime auto must be resolved explicitly");
      }
      if (
        configuredRuntime !== "auto" &&
        requestedRuntime !== undefined &&
        requestedRuntime !== "auto" &&
        requestedRuntime !== configuredRuntime
      ) {
        throw new TypeError(
          `requested runtime ${requestedRuntime} conflicts with configured runtime ${configuredRuntime}`,
        );
      }
      const runtime = configuredRuntime === "auto" ? requestedRuntime : configuredRuntime;
      if (runtime === undefined || runtime === "auto") {
        throw new TypeError("framework runtime must be concrete");
      }

      const build = requireApplicationBuild(config);
      return Object.freeze({
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: config.applicationRoot,
        adapter: ADAPTER_NAME,
        runtime,
        installCommand: build.install,
        buildCommand: build.command,
        outputDirectory: build.output,
        runtimePolicy: Object.freeze({
          healthCheckPath: config.runtime.healthcheck,
          egressAllowedOrigins: config.runtime.egress.allow,
        }),
        database: databaseRequirementFromConfig(config),
        auth: createCustomerAuthRequirement(config, "companion"),
        mail: mailRequirementFromConfig(config),
        storage: storageRequirementFromConfig(config),
      });
    },
  };
}

function detectConfig(
  repository: RepositorySnapshot | { readonly files: readonly string[] },
): DetectionResult {
  if (!repository.files.includes(CONFIG_PATH)) {
    return freezeDetection(0, []);
  }
  return freezeDetection(10_000, [
    Object.freeze({
      path: CONFIG_PATH,
      reason: "explicit ohmyhost configuration",
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

function assertDetectedConfig(input: {
  readonly repository: RepositorySnapshot | { readonly files: readonly string[] };
  readonly detection: DetectionResult;
}): void {
  const hasConfig = input.repository.files.includes(CONFIG_PATH);
  const hasEvidence = input.detection.evidence.some(({ path }) => path === CONFIG_PATH);
  if (
    !hasConfig ||
    input.detection.adapter !== ADAPTER_NAME ||
    input.detection.confidenceBasisPoints !== 10_000 ||
    !hasEvidence
  ) {
    throw new TypeError("ohmyhost.yaml is required before planning");
  }
}
