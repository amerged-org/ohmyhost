/* global URL, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseJsonc } from "../../platform-release.mjs";
import { buildQaMailCustodyConfig } from "./custody-config.mjs";

test("QA custody overlay preserves the Development profile and rejects altered targets", async () => {
  const base = parseJsonc(
    await readFile(
      new URL("../../../apps/runtime-secret-delivery/wrangler.development.jsonc", import.meta.url),
      "utf8",
    ),
  );
  const original = structuredClone(base);
  const overlay = buildQaMailCustodyConfig(base);
  assert.deepEqual(base, original);
  assert.deepEqual(overlay, {
    ...original,
    vars: { ...original.vars, RUNTIME_QA_PREVIEW_MAIL_ENABLED: "development-only-v1" },
    services: [
      ...original.services,
      {
        binding: "QA_MAIL_KEY_AUTHORITY",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "QaPreviewMailKeyAuthority",
      },
    ],
  });
  assert.deepEqual(overlay.triggers, original.triggers);
  assert.deepEqual(overlay.secrets, original.secrets);
  const runtime = base.services.find((item) => item.binding === "RUNTIME_SECRET_RUNTIME");
  for (const bad of [
    { ...base, name: "ohmyho-runtime-secret-delivery-production" },
    { ...base, account_id: "0".repeat(32) },
    { ...base, main: "foreign.ts" },
    { ...base, workers_dev: true },
    { ...base, vars: { ...base.vars, RUNTIME_CONFIGURATION_STATE: "unconfigured" } },
    { ...base, vars: { ...base.vars, RUNTIME_QA_PREVIEW_MAIL_ENABLED: "unexpected" } },
    { ...base, services: [...base.services, { binding: "QA_MAIL_KEY_AUTHORITY" }] },
    { ...base, services: [...base.services, runtime] },
    { ...base, services: base.services.filter((item) => item !== runtime) },
    { ...base, triggers: { crons: [] } },
  ])
    assert.throws(() => buildQaMailCustodyConfig(bad), /qa_mail_custody_config_invalid/);
});
