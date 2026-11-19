import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OhmyhostConfig } from "@ohmyhost/contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createConfigFrameworkAdapter } from "./config-framework-adapter.js";

const STATIC_CONFIG: OhmyhostConfig = {
  version: 1,
  applicationRoot: "." as never,
  project: "example-project",
  build: {
    install: "pnpm install --frozen-lockfile",
    command: "pnpm build",
    output: "dist",
  },
  runtime: { mode: "static", healthcheck: "/", egress: { allow: [] } },
};
const AUTO_CONFIG: OhmyhostConfig = {
  ...STATIC_CONFIG,
  runtime: { mode: "auto", healthcheck: "/", egress: { allow: [] } },
};

const activeDirectories: string[] = [];
const createdDirectories: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  activeDirectories.push(directory);
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of activeDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  for (const directory of createdDirectories) {
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

describe("config framework adapter", () => {
  it("detects only a repository containing the root ohmyhost.yaml", async () => {
    const adapter = createConfigFrameworkAdapter({ loadConfig: async () => STATIC_CONFIG });

    await expect(adapter.detect({ files: ["src/main.ts"] })).resolves.toEqual({
      adapter: "ohmyhost-config",
      confidenceBasisPoints: 0,
      evidence: [],
    });
    const detected = await adapter.detect({ files: ["src/main.ts", "ohmyhost.yaml"] });

    expect(detected).toEqual({
      adapter: "ohmyhost-config",
      confidenceBasisPoints: 10_000,
      evidence: [
        {
          path: "ohmyhost.yaml",
          reason: "explicit ohmyhost configuration",
          scope: "application",
        },
      ],
    });
    expect(Object.isFrozen(detected)).toBe(true);
    expect(Object.isFrozen(detected.evidence)).toBe(true);
  });

  it("returns a deterministic validated plan without mutating the fixture", async () => {
    const directory = await createTemporaryDirectory("ohmyhost-framework-");
    const fixturePath = join(directory, "ohmyhost.yaml");
    await writeFile(fixturePath, "version: 1\n", "utf8");
    const loadConfig = vi.fn(async (path: string) => {
      expect(path).toBe(fixturePath);
      return STATIC_CONFIG;
    });
    const adapter = createConfigFrameworkAdapter({ rootDirectory: directory, loadConfig });
    const repository = { files: ["ohmyhost.yaml", "src/main.ts"] };
    const detection = await adapter.detect(repository);

    const first = await adapter.plan({ repository, detection, requestedRuntime: "auto" });
    const second = await adapter.plan({ repository, detection });

    expect(first).toEqual({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "ohmyhost-config",
      runtime: "static",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm build",
      outputDirectory: "dist",
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
    });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(loadConfig).toHaveBeenCalledTimes(2);
    await expect(
      import("node:fs/promises").then(({ readFile }) => readFile(fixturePath, "utf8")),
    ).resolves.toBe("version: 1\n");
  });

  it("rejects missing config, malformed config, and conflicting runtime requests", async () => {
    const missing = createConfigFrameworkAdapter({ loadConfig: async () => STATIC_CONFIG });
    const absentRepository = { files: ["package.json"] };
    const absentDetection = await missing.detect(absentRepository);

    await expect(
      missing.plan({ repository: absentRepository, detection: absentDetection }),
    ).rejects.toThrow("ohmyhost.yaml is required");

    const repository = { files: ["ohmyhost.yaml"] };
    const missingProject = createConfigFrameworkAdapter({
      loadConfig: async () => {
        const config: Record<string, unknown> = { ...STATIC_CONFIG };
        Reflect.deleteProperty(config, "project");
        return config;
      },
    });
    const detection = await missingProject.detect(repository);
    await expect(missingProject.plan({ repository, detection })).rejects.toThrow(
      "ohmyhost.yaml is invalid: / must have required property 'project'",
    );

    const unknownField = createConfigFrameworkAdapter({
      loadConfig: async () => ({ ...STATIC_CONFIG, unexpected: true }),
    });
    await expect(unknownField.plan({ repository, detection })).rejects.toThrow(
      "ohmyhost.yaml is invalid: / must NOT have additional properties",
    );

    const valid = createConfigFrameworkAdapter({ loadConfig: async () => STATIC_CONFIG });
    const validDetection = await valid.detect(repository);
    await expect(
      valid.plan({ repository, detection: validDetection, requestedRuntime: "edge" }),
    ).rejects.toThrow("requested runtime edge conflicts with configured runtime static");
  });

  it("resolves configured auto only from a concrete requested runtime", async () => {
    const adapter = createConfigFrameworkAdapter({ loadConfig: async () => AUTO_CONFIG });
    const repository = { files: ["ohmyhost.yaml"] };
    const detection = await adapter.detect(repository);

    await expect(
      adapter.plan({ repository, detection, requestedRuntime: "edge" }),
    ).resolves.toMatchObject({ runtime: "edge" });
    await expect(adapter.plan({ repository, detection })).rejects.toThrow(
      "configured runtime auto must be resolved explicitly",
    );
    await expect(adapter.plan({ repository, detection, requestedRuntime: "auto" })).rejects.toThrow(
      "configured runtime auto must be resolved explicitly",
    );
  });

  it("never invokes network APIs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = createConfigFrameworkAdapter({ loadConfig: async () => STATIC_CONFIG });
    const repository = { files: ["ohmyhost.yaml"] };
    const detection = await adapter.detect(repository);

    await adapter.plan({ repository, detection });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
