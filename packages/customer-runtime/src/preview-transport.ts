import type { CustomerDatabaseBinding, CustomerDatabaseRlsIdentity } from "./database.js";
import type { NativeAuthBinding, NativeAuthSession } from "./auth-server.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 16;
const MAX_RESPONSE_MS = 30_000;
type Wire = readonly [string, unknown];

function invalid(): never {
  throw new Error("preview_transport_invalid");
}

/** A tagged envelope preserves PostgreSQL timestamps/bytes without colliding with JSON objects. */
export function encodePreviewValue(value: unknown): string {
  let nodes = 0;
  function encode(input: unknown, depth: number): Wire {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (input === null) return ["null", null];
    if (typeof input === "string" || typeof input === "boolean") return [typeof input, input];
    if (typeof input === "number" && Number.isFinite(input)) return ["number", input];
    if (input instanceof Date && Number.isFinite(input.getTime()))
      return ["date", input.toISOString()];
    if (input instanceof Uint8Array) {
      let binary = "";
      for (let offset = 0; offset < input.length; offset += 32_768)
        binary += String.fromCharCode(...input.subarray(offset, offset + 32_768));
      return ["bytes", btoa(binary)];
    }
    if (Array.isArray(input)) return ["array", input.map((child) => encode(child, depth + 1))];
    if (
      typeof input === "object" &&
      input !== null &&
      Object.getPrototypeOf(input) === Object.prototype
    )
      return [
        "object",
        Object.entries(input).map(([key, child]) => [key, encode(child, depth + 1)]),
      ];
    return invalid();
  }
  const text = JSON.stringify(encode(value, 0));
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) invalid();
  return text;
}

export function decodePreviewValue(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) invalid();
  let nodes = 0;
  function decode(input: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || !Array.isArray(input) || input.length !== 2)
      invalid();
    const [tag, value] = input;
    if (tag === "null" && value === null) return null;
    if (tag === "string" && typeof value === "string") return value;
    if (tag === "boolean" && typeof value === "boolean") return value;
    if (tag === "number" && typeof value === "number" && Number.isFinite(value)) return value;
    if (tag === "date" && typeof value === "string") {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid();
      return date;
    }
    if (tag === "bytes" && typeof value === "string") {
      const binary = atob(value);
      if (btoa(binary) !== value) invalid();
      return Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
    }
    if (tag === "array" && Array.isArray(value))
      return value.map((child) => decode(child, depth + 1));
    if (tag === "object" && Array.isArray(value)) {
      const result: Record<string, unknown> = {};
      for (const pair of value) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          Object.hasOwn(result, pair[0])
        )
          invalid();
        Object.defineProperty(result, pair[0], {
          enumerable: true,
          configurable: true,
          writable: true,
          value: decode(pair[1], depth + 1),
        });
      }
      return result;
    }
    return invalid();
  }
  try {
    return decode(JSON.parse(text) as unknown, 0);
  } catch {
    return invalid();
  }
}

/** Server-only development adapter. The platform outbound handler selects the data environment. */
export function createPreviewDatabaseBinding(options: {
  readonly endpoint?: string;
  readonly fetch: (request: Request) => Promise<Response>;
}): CustomerDatabaseBinding {
  const origin = new URL(options.endpoint ?? "http://preview.capabilities").origin;
  async function call(operation: string, input: unknown): Promise<unknown> {
    const request = new Request(`${origin}/database/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodePreviewValue(input),
      signal: AbortSignal.timeout(MAX_RESPONSE_MS),
    });
    let response: Response;
    try {
      response = await options.fetch(request);
    } catch {
      // Once dispatched, the server may have committed even if the reply is lost.
      return { type: "ohmyhost.database-error/v1", sqlstate: "08007" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409) return { type: "ohmyhost.database-error/v1", sqlstate: "08007" };
      throw new Error("project_database_unavailable");
    }
    try {
      return decodePreviewValue(await readBounded(response));
    } catch {
      // Malformed or interrupted replies cannot establish the outcome of a dispatched operation.
      return { type: "ohmyhost.database-error/v1", sqlstate: "08007" };
    }
  }
  async function open(operation: "open" | "openRls", identity: unknown) {
    const result = await call(operation, identity);
    if (
      typeof result !== "object" ||
      result === null ||
      !("handle" in result) ||
      typeof result.handle !== "string"
    )
      throw new Error("project_database_unavailable");
    const handle = result.handle;
    return Object.freeze({
      query: (input: unknown) => call("connection-query", { handle, input }),
      async close() {
        await call("connection-close", { handle });
      },
      commit: () => call("connection-commit", { handle }),
    });
  }
  return Object.freeze({
    query: (input: unknown) => call("query", input),
    transaction: (input: unknown) => call("transaction", input),
    open: () => open("open", null),
    openRls: (identity: CustomerDatabaseRlsIdentity | null) => open("openRls", identity),
  });
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("preview_transport_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("preview_transport_invalid");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The framework's server context receives this in OHMYHOST_AUTH, never a realm secret. */
export function createPreviewNativeAuthBinding(options: {
  readonly endpoint?: string;
  readonly fetch: (request: Request) => Promise<Response>;
}): NativeAuthBinding {
  const origin = new URL(options.endpoint ?? "http://preview.capabilities").origin;
  return Object.freeze({
    async validateSession({
      cookie,
    }: {
      readonly cookie: string;
    }): Promise<NativeAuthSession | null> {
      if (typeof cookie !== "string" || cookie.length > 16384) throw new Error("auth_unavailable");
      const response = await options.fetch(
        new Request(`${origin}/native-auth/session`, {
          method: "POST",
          headers: { cookie },
          signal: AbortSignal.timeout(MAX_RESPONSE_MS),
        }),
      );
      if (!response.ok) throw new Error("auth_unavailable");
      const value = decodePreviewValue(await readBounded(response));
      if (value === null) return null;
      if (
        typeof value !== "object" ||
        !("user" in value) ||
        !("session" in value) ||
        typeof value.user !== "object" ||
        value.user === null ||
        typeof value.session !== "object" ||
        value.session === null ||
        !("id" in value.user) ||
        !("email" in value.user) ||
        !("id" in value.session) ||
        !("expiresAt" in value.session) ||
        typeof value.user.id !== "string" ||
        typeof value.user.email !== "string" ||
        typeof value.session.id !== "string" ||
        typeof value.session.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.session.expiresAt))
      )
        throw new Error("auth_unavailable");
      return {
        user: { id: value.user.id, email: value.user.email },
        session: { id: value.session.id, expiresAt: value.session.expiresAt },
      };
    },
  });
}
