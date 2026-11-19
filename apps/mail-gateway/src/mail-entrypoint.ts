import { WorkerEntrypoint } from "cloudflare:workers";
import { EnvironmentSecretCipherInputError } from "@ohmyhost/platform";

export const MAIL_EGRESS_CALLER = "wfp-egress-policy";
export const DATABASE_MAIL_CALLER = "project-database-runtime";
export type MailCallerRole = typeof MAIL_EGRESS_CALLER | typeof DATABASE_MAIL_CALLER;
const PROJECT_HEADER = "x-ohmyhost-egress-project-id";
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export type MailSendPhase = "readiness" | "initialization" | "send" | "boundary";
const MAIL_SEND_REASONS = new Set<string>([
  "mail_core_binding_required",
  "mail_core_unavailable",
  "mail_core_response_invalid",
  "mail_scope_unavailable",
  "mail_send_scope_unavailable",
  "store_busy",
  "store_outcome_unknown",
]);

/** Only fixed operational reasons enter private Worker logs. */
export function reportMailSendUnavailable(
  phase: MailSendPhase,
  error?: unknown,
  runtimeNotConfigured = false,
): void {
  let reason = "unknown";
  try {
    if (runtimeNotConfigured) reason = "runtime_not_configured";
    else if (phase === "initialization" && error instanceof EnvironmentSecretCipherInputError)
      reason = "cipher_configuration_invalid";
    else {
      const message = error instanceof Error ? error.message : undefined;
      const code = error !== null && typeof error === "object" ? Reflect.get(error, "code") : null;
      if (typeof message === "string" && MAIL_SEND_REASONS.has(message)) reason = message;
      else if (typeof code === "string" && MAIL_SEND_REASONS.has(code)) reason = code;
    }
  } catch {
    reason = "unknown";
  }
  try {
    console.error("mail_send_unavailable", { phase, reason });
  } catch {
    // A logging failure must not change the mail response.
  }
}

type MailConstructor<Env> = new (
  context: unknown,
  env: Env,
) => WorkerEntrypoint<Env> & {
  fetch(request: Request): Promise<Response>;
};

/** The private named class fixes its capability; ctx.props cannot grant a different role. */
export function createMailEntrypoint<Env>(
  serve: (request: Request, env: Env, projectId: string, role: MailCallerRole) => Promise<Response>,
  role: MailCallerRole,
): MailConstructor<Env> {
  return class ScopedMail extends WorkerEntrypoint<Env> {
    public async fetch(request: Request): Promise<Response> {
      const projectId = request.headers.get(PROJECT_HEADER);
      if (projectId === null || !ULID.test(projectId))
        return Response.json({ code: "unauthorized" }, { status: 401 });
      const url = new URL(request.url);
      const attachment = role === MAIL_EGRESS_CALLER && url.pathname === "/v1/attachments/download";
      if (
        request.method !== "POST" ||
        (!attachment && url.pathname !== "/v1/send") ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        return Response.json({ code: "resource_not_found" }, { status: 404 });
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return Response.json({ code: "invalid_request" }, { status: 400 });
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await boundedMailBody(request, attachment ? 1024 : 262144);
        const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof body !== "object" || body === null || Array.isArray(body))
          return Response.json({ code: "invalid_request" }, { status: 400 });
        if (typeof (body as Record<string, unknown>)["project_id"] !== "string")
          return Response.json({ code: "invalid_request" }, { status: 400 });
        if ((body as Record<string, unknown>)["project_id"] !== projectId)
          return Response.json({ code: "unauthorized" }, { status: 401 });
      } catch {
        return Response.json({ code: "invalid_request" }, { status: 400 });
      }
      try {
        return await serve(new Request(request, { body: bytes }), this.env, projectId, role);
      } catch (error) {
        if (!attachment) reportMailSendUnavailable("boundary", error);
        return Response.json({ code: "mail_gateway_unavailable" }, { status: 503 });
      }
    }
  };
}

/** Only bounded control JSON is buffered; binary responses never pass through this reader. */
export async function boundedMailBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Invalid mail request");
  const cancelReader = async () => {
    try {
      await reader.cancel();
    } catch {
      /* A failed cancel must not replace the bounded request failure. */
    }
  };
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) abort.abort();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => {
      void cancelReader();
      reject(new TypeError("Invalid mail request"));
    };
    if (abort.signal.aborted) fail();
    else abort.signal.addEventListener("abort", fail, { once: true });
  });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (abort.signal.aborted) throw new TypeError("Invalid mail request");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new TypeError("Invalid mail request");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onAbort);
    await cancelReader();
  }
}
