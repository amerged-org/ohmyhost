import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = Object.freeze({});
  },
}));

import { requireWfpManagementConfiguration } from "../src/bindings.js";
import { createWfpManagementRuntime } from "../src/worker-main.js";
import { DIAGNOSTIC_SIGNING_KEY, WFP_API_TOKEN, workerBindings } from "./worker-fixtures.js";

const INVALID = "wfp_management_configuration_invalid";

describe("WFP management Worker bindings", () => {
  it.each([
    ["sandbox", "ohmyho-builds-development"],
    ["poc-private-fullstack", "ohmyho-builds-development"],
    ["production", "ohmyho-builds-production"],
  ])("derives every %s service identity from the dispatch namespace", (namespace, bucket) => {
    const bindings = workerBindings({
      WFP_DISPATCH_NAMESPACE: `ohmyho-${namespace}`,
      DATABASE_SERVICE_US: `ohmyho-project-database-${namespace === "poc-private-fullstack" ? "development" : namespace}-us`,
      DATABASE_SERVICE_EU: `ohmyho-project-database-${namespace === "poc-private-fullstack" ? "development" : namespace}-eu`,
      BUILD_OBJECTS_BUCKET_US: bucket,
      BUILD_OBJECTS_BUCKET_EU: `${bucket}-eu`,
    });
    expect(requireWfpManagementConfiguration(bindings)).toEqual({
      accountId: "00000000000000000000000000000001",
      namespace: `ohmyho-${namespace}`,
      workersDevSubdomain: "your-omh-account",
      buildObjectsBuckets: [
        { bucketName: bucket, objects: bindings.BUILD_OBJECTS_US },
        { bucketName: `${bucket}-eu`, objects: bindings.BUILD_OBJECTS_EU },
      ],
      apiToken: WFP_API_TOKEN,
      gatewayRegistry: bindings.GATEWAY_REGISTRY,
      runtimeSecretAuthority: bindings.RUNTIME_SECRET_AUTHORITY,
      databaseServiceUs: bindings.DATABASE_SERVICE_US,
      databaseServiceEu: bindings.DATABASE_SERVICE_EU,
      mailGatewayService: `ohmyho-mail-gateway-${namespace}`,
      mailGatewayOrigin: `https://ohmyho-mail-gateway-${namespace}.your-omh-account.workers.dev`,
      storageGatewayOrigin: `https://ohmyho-storage-gateway-${namespace}.your-omh-account.workers.dev`,
      aiGatewayOrigin:
        namespace === "production" ? "https://ai.ohmyho.st" : "https://ai.dev.ohmyho.st",
    });
  });

  it.each([
    [
      "a foreign database service",
      { DATABASE_SERVICE_US: "ohmyho-project-database-production-us" },
    ],
    ["a missing EU database service", { DATABASE_SERVICE_EU: undefined }],
    ["a missing API token secret", { WFP_API_TOKEN: undefined }],
    ["an empty API token secret", { WFP_API_TOKEN: "" }],
    ["an API token secret with a line break", { WFP_API_TOKEN: `${WFP_API_TOKEN}\n` }],
    ["a malformed account", { WFP_ACCOUNT_ID: "account" }],
    ["the disabled namespace", { WFP_DISPATCH_NAMESPACE: "disabled" }],
    ["an unknown namespace", { WFP_DISPATCH_NAMESPACE: "ohmyho-staging" }],
    ["a malformed workers.dev subdomain", { WFP_WORKERS_DEV_SUBDOMAIN: "a.b" }],
    ["the Prod build bucket outside Prod", { BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-production" }],
    [
      "the Prod EU build bucket outside Prod",
      { BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-production-eu" },
    ],
    ["a US bucket name as the EU bucket", { BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development" }],
    [
      "the Dev build bucket in Prod",
      {
        WFP_DISPATCH_NAMESPACE: "ohmyho-production",
        BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-development",
        BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development-eu",
      },
    ],
    ["a missing US build bucket binding", { BUILD_OBJECTS_US: undefined }],
    ["a missing EU build bucket binding", { BUILD_OBJECTS_EU: undefined }],
    ["a build bucket binding without get", { BUILD_OBJECTS_US: {} }],
    ["an EU build bucket binding without get", { BUILD_OBJECTS_EU: {} }],
    ["a missing dispatch namespace binding", { WFP_DISPATCH: null }],
    ["a missing runtime probe binding", { RUNTIME_PROBES: undefined }],
    ["a missing runtime secret authority binding", { RUNTIME_SECRET_AUTHORITY: undefined }],
    [
      "a runtime secret authority binding without authorizeManifest",
      { RUNTIME_SECRET_AUTHORITY: {} },
    ],
    ["a missing route registry binding", { GATEWAY_REGISTRY: undefined }],
    ["an incomplete route registry binding", { GATEWAY_REGISTRY: { activate: () => null } }],
  ])("fails closed on %s", (_name, override) => {
    expect(() => requireWfpManagementConfiguration(workerBindings(override))).toThrow(INVALID);
    expect(() => createWfpManagementRuntime(workerBindings(override) as never)).toThrow(INVALID);
  });

  it("rejects a binding inventory that is not an object and never echoes a secret", () => {
    for (const value of [null, undefined, "bindings", []]) {
      expect(() => requireWfpManagementConfiguration(value)).toThrow(INVALID);
    }
    let error: unknown;
    try {
      requireWfpManagementConfiguration(workerBindings({ WFP_ACCOUNT_ID: "bad" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error) + String(error)).not.toContain(WFP_API_TOKEN);
    expect(JSON.stringify(error) + String(error)).not.toContain(DIAGNOSTIC_SIGNING_KEY);
  });
});
