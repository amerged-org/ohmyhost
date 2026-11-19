import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_ID = "00000000000000000000000000000001";
const NAMESPACE_ID = "5866f088-54b4-4fc8-8c85-c8fc40ea2553";
const NAMESPACE_NAME = "ohmyho-sandbox";
const BUILD_OBJECTS_BUCKET = "ohmyho-builds-development";
const TOMBSTONE_SCRIPT_ID = "p-01arz3ndektsv4rrffq69g5faw";
const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

export function validateSandboxConfiguration(configText) {
  let config;
  try {
    config = JSON.parse(configText.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
  } catch {
    return failure("WFP_MANAGEMENT_SANDBOX_CONFIG_INVALID");
  }
  if (
    config?.name !== "ohmyho-wfp-management-sandbox" ||
    config?.account_id !== ACCOUNT_ID ||
    config?.main !== "src/worker-main.ts" ||
    config?.workers_dev !== false ||
    config?.preview_urls !== false ||
    config?.routes !== undefined ||
    !exactRecord(config?.vars, {
      WFP_ACCOUNT_ID: ACCOUNT_ID,
      WFP_DISPATCH_NAMESPACE: NAMESPACE_NAME,
      DATABASE_SERVICE_US: "ohmyho-project-database-sandbox-us",
      DATABASE_SERVICE_EU: "ohmyho-project-database-sandbox-eu",
      NATIVE_AUTH_SERVICE_US: "ohmyho-native-auth-development-us",
      NATIVE_AUTH_SERVICE_EU: "ohmyho-native-auth-development-eu",
      WFP_WORKERS_DEV_SUBDOMAIN: "your-omh-account",
      BUILD_OBJECTS_BUCKET_US: BUILD_OBJECTS_BUCKET,
      BUILD_OBJECTS_BUCKET_EU: `${BUILD_OBJECTS_BUCKET}-eu`,
    }) ||
    !exactRecordArray(config?.r2_buckets, [
      { binding: "BUILD_OBJECTS_US", bucket_name: BUILD_OBJECTS_BUCKET, jurisdiction: "us" },
      {
        binding: "BUILD_OBJECTS_EU",
        bucket_name: `${BUILD_OBJECTS_BUCKET}-eu`,
        jurisdiction: "eu",
      },
    ]) ||
    !exactRecordArray(config?.services, [
      {
        binding: "NATIVE_AUTH_REGISTRY_AUTHORITY",
        service: "ohmyho-control-store-disabled",
        entrypoint: "NativeAuthRegistryAuthorityRuntime",
      },
      {
        binding: "RUNTIME_SECRET_AUTHORITY",
        service: "ohmyho-control-store-disabled",
        entrypoint: "RuntimeSecretAuthorityRuntime",
      },
      {
        binding: "GATEWAY_REGISTRY",
        service: "ohmyho-control-api-sandbox",
        entrypoint: "GatewayRoutingManagementService",
      },
      {
        binding: "RUNTIME_PROBES",
        service: "ohmyho-control-api-sandbox",
        entrypoint: "RuntimeCreditService",
      },
    ])
  ) {
    return failure("WFP_MANAGEMENT_SANDBOX_CONFIG_INVALID");
  }
  return Object.freeze({ ok: true });
}

export async function inspectWfpSandbox(input) {
  if (!nonEmptyString(input?.apiToken) || typeof input?.fetch !== "function") {
    return failure("WFP_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY");
  }
  const accountPath = `${API_ORIGIN}/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces`;
  const namespaces = await readProviderJson(input.fetch, accountPath, input.apiToken);
  if (!namespaces.ok || !Array.isArray(namespaces.result)) {
    return failure("WFP_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY");
  }
  const namespace = namespaces.result.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.namespace_id === NAMESPACE_ID &&
      candidate.namespace_name === NAMESPACE_NAME,
  );
  if (
    !isRecord(namespace) ||
    !Number.isSafeInteger(namespace.script_count) ||
    (namespace.script_count !== 0 && namespace.script_count !== 1)
  ) {
    return failure("WFP_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY");
  }
  const scripts = await readProviderJson(
    input.fetch,
    `${accountPath}/${NAMESPACE_NAME}/scripts`,
    input.apiToken,
  );
  if (
    !scripts.ok ||
    !Array.isArray(scripts.result) ||
    scripts.result.length !== namespace.script_count
  ) {
    return failure("WFP_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY");
  }
  if (scripts.result.length === 0) {
    return Object.freeze({
      ok: true,
      namespaceId: NAMESPACE_ID,
      tombstone: null,
      dispatchSamples: 0,
    });
  }
  const tombstone = scripts.result[0];
  if (
    !isRecord(tombstone) ||
    tombstone.id !== TOMBSTONE_SCRIPT_ID ||
    typeof tombstone.tag !== "string" ||
    !/^[0-9a-f]{32}$/u.test(tombstone.tag)
  ) {
    return failure("WFP_MANAGEMENT_SANDBOX_PROVIDER_NOT_READY");
  }
  const gatewayOrigin = parseGatewayOrigin(input.gatewayOrigin);
  if (gatewayOrigin === null) {
    return failure("WFP_MANAGEMENT_SANDBOX_GATEWAY_ORIGIN_MISSING");
  }
  for (let sample = 1; sample <= 3; sample += 1) {
    try {
      const response = await input.fetch(`${gatewayOrigin}/?preflight=${sample}`, {
        headers: { "cache-control": "no-store" },
        method: "GET",
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      if (response?.status !== 404) {
        return failure("WFP_MANAGEMENT_SANDBOX_TOMBSTONE_ROUTE_UNSAFE");
      }
    } catch {
      return failure("WFP_MANAGEMENT_SANDBOX_TOMBSTONE_ROUTE_UNSAFE");
    }
  }
  return Object.freeze({
    ok: true,
    namespaceId: NAMESPACE_ID,
    tombstone: Object.freeze({
      scriptId: TOMBSTONE_SCRIPT_ID,
      providerTag: tombstone.tag,
    }),
    dispatchSamples: 3,
  });
}

export async function runSandboxPreflight(input = {}) {
  const configText =
    input.configText ?? (await readFile(resolve(appRoot, "wrangler.sandbox.jsonc"), "utf8"));
  const configResult = validateSandboxConfiguration(configText);
  if (!configResult.ok) return configResult;
  const apiToken = input.apiToken ?? process.env.WFP_API_TOKEN ?? "";
  if (!nonEmptyString(apiToken)) {
    return failure("WFP_MANAGEMENT_SANDBOX_CREDENTIAL_MISSING");
  }
  const inspect = input.inspect ?? inspectWfpSandbox;
  return inspect({
    apiToken,
    gatewayOrigin: input.gatewayOrigin ?? process.env.WFP_PREFLIGHT_GATEWAY_ORIGIN ?? "",
    fetch: input.fetch ?? globalThis.fetch,
  });
}

function parseGatewayOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

async function readProviderJson(fetchImplementation, url, apiToken) {
  try {
    const response = await fetchImplementation(url, {
      headers: { authorization: `Bearer ${apiToken}` },
      method: "GET",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response?.ok) return failure("provider_not_ready");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_RESPONSE_BYTES) {
      return failure("provider_not_ready");
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAXIMUM_RESPONSE_BYTES) return failure("provider_not_ready");
    const parsed = JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!isRecord(parsed) || parsed.success !== true || !("result" in parsed)) {
      return failure("provider_not_ready");
    }
    return Object.freeze({ ok: true, result: parsed.result });
  } catch {
    return failure("provider_not_ready");
  }
}

function exactRecord(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("|") === Object.keys(expected).sort().join("|") &&
    Object.entries(expected).every(([name, item]) => value[name] === item)
  );
}

function exactRecordArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => exactRecord(item, expected[index]))
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
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
      `${JSON.stringify({ ok: false, reasonCode: "WFP_MANAGEMENT_SANDBOX_PREFLIGHT_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
