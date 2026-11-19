import type { UlidFactory } from "@ohmyhost/platform";
import type {
  PreviewCapabilityEnvelope,
  PreviewCustomerRecord,
  PreviewCustomerScope,
  ProductApiPreviewRuntime,
} from "@ohmyhost/contracts/previews";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";

export interface PreviewView {
  readonly id: string;
  readonly project_id: string;
  readonly environment: "dev" | "prod";
  readonly status: "cold" | "starting" | "ready" | "sleeping";
  readonly url: string;
  readonly source: Readonly<{ sequence: number; commit_sha: string }> | null;
}
export interface PreviewExecutionBinding {
  fence(input: {
    previewId: string;
    runtimeGeneration: number;
    tokenGeneration: number;
    reason: "rotate" | "destroy";
  }): Promise<void>;
  sourceChanged?(input: { previewId: string; sequence: number }): Promise<void>;
  wake?(input: {
    previewId: string;
    runtimeGeneration: number;
    tokenGeneration: number;
    publicOrigin: string;
  }): Promise<void>;
}

/** A latency optimization only: Core's durable pending record remains the retry authority. */
export async function notifyPreviewSources(
  core: Pick<ProductApiPreviewRuntime, "listProjectPendingSources"> | undefined,
  runtime: PreviewExecutionBinding | undefined,
  scope: { organizationId: string; projectId: string },
): Promise<void> {
  if (!core || !runtime?.sourceChanged) return;
  try {
    await Promise.race([
      (async () => {
        const pending = await core.listProjectPendingSources({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        });
        if (
          !Array.isArray(pending) ||
          pending.length > 2 ||
          pending.some(
            (item) =>
              !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(item.previewId) ||
              !Number.isSafeInteger(item.sequence) ||
              item.sequence <= 0,
          )
        )
          return;
        await Promise.allSettled(pending.map((item) => runtime.sourceChanged?.(item)));
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch {
    /* Scheduled outbox delivery retries independently of the saved source. */
  }
}
export interface PreviewSurface {
  get(scope: PreviewCustomerScope): Promise<PreviewView | null>;
  open(scope: PreviewCustomerScope): Promise<PreviewView | null>;
  rotate(scope: PreviewCustomerScope, requestId: string): Promise<PreviewView | null>;
  stop(scope: PreviewCustomerScope, requestId: string): Promise<PreviewView | null>;
}
const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let buffer = 0,
    bits = 0,
    output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("Invalid preview capability envelope");
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new TypeError("Invalid preview capability envelope");
  return bytes;
}
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
function unhex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("Invalid preview capability hash");
  const parts = value.match(/../gu);
  if (parts === null) throw new TypeError("Invalid preview capability hash");
  return Uint8Array.from(parts, (part) => parseInt(part, 16));
}
function secretIdentity(
  scope: PreviewCustomerScope,
  environmentId: string,
  previewId: string,
  generation: number,
) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId,
    name: `PREVIEW_CAPABILITY_${previewId}_${generation}`,
  };
}
async function privateRequestId(scope: PreviewCustomerScope, requestId: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "preview-request-v1",
      scope.organizationId,
      scope.projectId,
      scope.environment,
      requestId,
    ]),
  );
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Plaintext capability exists only inside this authorized Control API surface. */
export function createPreviewSurface(input: {
  readonly core: ProductApiPreviewRuntime;
  readonly runtime: PreviewExecutionBinding;
  readonly cipher: ReturnType<typeof createEnvironmentSecretCipherKeyring>;
  readonly ids: UlidFactory;
  readonly hostSuffix: "preview.dev.omh.st" | "preview.omh.st";
  readonly ensureInitialSource?: (scope: PreviewCustomerScope) => Promise<void>;
}): PreviewSurface {
  const seal = async (
    scope: PreviewCustomerScope,
    environmentId: string,
    previewId: string,
    generation: number,
  ): Promise<PreviewCapabilityEnvelope> => {
    const token = base32(crypto.getRandomValues(new Uint8Array(32)));
    const encrypted = await input.cipher.encrypt({
      ...secretIdentity(scope, environmentId, previewId, generation),
      value: token,
    });
    return {
      lookupSha256: hex(encrypted.valueSha256),
      ciphertext: encode(encrypted.ciphertext),
      nonce: encode(encrypted.nonce),
      keyVersion: encrypted.keyVersion,
      tokenGeneration: generation,
    };
  };
  const view = async (
    scope: PreviewCustomerScope,
    value: PreviewCustomerRecord,
  ): Promise<PreviewView> => {
    const { preview, capability } = value;
    if (
      preview.organizationId !== scope.organizationId ||
      preview.projectId !== scope.projectId ||
      preview.environment !== scope.environment ||
      preview.tokenGeneration !== capability.tokenGeneration ||
      preview.retirement !== "none"
    )
      throw new Error("Preview is unavailable");
    const token = await input.cipher.decrypt({
      ...secretIdentity(scope, preview.environmentId, preview.previewId, preview.tokenGeneration),
      ciphertext: decode(capability.ciphertext),
      nonce: decode(capability.nonce),
      valueSha256: unhex(capability.lookupSha256),
      keyVersion: capability.keyVersion,
    });
    if (!/^[a-z2-7]{51}[aq]$/u.test(token)) throw new Error("Preview capability is invalid");
    return {
      id: preview.previewId,
      project_id: preview.projectId,
      environment: preview.environment,
      status: preview.state,
      url: `https://${token}.${input.hostSuffix}`,
      source:
        preview.targetSource === null
          ? null
          : { sequence: preview.targetSource.sequence, commit_sha: preview.targetSource.commitSha },
    };
  };
  const settle = async (
    scope: PreviewCustomerScope,
    value: PreviewCustomerRecord,
  ): Promise<PreviewCustomerRecord> => {
    const preview = value.preview;
    if (
      preview.organizationId !== scope.organizationId ||
      preview.projectId !== scope.projectId ||
      preview.environment !== scope.environment
    )
      throw new Error("Preview is unavailable");
    if (preview.retirement === "none") return value;
    const fence = {
      previewId: preview.previewId,
      runtimeGeneration: preview.runtimeGeneration,
      tokenGeneration: preview.tokenGeneration,
    };
    if (preview.retirement === "rotating") {
      await input.runtime.fence({ ...fence, reason: "rotate" });
      await input.core.confirmRotation(fence);
    } else {
      await input.runtime.fence({ ...fence, reason: "destroy" });
      await input.core.confirmDestroy(fence);
    }
    const current = await input.core.get(scope);
    if (current === null || current.preview.retirement !== "none")
      throw new Error("Preview is unavailable");
    return current;
  };
  const openView = async (
    scope: PreviewCustomerScope,
    record: PreviewCustomerRecord,
  ): Promise<PreviewView> => {
    let current = await settle(scope, record);
    if (input.ensureInitialSource) {
      await input.ensureInitialSource(scope);
      current = (await input.core.get(scope)) ?? current;
      current = await settle(scope, current);
    }
    const result = await view(scope, current);
    if (input.runtime.wake) {
      const { previewId, runtimeGeneration, tokenGeneration } = current.preview;
      try {
        await Promise.race([
          input.runtime.wake({
            previewId,
            runtimeGeneration,
            tokenGeneration,
            publicOrigin: result.url,
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      } catch {
        /* The browser can retry the stable URL. */
      }
    }
    return result;
  };
  return {
    async get(scope) {
      const record = await input.core.get(scope);
      return record === null ? null : view(scope, await settle(scope, record));
    },
    async open(scope) {
      const prepared = await input.core.prepare(scope);
      if (prepared.preview !== null) return openView(scope, prepared.preview);
      const previewId = input.ids.next();
      const capability = await seal(scope, prepared.environmentId, previewId, 1);
      return openView(
        scope,
        await input.core.ensure({
          ...scope,
          environmentId: prepared.environmentId,
          previewId,
          capability,
        }),
      );
    },
    async rotate(scope, requestId) {
      const current = await input.core.get(scope);
      if (current === null) return null;
      const preview = (await settle(scope, current)).preview;
      const capability = await seal(
        scope,
        preview.environmentId,
        preview.previewId,
        preview.tokenGeneration + 1,
      );
      const rotated = await input.core.rotate({
        ...scope,
        previewId: preview.previewId,
        expectedRowVersion: preview.rowVersion,
        expectedTokenGeneration: preview.tokenGeneration,
        requestId: await privateRequestId(scope, requestId),
        capability,
      });
      return view(scope, await settle(scope, rotated));
    },
    async stop(scope, requestId) {
      const current = await input.core.get(scope);
      if (current === null) return null;
      const preview = (await settle(scope, current)).preview;
      const destroyed = await input.core.destroy({
        ...scope,
        previewId: preview.previewId,
        expectedRowVersion: preview.rowVersion,
        requestId: await privateRequestId(scope, requestId),
      });
      const fence = {
        previewId: destroyed.previewId,
        runtimeGeneration: destroyed.runtimeGeneration,
        tokenGeneration: destroyed.tokenGeneration,
      };
      if (destroyed.retirement === "destroying") {
        await input.runtime.fence({ ...fence, reason: "destroy" });
        await input.core.confirmDestroy(fence);
      }
      const result = await input.core.get(scope);
      return result === null ? null : view(scope, await settle(scope, result));
    },
  };
}
