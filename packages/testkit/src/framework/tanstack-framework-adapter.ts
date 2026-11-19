import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseOhmyhostConfig, parseOhmyhostConfigYaml } from "@ohmyhost/contracts";
import {
  createTanStackFrameworkAdapter as createProductionTanStackFrameworkAdapter,
  type TanStackFrameworkAdapterDependencies as ProductionDependencies,
} from "@ohmyhost/adapter-tanstack";

export interface TanStackFrameworkAdapterDependencies {
  readonly rootDirectory?: string;
  readonly loadConfig?: (path: "ohmyhost.yaml") => Promise<unknown>;
  readonly loadPackageJson?: ProductionDependencies["loadPackageJson"];
  readonly loadViteConfig?: ProductionDependencies["loadViteConfig"];
  /** Passed through only when given, so a fixture never reads an unrelated lockfile. */
  readonly loadLockfile?: ProductionDependencies["loadLockfile"];
}

export function createTanStackFrameworkAdapter({
  rootDirectory = ".",
  loadConfig = (path) => readFile(join(rootDirectory, path), "utf8"),
  loadPackageJson = (path) => readFile(join(rootDirectory, path), "utf8"),
  loadViteConfig = (path) => readFile(join(rootDirectory, path), "utf8"),
  loadLockfile,
}: TanStackFrameworkAdapterDependencies = {}) {
  const production = createProductionTanStackFrameworkAdapter({
    loadPackageJson,
    loadViteConfig,
    ...(loadLockfile === undefined ? {} : { loadLockfile }),
  });
  return {
    detect(repository: { readonly files: readonly string[] }) {
      return production.detect({
        root: "." as never,
        files: repository.files.filter((path) => path !== "ohmyhost.yaml"),
      });
    },
    async plan(input: {
      readonly repository: { readonly files: readonly string[] };
      readonly detection: Awaited<ReturnType<typeof production.detect>>;
      readonly requestedRuntime?: "auto" | "static" | "edge";
    }) {
      const configValue = await loadConfig("ohmyhost.yaml");
      const repositoryConfig =
        typeof configValue === "string"
          ? parseOhmyhostConfigYaml(configValue)
          : parseOhmyhostConfig(configValue);
      if (repositoryConfig.applicationRoot !== ".") {
        throw new TypeError("Testkit TanStack wrapper supports only repository-root fixtures");
      }
      return production.plan({
        repositoryConfig,
        repositoryConfigEvidence: {
          scope: "repository",
          path: "ohmyhost.yaml",
          reason: "authoritative repository configuration",
        },
        application: {
          root: repositoryConfig.applicationRoot,
          files: input.repository.files.filter((path) => path !== "ohmyhost.yaml"),
        },
        detection: input.detection,
        ...(input.requestedRuntime === undefined
          ? {}
          : { requestedRuntime: input.requestedRuntime }),
      });
    },
  };
}
