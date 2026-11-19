import { GithubProviderAuthenticationError, GithubProviderInputError } from "./errors.js";
import {
  isLowercaseNonzeroSha,
  isRecord,
  requireBoundedString,
  requireSafePositiveInteger,
} from "./validation.js";

const FULL_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const ZERO_SHA = "0".repeat(40);

export interface VerifyGitHubWebhookSignatureInput {
  readonly body: Uint8Array;
  readonly signatureHeader: string;
  readonly secret: Uint8Array;
  readonly additionalSecrets?: readonly Uint8Array[];
  readonly maxBodyBytes: number;
  readonly crypto?: SubtleCrypto;
}

export interface ParseGitHubPushWebhookInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly body: Uint8Array;
}

export interface GitHubPushTrigger {
  readonly schemaVersion: "github.push.v1";
  readonly deliveryId: string;
  readonly eventName: "push";
  readonly installationId: number;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly ref: string;
  readonly deleted: boolean;
  readonly beforeCommitSha: string | null;
  readonly commitSha?: string;
}

function decodeSignature(value: string): Uint8Array {
  if (!/^sha256=[0-9a-f]{64}$/u.test(value)) {
    throw new GithubProviderAuthenticationError("invalid_webhook_signature");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(7 + index * 2, 9 + index * 2), 16);
  }
  return bytes;
}

async function verifyRawGitHubWebhookSignature(
  input: VerifyGitHubWebhookSignatureInput,
): Promise<Uint8Array> {
  if (!(input.body instanceof Uint8Array))
    throw new GithubProviderInputError("invalid_webhook_body");
  if (!Number.isSafeInteger(input.maxBodyBytes) || input.maxBodyBytes <= 0) {
    throw new GithubProviderInputError("invalid_archive_limit");
  }
  if (input.body.byteLength > input.maxBodyBytes) {
    throw new GithubProviderInputError("webhook_body_too_large");
  }
  if (!(input.secret instanceof Uint8Array) || input.secret.byteLength === 0) {
    throw new GithubProviderInputError("invalid_webhook_secret");
  }
  const additional = input.additionalSecrets;
  const additionalSecret = additional?.length === 1 ? additional[0] : undefined;
  if (
    additional !== undefined &&
    (!Array.isArray(additional) ||
      additional.length > 1 ||
      (additional.length === 1 &&
        (!(additionalSecret instanceof Uint8Array) || additionalSecret.byteLength === 0)))
  ) {
    throw new GithubProviderInputError("invalid_webhook_secret");
  }
  const signature = decodeSignature(input.signatureHeader);
  const subtle = input.crypto ?? globalThis.crypto.subtle;
  try {
    const body = Uint8Array.from(input.body);
    const secrets = [Uint8Array.from(input.secret)];
    if (additionalSecret !== undefined) secrets.push(Uint8Array.from(additionalSecret));
    let valid = false;
    for (const secret of secrets) {
      const key = await subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
        "verify",
      ]);
      const verified = await subtle.verify("HMAC", key, Uint8Array.from(signature), body);
      valid = verified || valid;
    }
    if (!valid) throw new GithubProviderAuthenticationError("invalid_webhook_signature");
    return body;
  } catch {
    throw new GithubProviderAuthenticationError("invalid_webhook_signature");
  }
}

export async function verifyGitHubWebhookSignature(
  input: VerifyGitHubWebhookSignatureInput,
): Promise<void> {
  await verifyRawGitHubWebhookSignature(input);
}

function repositoryFullName(repository: Record<string, unknown>): string {
  const fullName = repository["full_name"];
  const owner = repository["owner"];
  const name = repository["name"];
  let derived: string | undefined;
  if (isRecord(owner) && typeof owner["login"] === "string" && typeof name === "string") {
    derived = `${owner["login"]}/${name}`;
  }
  const selected = typeof fullName === "string" ? fullName : derived;
  if (
    selected === undefined ||
    !FULL_NAME_PATTERN.test(selected) ||
    (typeof fullName === "string" && derived !== undefined && fullName !== derived)
  ) {
    throw new GithubProviderInputError("invalid_repository_name");
  }
  return selected;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

export function parseGitHubPushWebhook(
  input: ParseGitHubPushWebhookInput,
): Readonly<GitHubPushTrigger> {
  const deliveryId = requireBoundedString(input.deliveryId, 128, "invalid_webhook_delivery_id");
  if (input.eventName !== "push") throw new GithubProviderInputError("invalid_webhook_event");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    throw new GithubProviderInputError("invalid_webhook_payload");
  }
  if (!isRecord(value) || !isRecord(value["installation"]) || !isRecord(value["repository"])) {
    throw new GithubProviderInputError("invalid_webhook_payload");
  }
  const installationId = requireSafePositiveInteger(
    value["installation"]["id"],
    "invalid_installation_id",
  );
  const repositoryId = requireSafePositiveInteger(
    value["repository"]["id"],
    "invalid_repository_id",
  );
  const fullName = repositoryFullName(value["repository"]);
  const ref = value["ref"];
  const deleted = value["deleted"];
  const before = value["before"];
  const after = value["after"];
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 1_024 ||
    !ref.startsWith("refs/") ||
    containsControlCharacter(ref) ||
    typeof deleted !== "boolean"
  ) {
    throw new GithubProviderInputError("invalid_webhook_payload");
  }
  const validBefore = before === ZERO_SHA || isLowercaseNonzeroSha(before);
  if (
    !validBefore ||
    (deleted && (after !== ZERO_SHA || !isLowercaseNonzeroSha(before))) ||
    (!deleted && !isLowercaseNonzeroSha(after))
  ) {
    throw new GithubProviderInputError("invalid_webhook_payload");
  }
  return Object.freeze({
    schemaVersion: "github.push.v1" as const,
    deliveryId,
    eventName: "push" as const,
    installationId,
    repositoryId,
    repositoryFullName: fullName,
    ref,
    deleted,
    beforeCommitSha: before === ZERO_SHA ? null : before,
    ...(!deleted && typeof after === "string" ? { commitSha: after } : {}),
  });
}

export interface GitHubInstallationTrigger {
  readonly schemaVersion: "github.installation.v1";
  readonly eventName: "installation" | "installation_repositories";
  /** The events that withdraw access: an uninstall, a suspension, or repositories removed from the installation. */
  readonly action: "deleted" | "suspended" | "repositories_removed";
  readonly installationId: number;
  readonly removedRepositoryIds: readonly number[];
}

/**
 * Reads an authenticated installation event. Only the ids of the withdrawing events are kept; every other action
 * (created, unsuspend, added, ...) returns null and grants nothing. Sender and account details are never kept.
 */
export function parseGitHubInstallationWebhook(input: {
  readonly eventName: string;
  readonly body: Uint8Array;
}): Readonly<GitHubInstallationTrigger> | null {
  if (input.eventName !== "installation" && input.eventName !== "installation_repositories")
    throw new GithubProviderInputError("invalid_webhook_event");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    throw new GithubProviderInputError("invalid_webhook_payload");
  }
  if (!isRecord(value) || !isRecord(value["installation"])) {
    throw new GithubProviderInputError("invalid_webhook_payload");
  }
  const action = value["action"];
  const installationId = requireSafePositiveInteger(
    value["installation"]["id"],
    "invalid_installation_id",
  );
  const base = { schemaVersion: "github.installation.v1" as const, installationId };
  if (input.eventName === "installation" && action === "deleted") {
    return Object.freeze({
      ...base,
      eventName: "installation",
      action: "deleted",
      removedRepositoryIds: [],
    });
  }
  if (input.eventName === "installation" && action === "suspend") {
    return Object.freeze({
      ...base,
      eventName: "installation",
      action: "suspended",
      removedRepositoryIds: [],
    });
  }
  if (input.eventName === "installation_repositories" && action === "removed") {
    const removed = value["repositories_removed"];
    if (!Array.isArray(removed) || removed.length > 1_000) {
      throw new GithubProviderInputError("invalid_webhook_payload");
    }
    const ids = removed.map((repository) => {
      if (!isRecord(repository)) throw new GithubProviderInputError("invalid_webhook_payload");
      return requireSafePositiveInteger(repository["id"], "invalid_repository_id");
    });
    if (ids.length === 0) return null;
    return Object.freeze({
      ...base,
      eventName: "installation_repositories",
      action: "repositories_removed",
      removedRepositoryIds: Object.freeze(ids),
    });
  }
  return null;
}

export async function verifyGitHubPushWebhook(
  input: VerifyGitHubWebhookSignatureInput & Omit<ParseGitHubPushWebhookInput, "body">,
): Promise<Readonly<GitHubPushTrigger>> {
  const body = await verifyRawGitHubWebhookSignature(input);
  return parseGitHubPushWebhook({ ...input, body });
}
