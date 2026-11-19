import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const required = [
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON",
  "WORKOS_WEBHOOK_SECRET",
  "WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_WEBHOOK_SECRET",
];

describe("webhook Wrangler configurations", () => {
  it("keeps the signed webhook Worker private with only its two Core capabilities", async () => {
    const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const config = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as Record<string, unknown>;

    expect(config).toMatchObject({
      name: "ohmyho-workos-webhook-poc-private-fullstack",
      account_id: "00000000000000000000000000000001",
      main: "src/worker-main.ts",
      compatibility_date: "2026-08-19",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      vars: {
        STRIPE_ACCOUNT_ID: "acct_00000W39Example2",
        STRIPE_MODE: "test",
      },
      services: [
        {
          binding: "CONTROL_RUNTIME",
          service: "ohmyho-control-store-poc-private-fullstack",
          entrypoint: "WebhookIngressRuntime",
        },
        {
          binding: "RESEND_INGRESS_RUNTIME",
          service: "ohmyho-control-store-poc-private-fullstack",
          entrypoint: "MailResendIngressRuntime",
        },
      ],
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        logs: {
          enabled: true,
          head_sampling_rate: 1,
          invocation_logs: false,
          persist: true,
        },
      },
    });
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "account_id",
        "compatibility_date",
        "compatibility_flags",
        "main",
        "name",
        "observability",
        "preview_urls",
        "secrets",
        "services",
        "workers_dev",
        "vars",
      ].sort(),
    );
    expect(JSON.stringify(config)).not.toMatch(
      /WORKOS_(?:API_KEY|MANAGEMENT|CONNECT)|GITHUB_(?:APP|INSTALLATION|USER)|AWS_|NEON_|CONTROL_STORAGE_PROVIDER|CONTROL_DATABASE_URL|HYPERDRIVE/u,
    );
    expect(config).not.toHaveProperty("routes");
    for (const [name, file] of [
      ["ohmyho-workos-webhook-poc-private-fullstack", "wrangler.jsonc"],
      ["ohmyho-webhook-ingress-production", "wrangler.production.jsonc"],
    ]) {
      const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const profile = JSON.parse(
        text.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"),
      ) as Record<string, unknown>;
      expect(profile["name"]).toBe(name);
      // Workers Logs would keep the full URL of each invocation, so both profiles keep invocation logs off.
      expect(profile["observability"]).toMatchObject({ logs: { invocation_logs: false } });
      expect(profile["secrets"]).toEqual({ required });
      expect(Object.keys(profile["vars"] as Record<string, unknown>).sort()).toEqual([
        "STRIPE_ACCOUNT_ID",
        "STRIPE_MODE",
      ]);
    }
  });
});
