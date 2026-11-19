import {
  decodePreviewValue,
  encodePreviewValue,
} from "@ohmyhost/customer-runtime/preview-transport";
import type {
  PreviewRuntimeFence,
  PreviewRuntimeRecord,
  ProjectPreviewRuntime,
  SourceVersion,
} from "@ohmyhost/contracts/previews";
import { sameSourceVersion } from "./source-sync.js";
import type { PreviewDatabaseService } from "./database-handles.js";

const MAX_BODY = 2 * 1024 * 1024;
type DatabaseOperation = "query" | "transaction";
export interface PreviewCapabilityBindings {
  readonly authority: Pick<ProjectPreviewRuntime, "authorizeRuntime">;
  readonly database: (region: "eu" | "us") => PreviewDatabaseService | undefined;
  readonly heldDatabase: (input: {
    fence: PreviewRuntimeFence;
    region: "eu" | "us";
    operation: "open" | "openRls" | "connection-query" | "connection-commit" | "connection-close";
    input: unknown;
  }) => Promise<unknown>;
  readonly nativeAuth: (region: "eu" | "us") =>
    | {
        validatePreviewSession(input: {
          fence: PreviewRuntimeFence;
          cookie: string;
          publicOrigin: string;
        }): Promise<unknown>;
      }
    | undefined;
  readonly platform?: {
    fetchPreview(request: Request, fence: PreviewRuntimeFence): Promise<Response>;
  };
}
export interface PreviewCapabilitySelection {
  readonly source: SourceVersion;
  readonly database: boolean;
  readonly auth: boolean;
  readonly mail: boolean;
  readonly storage: boolean;
  readonly ai: boolean;
}

function error(status: number): Response {
  return Response.json(
    status === 409
      ? { outcome: "unknown", retryable: false }
      : { error: "preview_capability_unavailable" },
    { status, headers: { "cache-control": "no-store" } },
  );
}
function sameAuthority(a: PreviewRuntimeRecord, b: PreviewRuntimeRecord | null): boolean {
  return (
    b !== null &&
    b.previewId === a.previewId &&
    b.runtimeGeneration === a.runtimeGeneration &&
    b.tokenGeneration === a.tokenGeneration &&
    b.assignmentVersion === a.assignmentVersion &&
    b.billingEpochId === a.billingEpochId &&
    b.dataEnvironmentId === a.dataEnvironmentId &&
    b.authGeneration === a.authGeneration &&
    b.ownershipVersion === a.ownershipVersion &&
    b.lifecycleVersion === a.lifecycleVersion &&
    b.retirement === "none"
  );
}
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("preview_capability_invalid");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY) {
        await reader.cancel();
        throw new Error("preview_capability_invalid");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodePreviewValue(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Only the trusted outbound intercept supplies the fence. The guest cannot choose identity. */
export function createPreviewCapabilityHandler(bindings: PreviewCapabilityBindings) {
  return async (
    request: Request,
    fence: PreviewRuntimeFence,
    selection: PreviewCapabilitySelection,
    publicOrigin: string,
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== "http://preview.capabilities" || url.username || url.password)
      return error(404);
    let initial: PreviewRuntimeRecord | null;
    try {
      initial = await bindings.authority.authorizeRuntime(fence);
    } catch {
      return error(503);
    }
    if (
      !initial ||
      !["starting", "ready"].includes(initial.state) ||
      !sameSourceVersion(initial.targetSource, selection.source) ||
      !sameSourceVersion(initial.appliedSource, selection.source)
    )
      return error(403);
    const current = initial;
    const after = async () => {
      try {
        const next = await bindings.authority.authorizeRuntime(fence);
        return (
          sameAuthority(current, next) &&
          sameSourceVersion(next?.targetSource ?? null, selection.source) &&
          sameSourceVersion(next?.appliedSource ?? null, selection.source)
        );
      } catch {
        return false;
      }
    };
    if (url.pathname === "/ready" && request.method === "GET" && !url.search) {
      return (await after())
        ? Response.json({ status: "authorized" }, { headers: { "cache-control": "no-store" } })
        : error(403);
    }
    const match = /^\/database\/(query|transaction)$/u.exec(url.pathname);
    if (match && request.method === "POST" && !url.search) {
      const database = bindings.database(current.region);
      if (!database || !selection.database) return error(503);
      let input: unknown;
      try {
        input = await body(request);
      } catch {
        return error(400);
      }
      if (!(await after())) return error(403);
      try {
        const result = await database.execute({
          fence,
          operation: match[1] as DatabaseOperation,
          input,
        });
        if (!(await after())) return error(409);
        return new Response(encodePreviewValue(result ?? null), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      } catch {
        return error(409);
      }
    }
    const held =
      /^\/database\/(open|openRls|connection-query|connection-commit|connection-close)$/u.exec(
        url.pathname,
      );
    if (held && request.method === "POST" && !url.search && selection.database) {
      let input: unknown;
      try {
        input = await body(request);
      } catch {
        return error(400);
      }
      if (!(await after())) return error(403);
      try {
        const result = await bindings.heldDatabase({
          fence,
          region: current.region,
          operation: held[1] as
            | "open"
            | "openRls"
            | "connection-query"
            | "connection-commit"
            | "connection-close",
          input,
        });
        if (!(await after())) return error(409);
        return new Response(encodePreviewValue(result ?? null), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      } catch {
        return error(409);
      }
    }
    if (url.pathname.startsWith("/database/")) return error(503);
    if (url.pathname === "/native-auth/session" && request.method === "POST" && !url.search) {
      const auth = bindings.nativeAuth(current.region);
      const cookie = request.headers.get("cookie") ?? "";
      if (!auth || !selection.auth || cookie.length > 16_384) return error(503);
      try {
        const result = await auth.validatePreviewSession({ fence, cookie, publicOrigin });
        if (!(await after())) return error(409);
        return new Response(encodePreviewValue(result), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      } catch {
        return error(503);
      }
    }
    const kind = /^\/(mail|storage|ai)(?:\/|$)/u.exec(url.pathname)?.[1];
    if (
      !bindings.platform ||
      !kind ||
      !(kind === "mail" ? selection.mail : kind === "storage" ? selection.storage : selection.ai)
    )
      return error(404);
    try {
      const response = await bindings.platform.fetchPreview(request, fence);
      if (!(await after())) {
        if (response.status === 101 && response.webSocket) {
          try {
            response.webSocket.accept();
          } finally {
            response.webSocket.close(1001, "Preview ended");
          }
        }
        await response.body?.cancel();
        return error(409);
      }
      return response;
    } catch {
      return error(409);
    }
  };
}
