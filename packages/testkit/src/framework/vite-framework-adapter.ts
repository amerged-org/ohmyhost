import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseOhmyhostConfig, parseOhmyhostConfigYaml } from "@ohmyhost/contracts";
import {
  createViteFrameworkAdapter as createProductionViteFrameworkAdapter,
  type ViteFrameworkAdapterDependencies as ProductionDependencies,
} from "@ohmyhost/adapter-vite";

export interface ViteFrameworkAdapterDependencies {
  readonly rootDirectory?: string;
  readonly loadConfig?: (path: "ohmyhost.yaml") => Promise<unknown>;
  readonly loadPackageJson?: ProductionDependencies["loadPackageJson"];
  readonly loadViteConfig?: ProductionDependencies["loadViteConfig"];
  /** Passed through only when given, so a fixture never reads an unrelated lockfile. */
  readonly loadLockfile?: ProductionDependencies["loadLockfile"];
}

export function createViteFrameworkAdapter({
  rootDirectory = ".",
  loadConfig = (path) => loadTextFile(join(rootDirectory, path)),
  loadPackageJson = (path) => loadTextFile(join(rootDirectory, path)),
  loadViteConfig,
  loadLockfile,
}: ViteFrameworkAdapterDependencies = {}) {
  const production = createProductionViteFrameworkAdapter({
    loadPackageJson,
    ...(loadViteConfig === undefined ? {} : { loadViteConfig }),
    ...(loadLockfile === undefined ? {} : { loadLockfile }),
  });
  return {
    detect(repository: { readonly files: readonly string[] }) {
      if (!repository.files.includes("ohmyhost.yaml")) {
        return Promise.resolve({
          adapter: "vite-static",
          confidenceBasisPoints: 0,
          evidence: [],
        });
      }
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
      if (!input.repository.files.includes("ohmyhost.yaml")) {
        throw new TypeError("root ohmyhost.yaml is required before Vite planning");
      }
      const configValue = await loadConfig("ohmyhost.yaml");
      const repositoryConfig =
        typeof configValue === "string"
          ? parseOhmyhostConfigYaml(configValue)
          : parseOhmyhostConfig(configValue);
      if (repositoryConfig.applicationRoot !== ".") {
        throw new TypeError("Testkit Vite wrapper supports only repository-root fixtures");
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

async function loadTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
