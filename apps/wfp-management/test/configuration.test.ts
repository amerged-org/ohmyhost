import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface WorkerConfiguration {
  readonly name: string;
  readonly account_id?: string;
  readonly main: string;
  readonly workers_dev: boolean;
  readonly preview_urls: boolean;
  readonly compatibility_flags?: readonly string[];
  readonly vars: Readonly<Record<string, string>>;
  readonly services?: readonly Readonly<Record<string, string>>[];
  readonly r2_buckets?: readonly Readonly<Record<string, string>>[];
  readonly dispatch_namespaces?: readonly Readonly<Record<string, unknown>>[];
  readonly routes?: readonly unknown[];
}

function readConfiguration(name: string): WorkerConfiguration {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const json = source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1");
  return JSON.parse(json) as WorkerConfiguration;
}

function expectPrivateBoundary(name: string, configuration: WorkerConfiguration): void {
  expect(configuration).toMatchObject({
    main: "src/worker-main.ts",
    workers_dev: false,
    preview_urls: false,
  });
  expect(configuration.routes).toBeUndefined();
  expect(configuration.compatibility_flags).toEqual(["nodejs_compat"]);
  expect(Object.keys(configuration.vars).sort()).toEqual([
    "BUILD_OBJECTS_BUCKET_EU",
    "BUILD_OBJECTS_BUCKET_US",
    "DATABASE_SERVICE_EU",
    "DATABASE_SERVICE_US",
    "NATIVE_AUTH_SERVICE_EU",
    "NATIVE_AUTH_SERVICE_US",
    "WFP_ACCOUNT_ID",
    "WFP_DISPATCH_NAMESPACE",
    "WFP_WORKERS_DEV_SUBDOMAIN",
  ]);
  // The two secrets and the dev-access key are Worker secrets; no value may sit in a config.
  const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  expect(source).not.toMatch(/cfat_[A-Za-z0-9_-]+/u);
  expect(source).not.toMatch(/"(?:kty|crv|d)"/u);
  for (const secret of ["WFP_API_TOKEN"]) {
    expect(configuration.vars).not.toHaveProperty(secret);
    expect(source).toContain(`// ${secret} is`);
  }
  // The Worker reaches Workers for Platforms itself: no AWS egress binding remains.
  expect(source).not.toMatch(/AWS|Lambda/u);
  expect(configuration.services).toHaveLength(
    ["wrangler.development.jsonc", "wrangler.production.jsonc"].includes(name) ? 5 : 4,
  );
  // Each region's bundles are read from a bucket inside that region's jurisdiction.
  expect(configuration.r2_buckets).toEqual([
    {
      binding: "BUILD_OBJECTS_US",
      bucket_name: configuration.vars["BUILD_OBJECTS_BUCKET_US"],
      jurisdiction: "us",
    },
    {
      binding: "BUILD_OBJECTS_EU",
      bucket_name: configuration.vars["BUILD_OBJECTS_BUCKET_EU"],
      jurisdiction: "eu",
    },
  ]);
  expect(configuration.vars["BUILD_OBJECTS_BUCKET_EU"]).toBe(
    `${configuration.vars["BUILD_OBJECTS_BUCKET_US"]}-eu`,
  );
  expect(configuration.vars).not.toHaveProperty("BUILD_OBJECTS_BUCKET");
  expect(configuration.dispatch_namespaces).toHaveLength(1);
  expect(configuration.dispatch_namespaces?.[0]?.["binding"]).toBe("WFP_DISPATCH");
  // The health probe runs customer code through this binding, so it declares the same Outbound
  // Worker and egress context parameter as the gateway: a profile without it opens sockets and
  // fetches any origin during the probe.
  expect(configuration.dispatch_namespaces?.[0]?.["outbound"]).toEqual({
    service: expect.stringMatching(
      /^ohmyho-wfp-egress-(?:disabled|v3-poc-private-fullstack|production)$/u,
    ),
    parameters: ["EGRESS_CONTEXT"],
  });
}

describe("WFP management bundle boundary", () => {
  it("keeps the generic configuration private and fail-closed", () => {
    const configuration = readConfiguration("wrangler.jsonc");

    expectPrivateBoundary("wrangler.jsonc", configuration);
    expect(configuration).toMatchObject({
      name: "ohmyho-wfp-management-disabled",
      vars: {
        WFP_ACCOUNT_ID: "00000000000000000000000000000000",
        WFP_DISPATCH_NAMESPACE: "disabled",
        WFP_WORKERS_DEV_SUBDOMAIN: "disabled",
        BUILD_OBJECTS_BUCKET_US: "disabled",
        BUILD_OBJECTS_BUCKET_EU: "disabled-eu",
      },
      services: [
        {
          binding: "NATIVE_AUTH_REGISTRY_AUTHORITY",
          service: "ohmyho-control-store-disabled",
          entrypoint: "NativeAuthRegistryAuthorityRuntime",
        },
        {
          binding: "RUNTIME_SECRET_AUTHORITY",
          service: "ohmyho-control-store-disabled",
          entrypoint: "RuntimeSecretAuthorityRuntime",
        },
        {
          binding: "GATEWAY_REGISTRY",
          service: "ohmyho-control-api-disabled",
          entrypoint: "GatewayRoutingManagementService",
        },
        {
          binding: "RUNTIME_PROBES",
          service: "ohmyho-control-api-disabled",
          entrypoint: "RuntimeCreditService",
        },
      ],
      dispatch_namespaces: [
        {
          binding: "WFP_DISPATCH",
          namespace: "disabled",
          outbound: { service: "ohmyho-wfp-egress-disabled", parameters: ["EGRESS_CONTEXT"] },
        },
      ],
    });
  });

  it("pins the reviewed sandbox account and namespace without secret values", () => {
    const configuration = readConfiguration("wrangler.sandbox.jsonc");

    expectPrivateBoundary("wrangler.sandbox.jsonc", configuration);
    expect(configuration).toMatchObject({
      name: "ohmyho-wfp-management-sandbox",
      account_id: "00000000000000000000000000000001",
      vars: {
        WFP_ACCOUNT_ID: "00000000000000000000000000000001",
        WFP_DISPATCH_NAMESPACE: "ohmyho-sandbox",
        WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
        BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-development",
        BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development-eu",
      },
      services: [
        {
          binding: "NATIVE_AUTH_REGISTRY_AUTHORITY",
          service: "ohmyho-control-store-disabled",
          entrypoint: "NativeAuthRegistryAuthorityRuntime",
        },
        {
          binding: "RUNTIME_SECRET_AUTHORITY",
          service: "ohmyho-control-store-disabled",
          entrypoint: "RuntimeSecretAuthorityRuntime",
        },
        {
          binding: "GATEWAY_REGISTRY",
          service: "ohmyho-control-api-sandbox",
          entrypoint: "GatewayRoutingManagementService",
        },
        {
          binding: "RUNTIME_PROBES",
          service: "ohmyho-control-api-sandbox",
          entrypoint: "RuntimeCreditService",
        },
      ],
      // The sandbox namespace has no Outbound Worker of its own; it borrows Development's.
      dispatch_namespaces: [
        {
          binding: "WFP_DISPATCH",
          namespace: "ohmyho-sandbox",
          outbound: {
            service: "ohmyho-wfp-egress-v3-poc-private-fullstack",
            parameters: ["EGRESS_CONTEXT"],
          },
        },
      ],
    });
  });

  it.each([
    ["wrangler.development.jsonc", "poc-private-fullstack", "ohmyho-builds-development"],
    ["wrangler.production.jsonc", "production", "ohmyho-builds-production"],
  ])("binds %s to its own namespace, control API and build bucket", (name, namespace, bucket) => {
    const configuration = readConfiguration(name);

    expectPrivateBoundary(name, configuration);
    expect(configuration).toMatchObject({
      name: `ohmyho-wfp-management-${namespace}`,
      account_id: "00000000000000000000000000000001",
      vars: {
        WFP_ACCOUNT_ID: "00000000000000000000000000000001",
        WFP_DISPATCH_NAMESPACE: `ohmyho-${namespace}`,
        WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
        BUILD_OBJECTS_BUCKET_US: bucket,
        BUILD_OBJECTS_BUCKET_EU: `${bucket}-eu`,
      },
      services: [
        {
          binding: "GROWTH_ANALYTICS",
          service: `ohmyho-growth-analytics-${namespace}`,
          entrypoint: "GrowthCollectRuntime",
        },
        {
          binding: "NATIVE_AUTH_REGISTRY_AUTHORITY",
          service: `ohmyho-control-store-${namespace === "production" ? "production" : "poc-private-fullstack"}`,
          entrypoint: "NativeAuthRegistryAuthorityRuntime",
        },
        {
          binding: "RUNTIME_SECRET_AUTHORITY",
          service: `ohmyho-control-store-${namespace === "production" ? "production" : "poc-private-fullstack"}`,
          entrypoint: "RuntimeSecretAuthorityRuntime",
        },
        {
          binding: "GATEWAY_REGISTRY",
          service: `ohmyho-control-api-${namespace}`,
          entrypoint: "GatewayRoutingManagementService",
        },
        {
          binding: "RUNTIME_PROBES",
          service: `ohmyho-control-api-${namespace}`,
          entrypoint: "RuntimeCreditService",
        },
      ],
      dispatch_namespaces: [
        {
          binding: "WFP_DISPATCH",
          namespace: `ohmyho-${namespace}`,
          outbound: {
            service: `ohmyho-wfp-egress-${namespace === "production" ? "production" : "v3-poc-private-fullstack"}`,
            parameters: ["EGRESS_CONTEXT"],
          },
        },
      ],
    });
  });
});
