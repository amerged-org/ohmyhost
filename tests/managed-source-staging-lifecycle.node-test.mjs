/* global URL */
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStagingLifecycleArgs,
  stagingRule,
  withManagedSourceStagingRule,
} from "../scripts/managed-source-staging-lifecycle.mjs";

test("managed staging expiry preserves unrelated retention and handles exact replay", () => {
  const original = [{ id: "logs", enabled: true, conditions: { prefix: "logs/" } }];
  const merged = withManagedSourceStagingRule(original);
  assert.deepEqual(merged, [...original, stagingRule]);
  assert.equal(original.length, 1);
  assert.equal(withManagedSourceStagingRule(merged), merged);
  assert.equal(stagingRule.conditions.prefix, "managed-staging/");
  assert.equal(stagingRule.deleteObjectsTransition.condition.maxAge, 604800);
});

test("policy conflicts, invalid responses and unapproved environment writes are rejected", async () => {
  assert.deepEqual(parseStagingLifecycleArgs([]), {
    apply: false,
    environment: "development",
    buckets: { us: "ohmyho-builds-development", eu: "ohmyho-builds-development-eu" },
  });
  assert.deepEqual(parseStagingLifecycleArgs(["--apply-development"]), {
    apply: true,
    environment: "development",
    buckets: { us: "ohmyho-builds-development", eu: "ohmyho-builds-development-eu" },
  });
  // Production is a separate, explicitly requested mode whose buckets are the ones the production Worker binds.
  const production = parseStagingLifecycleArgs(["--apply-production"]);
  assert.equal(production.apply, true);
  assert.equal(production.environment, "production");
  const wrangler = await readFile(
    new URL("../apps/source-fetcher/wrangler.production.jsonc", import.meta.url),
    "utf8",
  );
  const bound = (binding) =>
    wrangler.match(new RegExp(`"binding": "${binding}",\\s*"bucket_name": "([^"]+)"`, "u"))?.[1];
  assert.deepEqual(production.buckets, {
    us: bound("MANAGED_SOURCE_STAGING_US"),
    eu: bound("MANAGED_SOURCE_STAGING_EU"),
  });
  for (const args of [
    ["--apply-development", "extra"],
    ["--apply"],
    ["--apply-production", "extra"],
  ])
    assert.throws(() => parseStagingLifecycleArgs(args), /Usage/u);
  for (const rules of [
    null,
    [{}],
    [stagingRule, stagingRule],
    [{ ...stagingRule, enabled: false }],
  ])
    assert.throws(() => withManagedSourceStagingRule(rules));
});
