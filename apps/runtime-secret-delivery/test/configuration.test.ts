import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const readConfig = async (name: "wrangler" | "wrangler.production" | "wrangler.development") =>
  JSON.parse(
    (await readFile(resolve(root, `${name}.jsonc`), "utf8"))
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/,\s*([}\]])/gu, "$1"),
  ) as Record<string, unknown>;

const previewServices = (environment: "poc-private-fullstack" | "production") => [
  {
    binding: "PROJECT_PREVIEW_AUTHORITY",
    service: `ohmyho-control-store-${environment}`,
    entrypoint: "PreviewTokenLookupRuntime",
  },
  {
    binding: "PREVIEW_SECRET_AUTHORITY",
    service: `ohmyho-control-store-${environment}`,
    entrypoint: "PreviewSecretAuthorityRuntime",
  },
  {
    binding: "PREVIEW_MAIL_GATEWAY",
    service: `ohmyho-mail-gateway-${environment}`,
    entrypoint: "MailEgressEntrypoint",
  },
  {
    binding: "PREVIEW_STORAGE_GATEWAY",
    service: `ohmyho-storage-gateway-${environment}`,
    entrypoint: "StorageGatewayRelayEntrypoint",
  },
  {
    binding: "PREVIEW_AI_GATEWAY",
    service: `ohmyho-ai-gateway-${environment}`,
  },
];

describe("runtime secret delivery deployment configuration", () => {
  it("pins the existing development graph on the Core without embedding its keyring material", async () => {
    const config = await readConfig("wrangler.development");
    expect(config).toMatchObject({
      name: "ohmyho-runtime-secret-delivery-poc-private-fullstack",
      workers_dev: false,
      preview_urls: false,
      vars: {
        RUNTIME_CONFIGURATION_STATE: "configured",
        ENVIRONMENT_SECRET_KEY_VERSION: "20261106",
      },
      services: [
        ...previewServices("poc-private-fullstack"),
        {
          binding: "RUNTIME_SECRET_RUNTIME",
          service: "ohmyho-control-store-poc-private-fullstack",
          entrypoint: "RuntimeSecretDeliveryRuntime",
        },
        {
          binding: "WFP_MANAGEMENT",
          service: "ohmyho-wfp-management-poc-private-fullstack",
          entrypoint: "WfpManagementService",
        },
      ],
      triggers: { crons: ["*/1 * * * *"] },
    });
    expect(config["routes"]).toBeUndefined();
    expect(
      (config["vars"] as Record<string, unknown>)["ENVIRONMENT_SECRET_KEY_BASE64"],
    ).toBeUndefined();
    expect(
      (config["vars"] as Record<string, unknown>)["ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON"],
    ).toBeUndefined();
  });

  it("schedules the verified private production graph for runtime secret updates", async () => {
    const config = await readConfig("wrangler.production");
    expect(config).toMatchObject({
      name: "ohmyho-runtime-secret-delivery-production",
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: ["*/1 * * * *"] },
      services: [
        ...previewServices("production"),
        {
          binding: "RUNTIME_SECRET_RUNTIME",
          service: "ohmyho-control-store-production",
          entrypoint: "RuntimeSecretDeliveryRuntime",
        },
        {
          binding: "WFP_MANAGEMENT",
          service: "ohmyho-wfp-management-production",
          entrypoint: "WfpManagementService",
        },
      ],
    });
    expect(config["routes"]).toBeUndefined();
    expect(config["queues"]).toBeUndefined();
  });

  it("keeps the checked-in generic deployment disabled and private", async () => {
    const config = await readConfig("wrangler");

    expect(config).toMatchObject({
      name: "ohmyho-runtime-secret-delivery",
      main: "src/worker-main.ts",
      workers_dev: false,
      preview_urls: false,
      vars: {
        RUNTIME_CONFIGURATION_STATE: "disabled",
        ENVIRONMENT_SECRET_KEY_VERSION: "2",
      },
      services: [
        {
          binding: "WFP_MANAGEMENT",
          service: "ohmyho-wfp-management-sandbox",
          entrypoint: "WfpManagementService",
        },
      ],
      triggers: { crons: ["*/1 * * * *"] },
    });
    expect(config["routes"]).toBeUndefined();
  });
});
