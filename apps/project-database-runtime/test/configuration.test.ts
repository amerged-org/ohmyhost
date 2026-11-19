import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("project database runtime configuration", () => {
  it("has no public origin, credential, route, or unrelated provider binding", () => {
    const config = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../wrangler.jsonc"), "utf8").replace(
        /,\s*([}\]])/gu,
        "$1",
      ),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({
      name: "ohmyhost-project-database-runtime",
      workers_dev: false,
      preview_urls: false,
      compatibility_date: "2026-08-24",
      durable_objects: {
        bindings: [{ name: "DATABASE_ENVIRONMENTS", class_name: "ProjectDatabaseEnvironment" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ProjectDatabaseEnvironment"] }],
      services: [
        {
          binding: "OHMYHOST_MAIL_GATEWAY",
          service: "ohmyho-mail-gateway-disabled",
        },
      ],
      vars: { DATABASE_REGION: "us" },
    });
    for (const environment of ["development", "production", "sandbox"]) {
      for (const region of ["eu", "us"]) {
        const profile = JSON.parse(
          readFileSync(
            resolve(import.meta.dirname, `../wrangler.${environment}.${region}.jsonc`),
            "utf8",
          )
            .replace(/^\s*\/\/.*$/gmu, "")
            .replace(/,\s*([}\]])/gu, "$1"),
        ) as Record<string, unknown>;
        expect(profile).toMatchObject({
          workers_dev: false,
          preview_urls: false,
          vars: { DATABASE_REGION: region },
        });
        expect(profile["services"]).toEqual([
          ...(environment !== "sandbox"
            ? [
                {
                  binding: "PROJECT_PREVIEW_AUTHORITY",
                  service:
                    environment === "development"
                      ? "ohmyho-control-store-poc-private-fullstack"
                      : "ohmyho-control-store-production",
                  entrypoint: "PreviewDatabaseAuthorityRuntime",
                },
              ]
            : []),
          {
            binding: "OHMYHOST_MAIL_GATEWAY",
            service:
              environment === "development"
                ? "ohmyho-mail-gateway-poc-private-fullstack"
                : `ohmyho-mail-gateway-${environment}`,
            entrypoint: "DatabaseMailEntrypoint",
          },
          ...(environment === "development" && region === "eu"
            ? [
                {
                  binding: "QA_DATABASE_AUTHORITY",
                  service: "ohmyho-control-store-poc-private-fullstack",
                  entrypoint: "PreviewQaDatabaseAuthority",
                },
                {
                  binding: "QA_DEV_ACCESS",
                  service: "ohmyho-control-store-poc-private-fullstack",
                  entrypoint: "DevAccessRuntime",
                },
                {
                  binding: "QA_CREDIT",
                  service: "ohmyho-control-store-poc-private-fullstack",
                  entrypoint: "GatewayCreditRuntime",
                },
              ]
            : []),
        ]);
        expect(profile["vars"]).not.toHaveProperty("QA_DATABASE_MANIFEST");
        if (environment === "development" && region === "eu")
          expect(profile["vars"]).toHaveProperty("QA_DATABASE_PLATFORM", "development");
        else expect(profile["vars"]).not.toHaveProperty("QA_DATABASE_PLATFORM");
      }
    }
    expect(config).not.toHaveProperty("routes");
    expect(JSON.stringify(config)).not.toContain("DATABASE_REGISTRY_KEY");
  });
});
