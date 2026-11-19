/* global URL, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseJsonc } from "../../platform-release.mjs";
import { buildQaMailGatewayConfig } from "./gateway-config.mjs";

test("temporary QA gateway overlay retains every Development setting and rejects unsafe targets", async () => {
  const base = parseJsonc(
    await readFile(
      new URL("../../../apps/mail-gateway/wrangler.development.jsonc", import.meta.url),
      "utf8",
    ),
  );
  const original = structuredClone(base);
  const overlay = buildQaMailGatewayConfig(base);
  assert.deepEqual(base, original);
  assert.deepEqual(overlay, {
    ...original,
    vars: { ...original.vars, QA_NATIVE_PREVIEW_MAIL_ENABLED: "development-only-v1" },
    services: [
      ...original.services,
      {
        binding: "QA_STABLE_PREVIEW_AUTHORITY",
        service: "ohmyho-preview-spike-auth-development",
        entrypoint: "QaStablePreviewAuthority",
      },
    ],
  });
  assert.deepEqual(overlay.triggers, original.triggers);
  assert.equal(Object.hasOwn(overlay.vars, "QA_NATIVE_PREVIEW_MAIL_SCOPE"), false);
  const sender = base.services.find((service) => service.binding === "NATIVE_AUTH_MAIL_AUTHORITY");
  for (const bad of [
    { ...base, name: "ohmyho-mail-gateway-production" },
    { ...base, account_id: "0".repeat(32) },
    { ...base, main: "foreign.ts" },
    { ...base, workers_dev: true },
    { ...base, vars: { ...base.vars, PLATFORM_ENVIRONMENT: "production" } },
    { ...base, vars: { ...base.vars, QA_NATIVE_PREVIEW_MAIL_SCOPE: "unexpected" } },
    { ...base, vars: { ...base.vars, QA_NATIVE_PREVIEW_MAIL_ENABLED: "unexpected" } },
    { ...base, services: [...base.services, { binding: "QA_STABLE_PREVIEW_AUTHORITY" }] },
    { ...base, services: [...base.services, sender] },
    { ...base, services: base.services.filter((service) => service !== sender) },
    { ...base, triggers: { crons: [] } },
  ])
    assert.throws(() => buildQaMailGatewayConfig(bad), /qa_mail_config_invalid/);
});
