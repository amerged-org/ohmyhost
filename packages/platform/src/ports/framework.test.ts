import { normalizeApplicationRoot, parseOhmyhostConfig } from "@ohmyhost/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  ApplicationDetectionEvidence,
  DetectionResult,
  FrameworkAdapter,
  FrameworkPlan,
  RepositoryConfigDetectionEvidence,
} from "./framework.js";

describe("FrameworkAdapter", () => {
  it("separates repository configuration from application-relative adapter evidence", async () => {
    const repositoryEvidence: RepositoryConfigDetectionEvidence = {
      scope: "repository",
      path: "ohmyhost.yaml",
      reason: "canonical repository configuration",
    };
    const applicationEvidence: ApplicationDetectionEvidence = {
      scope: "application",
      path: "package.json",
      reason: "vite dependency",
    };
    const detected: DetectionResult = {
      adapter: "vite",
      confidenceBasisPoints: 9800,
      evidence: [applicationEvidence],
    };
    const planned: FrameworkPlan = {
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: normalizeApplicationRoot("site"),
      adapter: "vite",
      runtime: "static",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm build",
      outputDirectory: "dist",
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
    };
    const adapter: FrameworkAdapter = {
      detect: async () => detected,
      plan: async () => planned,
    };
    const application = {
      root: normalizeApplicationRoot("site"),
      files: ["package.json", "src/main.ts"],
    };
    const repositoryConfig = parseOhmyhostConfig({
      version: 1,
      project: "storefront",
      applicationRoot: "site",
      build: {
        install: "pnpm install --frozen-lockfile",
        command: "pnpm build",
        output: "dist",
      },
      runtime: { mode: "static" },
    });

    await expect(adapter.detect(application)).resolves.toEqual(detected);
    await expect(
      adapter.plan({
        repositoryConfig,
        repositoryConfigEvidence: repositoryEvidence,
        application,
        detection: detected,
      }),
    ).resolves.toEqual(planned);
    expectTypeOf(adapter).toHaveProperty("detect");
    expectTypeOf(adapter).toHaveProperty("plan");
  });
});
