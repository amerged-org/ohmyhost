import {
  classifyGithubResponse,
  GithubProviderAuthenticationError,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderRateLimitError,
  GithubProviderTransportError,
  GithubProviderUncertainError,
} from "./errors.js";
import { readBoundedProviderJson } from "./provider-json.js";
import { StreamingSha256 } from "./sha256.js";
import type { GitHubAppJwtIssuer, GitHubProviderClock } from "./source-provider.js";
import { isRecord, requireBoundedString, requireSafePositiveInteger } from "./validation.js";

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_API_ORIGIN = "https://api.github.com";
const MAXIMUM_RESPONSE_BYTES = 64 * 1_024;
const MAXIMUM_WEBHOOK_URL_LENGTH = 2_048;
const MINIMUM_REQUEST_TIMEOUT_MS = 100;
const MAXIMUM_REQUEST_TIMEOUT_MS = 30_000;
const WEBHOOK_PATH = "/webhooks/github";
const MASKED_SECRET = "********";
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;

export interface GitHubAppIdentity {
  readonly id: number;
  readonly clientId: string;
  readonly slug: string;
}

export interface GitHubWebhookUrlReceipt {
  readonly origin: string;
  readonly path: string;
  readonly sha256: string;
}

export interface GitHubAppWebhookConfigurationReceipt {
  readonly schemaVersion: "github.app-webhook-configuration.v1";
  readonly scope: "configuration_only";
  readonly deliveryVerification: "not_evaluated";
  readonly app: GitHubAppIdentity;
  readonly changed: boolean;
  readonly previous: GitHubWebhookUrlReceipt;
  readonly current: GitHubWebhookUrlReceipt;
  readonly observedAt: string;
}

export interface EnsureGitHubAppWebhookConfigurationInput {
  readonly expectedApp: GitHubAppIdentity;
  readonly targetUrl: string;
}

export interface GitHubAppWebhookConfigurationProvider {
  observe(
    input: EnsureGitHubAppWebhookConfigurationInput,
  ): Promise<GitHubAppWebhookConfigurationReceipt>;
  ensure(
    input: EnsureGitHubAppWebhookConfigurationInput,
  ): Promise<GitHubAppWebhookConfigurationReceipt>;
}

export interface CreateGitHubAppWebhookConfigurationProviderInput {
  readonly appJwtIssuer: GitHubAppJwtIssuer;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: GitHubProviderClock;
  readonly userAgent: string;
  readonly requestTimeoutMs: number;
}

interface SafeWebhookConfiguration {
  readonly url: string;
  readonly receipt: GitHubWebhookUrlReceipt;
}

function validateFactoryInput(input: CreateGitHubAppWebhookConfigurationProviderInput): void {
  requireBoundedString(input.userAgent, 256, "invalid_user_agent");
  if (
    !Number.isSafeInteger(input.requestTimeoutMs) ||
    input.requestTimeoutMs < MINIMUM_REQUEST_TIMEOUT_MS ||
    input.requestTimeoutMs > MAXIMUM_REQUEST_TIMEOUT_MS
  ) {
    throw new GithubProviderInputError("invalid_webhook_configuration_timeout");
  }
}

function validateAppIdentity(identity: GitHubAppIdentity): GitHubAppIdentity {
  const id = requireSafePositiveInteger(identity.id, "invalid_app_client_id");
  const clientId = requireBoundedString(identity.clientId, 255, "invalid_app_client_id");
  const slug = requireBoundedString(identity.slug, 100, "invalid_app_client_id");
  if (!/^[A-Za-z0-9._-]+$/u.test(clientId) || !APP_SLUG_PATTERN.test(slug)) {
    throw new GithubProviderInputError("invalid_app_client_id");
  }
  return Object.freeze({ id, clientId, slug });
}

function parseWebhookUrl(value: unknown, input: boolean): URL {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_WEBHOOK_URL_LENGTH
  ) {
    if (input) throw new GithubProviderInputError("invalid_webhook_payload");
    throw new GithubProviderContractError();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    if (input) throw new GithubProviderInputError("invalid_webhook_payload");
    throw new GithubProviderContractError();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.pathname !== WEBHOOK_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== value
  ) {
    if (input) throw new GithubProviderInputError("invalid_webhook_payload");
    throw new GithubProviderContractError();
  }
  return url;
}

function webhookUrlReceipt(url: URL): GitHubWebhookUrlReceipt {
  const digest = new StreamingSha256();
  digest.update(new TextEncoder().encode(url.href));
  return Object.freeze({
    origin: url.origin,
    path: url.pathname,
    sha256: digest.digestHex(),
  });
}

function validateAppResponse(value: unknown, expected: GitHubAppIdentity): void {
  if (
    !isRecord(value) ||
    value["id"] !== expected.id ||
    value["client_id"] !== expected.clientId ||
    value["slug"] !== expected.slug ||
    !Array.isArray(value["events"]) ||
    value["events"].length !== 1 ||
    value["events"][0] !== "push" ||
    !isRecord(value["permissions"]) ||
    value["permissions"]["contents"] !== "read" ||
    value["permissions"]["metadata"] !== "read" ||
    Object.keys(value["permissions"]).length !== 2
  ) {
    throw new GithubProviderContractError();
  }
  for (const [permission, access] of Object.entries(value["permissions"])) {
    if ((permission !== "contents" && permission !== "metadata") || access !== "read") {
      throw new GithubProviderContractError();
    }
  }
}

function validateWebhookConfiguration(value: unknown): SafeWebhookConfiguration {
  if (
    !isRecord(value) ||
    value["content_type"] !== "json" ||
    (value["insecure_ssl"] !== "0" && value["insecure_ssl"] !== 0) ||
    value["secret"] !== MASKED_SECRET
  ) {
    throw new GithubProviderContractError();
  }
  const url = parseWebhookUrl(value["url"], false);
  return Object.freeze({ url: url.href, receipt: webhookUrlReceipt(url) });
}

function isKnownProviderError(error: unknown): boolean {
  return (
    error instanceof GithubProviderInputError ||
    error instanceof GithubProviderAuthenticationError ||
    error instanceof GithubProviderRateLimitError ||
    error instanceof GithubProviderContractError ||
    error instanceof GithubProviderTransportError ||
    error instanceof GithubProviderUncertainError
  );
}

function assertClock(clock: GitHubProviderClock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new GithubProviderInputError("invalid_clock");
  }
  return now;
}

async function issueAppJwt(issuer: GitHubAppJwtIssuer, now: Date): Promise<string> {
  try {
    return requireBoundedString(await issuer.issue(now), 16_384, "invalid_installation_token");
  } catch (error) {
    if (isKnownProviderError(error)) throw error;
    throw new GithubProviderAuthenticationError();
  }
}

async function request(
  dependencies: CreateGitHubAppWebhookConfigurationProviderInput,
  now: Date,
  path: "/app" | "/app/hook/config",
  init: Readonly<{ method: "GET" }> | Readonly<{ method: "PATCH"; body: string }>,
): Promise<Response> {
  const appJwt = await issueAppJwt(dependencies.appJwtIssuer, now);
  const signal = AbortSignal.timeout(dependencies.requestTimeoutMs);
  try {
    return await dependencies.fetch(`${GITHUB_API_ORIGIN}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJwt}`,
        ...(init.method === "PATCH" ? { "Content-Type": "application/json" } : {}),
        "User-Agent": dependencies.userAgent,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal,
    });
  } catch {
    throw new GithubProviderTransportError(
      signal.aborted ? "github_request_timeout" : "github_request_failed",
    );
  }
}

async function observeApp(
  dependencies: CreateGitHubAppWebhookConfigurationProviderInput,
  now: Date,
  expected: GitHubAppIdentity,
): Promise<void> {
  const response = await request(dependencies, now, "/app", { method: "GET" });
  if (response.status !== 200) classifyGithubResponse(response, false);
  validateAppResponse(await readBoundedProviderJson(response, MAXIMUM_RESPONSE_BYTES), expected);
}

async function observeWebhookConfiguration(
  dependencies: CreateGitHubAppWebhookConfigurationProviderInput,
  now: Date,
): Promise<SafeWebhookConfiguration> {
  const response = await request(dependencies, now, "/app/hook/config", { method: "GET" });
  if (response.status !== 200) classifyGithubResponse(response, false);
  return validateWebhookConfiguration(
    await readBoundedProviderJson(response, MAXIMUM_RESPONSE_BYTES),
  );
}

async function patchWebhookUrl(
  dependencies: CreateGitHubAppWebhookConfigurationProviderInput,
  now: Date,
  targetUrl: string,
): Promise<void> {
  const response = await request(dependencies, now, "/app/hook/config", {
    method: "PATCH",
    body: JSON.stringify({ url: targetUrl }),
  });
  if (response.status !== 200) classifyGithubResponse(response, true);
  let patched: SafeWebhookConfiguration;
  try {
    patched = validateWebhookConfiguration(
      await readBoundedProviderJson(response, MAXIMUM_RESPONSE_BYTES),
    );
  } catch {
    throw new GithubProviderUncertainError();
  }
  if (patched.url !== targetUrl) throw new GithubProviderUncertainError();
}

function receipt(
  app: GitHubAppIdentity,
  previous: GitHubWebhookUrlReceipt,
  current: GitHubWebhookUrlReceipt,
  changed: boolean,
  observedAt: string,
): GitHubAppWebhookConfigurationReceipt {
  return Object.freeze({
    schemaVersion: "github.app-webhook-configuration.v1" as const,
    scope: "configuration_only" as const,
    deliveryVerification: "not_evaluated" as const,
    app,
    changed,
    previous,
    current,
    observedAt,
  });
}

export function createGitHubAppWebhookConfigurationProvider(
  dependencies: CreateGitHubAppWebhookConfigurationProviderInput,
): GitHubAppWebhookConfigurationProvider {
  validateFactoryInput(dependencies);
  return Object.freeze({
    async observe(
      input: EnsureGitHubAppWebhookConfigurationInput,
    ): Promise<GitHubAppWebhookConfigurationReceipt> {
      const now = assertClock(dependencies.clock);
      const expectedApp = validateAppIdentity(input.expectedApp);
      const targetUrl = parseWebhookUrl(input.targetUrl, true).href;
      await observeApp(dependencies, now, expectedApp);
      const current = await observeWebhookConfiguration(dependencies, now);
      if (current.url !== targetUrl) throw new GithubProviderContractError();
      return receipt(expectedApp, current.receipt, current.receipt, false, now.toISOString());
    },
    async ensure(
      input: EnsureGitHubAppWebhookConfigurationInput,
    ): Promise<GitHubAppWebhookConfigurationReceipt> {
      const now = assertClock(dependencies.clock);
      const expectedApp = validateAppIdentity(input.expectedApp);
      const targetUrl = parseWebhookUrl(input.targetUrl, true).href;
      await observeApp(dependencies, now, expectedApp);
      const previous = await observeWebhookConfiguration(dependencies, now);
      if (previous.url === targetUrl) {
        return receipt(expectedApp, previous.receipt, previous.receipt, false, now.toISOString());
      }

      try {
        await patchWebhookUrl(dependencies, now, targetUrl);
      } catch (error) {
        if (
          error instanceof GithubProviderAuthenticationError ||
          error instanceof GithubProviderRateLimitError ||
          error instanceof GithubProviderContractError ||
          error instanceof GithubProviderInputError
        ) {
          throw error;
        }
      }

      try {
        const current = await observeWebhookConfiguration(dependencies, now);
        if (current.url !== targetUrl) throw new GithubProviderUncertainError();
        return receipt(expectedApp, previous.receipt, current.receipt, true, now.toISOString());
      } catch {
        throw new GithubProviderUncertainError();
      }
    },
  });
}
