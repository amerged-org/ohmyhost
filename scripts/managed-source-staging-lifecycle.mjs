/* global URL, fetch, AbortSignal */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

export const stagingRule = Object.freeze({
  id: "expire-managed-source-staging",
  enabled: true,
  conditions: { prefix: "managed-staging/" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } },
});

/** Preserve every unrelated rule, and refuse to silently rewrite an existing staging policy. */
export function withManagedSourceStagingRule(rules) {
  if (!Array.isArray(rules) || rules.some((rule) => !rule || typeof rule.id !== "string"))
    throw new TypeError("R2 lifecycle response is invalid");
  const matching = rules.filter((rule) => rule.id === stagingRule.id);
  if (matching.length > 1 || (matching[0] && !isDeepStrictEqual(matching[0], stagingRule)))
    throw new Error("Existing managed staging policy requires explicit review");
  return matching.length === 1 ? rules : [...rules, stagingRule];
}

/** The staging buckets of each environment: Production's are the ones its SourceFetcher binds. */
export const STAGING_BUCKETS = Object.freeze({
  development: Object.freeze({
    us: "ohmyho-builds-development",
    eu: "ohmyho-builds-development-eu",
  }),
  production: Object.freeze({ us: "ohmyho-builds-production", eu: "ohmyho-builds-production-eu" }),
});

/** Production is applied only when the owner asks for it by name; a plain run reads Development only. */
export function parseStagingLifecycleArgs(args) {
  if (args.length === 0)
    return { apply: false, environment: "development", buckets: STAGING_BUCKETS.development };
  if (
    args.length === 1 &&
    (args[0] === "--apply-development" || args[0] === "--apply-production")
  ) {
    const environment = args[0] === "--apply-production" ? "production" : "development";
    return { apply: true, environment, buckets: STAGING_BUCKETS[environment] };
  }
  throw new Error(
    "Usage: managed-source-staging-lifecycle [--apply-development|--apply-production]",
  );
}

async function main() {
  const { apply, environment, buckets } = parseStagingLifecycleArgs(process.argv.slice(2));
  const values = new Map();
  for (const line of (await readFile(new URL("../.env.local", import.meta.url), "utf8")).split(
    /\r?\n/u,
  )) {
    if (line.trimStart().startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    values.set(
      line.slice(0, at).trim(),
      line
        .slice(at + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/u, "$2"),
    );
  }
  const credential = values.get("CLOUDFLARE_API_TOKEN_ADMIN");
  if (!credential) throw new Error("Staging lifecycle credential is unavailable");
  const accountId = "00000000000000000000000000000001";
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const api = async (path, region, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "PUT",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        ...(region === undefined ? {} : { "cf-r2-jurisdiction": region }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const envelope = await response.json();
    if (!response.ok || envelope.success !== true)
      throw new Error(`Staging lifecycle provider request failed (${response.status})`);
    return envelope.result;
  };
  const account = await api("");
  if (account.id !== accountId || account.name !== "amerged")
    throw new Error("Staging lifecycle account mismatch");
  const receipts = [];
  for (const region of ["us", "eu"]) {
    const bucket = buckets[region];
    const path = `/r2/buckets/${bucket}/lifecycle`;
    const before = await api(path, region);
    const rules = withManagedSourceStagingRule(before.rules);
    if (apply && !isDeepStrictEqual(rules, before.rules)) await api(path, region, { rules });
    const after = apply ? await api(path, region) : before;
    if (apply && !isDeepStrictEqual(after.rules, rules))
      throw new Error("Staging lifecycle readback differs from the reviewed rules");
    receipts.push({
      region,
      bucket,
      existingRules: before.rules,
      resultingRules: rules,
      applied: apply,
    });
  }
  const receipt = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    accountId,
    environment,
    uploadRetentionSeconds: stagingRule.deleteObjectsTransition.condition.maxAge,
    prefix: stagingRule.conditions.prefix,
    rules: receipts,
  };
  if (apply)
    await writeFile(
      new URL(
        environment === "development"
          ? "../docs/plan/evidence/P39/staging-lifecycle-20261006.json"
          : `../docs/plan/evidence/P39/staging-lifecycle-${environment}-${receipt.observedAt.slice(0, 10).replaceAll("-", "")}.json`,
        import.meta.url,
      ),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx" },
    );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
