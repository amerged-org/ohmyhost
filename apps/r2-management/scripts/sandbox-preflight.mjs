import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_ID = "00000000000000000000000000000001";
const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

export function validateSandboxConfiguration(configText) {
  let config;
  try {
    config = JSON.parse(configText.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
  } catch {
    return failure("R2_MANAGEMENT_SANDBOX_CONFIG_INVALID");
  }
  if (
    config?.name !== "ohmyho-r2-management-sandbox" ||
    config?.main !== "src/worker-main.ts" ||
    config?.workers_dev !== false ||
    config?.preview_urls !== false ||
    config?.routes !== undefined ||
    !exactRecord(config?.vars, {
      RUNTIME_CONFIGURATION_STATE: "configured",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    }) ||
    config?.d1_databases !== undefined ||
    !exactServices(config?.services) ||
    configText.includes('"CLOUDFLARE_R2_API_TOKEN":')
  ) {
    return failure("R2_MANAGEMENT_SANDBOX_CONFIG_INVALID");
  }
  return Object.freeze({ ok: true });
}

export async function inspectR2Provider(input) {
  if (
    input?.accountId !== ACCOUNT_ID ||
    !validToken(input?.apiToken) ||
    typeof input?.fetch !== "function"
  ) {
    return failure("R2_MANAGEMENT_SANDBOX_CREDENTIAL_MISSING");
  }
  const result = await readBucketInventory(input.fetch, input.accountId, input.apiToken);
  if (!result.ok) return failure("R2_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY");
  return Object.freeze({ ok: true, bucketCount: result.buckets.length });
}

export async function runSandboxPreflight(input = {}) {
  const configText =
    input.configText ?? (await readFile(resolve(appRoot, "wrangler.sandbox.jsonc"), "utf8"));
  const config = validateSandboxConfiguration(configText);
  if (!config.ok) return config;
  const apiToken = input.apiToken ?? process.env.CLOUDFLARE_R2_API_TOKEN ?? "";
  if (!validToken(apiToken)) return failure("R2_MANAGEMENT_SANDBOX_CREDENTIAL_MISSING");
  const inspect = input.inspect ?? inspectR2Provider;
  return inspect({ accountId: ACCOUNT_ID, apiToken, fetch: input.fetch ?? globalThis.fetch });
}

async function readBucketInventory(fetchImplementation, accountId, apiToken) {
  try {
    const response = await fetchImplementation(
      `${API_ORIGIN}/accounts/${accountId}/r2/buckets?per_page=1`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "cf-r2-jurisdiction": "eu",
        },
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10_000),
      },
    );
    if (!response?.ok) return Object.freeze({ ok: false });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_RESPONSE_BYTES) {
      return Object.freeze({ ok: false });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAXIMUM_RESPONSE_BYTES) return Object.freeze({ ok: false });
    const body = JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !isRecord(body) ||
      body.success !== true ||
      !isRecord(body.result) ||
      !Array.isArray(body.result.buckets) ||
      body.result.buckets.some((bucket) => !isRecord(bucket))
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({ ok: true, buckets: body.result.buckets });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function validToken(value) {
  return typeof value === "string" && value.length >= 20 && !/(?:\s|\p{Cc})/u.test(value);
}

function exactRecord(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("|") === Object.keys(expected).sort().join("|") &&
    Object.entries(expected).every(([key, item]) => value[key] === item)
  );
}

/** Core is reached only through its private service binding, never through a direct database binding. */
function exactServices(value) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    exactRecord(value[0], {
      binding: "R2_MANAGEMENT_RUNTIME",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "R2ManagementRuntime",
    })
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(reasonCode) {
  return Object.freeze({ ok: false, reasonCode });
}

async function main() {
  try {
    const result = await runSandboxPreflight();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reasonCode: "R2_MANAGEMENT_SANDBOX_PREFLIGHT_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
