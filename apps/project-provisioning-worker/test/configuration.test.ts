import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readCoreConsumerBindings,
  readCorePublisherBindings,
  readCoreWorkflowBindings,
} from "../src/core-bindings.js";
import { readCoreDeploymentWorkflowBindings } from "../src/core-deployment-workflow.js";
import { verifyBuiltBoundary } from "../scripts/verify-built-boundary.mjs";

const root = path.resolve(import.meta.dirname, "..");
const readConfig = async (name: "publisher" | "consumer" | "workflow" | "deployment-workflow") => {
  const source = await readFile(path.join(root, `wrangler.${name}.jsonc`), "utf8");
  return JSON.parse(source.replace(/,\s*([}\]])/gu, "$1"));
};

describe("project provisioning Worker deployment boundaries", () => {
  it("selects the Core for the Deployment Workflow with exactly the inventory its reader accepts", async () => {
    for (const environment of ["development", "production"]) {
      const configuration = JSON.parse(
        (
          await readFile(
            path.join(root, `wrangler.${environment}.deployment-workflow.jsonc`),
            "utf8",
          )
        )
          .replace(/^\s*\/\/.*$/gmu, "")
          .replace(/,\s*([}\]])/gu, "$1"),
      ) as {
        vars: Record<string, string>;
        services: { binding: string; service: string; entrypoint: string }[];
        workflows: { binding: string }[];
      };
      expect(configuration.vars).toEqual({ RUNTIME_CONFIGURATION_STATE: "configured" });
      const core = configuration.services.find(
        (service) => service.binding === "DEPLOYMENT_WORKFLOW_RUNTIME",
      );
      expect(core).toMatchObject({
        service:
          environment === "development"
            ? "ohmyho-control-store-poc-private-fullstack"
            : "ohmyho-control-store-production",
        entrypoint: "DeploymentWorkflowRuntime",
      });
      const cache = JSON.parse(
        (await readFile(path.join(root, `../next-cache/wrangler.${environment}.jsonc`), "utf8"))
          .replace(/^\s*\/\/.*$/gmu, "")
          .replace(/,\s*([}\]])/gu, "$1"),
      ) as { name: string; services: { binding: string; service: string; entrypoint: string }[] };
      expect(
        configuration.services.filter((service) => service.binding === "NEXT_CACHE_RETIREMENT"),
      ).toEqual([
        {
          binding: "NEXT_CACHE_RETIREMENT",
          service: cache.name,
          entrypoint: "NextCacheRetirementRuntime",
        },
      ]);
      expect(cache.services).toEqual([
        {
          binding: "NEXT_CACHE_RETIREMENT_AUTHORITY",
          service: core?.service,
          entrypoint: "NextCacheRetirementAuthorityRuntime",
        },
      ]);
      // Every binding becomes a callable stand-in; the Worker's own reader judges the complete name inventory.
      const callable = new Proxy({}, { get: () => () => undefined });
      const environmentBindings = {
        ...configuration.vars,
        ...Object.fromEntries(
          [...configuration.services, ...configuration.workflows].map(({ binding }) => [
            binding,
            callable,
          ]),
        ),
      };
      expect(() => readCoreDeploymentWorkflowBindings(environmentBindings)).not.toThrow();
    }
  });

  it("selects the Core for the publisher, consumer and Workflow with bindings their readers accept", async () => {
    const readers = {
      publisher: readCorePublisherBindings,
      consumer: readCoreConsumerBindings,
      workflow: readCoreWorkflowBindings,
    };
    for (const environment of ["development", "production"])
      for (const [name, read] of Object.entries(readers)) {
        const configuration = JSON.parse(
          (await readFile(path.join(root, `wrangler.${environment}.${name}.jsonc`), "utf8"))
            .replace(/^\s*\/\/.*$/gmu, "")
            .replace(/,\s*([}\]])/gu, "$1"),
        ) as {
          vars: Record<string, string>;
          services?: { binding: string }[];
          workflows?: { binding: string }[];
          queues?: { producers?: { binding: string }[] };
        };
        expect(configuration.vars).toEqual({ RUNTIME_CONFIGURATION_STATE: "configured" });
        const callable = new Proxy({}, { get: () => () => undefined });
        const bindings = [
          ...(configuration.services ?? []),
          ...(configuration.workflows ?? []),
          ...(configuration.queues?.producers ?? []),
        ];
        expect(() =>
          read({
            ...configuration.vars,
            ...Object.fromEntries(bindings.map(({ binding }) => [binding, callable])),
          }),
        ).not.toThrow();
      }
  });

  it("connects production commands to their isolated queue and owned API origin", async () => {
    const [publisher, consumer, api, workflow] = await Promise.all(
      [
        "wrangler.production.publisher.jsonc",
        "wrangler.production.consumer.jsonc",
        "../control-api/wrangler.production.jsonc",
        "wrangler.production.workflow.jsonc",
      ].map(async (name) =>
        JSON.parse(
          (await readFile(path.join(root, name), "utf8"))
            .replace(/^\s*\/\/.*$/gmu, "")
            .replace(/,\s*([}\]])/gu, "$1"),
        ),
      ),
    );
    expect(publisher.triggers).toEqual({ crons: ["*/1 * * * *"] });
    expect(consumer.queues).toEqual({
      consumers: [
        {
          queue: "ohmyho-project-provisioning-production",
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 30,
          dead_letter_queue: "ohmyho-project-provisioning-dlq-production",
        },
      ],
    });
    expect(api.routes).toEqual([{ pattern: "app.ohmyho.st", custom_domain: true }]);
    expect(consumer.services).toEqual([
      {
        binding: "PROJECT_WORKFLOW_RUNTIME",
        service: "ohmyho-control-store-production",
        entrypoint: "ProjectWorkflowRuntime",
      },
      {
        binding: "PROJECT_DISPATCH_RUNTIME",
        service: "ohmyho-control-store-production",
        entrypoint: "ProjectDispatchRuntime",
      },
      {
        binding: "MANAGED_SOURCE_PROCESSOR",
        service: api.name,
        entrypoint: "ManagedSourceProcessor",
      },
    ]);
    const [developmentConsumer, developmentApi, developmentWorkflow] = await Promise.all(
      [
        "wrangler.development.consumer.jsonc",
        "../control-api/wrangler.jsonc",
        "wrangler.development.workflow.jsonc",
      ].map(async (name) =>
        JSON.parse(
          (await readFile(path.join(root, name), "utf8"))
            .replace(/^\s*\/\/.*$/gmu, "")
            .replace(/,\s*([}\]])/gu, "$1"),
        ),
      ),
    );
    expect(developmentConsumer.services).toEqual([
      {
        binding: "PROJECT_WORKFLOW_RUNTIME",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "ProjectWorkflowRuntime",
      },
      {
        binding: "PROJECT_DISPATCH_RUNTIME",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "ProjectDispatchRuntime",
      },
      {
        binding: "MANAGED_SOURCE_PROCESSOR",
        service: developmentApi.name,
        entrypoint: "ManagedSourceProcessor",
      },
    ]);
    // Both workflow bundles enter the artifact-pinned train under this exact account,
    // rather than depending on whichever account the operator's Wrangler login selects.
    for (const configuration of [workflow, developmentWorkflow]) {
      expect(configuration.account_id).toBe("00000000000000000000000000000001");
      expect(configuration.queues).toBeUndefined();
      expect(configuration.triggers).toBeUndefined();
    }
    for (const configuration of [publisher, consumer, api]) {
      expect(configuration.workers_dev).toBe(false);
      expect(configuration.preview_urls).toBe(false);
    }
  });

  it("separates publisher capabilities and keeps checked-in execution disabled", async () => {
    const config = await readConfig("publisher");
    expect(config).toMatchObject({
      main: "src/publisher-main.ts",
      compatibility_date: "2026-08-19",
      workers_dev: false,
      preview_urls: false,
      vars: { RUNTIME_CONFIGURATION_STATE: "disabled" },
      queues: { producers: [{ binding: "PROJECT_PROVISIONING_QUEUE" }] },
      triggers: { crons: ["*/1 * * * *"] },
    });
    expect(config.queues.consumers).toBeUndefined();
    expect(config.workflows).toBeUndefined();
  });

  it("separates consumer capabilities with bounded retry and external Workflow binding", async () => {
    const config = await readConfig("consumer");
    expect(config).toMatchObject({
      main: "src/consumer-main.ts",
      vars: { RUNTIME_CONFIGURATION_STATE: "disabled" },
      queues: {
        consumers: [
          {
            max_batch_size: 10,
            max_batch_timeout: 5,
            max_retries: 30,
            dead_letter_queue: "ohmyhost-project-provisioning-dlq",
          },
        ],
      },
      workflows: [
        {
          binding: "PROJECT_PROVISIONING_WORKFLOW",
          class_name: "ProjectProvisioningWorkflow",
          script_name: "ohmyhost-project-provisioning-workflow",
        },
        {
          binding: "DEPLOYMENT_WORKFLOW",
          class_name: "DeploymentWorkflow",
          script_name: "ohmyhost-deployment-workflow",
        },
      ],
    });
    expect(config.queues.producers).toBeUndefined();
    expect(config.triggers).toBeUndefined();
  });

  it("binds the separate DeploymentWorkflow only to its database and private RPCs", async () => {
    const config = await readConfig("deployment-workflow");
    expect(config).toMatchObject({
      main: "src/deployment-workflow-main.ts",
      vars: { RUNTIME_CONFIGURATION_STATE: "disabled" },
      services: [
        {
          binding: "NEXT_CACHE_RETIREMENT",
          service: "ohmyho-next-cache-sandbox",
          entrypoint: "NextCacheRetirementRuntime",
        },
        {
          binding: "NATIVE_AUTH_RESOURCE_RUNTIME",
          service: "ohmyho-control-store-disabled",
          entrypoint: "NativeAuthResourceRuntime",
        },
        {
          binding: "NATIVE_AUTH_ADMIN_US",
          service: "ohmyho-native-auth-development-us",
          entrypoint: "NativePolicyService",
        },
        {
          binding: "NATIVE_AUTH_ADMIN_EU",
          service: "ohmyho-native-auth-development-eu",
          entrypoint: "NativePolicyService",
        },
        {
          binding: "SOURCE_FETCHER",
          service: "ohmyho-source-fetcher-sandbox",
          entrypoint: "SourceFetcherService",
        },
        {
          binding: "BUILD_RUNNER",
          service: "ohmyho-build-runner-sandbox",
          entrypoint: "BuildRunnerService",
        },
        {
          binding: "RECOVERY_INVOKER",
          service: "ohmyho-recovery-container-sandbox",
          entrypoint: "RecoveryContainerService",
        },
        {
          binding: "RUNTIME_SECRET_DELIVERY",
          service: "ohmyho-runtime-secret-delivery-sandbox",
          entrypoint: "RuntimeSecretDeliveryService",
        },
        {
          binding: "NEON_MANAGEMENT",
          service: "ohmyho-neon-management-sandbox",
          entrypoint: "NeonManagementService",
        },
        {
          binding: "R2_MANAGEMENT",
          service: "ohmyho-r2-management-sandbox",
          entrypoint: "R2ManagementService",
        },
        {
          binding: "SES_MANAGEMENT",
          service: "ohmyho-ses-management-sandbox",
          entrypoint: "ResendMailManagementService",
        },
        {
          binding: "CLOUDFLARE_DOMAIN_MANAGEMENT",
          service: "ohmyho-cloudflare-domain-management-sandbox",
          entrypoint: "CloudflareDomainManagementService",
        },
        {
          binding: "WFP_MANAGEMENT",
          service: "ohmyho-wfp-management-sandbox",
          entrypoint: "WfpManagementService",
        },
      ],
      workflows: [
        {
          binding: "DEPLOYMENT_WORKFLOW",
          class_name: "DeploymentWorkflow",
        },
        {
          binding: "PROVIDER_RECONCILIATION_WORKFLOW",
          class_name: "ProviderReconciliationWorkflow",
        },
        {
          binding: "PROJECT_PROVISIONING_WORKFLOW",
          class_name: "ProjectProvisioningWorkflow",
          script_name: "ohmyhost-project-provisioning-workflow",
        },
      ],
    });
    const cache = JSON.parse(
      (await readFile(path.join(root, "../next-cache/wrangler.jsonc"), "utf8")).replace(
        /,\s*([}\]])/gu,
        "$1",
      ),
    );
    expect(cache).toMatchObject({
      name: "ohmyho-next-cache-sandbox",
      services: [
        {
          binding: "NEXT_CACHE_RETIREMENT_AUTHORITY",
          service: "ohmyho-control-store-disabled",
          entrypoint: "NextCacheRetirementAuthorityRuntime",
        },
      ],
    });
    expect(config.queues).toBeUndefined();
    expect(config.triggers).toBeUndefined();
  });

  it("separates the Workflow class from Queue and schedule capabilities", async () => {
    const config = await readConfig("workflow");
    expect(config).toMatchObject({
      main: "src/workflow-main.ts",
      vars: { RUNTIME_CONFIGURATION_STATE: "disabled" },
      workflows: [
        {
          binding: "PROJECT_PROVISIONING_WORKFLOW",
          class_name: "ProjectProvisioningWorkflow",
        },
      ],
    });
    expect(config.queues).toBeUndefined();
    expect(config.triggers).toBeUndefined();
  });

  it("pins Wrangler and checks generated runtime types and all four dry-run builds", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    expect(packageJson.devDependencies.wrangler).toBe("4.125.0");
    expect(packageJson.scripts["types:check"]).toContain("wrangler types --check");
    for (const name of ["publisher", "consumer", "workflow", "deployment-workflow"]) {
      expect(packageJson.scripts.build).toContain(`wrangler.${name}.jsonc`);
    }
    const generated = await readFile(path.join(root, "worker-configuration.d.ts"), "utf8");
    expect(generated).toContain("Generated by Wrangler");
    expect(generated).toContain("interface Env");
  });

  it("rejects a deployment bundle built from missing or stale workspace output", async () => {
    const fixture = await createBuiltBoundaryFixture();
    try {
      await expect(
        verifyBuiltBoundary(pathToFileURL(`${fixture.root}${path.sep}`)),
      ).resolves.toBeUndefined();

      await rm(fixture.workspaceOutput);
      await expect(
        verifyBuiltBoundary(pathToFileURL(`${fixture.root}${path.sep}`)),
      ).rejects.toThrow(/deployment-workflow workspace dependency build is missing/u);

      await writeFile(fixture.workspaceOutput, "export const value = 'old';\n");
      const old = new Date("2026-01-01T00:00:00.000Z");
      const current = new Date("2026-01-02T00:00:00.000Z");
      await utimes(fixture.workspaceOutput, old, old);
      await utimes(fixture.workspaceSource, current, current);
      await expect(
        verifyBuiltBoundary(pathToFileURL(`${fixture.root}${path.sep}`)),
      ).rejects.toThrow(/deployment-workflow workspace dependency build is stale/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("has no public fetch route, credential binding, local env access, or duplicated SQL", async () => {
    const files = await readdir(path.join(root, "src"));
    const source = (
      await Promise.all(
        files
          .filter((file) => file.endsWith(".ts"))
          .map((file) => readFile(path.join(root, "src", file), "utf8")),
      )
    ).join("\n");
    const credentialSurface = source.replaceAll(/\burl\.password\b/gu, "");
    expect(credentialSurface).not.toMatch(
      /\bfetch\s*\(|process\.env|dotenv|\b(?:token|password|apiKey)\b/iu,
    );
    expect(source).not.toMatch(/ENVIRONMENT_SECRET_KEY|secretValue|ciphertext|\.decrypt\s*\(/u);
    expect(source).not.toMatch(
      /\b(?:select|insert|update|delete)\s+(?:from|into|[a-z_]+\s+set)\b/iu,
    );
    for (const name of ["publisher", "consumer", "workflow", "deployment-workflow"] as const) {
      expect((await readConfig(name)).routes).toBeUndefined();
    }
  });
});

async function createBuiltBoundaryFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "project-built-boundary-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace");
  const appRoot = path.join(workspaceRoot, "apps", "project-provisioning-worker");
  const dependencyRoot = path.join(workspaceRoot, "packages", "dependency");
  const workspaceSource = path.join(dependencyRoot, "src", "index.ts");
  const workspaceOutput = path.join(dependencyRoot, "dist", "index.js");
  await Promise.all([
    mkdir(path.dirname(workspaceSource), { recursive: true }),
    mkdir(path.dirname(workspaceOutput), { recursive: true }),
  ]);
  await writeFile(path.join(dependencyRoot, "package.json"), '{"name":"@ohmyhost/dependency"}\n');
  await writeFile(workspaceSource, "export const value = 'current';\n");
  await writeFile(workspaceOutput, "export const value = 'current';\n");

  for (const name of ["publisher", "consumer", "workflow", "deployment-workflow"] as const) {
    const main = name === "deployment-workflow" ? "deployment-workflow-main.ts" : `${name}-main.ts`;
    const config = {
      main: `src/${main}`,
      compatibility_date: "2026-08-19",
      workers_dev: false,
      preview_urls: false,
      vars: { RUNTIME_CONFIGURATION_STATE: "disabled" },
      ...(name === "publisher" ? { queues: { producers: [{}] } } : {}),
      ...(name === "consumer"
        ? {
            queues: { consumers: [{}] },
            workflows: [{ script_name: "ohmyhost-project-provisioning-workflow" }],
          }
        : {}),
    };
    const bundleRoot = path.join(appRoot, "dist", `${name}-bundle`);
    await mkdir(bundleRoot, { recursive: true });
    await writeFile(path.join(appRoot, `wrangler.${name}.jsonc`), JSON.stringify(config));
    await writeFile(path.join(bundleRoot, `${name}-main.js`), "export default {};\n");
    await writeFile(
      path.join(bundleRoot, "metafile.json"),
      JSON.stringify({
        inputs: {
          [`src/${main}`]: {},
          ...(name === "deployment-workflow"
            ? { "../../packages/dependency/dist/index.js": {} }
            : {}),
        },
      }),
    );
  }
  return { root: appRoot, workspaceSource, workspaceOutput };
}
