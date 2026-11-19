import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Resend mail management Worker configuration (historical ses-management name)", () => {
  it("is route-free and exposes only fixed non-secret settings and the DNS binding", async () => {
    const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const configuration = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as Record<
      string,
      unknown
    >;

    expect(configuration).toMatchObject({
      name: "ohmyho-ses-management",
      main: "src/resend-worker.ts",
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: false },
      compatibility_flags: ["nodejs_compat"],
      services: [
        {
          binding: "CLOUDFLARE_DOMAIN_MANAGEMENT",
          service: "ohmyho-cloudflare-domain-management-sandbox",
          entrypoint: "CloudflareDomainManagementService",
        },
      ],
    });
    expect(configuration).not.toHaveProperty("routes");
    expect(JSON.stringify(configuration)).not.toMatch(/AWS_/u);
  });

  it("pins the sandbox to its DNS binding without any AWS setting", async () => {
    const source = await readFile(new URL("../wrangler.sandbox.jsonc", import.meta.url), "utf8");
    const configuration = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as Record<
      string,
      unknown
    >;

    expect(configuration).toMatchObject({
      name: "ohmyho-ses-management-sandbox",
      workers_dev: false,
      preview_urls: false,
      vars: {
        RUNTIME_CONFIGURATION_STATE: "configured",
      },
      services: [
        {
          binding: "CLOUDFLARE_DOMAIN_MANAGEMENT",
          service: "ohmyho-cloudflare-domain-management-sandbox",
          entrypoint: "CloudflareDomainManagementService",
        },
      ],
    });
    expect(JSON.stringify(configuration)).not.toMatch(/AWS_/u);
  });
});
