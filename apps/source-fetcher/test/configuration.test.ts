import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface Configuration {
  readonly name: string;
  readonly account_id: string;
  readonly main: string;
  readonly workers_dev: boolean;
  readonly preview_urls: boolean;
  readonly vars: Readonly<Record<string, string>>;
  readonly services: readonly Readonly<Record<string, string>>[];
  readonly routes?: readonly unknown[];
}

function readConfiguration(name: string): Configuration {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  const json = source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1");
  return JSON.parse(json) as Configuration;
}

function expectPrivate(
  configuration: Configuration,
  environment: "disabled" | "sandbox" | "poc-private-fullstack" | "production",
): void {
  expect(configuration).toMatchObject({
    main: "src/worker-main.ts",
    workers_dev: false,
    preview_urls: false,
  });
  expect(configuration.routes).toBeUndefined();
  expect(configuration.services).toEqual([
    ...(environment === "poc-private-fullstack" || environment === "production"
      ? [
          {
            binding: "PREVIEW_CONTROL",
            service: `ohmyho-control-store-${environment}`,
            entrypoint: "PreviewSourceRuntime",
          },
        ]
      : []),
    {
      binding: "BUILD_RUNNER",
      service: `ohmyho-build-runner-${environment}`,
      entrypoint: "BuildRunnerService",
    },
  ]);
  const source = JSON.stringify(configuration);
  expect(source).not.toMatch(/(?:ghs_|-----BEGIN|cfat_)/u);
}

describe("source fetcher configuration", () => {
  it("keeps Dev and transferred Prod consent on their exact GitHub applications, build runners and build buckets", () => {
    const configuration = readConfiguration("wrangler.development.jsonc");
    expectPrivate(configuration, "poc-private-fullstack");
    expect(configuration.name).toBe("ohmyho-source-fetcher-poc-private-fullstack");
    expect(configuration.vars).toMatchObject({
      GITHUB_APP_CLIENT_ID: "Iv23Example000000001",
      GITHUB_APP_SLUG: "example-omh-development",
      GITHUB_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
    });
    expect(
      configuration.services.find((item) => item["binding"] === "BUILD_RUNNER")?.["service"],
    ).toBe("ohmyho-build-runner-poc-private-fullstack");
    expect(configuration.vars["BUILD_OBJECTS_BUCKET_US"]).toBe("ohmyho-builds-development");
    expect(configuration.vars["BUILD_OBJECTS_BUCKET_EU"]).toBe("ohmyho-builds-development-eu");
    expect(configuration.vars).not.toHaveProperty("BUILD_OBJECTS_BUCKET");
    expect(configuration.vars).not.toHaveProperty("GITHUB_APP_CLIENT_SECRET");
    expect(configuration.vars).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY_BASE64");
    const production = readConfiguration("wrangler.production.jsonc");
    expectPrivate(production, "production");
    expect(production.name).toBe("ohmyho-source-fetcher-production");
    expect(production.vars).toMatchObject({
      GITHUB_APP_CLIENT_ID: "Iv23Example000000002",
      GITHUB_APP_SLUG: "example-omh-production",
      GITHUB_OAUTH_REDIRECT_URI: "https://app.ohmyho.st/v1/github/oauth/callback",
    });
    expect(
      production.services.find((item) => item["binding"] === "BUILD_RUNNER")?.["service"],
    ).toBe("ohmyho-build-runner-production");
    expect(production.vars["BUILD_OBJECTS_BUCKET_US"]).toBe("ohmyho-builds-production");
    expect(production.vars["BUILD_OBJECTS_BUCKET_EU"]).toBe("ohmyho-builds-production-eu");
    expect(production.vars).not.toHaveProperty("BUILD_OBJECTS_BUCKET");
    expect(production.vars).not.toHaveProperty("GITHUB_APP_CLIENT_SECRET");
    expect(production.vars).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY_BASE64");
  });

  it("keeps the generic bundle private and disabled", () => {
    const configuration = readConfiguration("wrangler.jsonc");
    expectPrivate(configuration, "disabled");
    expect(configuration.name).toBe("ohmyho-source-fetcher-disabled");
    expect(configuration.account_id).toBe("00000000000000000000000000000000");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_OWNER");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_REPOSITORY");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_REPOSITORY_ID");
    expect(configuration.vars).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
    expect(configuration.vars).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY_BASE64");
  });

  it("pins only the reviewed sandbox account and provider limits", () => {
    const configuration = readConfiguration("wrangler.sandbox.jsonc");
    expectPrivate(configuration, "sandbox");
    expect(configuration.name).toBe("ohmyho-source-fetcher-sandbox");
    expect(configuration.account_id).toBe("00000000000000000000000000000001");
    expect(configuration.vars).toMatchObject({
      GITHUB_APP_CLIENT_ID: "Iv23Example000000001",
      GITHUB_APP_SLUG: "example-omh-development",
      GITHUB_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
    });
    expect(configuration.vars).not.toHaveProperty("GITHUB_APP_CLIENT_SECRET");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_OWNER");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_REPOSITORY");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_REPOSITORY_ID");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_INSTALLATION_ID");
    expect(configuration.vars).not.toHaveProperty("EXPECTED_GITHUB_COMMIT_SHA");
    expect(configuration.vars).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY_BASE64");
    const source = readFileSync(new URL("../wrangler.sandbox.jsonc", import.meta.url), "utf8");
    expect(source.match(/GITHUB_APP_PRIVATE_KEY_BASE64/gu)).toHaveLength(1);
  });
});
