import {
  AI_KEY_NAME,
  BROWSER_KEY_NAME,
  createAiKey,
  createBrowserKey,
  type Clock,
} from "@ohmyhost/platform";
import type { EnvironmentSecretsPort } from "./contracts.js";
import { IdempotencyKeyReusedError } from "./contracts.js";
import {
  EnvironmentSecretMutationBlockedError,
  EnvironmentSecretNotInstalledError,
  runtimeSecretDeliveryMetadata,
} from "./environment-secrets.js";
import type { createEnvironmentSecretCipher } from "./environment-secret-cipher.js";

type Metadata = {
  name: string;
  revision: number;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
};
type Delivery = Parameters<typeof runtimeSecretDeliveryMetadata>[0];
type Response =
  | { status: "stored"; secret: Metadata }
  | { status: "deleted" | "absent"; name: string };
export interface D1EnvironmentSecretsRuntime {
  readApiEnvironmentSecrets(
    input: unknown,
  ): Promise<{ items: readonly Metadata[]; delivery: Delivery }>;
  mutateApiEnvironmentSecret(input: unknown): Promise<{ response: Response; delivery: Delivery }>;
}
export function isD1EnvironmentSecretsRuntime(
  value: unknown,
): value is D1EnvironmentSecretsRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    ["readApiEnvironmentSecrets", "mutateApiEnvironmentSecret"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}
/**
 * A fresh value for an installed platform key: 32 random bytes in base64url, the form runtime-secret-delivery generates. The
 * AI gateway key wraps the same bytes in its project's prefix, so the gateway can find the row by its project.
 */
function generatePlatformKeyValue(projectId: string, name: string): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const secret = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  bytes.fill(0);
  return name === AI_KEY_NAME
    ? createAiKey(projectId, secret)
    : name === BROWSER_KEY_NAME
      ? createBrowserKey(projectId, secret)
      : secret;
}

/** API owns encryption and plaintext. Only the original sealed mutation crosses the private binding. */
export function createD1EnvironmentSecretsPort(input: {
  runtime: D1EnvironmentSecretsRuntime;
  clock: Clock;
  cipher: ReturnType<typeof createEnvironmentSecretCipher>;
}): EnvironmentSecretsPort {
  const scope = (context: Parameters<EnvironmentSecretsPort["list"]>[0]) => ({
    organizationId: context.organizationId,
    projectId: context.projectId,
    environmentId: context.environmentId,
  });
  const mutation = async (raw: unknown) => {
    try {
      return await input.runtime.mutateApiEnvironmentSecret(raw);
    } catch (error) {
      const code =
        error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
      const message = error instanceof Error ? error.message : "";
      if (
        code === "environment_secret_idempotency_conflict" ||
        message === "environment_secret_idempotency_conflict" ||
        message.includes("Environment secret idempotency key was reused")
      )
        throw new IdempotencyKeyReusedError();
      if (
        code === "environment_secret_absent" ||
        message === "environment_secret_absent" ||
        message.includes("Environment secret is not installed")
      )
        throw new EnvironmentSecretNotInstalledError();
      if (
        code === "environment_secret_mutation_blocked" ||
        message === "environment_secret_mutation_blocked" ||
        message.includes("Environment secret mutation is blocked")
      )
        throw new EnvironmentSecretMutationBlockedError();
      throw error;
    }
  };
  const port: EnvironmentSecretsPort = {
    async list(context) {
      const result = await input.runtime.readApiEnvironmentSecrets(scope(context));
      return { items: result.items, delivery: runtimeSecretDeliveryMetadata(result.delivery) };
    },
    async put(request) {
      const encrypted = await input.cipher.encrypt(request),
        now = input.clock.now().toISOString();
      const result = await mutation({
        ...scope(request),
        ...(request.delegation === undefined
          ? {}
          : { principalId: request.principalId, handoffDelegation: request.delegation }),
        action: "set",
        name: request.name,
        ...encrypted,
        // Keyed, not the plaintext SHA-256: the stored digests must not be a guessing oracle for a low-entropy value.
        valueSha256: await input.cipher.keyedDigest(
          "value",
          new TextEncoder().encode(request.value),
        ),
        writtenAt: now,
        requestedAt: now,
        idempotencyKey: request.idempotencyKey,
        requestSha256: await input.cipher.keyedDigest("request", request.canonicalRequestDigest),
      });
      if (result.response.status !== "stored") throw new IdempotencyKeyReusedError();
      return { ...result.response.secret, ...runtimeSecretDeliveryMetadata(result.delivery) };
    },
    async rotate(request) {
      // The stored digest is the plain SHA-256 that encrypt returns, not the keyed digest `put` stores for a user value.
      // The gateways compare the SHA-256 of the whole key, and runtime-secret-delivery and the cipher's decrypt check it
      // against the opened plaintext. A user value is low-entropy, so its keyed digest is no guessing oracle; a platform key
      // is 256 random bits, so the plain digest reveals nothing and is what those comparisons need.
      const encrypted = await input.cipher.encrypt({
        ...scope(request),
        name: request.name,
        value: generatePlatformKeyValue(request.projectId, request.name),
      });
      const now = input.clock.now().toISOString();
      const result = await mutation({
        ...scope(request),
        ...(request.delegation === undefined
          ? {}
          : { principalId: request.principalId, handoffDelegation: request.delegation }),
        action: "rotate",
        name: request.name,
        ...encrypted,
        writtenAt: now,
        requestedAt: now,
        idempotencyKey: request.idempotencyKey,
        requestSha256: await input.cipher.keyedDigest("request", request.canonicalRequestDigest),
      });
      if (result.response.status !== "stored") throw new IdempotencyKeyReusedError();
      return { ...result.response.secret, ...runtimeSecretDeliveryMetadata(result.delivery) };
    },
    async remove(request) {
      const result = await mutation({
        ...scope(request),
        ...(request.delegation === undefined
          ? {}
          : { principalId: request.principalId, handoffDelegation: request.delegation }),
        action: "delete",
        name: request.name,
        requestedAt: input.clock.now().toISOString(),
        idempotencyKey: request.idempotencyKey,
        requestSha256: await input.cipher.keyedDigest("request", request.canonicalRequestDigest),
      });
      if (result.response.status === "stored") throw new IdempotencyKeyReusedError();
      return { ...result.response, ...runtimeSecretDeliveryMetadata(result.delivery) };
    },
  };
  return Object.freeze(port);
}
