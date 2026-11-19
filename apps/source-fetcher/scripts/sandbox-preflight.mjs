import { Buffer } from "node:buffer";
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_ACCOUNT_ID = "00000000000000000000000000000001";
const EXPECTED_APP_CLIENT_ID = "Iv23Example000000001";
const EXPECTED_OWNER = "aixyte";
const EXPECTED_REPOSITORY = "ohmyho.st";
const INSTALLATION_URL = "https://api.github.com/repos/aixyte/ohmyho.st/installation";
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_PRIVATE_KEY_BYTES = 32 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function normalizeGithubPrivateKeyBase64(value) {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > Math.ceil(MAXIMUM_PRIVATE_KEY_BYTES / 3) * 4 ||
      !BASE64_PATTERN.test(value)
    ) {
      throw new Error("invalid");
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0 || decoded.length > MAXIMUM_PRIVATE_KEY_BYTES) {
      throw new Error("invalid");
    }
    const pem = decoded.subarray(0, 11).toString("ascii") === "-----BEGIN ";
    const privateKey = pem
      ? createPrivateKey({ key: decoded, format: "pem" })
      : createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
    const modulusLength = privateKey.asymmetricKeyDetails?.modulusLength;
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "rsa" ||
      typeof modulusLength !== "number" ||
      modulusLength < 2048 ||
      modulusLength > 8192
    ) {
      throw new Error("invalid");
    }
    return Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64");
  } catch {
    throw new Error("SOURCE_FETCHER_SANDBOX_CREDENTIAL_FORMAT_INVALID");
  }
}

export function validateSandboxConfiguration(configText) {
  let config;
  try {
    config = JSON.parse(configText.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
  } catch {
    return failure("SOURCE_FETCHER_SANDBOX_CONFIG_INVALID");
  }
  const variables = config?.vars;
  const services = config?.services;
  const expectedVariableNames = [
    "BINDING_REQUEST_TIMEOUT_MS",
    "BUILD_OBJECTS_BUCKET_EU",
    "BUILD_OBJECTS_BUCKET_US",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_OAUTH_REDIRECT_URI",
    "GITHUB_USER_AGENT",
    "PROVIDER_REQUEST_TIMEOUT_MS",
    "SOURCE_ARCHIVE_MAX_BYTES",
    "SOURCE_FETCH_TIMEOUT_MS",
  ];
  if (
    config?.name !== "ohmyho-source-fetcher-sandbox" ||
    config?.account_id !== EXPECTED_ACCOUNT_ID ||
    config?.main !== "src/worker-main.ts" ||
    config?.workers_dev !== false ||
    config?.preview_urls !== false ||
    config?.routes !== undefined ||
    !isRecord(variables) ||
    Object.keys(variables).sort().join("|") !== expectedVariableNames.join("|") ||
    variables.BUILD_OBJECTS_BUCKET_US !== "ohmyho-builds-development" ||
    variables.BUILD_OBJECTS_BUCKET_EU !== "ohmyho-builds-development-eu" ||
    variables.GITHUB_APP_CLIENT_ID !== EXPECTED_APP_CLIENT_ID ||
    variables.GITHUB_APP_SLUG !== "example-omh-development" ||
    variables.GITHUB_OAUTH_REDIRECT_URI !== "https://dev.app.ohmyho.st/v1/github/oauth/callback" ||
    !Array.isArray(services) ||
    services.length !== 1 ||
    !exactRecord(services[0], {
      binding: "BUILD_RUNNER",
      service: "ohmyho-build-runner-sandbox",
      entrypoint: "BuildRunnerService",
    })
  ) {
    return failure("SOURCE_FETCHER_SANDBOX_CONFIG_INVALID");
  }
  return Object.freeze({ ok: true, appClientId: EXPECTED_APP_CLIENT_ID });
}

export async function inspectGithubFixtureInstallation(input) {
  if (!nonEmptyString(input?.appJwt) || typeof input?.fetch !== "function") {
    return failure("SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY");
  }
  try {
    const response = await input.fetch(INSTALLATION_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.appJwt}`,
        "user-agent": "ohmyho-source-fetcher/sandbox-preflight",
        "x-github-api-version": "2022-11-28",
      },
      method: "GET",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10_000),
    });
    if (!response?.ok) return failure("SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_RESPONSE_BYTES) {
      return failure("SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY");
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAXIMUM_RESPONSE_BYTES) {
      return failure("SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY");
    }
    const parsed = JSON.parse(new globalThis.TextDecoder("utf-8", { fatal: true }).decode(body));
    const permissions = parsed?.permissions;
    if (
      !Number.isSafeInteger(parsed?.id) ||
      parsed.id < 1 ||
      parsed?.account?.login !== EXPECTED_OWNER ||
      (parsed?.repository_selection !== "selected" && parsed?.repository_selection !== "all") ||
      !isRecord(permissions) ||
      Object.keys(permissions).sort().join("|") !== "contents|metadata" ||
      permissions.contents !== "read" ||
      permissions.metadata !== "read"
    ) {
      return failure("SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY");
    }
    return Object.freeze({
      ok: true,
      installationId: parsed.id,
      repository: `${EXPECTED_OWNER}/${EXPECTED_REPOSITORY}`,
      permissions: Object.freeze(["contents:read", "metadata:read"]),
    });
  } catch {
    return failure("SOURCE_FETCHER_SANDBOX_INSTALLATION_NOT_READY");
  }
}

export async function runSandboxPreflight(input = {}) {
  const configText =
    input.configText ?? (await readFile(resolve(appRoot, "wrangler.sandbox.jsonc"), "utf8"));
  const configResult = validateSandboxConfiguration(configText);
  if (!configResult.ok) return configResult;
  const privateKeyBase64 =
    input.privateKeyBase64 ?? process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ?? "";
  if (!nonEmptyString(privateKeyBase64)) {
    return failure("SOURCE_FETCHER_SANDBOX_CREDENTIAL_MISSING");
  }
  const issueAppJwt = input.issueAppJwt ?? defaultIssueAppJwt;
  const inspectInstallation = input.inspectInstallation ?? inspectGithubFixtureInstallation;
  const normalizePrivateKey = input.normalizePrivateKey ?? normalizeGithubPrivateKeyBase64;
  let normalizedPrivateKeyBase64;
  try {
    normalizedPrivateKeyBase64 = normalizePrivateKey(privateKeyBase64);
  } catch {
    return failure("SOURCE_FETCHER_SANDBOX_CREDENTIAL_FORMAT_INVALID");
  }
  try {
    const appJwt = await issueAppJwt({
      clientId: configResult.appClientId,
      privateKeyBase64: normalizedPrivateKeyBase64,
    });
    return inspectInstallation({ appJwt, fetch: input.fetch ?? globalThis.fetch });
  } catch {
    return failure("SOURCE_FETCHER_SANDBOX_PREFLIGHT_FAILED");
  }
}

async function defaultIssueAppJwt(input) {
  const { createBase64GithubAppJwtIssuer } = await import("../dist/github-app-signer.js");
  return createBase64GithubAppJwtIssuer(input).issue(new Date());
}

function exactRecord(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("|") === Object.keys(expected).sort().join("|") &&
    Object.entries(expected).every(([name, item]) => value[name] === item)
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
      `${JSON.stringify({ ok: false, reasonCode: "SOURCE_FETCHER_SANDBOX_PREFLIGHT_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
