import type {
  PreviewRuntimeFence,
  PreviewRuntimeRecord,
  ProjectPreviewRuntime,
} from "@ohmyhost/contracts/previews";
import { createEnvironmentSecretCipherKeyring } from "@ohmyhost/platform";
import { isUserSecretName } from "@ohmyhost/contracts/secret-names";

interface SecretEnvelope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly name: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly valueSha256: Uint8Array;
  readonly keyVersion: number;
  readonly revision: number;
}
export interface PreviewSecretBindings {
  readonly ENVIRONMENT_SECRET_KEY_BASE64: string;
  readonly ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: string;
  readonly ENVIRONMENT_SECRET_KEY_VERSION: string;
  readonly PROJECT_PREVIEW_AUTHORITY?: Pick<ProjectPreviewRuntime, "authorizeRuntime">;
  readonly PREVIEW_SECRET_AUTHORITY?: {
    listCustomerSecretNames(input: { fence: PreviewRuntimeFence }): Promise<readonly string[]>;
    readEnvelopes(input: {
      fence: PreviewRuntimeFence;
      names: readonly string[];
    }): Promise<{ preview: PreviewRuntimeRecord; envelopes: readonly SecretEnvelope[] }>;
  };
  readonly PREVIEW_MAIL_GATEWAY?: { fetch(request: Request): Promise<Response> };
  readonly PREVIEW_STORAGE_GATEWAY?: { fetch(request: Request): Promise<Response> };
  readonly PREVIEW_AI_GATEWAY?: { fetch(request: Request): Promise<Response> };
}
const KEY_NAMES = {
  mail: "OHMYHOST_MAIL_KEY",
  storage: "OHMYHOST_STORAGE_KEY",
  ai: "OHMYHOST_AI_KEY",
} as const;
const fail = () => new Error("preview_capability_unavailable");
const fingerprint = (preview: PreviewRuntimeRecord) =>
  JSON.stringify([
    preview.previewId,
    preview.organizationId,
    preview.projectId,
    preview.environmentId,
    preview.runtimeGeneration,
    preview.tokenGeneration,
    preview.authGeneration,
    preview.assignmentVersion,
    preview.dataEnvironmentId,
    preview.billingEpochId,
    preview.ownershipVersion,
    preview.lifecycleVersion,
    preview.targetSource,
    preview.appliedSource,
    preview.retirement,
  ]);
function customerName(name: string): boolean {
  return isUserSecretName(name);
}

/** Keys are decrypted only in this trusted Worker. A guest can never select a tenant. */
export function createPreviewSecretAccess(env: PreviewSecretBindings) {
  async function read(
    fence: PreviewRuntimeFence,
    names: readonly string[],
    kind: "customer" | "platform",
  ) {
    if (!env.PREVIEW_SECRET_AUTHORITY || !env.PROJECT_PREVIEW_AUTHORITY) throw fail();
    const initial = await env.PROJECT_PREVIEW_AUTHORITY.authorizeRuntime(fence);
    if (!initial || !["starting", "ready"].includes(initial.state)) throw fail();
    const result = await env.PREVIEW_SECRET_AUTHORITY.readEnvelopes({ fence, names });
    if (fingerprint(result.preview) !== fingerprint(initial)) throw fail();
    const cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: env.ENVIRONMENT_SECRET_KEY_BASE64,
      additionalKeysJson: env.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON,
      currentKeyVersion: Number(env.ENVIRONMENT_SECRET_KEY_VERSION),
      crypto: globalThis.crypto,
    });
    const values: Record<string, string> = {};
    const identities: unknown[] = [];
    for (const secret of result.envelopes) {
      if (
        !names.includes(secret.name) ||
        Object.hasOwn(values, secret.name) ||
        secret.organizationId !== initial.organizationId ||
        secret.projectId !== initial.projectId ||
        secret.environmentId !== initial.environmentId
      )
        throw fail();
      Object.defineProperty(values, secret.name, {
        // Customer digests are keyed; platform gateway-key digests are plain SHA-256.
        value:
          kind === "customer"
            ? await cipher.openEnvironmentSecret(secret)
            : await cipher.decrypt(secret),
        enumerable: true,
      });
      identities.push([secret.name, secret.revision, Array.from(secret.valueSha256)]);
    }
    const current = async () => {
      const next = await env.PROJECT_PREVIEW_AUTHORITY?.authorizeRuntime(fence);
      if (!next || fingerprint(next) !== fingerprint(initial)) return false;
      const refreshed = await env.PREVIEW_SECRET_AUTHORITY?.readEnvelopes({ fence, names });
      return (
        refreshed !== undefined &&
        fingerprint(refreshed.preview) === fingerprint(initial) &&
        JSON.stringify(
          refreshed.envelopes.map((secret) => [
            secret.name,
            secret.revision,
            Array.from(secret.valueSha256),
          ]),
        ) === JSON.stringify(identities)
      );
    };
    if (!(await current())) throw fail();
    return { preview: initial, values, current };
  }
  return {
    async readCustomerVariables(input: { fence: PreviewRuntimeFence; names?: readonly string[] }) {
      const names =
        input.names ??
        (await env.PREVIEW_SECRET_AUTHORITY?.listCustomerSecretNames({ fence: input.fence }));
      if (
        !Array.isArray(names) ||
        names.length > 100 ||
        new Set(names).size !== names.length ||
        names.some((name) => !customerName(name))
      )
        throw fail();
      return (await read(input.fence, names, "customer")).values;
    },
    async fetchPreview(request: Request, fence: PreviewRuntimeFence): Promise<Response> {
      const url = new URL(request.url);
      const match = /^\/(mail|storage|ai)(\/v1\/[^?#]*)$/u.exec(url.pathname);
      if (
        url.origin !== "http://preview.capabilities" ||
        url.username ||
        url.password ||
        !match ||
        (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE")
      )
        return new Response(null, { status: 404 });
      const kind = match[1] as keyof typeof KEY_NAMES;
      const binding =
        kind === "mail"
          ? env.PREVIEW_MAIL_GATEWAY
          : kind === "storage"
            ? env.PREVIEW_STORAGE_GATEWAY
            : env.PREVIEW_AI_GATEWAY;
      if (!binding) throw fail();
      const name = KEY_NAMES[kind];
      const selected = await read(fence, [name], "platform");
      const key = selected.values[name];
      if (!key || /[\s\p{Cc}]/u.test(key)) throw fail();
      const headers = new Headers({
        authorization: `Bearer ${key}`,
        "x-ohmyhost-egress-project-id": selected.preview.projectId,
      });
      for (const header of ["content-type", "accept", "idempotency-key", "range"]) {
        const value = request.headers.get(header);
        if (value !== null) headers.set(header, value);
      }
      if (
        kind === "ai" &&
        match[2] === "/v1/realtime" &&
        request.method === "GET" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      )
        headers.set("upgrade", "websocket");
      const init: RequestInit & { duplex: "half" } = {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        redirect: "manual",
        duplex: "half",
      };
      const forwarded = new Request(
        `https://preview-gateway.internal${match[2]}${url.search}`,
        init,
      );
      // There is deliberately no retry: an interrupted mail/AI/storage write may have completed.
      const response = await binding.fetch(forwarded);
      const socket = (
        response as Response & {
          webSocket?: WebSocket & { accept(): void };
        }
      ).webSocket;
      if (!(await selected.current().catch(() => false))) {
        if (socket) {
          // A fetch client socket must be accepted before it can be closed.
          try {
            socket.accept();
          } finally {
            socket.close(1001, "Preview ended");
          }
        }
        await response.body?.cancel();
        return Response.json({ outcome: "unknown", retryable: false }, { status: 409 });
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("set-cookie");
      responseHeaders.delete("location");
      responseHeaders.set("cache-control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        ...(response.status === 101 ? { webSocket: socket } : {}),
      });
    },
  };
}
