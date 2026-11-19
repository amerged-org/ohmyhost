import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", async () => ({
  Container: (await import("./doubles.js")).ContainerBaseDouble,
}));

interface WorkerConfiguration {
  readonly name: string;
  readonly account_id: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
  readonly workers_dev: boolean;
  readonly preview_urls: boolean;
  readonly vars: Readonly<Record<string, string>>;
  readonly r2_buckets: readonly Readonly<Record<string, string>>[];
  readonly services: readonly Readonly<Record<string, string>>[];
  readonly durable_objects: { readonly bindings: readonly Readonly<Record<string, string>>[] };
  readonly migrations: readonly Readonly<Record<string, unknown>>[];
  readonly containers: readonly Readonly<Record<string, unknown>>[];
  readonly observability: Readonly<Record<string, unknown>>;
  readonly routes?: readonly unknown[];
}

function readConfiguration(name: string): WorkerConfiguration {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const json = source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1");
  return JSON.parse(json) as WorkerConfiguration;
}

async function expectBuildRunner(
  configuration: WorkerConfiguration,
  expected: Readonly<{ bucket: string; controlApi: string; maximumSandboxes: number }>,
): Promise<void> {
  const { BUILD_SANDBOX_INSTANCE_TYPE } = await import("../src/build-sandbox.js");
  expect(configuration).toMatchObject({
    main: "src/worker-main.ts",
    compatibility_date: "2026-08-19",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
  });
  // A private Worker: reachable through service bindings only.
  expect(configuration.routes).toBeUndefined();
  expect(configuration.vars).toMatchObject({
    BUILD_OBJECTS_BUCKET_US: expected.bucket,
    BUILD_OBJECTS_BUCKET_EU: `${expected.bucket}-eu`,
  });
  expect(Object.keys(configuration.vars).sort()).toEqual([
    "BUILD_OBJECTS_BUCKET_EU",
    "BUILD_OBJECTS_BUCKET_US",
    "BUILD_PROJECT",
  ]);
  // Each region's objects stay in its jurisdiction; the EU bucket never leaves the EU.
  expect(configuration.r2_buckets).toEqual([
    { binding: "BUILD_OBJECTS_US", bucket_name: expected.bucket, jurisdiction: "us" },
    { binding: "BUILD_OBJECTS_EU", bucket_name: `${expected.bucket}-eu`, jurisdiction: "eu" },
  ]);
  expect(configuration.services).toEqual([
    {
      binding: "BUILD_RECEIPTS",
      service: expected.controlApi,
      entrypoint: "BuildReceiptPersistenceService",
    },
  ]);
  expect(configuration.durable_objects.bindings).toEqual([
    { name: "BUILD_SANDBOX", class_name: "BuildSandbox" },
    { name: "BUILD_SANDBOX_EU", class_name: "BuildSandboxEu" },
  ]);
  expect(configuration.migrations).toEqual([
    { tag: "v1", new_sqlite_classes: ["BuildSandbox"] },
    { tag: "v2", new_sqlite_classes: ["BuildSandboxEu"] },
  ]);
  const sandbox = {
    image: "./sandbox/Dockerfile",
    image_build_context: "../..",
    // The billed meter is the instance type the object records as usage.
    instance_type: BUILD_SANDBOX_INSTANCE_TYPE,
    max_instances: expected.maximumSandboxes,
    // Longer than the longest build (five minutes to start, eight to run).
    rollout_active_grace_period: 900,
  };
  // US projects build in North America; EU projects build inside the EU jurisdiction.
  expect(configuration.containers).toEqual([
    {
      ...sandbox,
      name: expect.stringMatching(/^ohmyho-build-sandbox-[a-z0-9-]+$/u),
      class_name: "BuildSandbox",
      constraints: { regions: ["ENAM", "WNAM"] },
    },
    {
      ...sandbox,
      name: `${String(configuration.containers[0]?.["name"])}-eu`,
      class_name: "BuildSandboxEu",
      constraints: { jurisdiction: "eu" },
    },
  ]);
  expect(configuration.observability).toMatchObject({ enabled: true, head_sampling_rate: 1 });
  expect(existsSync(new URL("../sandbox/Dockerfile", import.meta.url))).toBe(true);
}

describe("build runner configuration", () => {
  it("keeps the generic configuration private and disabled", async () => {
    const configuration = readConfiguration("wrangler.jsonc");

    await expectBuildRunner(configuration, {
      bucket: "ohmyho-builds-disabled",
      controlApi: "ohmyho-control-api-disabled",
      maximumSandboxes: 1,
    });
    expect(configuration.name).toBe("ohmyho-build-runner-disabled");
    expect(configuration.account_id).toBe("00000000000000000000000000000000");
    expect(configuration.vars["BUILD_PROJECT"]).toBe("disabled");
  });

  it("pins the development bucket, receipts service and sandbox limits", async () => {
    const configuration = readConfiguration("wrangler.development.jsonc");

    await expectBuildRunner(configuration, {
      bucket: "ohmyho-builds-development",
      controlApi: "ohmyho-control-api-poc-private-fullstack",
      maximumSandboxes: 10,
    });
    expect(configuration).toMatchObject({
      name: "ohmyho-build-runner-poc-private-fullstack",
      account_id: "00000000000000000000000000000001",
      vars: { BUILD_PROJECT: "ohmyho-poc-private-fullstack-build" },
    });
  });

  it("pins the production bucket, receipts service and sandbox limits", async () => {
    const configuration = readConfiguration("wrangler.production.jsonc");

    await expectBuildRunner(configuration, {
      bucket: "ohmyho-builds-production",
      controlApi: "ohmyho-control-api-production",
      maximumSandboxes: 25,
    });
    expect(configuration).toMatchObject({
      name: "ohmyho-build-runner-production",
      account_id: "00000000000000000000000000000001",
      vars: { BUILD_PROJECT: "ohmyho-production-build" },
    });
  });

  it("carries no credential: the sandbox gets a per-build token and nothing else", () => {
    for (const name of [
      "wrangler.jsonc",
      "wrangler.development.jsonc",
      "wrangler.production.jsonc",
    ]) {
      const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/AWS_|AKIA[A-Z0-9]{12,20}|SECRET|TOKEN|image_vars/u);
    }
  });
});
