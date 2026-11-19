/* global URL, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseJsonc } from "../../platform-release.mjs";
import { buildQaNativeRuntimeConfig } from "./native-config.mjs";

test("temporary Native preview overlay preserves the complete Development profile and rejects other targets", async () => {
  const base = parseJsonc(
    await readFile(
      new URL("../../../apps/native-auth-runtime/wrangler.development.eu.jsonc", import.meta.url),
      "utf8",
    ),
  );
  const original = structuredClone(base);
  const overlay = buildQaNativeRuntimeConfig(base);
  assert.deepEqual(base, original);
  assert.equal(overlay.name, base.name);
  assert.equal(overlay.vars.NATIVE_AUTH_QA_PREVIEW_ENABLED, "development-only-v1");
  assert.deepEqual(overlay.services.slice(0, base.services.length), base.services);
  assert.deepEqual(overlay.services.slice(base.services.length), [
    {
      binding: "NATIVE_AUTH_PREVIEW_AUTHORITY",
      service: "ohmyho-preview-spike-auth-development",
      entrypoint: "QaStablePreviewAuthority",
    },
    {
      binding: "NATIVE_AUTH_PREVIEW_MAIL",
      service: "ohmyho-mail-gateway-poc-private-fullstack",
      entrypoint: "NativePreviewAuthMailService",
    },
  ]);
  for (const bad of [
    { ...base, name: "ohmyho-native-auth-production-eu" },
    { ...base, account_id: "0".repeat(32) },
    { ...base, vars: { ...base.vars, NATIVE_AUTH_REGION_ID: "us-dev" } },
    { ...base, vars: { ...base.vars, NATIVE_AUTH_QA_PREVIEW_ENABLED: "unexpected" } },
    { ...base, services: [...base.services, { binding: "NATIVE_AUTH_PREVIEW_MAIL" }] },
  ])
    assert.throws(() => buildQaNativeRuntimeConfig(bad), /qa_native_config_invalid/);
});
